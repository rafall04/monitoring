'use client';

// =============================================================================
// "Mode Ringan" — low-end device support. Auto-enabled on weak hardware
// (≤4GB deviceMemory, ≤4 cores, or prefers-reduced-motion), overridable via a
// manual toggle persisted in localStorage. Effects:
//   - refetchIntervals are stretched ×3 (min 60s) via liteInterval()
//   - MapView renders markers on the canvas renderer (preferCanvas) and skips
//     zoom/fade animations — the heaviest UI surface for weak GPUs
// =============================================================================

import { useEffect, useState } from 'react';

const KEY = 'noc.lite';

function detectLite(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mem = nav.deviceMemory ?? 8;
  const cores = nav.hardwareConcurrency ?? 8;
  const reduced =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;
  return mem <= 4 || cores <= 4 || reduced;
}

let cached: boolean | null = null;
const listeners = new Set<() => void>();

export function isLite(): boolean {
  if (cached === null) {
    const stored =
      typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    cached = stored !== null ? stored === '1' : detectLite();
  }
  return cached;
}

export function setLite(v: boolean) {
  cached = v;
  try {
    localStorage.setItem(KEY, v ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l());
}

/** Reactive lite flag — components re-render when the toggle flips. */
export function useLiteMode(): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(false);
  useEffect(() => {
    setV(isLite());
    const on = () => setV(isLite());
    listeners.add(on);
    return () => {
      listeners.delete(on);
    };
  }, []);
  return [v, setLite];
}

/** Stretch a polling interval in lite mode (×3, floor 60s). */
export function liteInterval(ms: number): number {
  return isLite() ? Math.max(ms * 3, 60_000) : ms;
}
