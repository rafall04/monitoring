// =============================================================================
// Message formatting helpers — one consistent visual language for every reply.
// WhatsApp renders *bold*, _italic_, ```mono``` — we lean on those + a short
// divider that survives narrow phone screens.
// =============================================================================

export const DIV = '─'.repeat(18);

/** Standard card: bold title + divider + body lines + hint footer. */
export function card(title: string, body: string | string[], hint?: string): string {
  const lines = Array.isArray(body) ? body : [body];
  return [
    title,
    DIV,
    ...lines,
    ...(hint ? [DIV, `_${hint}_`] : []),
  ].join('\n');
}

/** Bot header used for menus. */
export const BOT_TITLE = '🤖 *NOC BOT — RAF*';

/** Consistent command bullet. */
export const cmd = (name: string, desc: string) => `• *${name}* — ${desc}`;

/**
 * Aligned "Label : value" row. `kvBlock` pads every label in one card to the
 * longest so columns line up — much tidier than hand-padded strings.
 */
export const kv = (label: string, value: string, pad = 10): string =>
  `${label.padEnd(pad)}: ${value}`;

export function kvBlock(
  entries: ReadonlyArray<[string, string | null | undefined]>,
): string[] {
  const live = entries.filter((e): e is [string, string] => e[1] != null && e[1] !== '');
  if (live.length === 0) return [];
  const pad = Math.max(...live.map(([k]) => k.length)) + 1;
  return live.map(([k, v]) => kv(k, v, pad));
}

/** Block-character progress meter — WhatsApp renders █/░ cleanly. */
export function bar(pct: number, width = 10): string {
  const n = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width);
  return '█'.repeat(n) + '░'.repeat(width - n);
}

/** "x menit/jam" pendek — shared by cards and the outage banner. */
export function ago(iso: string | null): string {
  if (!iso) return '?';
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return 'baru saja';
  if (m < 60) return `${m} mnt`;
  return `${Math.floor(m / 60)}j ${m % 60}m`;
}

/** Wizard progress dots — `●●○○` reads better mid-flow than bare "2/4". */
export function stepDots(current: number, total: number): string {
  return '●'.repeat(Math.min(current, total)) + '○'.repeat(Math.max(0, total - current));
}

/** Step label like `langkah 2/4 ●●○○` — one call per wizard card title. */
export function stepLabel(current: number, total: number): string {
  return `langkah ${current}/${total} ${stepDots(current, total)}`;
}

/** Greeting variants for a friendlier first touch. */
export function greetingFor(name?: string | null): string {
  const who = name ? `, ${name}` : '';
  return `Halo${who}! 👋`;
}
