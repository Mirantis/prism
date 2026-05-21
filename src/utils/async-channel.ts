/**
 * AsyncChannel — bridge between push-based callbacks and pull-based async iteration.
 *
 * Producer calls push(value) / close() / error(). Consumer reads via `for await...of`.
 * Single-consumer only — concurrent iterators will interfere with each other.
 */
export class AsyncChannel<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolve: ((done: boolean) => void) | null = null;
  private done = false;
  private err: Error | null = null;

  push(value: T): void {
    if (this.done) return;
    this.queue.push(value);
    if (this.resolve) {
      this.resolve(false);
      this.resolve = null;
    }
  }

  close(): void {
    this.done = true;
    if (this.resolve) {
      this.resolve(true);
      this.resolve = null;
    }
  }

  error(err: Error): void {
    this.err = err;
    this.done = true;
    if (this.resolve) {
      this.resolve(true);
      this.resolve = null;
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) {
        if (this.err) throw this.err;
        return;
      }
      await new Promise<boolean>((resolve) => {
        this.resolve = resolve;
      });
    }
  }
}
