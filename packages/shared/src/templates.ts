// =============================================================================
// Tiny placeholder substitution for Netwatch/Telegram message templates.
//
// Supported placeholders (case-insensitive):
//   {device}  - device name
//   {ip}      - device IP address (or "-")
//   {site}    - site name
//   {status}  - "up" | "down" | "unknown" (lowercased)
//   {when}    - ISO timestamp of the event
//
// Unknown placeholders are left as-is so a typo is visible rather than silent.
// =============================================================================

export interface AlertVars {
  device: string;
  ip: string | null;
  site: string;
  status: string;
  when?: string | Date;
}

export function renderTemplate(template: string, vars: AlertVars): string {
  const when =
    vars.when instanceof Date
      ? vars.when.toISOString()
      : (vars.when ?? new Date().toISOString());
  const table: Record<string, string> = {
    device: vars.device,
    ip: vars.ip ?? '-',
    site: vars.site,
    status: vars.status.toLowerCase(),
    when,
  };
  return template.replace(/\{([a-zA-Z_]+)\}/g, (m, key) => {
    const k = String(key).toLowerCase();
    const v = table[k];
    return v !== undefined ? v : m;
  });
}

/** Placeholders the UI hints at — kept in one place. */
export const ALERT_PLACEHOLDERS = ['{device}', '{ip}', '{site}', '{status}', '{when}'] as const;
