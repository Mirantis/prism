/**
 * Runs a model-written JavaScript program in QuickJS compiled to WebAssembly.
 *
 * The program sees a fresh global scope with `tools`, `console` and the language
 * built-ins, and nothing of the host: no `require`, no filesystem, no network, no
 * timers. Every value crosses the boundary as JSON, so the program never holds a
 * host object. The only way out of the interpreter is `callTool`, which the caller
 * supplies.
 *
 * The interpreter runs on the host's thread, so no timer, socket or other turn runs
 * while it computes. A slice of interpreter time is therefore short, the run yields
 * to the event loop before each resume, and the interpreter time of the whole run has
 * a budget. Time spent waiting on a tool is bounded by the wall deadline.
 *
 * Each run gets its own WebAssembly module, with capped memory: QuickJS's allocator
 * limit does not bound everything the module allocates, a module's memory never
 * shrinks, and a module that aborted is unusable. A new module takes about 2 ms.
 */

import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle } from 'quickjs-emscripten-core';
import releaseSyncVariant from '@jitl/quickjs-singlefile-cjs-release-sync';
import { logger } from '../../logger';

const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
/** The module's whole WebAssembly memory, in 64 KiB pages: 16 MB to start, 128 MB at most. */
const WASM_INITIAL_PAGES = 256;
const WASM_MAXIMUM_PAGES = 2048;
/** Below the host's own stack, so that deep recursion mostly ends in QuickJS's error. */
const MAX_STACK_BYTES = 256 * 1024;
/** Printed text kept in memory. The tool-output limit cuts what the model reads. */
export const MAX_PRINTED_CHARS = 1_000_000;

export interface SandboxLimits {
  /** Wall time for the whole run, tool calls included. */
  timeoutMs: number;
  maxToolCalls: number;
  /** Tool calls in flight at once. */
  maxConcurrentCalls: number;
  /** Interpreter time in one go. The host's event loop waits for this long at most. */
  sliceMs: number;
  /** Interpreter time for the whole run, all slices together. */
  cpuBudgetMs: number;
}

