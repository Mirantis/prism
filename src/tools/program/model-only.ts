/**
 * Marks a tool whose result only a model can read, such as an image, so that
 * `run_program` leaves it off `tools`. The mark is an own enumerable property, so
 * it survives the wrappers that spread a tool (`...tool`).
 */

import type { Tool } from 'ai';

const MODEL_ONLY_OUTPUT = Symbol('modelOnlyOutput');

export function withModelOnlyOutput<T extends Tool>(tool: T): T {
  return Object.assign(tool, { [MODEL_ONLY_OUTPUT]: true });
}

export function hasModelOnlyOutput(tool: Tool): boolean {
  return (tool as Tool & { [MODEL_ONLY_OUTPUT]?: boolean })[MODEL_ONLY_OUTPUT] === true;
}
