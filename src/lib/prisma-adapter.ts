import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { resolvePrismaSqlitePath } from './sqlite-path';

type AdapterFactory = Pick<
  PrismaBetterSqlite3,
  'provider' | 'adapterName' | 'connect' | 'connectToShadowDb'
>;
type Adapter = Awaited<ReturnType<PrismaBetterSqlite3['connect']>>;
type Transaction = Awaited<ReturnType<Adapter['startTransaction']>>;

/**
 * The driver adapter every Prisma client opens the database with. Every
 * existing database stores DateTime columns as epoch milliseconds, so every
 * client writes them that way too.
 */
export function createSqliteAdapter(databaseUrl: string | undefined): AdapterFactory {
  const factory = new PrismaBetterSqlite3(
    { url: resolvePrismaSqlitePath(databaseUrl) },
    { timestampFormat: 'unixepoch-ms' },
  );
  return {
    provider: factory.provider,
    adapterName: factory.adapterName,
    connect: async () => serializeTransactions(await factory.connect()),
    connectToShadowDb: () => factory.connectToShadowDb(),
  };
}

/** A first-come lock: each holder runs after every earlier one has released it. */
class Lock {
  #tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise((resolve) => (release = resolve));
    await previous;
    return release;
  }
}

/**
 * The adapter runs every query on one connection, and its top-level queries do
 * not wait for an open interactive transaction, so they would run inside it and
 * roll back with it. Here a transaction holds the connection from its start
 * until Prisma commits or rolls it back, and every other query waits for that.
 */
function serializeTransactions(adapter: Adapter): Adapter {
  const lock = new Lock();
  const exclusive = async <T>(run: () => Promise<T>): Promise<T> => {
    const release = await lock.acquire();
    try {
      return await run();
    } finally {
      release();
    }
  };
  return {
    provider: adapter.provider,
    adapterName: adapter.adapterName,
    queryRaw: (query) => exclusive(() => adapter.queryRaw(query)),
    executeRaw: (query) => exclusive(() => adapter.executeRaw(query)),
    executeScript: (script) => exclusive(() => adapter.executeScript(script)),
    startTransaction: async (isolationLevel) => {
      const release = await lock.acquire();
      try {
        return releaseOnEnd(await adapter.startTransaction(isolationLevel), release);
      } catch (error) {
        release();
        throw error;
      }
    },
    dispose: () => adapter.dispose(),
  };
}

function releaseOnEnd(transaction: Transaction, release: () => void): Transaction {
  const end = (finish: () => Promise<void>) => async () => {
    try {
      await finish();
    } finally {
      release();
    }
  };
  return {
    provider: transaction.provider,
    adapterName: transaction.adapterName,
    options: transaction.options,
    queryRaw: (query) => transaction.queryRaw(query),
    executeRaw: (query) => transaction.executeRaw(query),
    commit: end(() => transaction.commit()),
    rollback: end(() => transaction.rollback()),
    createSavepoint: (name) => transaction.createSavepoint!(name),
    rollbackToSavepoint: (name) => transaction.rollbackToSavepoint!(name),
    releaseSavepoint: (name) => transaction.releaseSavepoint!(name),
  };
}
