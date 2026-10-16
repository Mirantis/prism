/**
 * The remote computers the agent has: the `remote_computers` rows, kept in memory too,
 * since the tools and the prompt ask whether any exist on every turn.
 */

import { Prisma, type RemoteComputer as RemoteComputerRow } from '@prisma/client';
import prisma from '../../../lib/prisma';
import { trackEvent } from '../../../lib/telemetry';
import type { RemotePlatform } from './link-protocol';

/** Another computer of this agent already has the name. */
export class ComputerNameTakenError extends Error {
  constructor(name: string, message = `A computer named "${name}" already exists.`) {
    super(message);
    this.name = 'ComputerNameTakenError';
  }
}

/** The name, and id, the runtime's own computer goes by when a tool call names it. */
const RESERVED_NAME = 'local';

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

class RemoteComputerService {
  private rows = new Map<string, RemoteComputerRow>();
  private agentId: string | null = null;
  private writes: Promise<unknown> = Promise.resolve();

  async load(agentId: string): Promise<void> {
    const rows = await prisma.remoteComputer.findMany({ where: { agentId }, orderBy: { createdAt: 'asc' } });
    this.agentId = agentId;
    this.rows = new Map(rows.map((row) => [row.id, row]));
  }

  /** Oldest first, the order the list and the prompt show them in. */
  list(): RemoteComputerRow[] {
    return [...this.rows.values()];
  }

  get(id: string): RemoteComputerRow | undefined {
    return this.rows.get(id);
  }

  get count(): number {
    return this.rows.size;
  }

  /**
   * Add a computer, or find the one an installation added before. `created` is false for
   * the second case, where a changed name renames it.
   */
  add(
    input: { name: string; platform?: RemotePlatform; installationId?: string },
    userId: string,
  ): Promise<{ computer: RemoteComputerRow; created: boolean }> {
    return this.serial(() => this.addNow(input, userId));
  }

  rename(id: string, name: string): Promise<RemoteComputerRow> {
    return this.serial(() => this.renameNow(id, name));
  }

  /** False when there was no such computer. */
  remove(id: string, userId: string): Promise<boolean> {
    return this.serial(() => this.removeNow(id, userId));
  }

  /**
   * One write at a time, in arrival order. The name check reads the cache, so a check
   * sees every write before it only when the write before it has finished.
   */
  private serial<T>(write: () => Promise<T>): Promise<T> {
    const run = this.writes.then(write);
    this.writes = run.catch(() => {});
    return run;
  }

  private async addNow(
    input: { name: string; platform?: RemotePlatform; installationId?: string },
    userId: string,
  ): Promise<{ computer: RemoteComputerRow; created: boolean }> {
    const agentId = this.requireAgent();
    const existing = input.installationId
      ? this.list().find((row) => row.installationId === input.installationId)
      : undefined;
    if (existing) {
      const computer = existing.name === input.name ? existing : await this.renameNow(existing.id, input.name);
      return { computer, created: false };
    }
    this.assertNameFree(input.name);
    let computer: RemoteComputerRow;
    try {
      computer = await prisma.remoteComputer.create({
        data: {
          agentId,
          name: input.name,
          platform: input.platform ?? null,
          installationId: input.installationId ?? null,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ComputerNameTakenError(input.name);
      throw error;
    }
    this.rows.set(computer.id, computer);
    trackEvent('computer added', userId, {
      'agent.id': agentId,
      'computer.id': computer.id,
      ...(computer.platform ? { platform: computer.platform } : {}),
    });
    return { computer, created: true };
  }

  private async renameNow(id: string, name: string): Promise<RemoteComputerRow> {
    this.assertNameFree(name, id);
    try {
      return this.cache(await prisma.remoteComputer.update({ where: { id }, data: { name } }));
    } catch (error) {
      if (isUniqueViolation(error)) throw new ComputerNameTakenError(name);
      throw error;
    }
  }

  private async removeNow(id: string, userId: string): Promise<boolean> {
    if (!this.rows.has(id)) return false;
    await prisma.remoteComputer.delete({ where: { id } });
    this.rows.delete(id);
    trackEvent('computer removed', userId, { 'agent.id': this.requireAgent(), 'computer.id': id });
    return true;
  }

  async recordConnected(id: string, info: { platform: RemotePlatform; clientVersion: string }): Promise<void> {
    if (!this.rows.has(id)) return;
    const now = new Date();
    this.cache(
      await prisma.remoteComputer.update({
        where: { id },
        data: { ...info, lastConnectedAt: now, lastSeenAt: now },
      }),
    );
  }

  async recordSeen(id: string): Promise<void> {
    if (!this.rows.has(id)) return;
    this.cache(await prisma.remoteComputer.update({ where: { id }, data: { lastSeenAt: new Date() } }));
  }

  /**
   * The agent picks a computer by name without case, so two names that differ only in
   * case would leave one of them unreachable. The table's index compares with case.
   */
  private assertNameFree(name: string, id?: string): void {
    const wanted = name.toLowerCase();
    if (wanted === RESERVED_NAME) {
      throw new ComputerNameTakenError(name, `"${name}" is the name of the runtime's own computer.`);
    }
    if (this.list().some((row) => row.id !== id && row.name.toLowerCase() === wanted)) {
      throw new ComputerNameTakenError(name);
    }
  }

  private cache(row: RemoteComputerRow): RemoteComputerRow {
    this.rows.set(row.id, row);
    return row;
  }

  private requireAgent(): string {
    if (!this.agentId) throw new Error('Remote computers are not loaded.');
    return this.agentId;
  }
}

export const remoteComputerService = new RemoteComputerService();
