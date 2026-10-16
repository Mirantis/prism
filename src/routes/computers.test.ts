/**
 * The computers a client adds and the user lists, renames and removes. The database is an
 * in-memory table.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const { rows } = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>() }));

vi.mock('../lib/prisma', () => {
  const taken = async () => {
    const { Prisma } = await import('@prisma/client');
    return new Prisma.PrismaClientKnownRequestError('taken', { code: 'P2002', clientVersion: 'test' });
  };
  const nameTaken = (name: unknown, id?: string) =>
    [...rows.values()].some((row) => row.name === name && row.id !== id);
  return {
    default: {
      remoteComputer: {
        findMany: vi.fn(async () => [...rows.values()]),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (nameTaken(data.name)) throw await taken();
          const row = {
            id: `00000000-0000-4000-8000-00000000000${rows.size + 1}`,
            lastConnectedAt: null,
            lastSeenAt: null,
            clientVersion: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...data,
          };
          rows.set(row.id, row);
          return row;
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          if (data.name !== undefined && nameTaken(data.name, where.id)) throw await taken();
          const row = { ...rows.get(where.id)!, ...data };
          rows.set(where.id, row);
          return row;
        }),
        delete: vi.fn(async ({ where }: { where: { id: string } }) => rows.delete(where.id)),
      },
      conversationMessage: { findMany: vi.fn(async () => []) },
    },
  };
});
vi.mock('../lib/telemetry', () => ({ trackEvent: vi.fn() }));
vi.mock('../logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { config } = await import('../config');
const { default: prisma } = await import('../lib/prisma');
const { remoteComputerService } = await import('../services/computer/remote/remote-computer.service');
const { computersRouter } = await import('./computers');

const INSTALLATION = '9b2f0c1e-0000-4000-8000-000000000001';

const app = express();
app.use(express.json());
app.use('/agents', computersRouter);

beforeAll(async () => {
  Object.assign(config, { agentId: 'agent-1', ownerUserId: 'user-1' });
});

beforeEach(async () => {
  rows.clear();
  await remoteComputerService.load('agent-1');
});

describe('adding a computer', () => {
  it('adds one, which is not connected until its client links', async () => {
    const res = await request(app).post('/agents/computers').send({ name: 'Work laptop', platform: 'macos' });
    expect(res.status).toBe(201);
    expect(res.body.computer).toMatchObject({
      kind: 'remote',
      name: 'Work laptop',
      connection: 'disconnected',
      platform: 'macos',
      lastConnectedAt: null,
    });
    const list = await request(app).get('/agents/computers');
    expect(list.body.computers.map((item: { name: string }) => item.name)).toEqual(['Work laptop']);
  });

  it('finds the computer an installation added before, renamed to the name it gives now', async () => {
    const first = await request(app)
      .post('/agents/computers')
      .send({ name: 'MacBook Pro', installationId: INSTALLATION });
    const again = await request(app)
      .post('/agents/computers')
      .send({ name: 'Work laptop', installationId: INSTALLATION });
    expect(again.status).toBe(200);
    expect(again.body.computer).toMatchObject({ id: first.body.computer.id, name: 'Work laptop' });
    expect(remoteComputerService.count).toBe(1);
  });

  it('refuses a name another computer has', async () => {
    await request(app).post('/agents/computers').send({ name: 'MacBook Pro', installationId: INSTALLATION });
    const res = await request(app).post('/agents/computers').send({ name: 'MacBook Pro' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('A computer named "MacBook Pro" already exists.');
  });

  it('refuses a name that differs from another only in case', async () => {
    await request(app).post('/agents/computers').send({ name: 'Laptop' });
    expect((await request(app).post('/agents/computers').send({ name: 'laptop' })).status).toBe(409);
    const { body } = await request(app).post('/agents/computers').send({ name: 'Desktop' });
    expect((await request(app).patch(`/agents/computers/${body.computer.id}`).send({ name: 'LAPTOP' })).status).toBe(409);
  });

  it('adds only one of two names that differ in case and arrive together', async () => {
    const answers = await Promise.all([
      request(app).post('/agents/computers').send({ name: 'Laptop' }),
      request(app).post('/agents/computers').send({ name: 'laptop' }),
    ]);
    expect(answers.map((res) => res.status).sort()).toEqual([201, 409]);
    expect(remoteComputerService.count).toBe(1);
  });

  it("refuses the name the runtime's own computer goes by", async () => {
    const res = await request(app).post('/agents/computers').send({ name: 'Local' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(`"Local" is the name of the runtime's own computer.`);
  });

  it('refuses a blank name', async () => {
    const res = await request(app).post('/agents/computers').send({ name: '   ' });
    expect(res.status).toBe(400);
  });
});

describe('renaming and removing a computer', () => {
  it('renames one', async () => {
    const { body } = await request(app).post('/agents/computers').send({ name: 'MacBook Pro' });
    const res = await request(app).patch(`/agents/computers/${body.computer.id}`).send({ name: 'Work laptop' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Work laptop');
  });

  it('removes one, and answers 404 for it after', async () => {
    const { body } = await request(app).post('/agents/computers').send({ name: 'MacBook Pro' });
    expect((await request(app).delete(`/agents/computers/${body.computer.id}`)).status).toBe(204);
    expect((await request(app).delete(`/agents/computers/${body.computer.id}`)).status).toBe(404);
    expect((await request(app).get(`/agents/computers/${body.computer.id}`)).status).toBe(404);
    expect((await request(app).get('/agents/computers')).body.computers).toEqual([]);
  });

  it("refuses a takeover that names another computer's help request", async () => {
    const { body } = await request(app).post('/agents/computers').send({ name: 'Work laptop' });
    const helpId = '00000000-0000-4000-8000-0000000000aa';
    vi.mocked(prisma.conversationMessage.findMany).mockResolvedValueOnce([
      { blocks: [{ type: 'computer_help', id: helpId, reason: 'Sign in', status: 'waiting', computerId: body.computer.id }] },
    ] as never);
    const res = await request(app)
      .post('/agents/computers/local/control')
      .send({ clientId: '00000000-0000-4000-8000-0000000000bb', helpId });
    expect(res.status).toBe(404);
  });

  it("answers the shipped desktop app's paths for the runtime's own computer", async () => {
    const status = await request(app).get('/agents/computer');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ computerId: 'local', help: [], awaitingHelp: [] });
    expect((await request(app).post('/agents/computer/stop')).status).toBe(200);
    expect((await request(app).post('/agents/computer/continue').send({})).status).toBe(400);
  });

  it("keeps the runtime's own computer", async () => {
    expect((await request(app).delete('/agents/computers/local')).status).toBe(409);
    expect((await request(app).patch('/agents/computers/local').send({ name: 'x' })).status).toBe(409);
  });
});
