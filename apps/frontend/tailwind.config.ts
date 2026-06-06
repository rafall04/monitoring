import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
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
    },
  },
  plugins: [],
};

export default config;
