'use client';

import { rssiQuality } from '@/lib/wifi';

/** Four signal bars colored by RSSI quality (shared by the inspect drawer + WiFi view). */
export default function SignalBars({ rssi }: { rssi: number | null }) {
  const q = rssiQuality(rssi);
  return (
    <span className="flex items-end gap-0.5" title={`${rssi ?? '—'} dBm · ${q.label}`}>
      {[1, 2, 3, 4].map((b) => (
        <span
          key={b}
          className="w-1 rounded-sm"
          style={{
            height: `${b * 3 + 2}px`,
            backgroundColor: b <= q.bars ? q.color : 'rgb(51 65 85)',
          }}
        />
      ))}
    </span>
  );
}
