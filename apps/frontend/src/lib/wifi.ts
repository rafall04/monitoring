// Shared WiFi signal helpers for the device⇄AP correlation UI (drawer + map).

export interface RssiQuality {
  bars: 0 | 1 | 2 | 3 | 4;
  label: string; // Indonesian
  color: string; // hex for inline SVG/markers
}

/** Map an RSSI (dBm, negative; closer to 0 = stronger) to a 4-bar quality. */
export function rssiQuality(rssi: number | null): RssiQuality {
  if (rssi == null) return { bars: 0, label: 'tidak diketahui', color: '#64748b' };
  if (rssi >= -55) return { bars: 4, label: 'Kuat', color: '#34d399' };
  if (rssi >= -67) return { bars: 3, label: 'Baik', color: '#34d399' };
  if (rssi >= -75) return { bars: 2, label: 'Cukup', color: '#fbbf24' };
  return { bars: 1, label: 'Lemah', color: '#f87171' };
}
