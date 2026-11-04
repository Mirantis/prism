/**
 * Seeded synthetic data and the tasks of the `program.*` scenarios: questions with
 * one right answer that take one tool call, or many calls over a list or pages.
 * All names and ids are invented.
 */

import { tool, type Tool } from 'ai';
import { z } from 'zod';

/** Deterministic data: mulberry32. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOREM =
  'Stocked in the central warehouse. Reorder through the standard procurement flow. ' +
  'Handling notes: keep dry, stack at most four high, inspect on arrival, and record the lot number.';

const rand = random(7);
const CATEGORIES = ['hardware', 'software', 'network', 'storage'];
const ITEMS = Array.from({ length: 60 }, (_, i) => ({
  id: `item-${i + 1}`,
  name: `Part ${String.fromCharCode(65 + (i % 26))}${i + 1}`,
  category: CATEGORIES[i % CATEGORIES.length],
  price: Math.round(rand() * 900 + 100),
  stock: Math.floor(rand() * 50),
  supplier: `Supplier ${1 + (i % 7)}`,
  description: LOREM,
}));

const SERVICES = ['auth', 'billing', 'search', 'checkout', 'catalog', 'email', 'gateway', 'inventory', 'reports', 'uploads'];
const ERRORS = Object.fromEntries(
  SERVICES.map((service) => [service, Array.from({ length: 24 }, () => Math.floor(rand() * 40))]),
);

const FIRST = ['Ada', 'Bo', 'Cy', 'Di', 'Ed', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jo', 'Kai', 'Lu', 'Max', 'Ned', 'Oz', 'Pia', 'Quin', 'Rex', 'Sol', 'Tia'];
const CUSTOMERS = FIRST.map((first, i) => ({ id: `cust-${i + 1}`, name: `${first} Example` }));
const STATUSES = ['delivered', 'shipped', 'cancelled', 'returned'];
const ORDERS = Object.fromEntries(
  CUSTOMERS.map((customer) => [
    customer.id,
    Array.from({ length: 3 + Math.floor(rand() * 6) }, (_, j) => ({
      orderId: `${customer.id}-o${j + 1}`,
      status: STATUSES[Math.floor(rand() * STATUSES.length)],
      amount: Math.round(rand() * 500 + 20),
      placedAt: `2026-0${1 + Math.floor(rand() * 9)}-1${Math.floor(rand() * 9)}`,
      shippingAddress: '1 Example Street, Example City',
    })),
  ]),
);

const SEVERITIES = ['info', 'warning', 'error', 'critical'];
const EVENTS = Array.from({ length: 96 }, (_, i) => ({
  id: `evt-${i + 1}`,
  severity: SEVERITIES[Math.floor(rand() * rand() * SEVERITIES.length)],
  source: SERVICES[Math.floor(rand() * SERVICES.length)],
  message: 'Health check reported a change in the service state.',
}));
const PAGE_SIZE = 12;

/** The data tools, answered from the seeded data. */
export function dataTools(): Record<string, Tool> {
  return {
    list_items: tool({
      description: 'List the ids and names of the inventory items in a category.',
      inputSchema: z.object({ category: z.enum(CATEGORIES as [string, ...string[]]) }),
      execute: async ({ category }) => ITEMS.filter((item) => item.category === category).map(({ id, name }) => ({ id, name })),
    }),
    get_item: tool({
      description: 'Get one inventory item: price per unit, units in stock, supplier and notes.',
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => ITEMS.find((item) => item.id === id) ?? { error: `No item ${id}` },
    }),
    list_services: tool({
      description: 'List the services that report errors.',
      inputSchema: z.object({}),
      execute: async () => SERVICES,
    }),
    get_error_counts: tool({
      description: "Get a service's error count for each of the last 24 hours, oldest first.",
      inputSchema: z.object({ service: z.string() }),
      execute: async ({ service }) => ({ service, unit: 'errors per hour', hours: ERRORS[service] ?? [] }),
    }),
    list_customers: tool({
      description: 'List every customer id and name.',
      inputSchema: z.object({}),
      execute: async () => CUSTOMERS,
    }),
    list_events: tool({
      description: 'List audit events, one page at a time. Pages start at 1; `nextPage` is null on the last page.',
      inputSchema: z.object({ page: z.number().int().min(1) }),
      execute: async ({ page }) => ({
        events: EVENTS.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
        nextPage: page * PAGE_SIZE < EVENTS.length ? page + 1 : null,
      }),
    }),
    get_orders: tool({
      description: "Get a customer's orders with status and amount in USD.",
      inputSchema: z.object({ customerId: z.string() }),
      execute: async ({ customerId }) => ORDERS[customerId] ?? [],
    }),
  };
}

export interface ProgramTask {
  name: string;
  prompt: string;
  /** Strings the final answer has to contain. */
  expect: string[];
  /** Whether the agent should answer with `run_program`: true for a task of many calls. */
  program: boolean;
}

const hardware = ITEMS.filter((item) => item.category === 'hardware');
const stockValue = hardware.reduce((sum, item) => sum + item.price * item.stock, 0);
const errorTotals = SERVICES.map((service) => ({ service, total: ERRORS[service].reduce((a, b) => a + b, 0) }))
  .sort((a, b) => b.total - a.total);
const delivered = CUSTOMERS.map((customer) => ({
  name: customer.name,
  total: ORDERS[customer.id].filter((order) => order.status === 'delivered').reduce((sum, order) => sum + order.amount, 0),
})).sort((a, b) => b.total - a.total);
const item17 = ITEMS[16];
const critical = EVENTS.filter((event) => event.severity === 'critical').length;

export const PROGRAM_TASKS: ProgramTask[] = [
  {
    name: 'single-lookup',
    prompt: `What is the unit price of ${item17.id}? Answer with the number.`,
    expect: [String(item17.price)],
    program: false,
  },
  {
    name: 'error-hotspot',
    prompt: 'Which service had the most errors in total over the last 24 hours, and how many?',
    expect: [errorTotals[0].service, String(errorTotals[0].total)],
    program: true,
  },
  {
    name: 'inventory-value',
    prompt: 'What is the total stock value (unit price × units in stock, summed) of every hardware item? Answer with the number.',
    expect: [String(stockValue)],
    program: true,
  },
  {
    name: 'paged-audit',
    prompt: 'How many audit events have severity critical? Read every page. Answer with the number.',
    expect: [String(critical)],
    program: true,
  },
  {
    name: 'top-customers',
    prompt: 'Which three customers have the highest total amount in delivered orders? Give each name and total.',
    expect: delivered.slice(0, 3).flatMap((entry) => [entry.name, String(entry.total)]),
    program: true,
  },
];
