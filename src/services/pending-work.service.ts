/**
 * Work the agent has accepted and not finished, kept in `pending_work` so the
 * process can stop at any moment and lose none of it.
 *
 * An owner `begin`s a row before the work starts and `end`s it when the work
 * ends, however it ends. At boot `interrupted` reads the rows left over and
 * `resumeAll` gives each to the owner of its kind, which continues the work.
 * A scheduled run keeps a row too, so the attempt bound covers the run a boot
 * starts again because it is still due.
 *
 * A shutdown freezes the journal. From `shutdown()` on, `update`, `settle` and
 * `end` change nothing, and `shutdownSignal` tells the work to stop, so the next
 * boot continues the work a shutdown interrupts from the point it had reached.
 * `finish` is the exception: work whose result reached its user records that,
 * so the next boot does not deliver it again.
 */

import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { config } from '../config';
import { logger } from '../logger';
import { trackEvent } from '../lib/telemetry';

/**
 * Each kind of work that survives a restart, by the service that owns it, in
 * the order the boot gives it back: a resumed reply or run can poll a coding
 * task, so the tasks come back first. A routed event comes back last, since it
 * can start an exchange on a thread whose interrupted reply resumes before it.
 */
export const PENDING_WORK_KINDS = ['coding-task', 'chat', 'webhook', 'cron', 'heartbeat', 'monitor', 'routed-event'] as const;
export type PendingWorkKind = (typeof PENDING_WORK_KINDS)[number];

/**
 * Boots that may give one piece of work back. Work that stops its own process
 * every time it runs would otherwise stop every boot after it.
 */
export const MAX_RESUME_ATTEMPTS = 3;

export interface PendingWorkItem {
  key: string;
  /** What the owner wrote. Only that owner writes its kind, so it reads its own shape back. */
  payload: Prisma.JsonValue;
  /** Boots that have given this work back, this one included. */
  attempts: number;
  createdAt: Date;
}

/** The work a restart interrupted, as the boot read it before any new work arrived. */
export type InterruptedWork = Array<PendingWorkItem & { kind: string }>;

/**
 * Continues the work a restart interrupted. Called once per boot, also with no
 * items. `givenUp` is the work that `MAX_RESUME_ATTEMPTS` boots in a row could
 * not finish. Its rows are gone, and an owner whose schedule would start it
 * again closes it.
 */
export type PendingWorkResumer = (items: PendingWorkItem[], givenUp: PendingWorkItem[]) => Promise<void>;

export class PendingWorkService {
  private readonly stopping = new AbortController();
  /** The last write to each row, so the writes to one row land in the order they were made. */
  private readonly writes = new Map<string, Promise<void>>();

  /** Aborted when shutdown starts. Work passes it to what it runs, so it stops rather than finishing in a process being taken apart. */
  get shutdownSignal(): AbortSignal {
    return this.stopping.signal;
  }

  /**
   * Record work before it starts, with what its owner needs to accept the work
   * again when a restart comes before the owner's own record of it. `payload` is
   * stored as JSON. Rejects when the row cannot be written, so the caller can
   * refuse work it cannot keep.
   */
  begin(kind: PendingWorkKind, key: string, payload: object): Promise<void> {
    const json = payload as Prisma.InputJsonValue;
    return this.write(kind, [key], () =>
      prisma.pendingWork.upsert({
        where: { kind_key: { kind, key } },
        create: { kind, key, payload: json },
        update: { payload: json },
      }),
    ).then(() => undefined);
  }

  /**
   * Run the owner's write and record the work in one transaction. When `ownerWrite`
   * resolves false, no row is written and this resolves false too.
   */
  beginWith(
    kind: PendingWorkKind,
    key: string,
    payload: object,
    ownerWrite: (tx: Prisma.TransactionClient) => Promise<boolean>,
  ): Promise<boolean> {
    const json = payload as Prisma.InputJsonValue;
    return this.write(kind, [key], () =>
      prisma.$transaction(async (tx) => {
        if (!(await ownerWrite(tx))) return false;
        await tx.pendingWork.upsert({
          where: { kind_key: { kind, key } },
          create: { kind, key, payload: json },
          update: { payload: json },
        });
        return true;
      }),
    );
  }

  /**
   * `begin` for work its sender can deliver more than once: records it unless a
   * row for it is already there, and answers whether this call recorded it.
   */
  async claim(kind: PendingWorkKind, key: string, payload: object): Promise<boolean> {
    try {
      await this.write(kind, [key], () =>
        prisma.pendingWork.create({ data: { kind, key, payload: payload as Prisma.InputJsonValue } }),
      );
      return true;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false;
      throw err;
    }
  }

  /** Replace what the owner needs to continue the work, e.g. once a session id is known. */
  update(kind: PendingWorkKind, key: string, payload: object): void {
    this.replace(kind, key, { payload: payload as Prisma.InputJsonValue });
  }

