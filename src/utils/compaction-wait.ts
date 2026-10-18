/**
 * Bounded wait so a missed `session.compacted` event cannot wedge the fallback path.
 */
export async function waitForNativeCompaction(
  isInFlight: () => boolean,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isInFlight()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
