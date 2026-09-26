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

/** Greeting variants for a friendlier first touch. */
export function greetingFor(name?: string | null): string {
  const who = name ? `, ${name}` : '';
  return `Halo${who}! 👋`;
}