  /**
   * The work is done, and its row holds the result until its reader asks. A
   * restart is no attempt at it, so the resume bound never drops the result.
   */
  settle(kind: PendingWorkKind, key: string, payload: object): void {
    this.replace(kind, key, { payload: payload as Prisma.InputJsonValue, attempts: 0 });
  }

  /** The work ended. Its row goes, so no boot continues it. */
  end(kind: PendingWorkKind, keys: string | readonly string[]): void {
    if (this.stopping.signal.aborted) return;
    this.remove(kind, keys);
  }

  /** The work's result reached its user. Its row goes, also during a shutdown. */
  finish(kind: PendingWorkKind, keys: string | readonly string[]): void {
    this.remove(kind, keys);
  }

  /** Stop the work in flight and keep its rows for the next boot. */
  shutdown(): void {
    this.stopping.abort();
  }

  /** Wait for the writes in flight, so a process that exits next keeps them. */
  async flush(): Promise<void> {
    await Promise.all(this.writes.values());
  }

  /**
   * The work a restart interrupted. Read at boot before the channels connect, so
   * a message that arrives during the boot is new work with its own turn. Each
   * read is an attempt; the work past `MAX_RESUME_ATTEMPTS` goes to its owner as
   * given up.
   */
  async interrupted(): Promise<InterruptedWork> {
    await prisma.pendingWork.updateMany({ data: { attempts: { increment: 1 } } });
    const rows = await prisma.pendingWork.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map((row) => ({ kind: row.kind, ...toItem(row) }));
  }

  /** The rows of one kind as they stand. */
  async rows(kind: PendingWorkKind): Promise<PendingWorkItem[]> {
    const rows = await prisma.pendingWork.findMany({ where: { kind }, orderBy: { createdAt: 'asc' } });
    return rows.map(toItem);
  }

  /**
   * Give each owner the work a restart interrupted. Runs once, at boot, after
   * the channels connect, so a resumed reply can be delivered.
   */
  async resumeAll(
    interrupted: InterruptedWork,
    resumers: Record<PendingWorkKind, PendingWorkResumer>,
  ): Promise<void> {
    for (const kind of PENDING_WORK_KINDS) {
      const ofKind = interrupted.filter((row) => row.kind === kind);
      const live = ofKind.filter((row) => row.attempts <= MAX_RESUME_ATTEMPTS);
      const givenUp = ofKind.filter((row) => row.attempts > MAX_RESUME_ATTEMPTS);
      if (live.length > 0) {
        logger.info('[PendingWork] Continuing %d piece(s) of %s work a restart interrupted', live.length, kind);
      }
      try {
        await resumers[kind](live.map(toItem), givenUp.map(toItem));
        // The owner has closed the work it was given up, so its rows can go. A boot
        // that stops before this gives the work up again.
        if (givenUp.length > 0) {
          logger.warn(
            '[PendingWork] Gave up %d piece(s) of %s work that %d boots in a row could not finish',
            givenUp.length,
            kind,
            MAX_RESUME_ATTEMPTS,
          );
          this.remove(kind, givenUp.map((row) => row.key));
        }
      } catch (err) {
        logger.error({ err, kind }, '[PendingWork] Could not continue the interrupted work');
      }
      if (ofKind.length > 0) {
        trackEvent('work resumed', config.ownerUserId, {
          ...(config.agentId ? { 'agent.id': config.agentId } : {}),
          'work.kind': kind,
          'work.count': String(live.length),
          'work.dropped': String(ofKind.length - live.length),
        });
      }
    }
  }

  private replace(kind: PendingWorkKind, key: string, data: Prisma.PendingWorkUpdateManyMutationInput): void {
    if (this.stopping.signal.aborted) return;
    void this.write(kind, [key], () =>
      prisma.pendingWork.updateMany({ where: { kind, key }, data }),
    ).catch((err) => logger.error({ err, kind, key }, '[PendingWork] Could not update the work'));
  }

  private remove(kind: PendingWorkKind, keys: string | readonly string[]): void {
    for (const key of typeof keys === 'string' ? [keys] : new Set(keys)) {
      void this.write(kind, [key], () =>
        prisma.pendingWork.deleteMany({ where: { kind, key } }),
      ).catch((err) => logger.error({ err, kind, key }, '[PendingWork] Could not end the work'));
    }
  }

  /** Run `run` after the earlier writes to each of `keys`, and before the later ones. */
  private write<T>(kind: PendingWorkKind, keys: readonly string[], run: () => Promise<T>): Promise<T> {
    const ids = keys.map((key) => `${kind}:${key}`);
    const done = Promise.all(ids.map((id) => this.writes.get(id))).then(run);
    const settled = done.then(
      () => undefined,
      () => undefined,
    );
    for (const id of ids) {
      this.writes.set(id, settled);
      void settled.then(() => {
        if (this.writes.get(id) === settled) this.writes.delete(id);
      });
    }
    return done;
  }
}

function toItem(row: PendingWorkItem): PendingWorkItem {
  return { key: row.key, payload: row.payload, attempts: row.attempts, createdAt: row.createdAt };
}

export const pendingWorkService = new PendingWorkService();
