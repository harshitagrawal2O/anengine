// Node's setTimeout takes a 32-bit delay: anything above 2^31-1 ms (~24.8 days)
// overflows and the callback fires almost immediately. safeSetTimeout re-arms in
// <=24-day chunks so long-horizon timers (e.g. a recovered multi-week reminder)
// fire at the correct wall-clock time instead of instantly.

const MAX_DELAY = 2 ** 31 - 1;

export type CancelHandle = { cancel: () => void };

export function safeSetTimeout(
  fn: () => void,
  delayMs: number,
  opts: { unref?: boolean } = {},
): CancelHandle {
  let handle: ReturnType<typeof setTimeout>;
  let cancelled = false;

  const arm = (remaining: number): void => {
    const chunk = Math.min(remaining, MAX_DELAY);
    handle = setTimeout(() => {
      if (cancelled) return;
      const left = remaining - chunk;
      if (left > 0) arm(left);
      else fn();
    }, Math.max(0, chunk));
    if (opts.unref) handle.unref?.();
  };

  arm(Math.max(0, delayMs));
  return {
    cancel: () => {
      cancelled = true;
      clearTimeout(handle);
    },
  };
}
