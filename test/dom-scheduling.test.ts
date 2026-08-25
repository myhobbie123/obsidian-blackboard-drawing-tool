import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { boundedRetry, rafCoalesce } from '../src/presentation/dom-scheduling';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function fakeWin() {
  let next = 1;
  const queued = new Map<number, () => void>();
  return {
    requestAnimationFrame: (cb: () => void) => { const id = next++; queued.set(id, cb); return id; },
    cancelAnimationFrame: (id: number) => { queued.delete(id); },
    flush() { const cbs = [...queued.values()]; queued.clear(); for (const cb of cbs) cb(); },
    get pending() { return queued.size; },
  } as unknown as Window & { flush(): void; pending: number };
}

describe('rafCoalesce', () => {
  it('runs once per frame no matter how many times it is called', () => {
    const win = fakeWin();
    const fn = vi.fn();
    const run = rafCoalesce(fn, win);
    for (let i = 0; i < 50; i++) run();
    expect(fn).not.toHaveBeenCalled();
    win.flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs again in the next frame', () => {
    const win = fakeWin();
    const fn = vi.fn();
    const run = rafCoalesce(fn, win);
    run(); win.flush();
    run(); win.flush();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('cancel drops a pending frame (teardown must not fire into a dead observer)', () => {
    const win = fakeWin();
    const fn = vi.fn();
    const run = rafCoalesce(fn, win);
    run();
    run.cancel();
    win.flush();
    expect(fn).not.toHaveBeenCalled();
    expect(win.pending).toBe(0);
  });
});

describe('boundedRetry', () => {
  it('stops at the first success', () => {
    const task = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    boundedRetry(task, { intervalMs: 100, maxAttempts: 5 });
    vi.advanceTimersByTime(1000);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('gives up after the attempt cap even if the task never succeeds', () => {
    const task = vi.fn().mockReturnValue(false);
    boundedRetry(task, { intervalMs: 100, maxAttempts: 4 });
    vi.advanceTimersByTime(10_000);
    expect(task).toHaveBeenCalledTimes(4);
  });

  it('uses one timer, not one per attempt', () => {
    const setInterval = vi.spyOn(globalThis, 'setInterval');
    const setTimeout = vi.spyOn(globalThis, 'setTimeout');
    boundedRetry(() => false, { intervalMs: 50, maxAttempts: 3 });
    vi.advanceTimersByTime(1000);
    expect(setInterval).toHaveBeenCalledTimes(1);
    expect(setTimeout).not.toHaveBeenCalled();
    setInterval.mockRestore();
    setTimeout.mockRestore();
  });

  it('the returned canceller stops further attempts', () => {
    const task = vi.fn().mockReturnValue(false);
    const cancel = boundedRetry(task, { intervalMs: 100, maxAttempts: 10 });
    vi.advanceTimersByTime(250);
    const seen = task.mock.calls.length;
    cancel();
    vi.advanceTimersByTime(5000);
    expect(task).toHaveBeenCalledTimes(seen);
  });

  it('defers the first attempt (the DOM it waits for does not exist yet)', () => {
    const task = vi.fn().mockReturnValue(true);
    boundedRetry(task, { intervalMs: 100 });
    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(task).toHaveBeenCalledTimes(1);
  });
});
