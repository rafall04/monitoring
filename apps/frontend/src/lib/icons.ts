import {
  STATUS_COLORS,
  STATUS_LABELS,
  type DeviceType,
  type DisplayStatus,
} from '@noc/shared';

// Built-in device icon library. Each value is the inner markup of a 24x24 SVG
// (stroke/fill use currentColor so we can recolour per status).
export const DEVICE_ICONS: Record<DeviceType, string> = {
  router:
    '<rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 13h.01M11 13h.01"/><path d="M16 9V5M16 5l-2 2M16 5l2 2"/>',
  switch:
    '<rect x="3" y="8" width="18" height="9" rx="2"/><path d="M7 12h2M11 12h2M15 12h2"/>',
  access_point:
    '<path d="M5 12a7 7 0 0 1 14 0"/><path d="M8 12a4 4 0 0 1 8 0"/><circle cx="12" cy="12" r="1.5"/>',
  onu: '<rect x="4" y="7" width="16" height="10" rx="2"/><circle cx="8" cy="12" r="1.2"/><path d="M12 12h5"/>',
  olt: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h10M7 12h10M7 15h6"/>',
  server:
    '<rect x="5" y="3" width="14" height="8" rx="1.5"/><rect x="5" y="13" width="14" height="8" rx="1.5"/><path d="M8 7h.01M8 17h.01"/>',
  cctv: '<path d="M3 8l13-3 1.5 4-13 3z"/><path d="M6 12v4h4"/><circle cx="18" cy="16" r="2"/>',
  tower:
    '<path d="M12 3v18"/><path d="M7 21l5-12 5 12"/><path d="M9 14h6"/>',
  antenna:
    '<path d="M12 8v13"/><circle cx="12" cy="5" r="2"/><path d="M8 21h8"/>',
  pc: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>',
  printer:
    '<rect x="6" y="3" width="12" height="6"/><rect x="4" y="9" width="16" height="7" rx="1.5"/><rect x="7" y="14" width="10" height="6"/>',
  gtex:
    '<rect x="4" y="3" width="16" height="14" rx="1.5"/><rect x="6.5" y="5.5" width="11" height="6" rx="1"/><path d="M8 14h4M8 20h8M11 17h2"/>',
  qcpad:
    '<rect x="6" y="3" width="12" height="18" rx="2"/><path d="M9.4 11.6l1.8 1.8 3.4-3.8"/><path d="M11 18.5h2"/>',
  androidtv:
    '<rect x="2.5" y="4" width="19" height="12" rx="1.5"/><path d="M10 19h4"/><path d="M10.5 8.6l4 1.4-4 1.4z"/>',
  other: '<circle cx="12" cy="12" r="7"/><path d="M12 9v4M12 16h.01"/>',
};

export function deviceSvg(type: DeviceType, size = 18): string {
  const inner = DEVICE_ICONS[type] ?? DEVICE_ICONS.other;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

/**
 * Build the HTML for a Leaflet divIcon: a coloured pin holding the device icon
 * plus a small text label. Status is conveyed by colour AND a label/shape so it
 * is readable for colour-blind users.
 */
export function markerHtml(opts: {
  type: DeviceType;
  iconKey?: string | null;
  iconUrl?: string | null;
  status: DisplayStatus;
  name: string;
  critical: boolean;
}): string {
  const color = STATUS_COLORS[opts.status];
  const ring = opts.critical ? `box-shadow:0 0 0 3px ${color}55;` : '';
  const pulse = opts.status === 'down' ? 'animation:nocpulse 1.4s ease-in-out infinite;' : '';
  // A custom uploaded icon wins; otherwise an explicit iconKey; otherwise the type.
  const glyph = opts.iconUrl
    ? `<img src="${escapeHtml(opts.iconUrl)}" alt="" width="18" height="18" style="object-fit:contain;display:block" />`
    : deviceSvg((opts.iconKey as DeviceType) || opts.type);
  return `
    <div class="noc-marker">
      <div style="width:32px;height:32px;border-radius:50%;background:#0b1220;border:2px solid ${color};color:${color};display:flex;align-items:center;justify-content:center;${ring}${pulse}">
        ${glyph}
      </div>
      <div class="noc-marker__label">${escapeHtml(opts.name)} · ${STATUS_LABELS[opts.status]}</div>
    </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