export interface SandboxInput {
  code: string;
  toolNames: readonly string[];
  /** Resolves with the tool's result, or rejects with an Error the program sees. */
  callTool: (name: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
  limits: SandboxLimits;
  abortSignal?: AbortSignal;
}

export type SandboxStatus = 'ok' | 'error' | 'timeout' | 'call_limit' | 'canceled';

export interface SandboxResult {
  status: SandboxStatus;
  /** Lines the program printed, in order. */
  printed: string;
  /** The program printed more than {@link MAX_PRINTED_CHARS}; `printed` holds the start. */
  printedCut: boolean;
  /** The program's return value as JSON, when it returned one. */
  returned?: string;
  /** The uncaught error or the limit that stopped the run. */
  error?: string;
  toolCalls: number;
}

// The TypeScript libs here have no WebAssembly types; Node has the global.
const { WebAssembly: wasm } = globalThis as unknown as {
  WebAssembly: { Memory: new (descriptor: { initial: number; maximum: number }) => unknown };
};

function newModule() {
  return newQuickJSWASMModuleFromVariant(
    newVariant(releaseSyncVariant, {
      wasmMemory: new wasm.Memory({ initial: WASM_INITIAL_PAGES, maximum: WASM_MAXIMUM_PAGES }),
    }),
  );
}

/**
 * The scaffolding the program runs inside. `__call` and `__print` are deleted from
 * the global scope before the program starts, so the program reaches them only
 * through `tools` and `console`.
 */
const PRELUDE = `
(() => {
  const call = globalThis.__call;
  const print = globalThis.__print;
  delete globalThis.__call;
  delete globalThis.__print;
  const format = (value) => typeof value === 'string' ? value : (() => {
    try { const json = JSON.stringify(value); return json === undefined ? String(value) : json; }
    catch { return String(value); }
  })();
  const log = (...values) => print(values.map(format).join(' '));
  globalThis.console = Object.freeze({ log, info: log, warn: log, error: log, debug: log });
  const names = JSON.parse(globalThis.__toolNames);
  delete globalThis.__toolNames;
  const tools = {};
  for (const name of names) {
    tools[name] = async (input = {}) => {
      const reply = JSON.parse(await call(name, JSON.stringify(input)));
      if ('error' in reply) throw new Error(reply.error);
      return reply.value;
    };
  }
  globalThis.tools = new Proxy(Object.freeze(tools), {
    get(target, name) {
      if (typeof name === 'string' && !(name in target)) {
        throw new Error('No tool named ' + name + '. Available: ' + names.join(', '));
      }
      return target[name];
    },
  });
})();
`;

export async function runInSandbox(input: SandboxInput): Promise<SandboxResult> {
  const canceled = (): SandboxResult => ({ status: 'canceled', printed: '', printedCut: false, error: CANCELED, toolCalls: 0 });
  if (input.abortSignal?.aborted) return canceled();
  const module = await newModule();
  if (input.abortSignal?.aborted) return canceled();
  const wallDeadline = Date.now() + input.limits.timeoutMs;
  const wallExceeded = `The program ran longer than ${Math.round(input.limits.timeoutMs / 1000)} seconds.`;
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(MAX_STACK_BYTES);
  // The interrupt reaches the program as an exception it may not get to see: inside
  // a promise job it can turn into a rejection, or into nothing at all. The handler
  // keeps the limit it hit, and every slice checks it afterwards.
  let sliceDeadline = 0;
  let sliceLimit = SLICE_EXCEEDED;
  let cpuSpent = 0;
  let interrupted: { status: SandboxStatus; reason: string } | undefined;
  runtime.setInterruptHandler(() => {
    const now = Date.now();
    if (now > wallDeadline) interrupted ??= { status: 'timeout', reason: wallExceeded };
    else if (now > sliceDeadline) interrupted ??= { status: 'timeout', reason: sliceLimit };
    return interrupted !== undefined;
  });
  const vm = runtime.newContext();

  const stop = new AbortController();
  let printed = '';
  let printedFull = false;
  let toolCalls = 0;
  let inFlight = 0;
  const waiting: Array<() => void> = [];
  let stoppedBy: SandboxStatus | undefined;
  let stopReason: string | undefined;
  const halt = (status: SandboxStatus, reason: string): void => {
    if (stoppedBy) return;
    stoppedBy = status;
    stopReason = reason;
    stop.abort();
  };
  const onAbort = (): void => halt('canceled', CANCELED);
  input.abortSignal?.addEventListener('abort', onAbort, { once: true });

  // A tool call can outlive the run when the run stops. Its promise is disposed
  // with the interpreter, and its late reply is dropped.
  const unsettled = new Set<QuickJSDeferredPromise>();
  let disposed = false;
  /**
   * Runs one slice, then halts the run if the slice hit a limit. The host can throw
   * from inside the interpreter too: deep recursion can run out of the host's stack
   * before QuickJS's own stack limit. That halts the run instead of escaping, since
   * a slice that resumes after a tool reply runs from a bare event-loop callback.
   */
  const enter = <T>(fn: () => T): T | undefined => {
    const startedAt = Date.now();
    const cpuLeft = Math.max(0, input.limits.cpuBudgetMs - cpuSpent);
    sliceLimit = cpuLeft < input.limits.sliceMs ? CPU_EXCEEDED : SLICE_EXCEEDED;
    sliceDeadline = startedAt + Math.min(input.limits.sliceMs, cpuLeft);
    try {
      return fn();
    } catch (err) {
      halt('error', err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      return undefined;
    } finally {
      cpuSpent += Date.now() - startedAt;
      if (interrupted) halt(interrupted.status, interrupted.reason);
    }
  };

  const define = (name: string, handle: QuickJSHandle): void => {
    vm.setProp(vm.global, name, handle);
    handle.dispose();
  };

  define('__print', vm.newFunction('__print', (line) => {
    if (printedFull) return;
    const text = vm.getString(line) + '\n';
    if (printed.length + text.length > MAX_PRINTED_CHARS) {
      printed += text.slice(0, MAX_PRINTED_CHARS - printed.length);
      printedFull = true;
      return;
    }
    printed += text;
  }));

  define('__toolNames', vm.newString(JSON.stringify(input.toolNames)));

  define('__call', vm.newFunction('__call', (nameHandle, inputHandle) => {
    const name = vm.getString(nameHandle);
    const json = vm.getString(inputHandle);
    const deferred = vm.newPromise();
    unsettled.add(deferred);
    toolCalls++;
    if (toolCalls > input.limits.maxToolCalls) {
      halt('call_limit', `The program made more than ${input.limits.maxToolCalls} tool calls.`);
    }
    if (Date.now() > wallDeadline) halt('timeout', wallExceeded);
    const run = async (): Promise<string> => {
      if (inFlight >= input.limits.maxConcurrentCalls) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      if (stop.signal.aborted) {
        waiting.shift()?.();
        return JSON.stringify({ error: 'The program was stopped.' });
      }
      inFlight++;
      try {
        const value = await input.callTool(name, JSON.parse(json), stop.signal);
        return JSON.stringify({ value: value ?? null });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      } finally {
        inFlight--;
        waiting.shift()?.();
      }
    };
    // Resume on a later turn of the event loop, never from a microtask: a tool that
    // answers at once would otherwise resume the program again and again with no
    // timer or socket getting a turn in between.
    void run().then((reply) => setImmediate(() => {
      if (disposed) return;
      unsettled.delete(deferred);
      const handle = vm.newString(reply);
      deferred.resolve(handle);
      handle.dispose();
      deferred.dispose();
      drainJobs();
    }));
    return deferred.handle;
  }));

  const drainJobs = (): void => {
    if (stoppedBy) return;
    if (Date.now() > wallDeadline) {
      halt('timeout', wallExceeded);
      return;
    }
    const result = enter(() => runtime.executePendingJobs());
    if (result?.error) {
      const message = errorText(vm, result.error);
      result.error.dispose();
      halt(statusOf(message), message);
    }
  };

  const timer = setTimeout(() => halt('timeout', wallExceeded), input.limits.timeoutMs);

  try {
    const prelude = enter(() => vm.evalCode(PRELUDE, 'prelude.js'));
    if (prelude) vm.unwrapResult(prelude).dispose();

    const evaluated = stoppedBy ? undefined : enter(() => vm.evalCode(`(async () => {\n${input.code}\n})()`, 'program.js'));
    if (!evaluated) return { status: stoppedBy ?? 'error', printed, printedCut: printedFull, error: stopReason, toolCalls };
    if (evaluated.error) {
      const message = stopReason ?? errorText(vm, evaluated.error);
      evaluated.error.dispose();
      return { status: stoppedBy ?? statusOf(message), printed, printedCut: printedFull, error: message, toolCalls };
    }
    const promiseHandle = evaluated.value;
    const outcome = vm.resolvePromise(promiseHandle);
    promiseHandle.dispose();
    drainJobs();

    const stopped = new Promise<'stopped'>((resolve) => {
      if (stop.signal.aborted) resolve('stopped');
      stop.signal.addEventListener('abort', () => resolve('stopped'), { once: true });
    });
    const settled = await Promise.race([outcome, stopped]);

    // A limit wins over what the program settled with: an interrupt can reject the
    // program's promise with an error that says nothing about the limit.
    if (settled === 'stopped' || stoppedBy) {
      if (settled !== 'stopped') settled.dispose();
      return { status: stoppedBy ?? 'canceled', printed, printedCut: printedFull, error: stopReason, toolCalls };
    }
    if (settled.error) {
      const message = errorText(vm, settled.error);
      settled.error.dispose();
      return { status: statusOf(message), printed, printedCut: printedFull, error: message, toolCalls };
    }
    const returned = vm.dump(settled.value) as unknown;
    settled.value.dispose();
    return {
      status: 'ok',
      printed,
      printedCut: printedFull,
      ...(returned === undefined ? {} : { returned: safeJson(returned) }),
      toolCalls,
    };
  } finally {
    clearTimeout(timer);
    input.abortSignal?.removeEventListener('abort', onAbort);
    stop.abort();
    disposed = true;
    // QuickJS asserts on freeing a runtime after an out-of-memory error, a stack
    // overflow or a very large value. The module is this run's alone and is dropped
    // here, so the failure only gets logged; it must not replace the result.
    try {
      for (const deferred of unsettled) deferred.dispose();
      vm.dispose();
      runtime.dispose();
    } catch (err) {
      logger.warn({ err }, '[run_program] could not free the QuickJS runtime');
    }
  }
}

const SLICE_EXCEEDED = 'The program computed too long without waiting on a tool.';
const CPU_EXCEEDED = 'The program computed too long in total.';
const CANCELED = 'The turn was canceled.';

function statusOf(message: string): SandboxStatus {
  return message === SLICE_EXCEEDED ? 'timeout' : 'error';
}

function errorText(vm: QuickJSContext, handle: QuickJSHandle): string {
  const dumped = vm.dump(handle) as unknown;
  if (dumped && typeof dumped === 'object' && 'message' in dumped) {
    const { name, message } = dumped as { name?: unknown; message?: unknown };
    // QuickJS reports a stop by the interrupt handler this way.
    if (name === 'InternalError' && message === 'interrupted') return SLICE_EXCEEDED;
    return `${typeof name === 'string' ? name : 'Error'}: ${String(message)}`;
  }
  return String(dumped);
}

function safeJson(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
