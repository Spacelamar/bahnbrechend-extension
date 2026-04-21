/**
 * Request throttle with human-like timing jitter.
 *
 * Base interval + random variance to avoid mechanical patterns
 * that could be detected as bot traffic.
 */
export function createThrottle(minIntervalMs: number) {
  let lastCall = 0;

  /** Add human-like jitter to the delay. */
  function jitteredDelay(baseMs: number): number {
    // ±500ms random variance around the base
    const jitter = (Math.random() - 0.5) * 1000;
    // 5% chance of an extra 2-5s pause (simulates human "thinking")
    const extraPause = Math.random() < 0.05 ? 2000 + Math.random() * 3000 : 0;
    return Math.max(500, baseMs + jitter + extraPause);
  }

  return async function throttle<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const elapsed = now - lastCall;
    const targetDelay = jitteredDelay(minIntervalMs);
    if (elapsed < targetDelay) {
      await new Promise((r) => setTimeout(r, targetDelay - elapsed));
    }
    lastCall = Date.now();
    return fn();
  };
}
