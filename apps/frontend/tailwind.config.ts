import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Extra top-end breakpoint. The stock ladder (sm 640 · md 768 · lg 1024 ·
      // xl 1280 · 2xl 1536) stops short of the 1920px+ displays a NOC actually
      // runs on, which is why every page used to bottom out at `lg:` and leave
      // ~40% of the viewport as dead margin.
      screens: {
        '3xl': '1920px',
      },
      colors: {
        // Themeable surfaces — RGB channel vars are defined in globals.css and
        // swapped by the `.dark` class. The /<alpha-value> keeps opacity utils.
        surface: {
          DEFAULT: 'rgb(var(--surface) / <alpha-value>)',
          raised: 'rgb(var(--surface-raised) / <alpha-value>)',
          border: 'rgb(var(--surface-border) / <alpha-value>)',
        },
        // Brand accent — overridden at runtime by BrandingProvider when an
        // admin saves a custom accent. Default = blue-500.
        accent: 'rgb(var(--accent) / <alpha-value>)',
      },
      // NOC-compact type ramp. Deliberately tighter than stock Tailwind: this is
      // an operations console watched all day on one screen, so `sm`/`base`/`lg`
      // each drop ~2px and line-heights tighten.
      //
      // `micro` and `2xs` exist so nothing needs an arbitrary `text-[10px]` /
      // `text-[11px]` again — those bypassed the scale and were the single most
      // visible source of misaligned labels.
      fontSize: {
        micro: ['0.625rem', { lineHeight: '0.875rem' }], // 10 / 14 — port + marker labels
        '2xs': ['0.6875rem', { lineHeight: '0.9375rem' }], // 11 / 15 — dense badges, table meta
        xs: ['0.75rem', { lineHeight: '1rem' }], // 12 / 16 — secondary text (unchanged)
        sm: ['0.8125rem', { lineHeight: '1.125rem' }], // 13 / 18 — table body, most UI
        base: ['0.875rem', { lineHeight: '1.25rem' }], // 14 / 20 — default body
        lg: ['1rem', { lineHeight: '1.375rem' }], // 16 / 22 — card + section titles
        xl: ['1.125rem', { lineHeight: '1.625rem' }], // 18 / 26 — page titles
        '2xl': ['1.375rem', { lineHeight: '1.75rem' }], // 22 / 28 — metric numbers
        '3xl': ['1.75rem', { lineHeight: '2.125rem' }], // 28 / 34 — hero metrics
      },
      // Three steps only: 6 (controls) · 8 (buttons, inputs, tiles) · 12 (cards).
      // Bare `rounded` was 4px and fought `rounded-lg`; it now lands on the ramp.
      borderRadius: {
        sm: '0.25rem', // 4
        DEFAULT: '0.375rem', // 6
        md: '0.5rem', // 8
        lg: '0.5rem', // 8
        xl: '0.75rem', // 12
        '2xl': '1rem', // 16
      },
    },
  },
  plugins: [],
};

export default config;
