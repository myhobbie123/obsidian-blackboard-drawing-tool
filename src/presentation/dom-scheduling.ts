/**
 * Small scheduling helpers shared by the DOM-observing parts of the presentation layer.
 * Both exist because Obsidian fires the events we listen to far more often than there is
 * work to do: CodeMirror rewrites its DOM on every keystroke (many MutationObserver
 * callbacks per frame) and `layout-change` fires in bursts.
 */

/**
 * Wrap `fn` so that no matter how many times it is called within one animation frame it runs
 * exactly once, at the end of that frame. Returns the wrapper plus a `cancel` used at teardown.
 */
export function rafCoalesce(fn: () => void, win: Window = window): (() => void) & { cancel(): void } {
  let handle = 0;
  const run = (() => {
    if (handle !== 0) return;
    handle = win.requestAnimationFrame(() => {
      handle = 0;
      fn();
    });
  }) as (() => void) & { cancel(): void };
  run.cancel = () => {
    if (handle !== 0) {
      win.cancelAnimationFrame(handle);
      handle = 0;
    }
  };
  return run;
}

export interface BoundedRetryOptions {
  /** Delay between attempts, in ms. */
  intervalMs?: number;
  /** Hard cap on attempts; the retry always stops, even if the task never succeeds. */
  maxAttempts?: number;
  win?: Window;
}

/**
 * Run `task` on ONE interval until it reports success or the attempt budget runs out.
 *
 * Replaces the previous "fire setTimeout at 200ms, 500ms and 1000ms and hope one of them
 * catches the node" pattern, which ran a full canvas sweep three times regardless of whether
 * the first attempt already worked. The first attempt is deliberately deferred by one
 * interval — every caller is waiting for DOM that provably does not exist yet. `task` returns
 * true once it has done its job. The returned function cancels the retry (call it at teardown).
 */
export function boundedRetry(task: () => boolean, opts: BoundedRetryOptions = {}): () => void {
  const intervalMs = opts.intervalMs ?? 200;
  const maxAttempts = opts.maxAttempts ?? 5;
  const win = opts.win ?? window;

  let attempts = 0;
  const timer = win.setInterval(() => {
    attempts++;
    if (task() || attempts >= maxAttempts) win.clearInterval(timer);
  }, intervalMs);

  return () => win.clearInterval(timer);
}
