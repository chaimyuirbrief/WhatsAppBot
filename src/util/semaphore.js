/**
 * Counting semaphore for stage-level concurrency.
 *
 * The shared job queue caps how many jobs run at once. When a plugin's job has
 * distinct stages that contend for *different* resources, a queue-wide limit
 * is the wrong tool: it either serializes work that could overlap, or lets two
 * jobs fight over the same resource. A semaphore per stage lets stages from
 * different jobs overlap while still capping each one on its own.
 *
 * Not used by the core - it is here for plugin authors doing staged bulk work.
 */
export class Semaphore {
  constructor(capacity = 1, name = 'sem') {
    this.capacity = Math.max(1, capacity);
    this.name = name;
    this.inUse = 0;
    this.waiters = [];
  }

  get waiting() { return this.waiters.length; }
  get free() { return this.capacity - this.inUse; }

  /** Resolves once a slot is held. Always pair with release() in a finally. */
  acquire() {
    if (this.inUse < this.capacity) {
      this.inUse += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release() {
    const next = this.waiters.shift();
    if (next) {
      // Hand the slot straight to the next waiter; inUse stays the same.
      next();
    } else {
      this.inUse = Math.max(0, this.inUse - 1);
    }
  }

  /** Run fn while holding a slot, releasing even if it throws. */
  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** Resize at runtime when the config changes. */
  setCapacity(n) {
    const target = Math.max(1, n);
    const grew = target - this.capacity;
    this.capacity = target;
    // If we grew, wake as many waiters as new slots allow.
    for (let i = 0; i < grew; i++) {
      if (this.inUse < this.capacity && this.waiters.length) {
        this.inUse += 1;
        this.waiters.shift()();
      }
    }
  }

  stats() {
    return { name: this.name, capacity: this.capacity, inUse: this.inUse, waiting: this.waiters.length };
  }
}
