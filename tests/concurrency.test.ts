import { describe, expect, it } from 'vitest';
import { createLimiter } from '../lib/concurrency';

/** A promise whose resolution the test controls. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Give every already-runnable continuation a chance before asserting. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('createLimiter', () => {
  it('never runs more tasks at once than the limit allows', async () => {
    const gate = createLimiter(2);
    const gates = [deferred(), deferred(), deferred(), deferred(), deferred()];
    let active = 0;
    let peak = 0;

    const runs = gates.map((g) =>
      gate(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await g.promise;
        active -= 1;
      }),
    );

    await settle();
    expect(peak).toBe(2);

    // Release one at a time; the gate must stay at its limit, not burst.
    for (const g of gates) {
      g.resolve();
      await settle();
      expect(peak).toBe(2);
    }

    await Promise.all(runs);
    expect(active).toBe(0);
  });

  it('starts a queued task as soon as a slot frees up', async () => {
    const gate = createLimiter(1);
    const first = deferred();
    const started: string[] = [];

    const a = gate(async () => {
      started.push('a');
      await first.promise;
    });
    const b = gate(async () => {
      started.push('b');
    });

    await settle();
    expect(started).toEqual(['a']);

    first.resolve();
    await Promise.all([a, b]);
    expect(started).toEqual(['a', 'b']);
  });

  it('wakes queued tasks in the order they arrived', async () => {
    const gate = createLimiter(1);
    const first = deferred();
    const order: number[] = [];

    const runs = [
      gate(async () => {
        order.push(0);
        await first.promise;
      }),
      ...[1, 2, 3].map((n) =>
        gate(async () => {
          order.push(n);
        }),
      ),
    ];

    await settle();
    first.resolve();
    await Promise.all(runs);

    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('gives the slot back when a task throws, instead of closing the gate', async () => {
    const gate = createLimiter(1);
    let ran = false;

    await expect(
      gate(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await gate(async () => {
      ran = true;
    });

    expect(ran).toBe(true);
  });

  it('returns each task’s own value to its own caller', async () => {
    const gate = createLimiter(2);
    const values = await Promise.all([1, 2, 3, 4].map((n) => gate(async () => n * 10)));
    expect(values).toEqual([10, 20, 30, 40]);
  });

  it('refuses a limit that would let nothing run', () => {
    expect(() => createLimiter(0)).toThrow(RangeError);
    expect(() => createLimiter(-1)).toThrow(RangeError);
    expect(() => createLimiter(1.5)).toThrow(RangeError);
  });
});
