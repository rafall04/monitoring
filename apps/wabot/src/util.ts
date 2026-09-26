// =============================================================================
// Shared tiny helpers for the bot. `withTimeout` exists because the worst bot
// failure mode is a SILENT STALL: a hung WA socket or a half-dead MikroTik
// API leaves the user staring at read-ticks with no reply and no log line.
// Every external wait that gates a reply gets a bound — a timeout turns into
// an honest "sedang lambat" card + a warn log instead of silence.
// =============================================================================

/** Rejects with `${label} timeout after ${ms}ms` when `p` outlives the budget. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    // Never let a stray timer hold the process open.
    t.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}
