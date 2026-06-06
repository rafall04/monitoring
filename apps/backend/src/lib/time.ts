/** Parse a short duration like "15m", "30d", "12h", "45s" into seconds. */
export function durationToSeconds(input: string): number {
  const m = /^(\d+)\s*([smhd])$/.exec(input.trim());
  if (!m) {
    const n = Number(input);
    if (Number.isFinite(n)) return n;
    throw new Error(`Invalid duration: ${input}`);
  }
  const value = Number(m[1]);
  const unit = m[2] as 's' | 'm' | 'h' | 'd';
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[unit];
  return value * mult;
}
