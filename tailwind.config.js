/** @type {import('tailwindcss').Config} */
const v = (n) => `rgb(var(--${n}) / <alpha-value>)`
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  // Estados da placa de horário são montados em tempo de execução (plate-${estado}).
  safelist: ['plate-open', 'plate-late', 'plate-done', 'plate-paused'],
  theme: {
    extend: {
      colors: {
        bg: v('bg'), surface: v('surface'), subtle: v('subtle'), hover: v('hover'),
        line: v('line'), 'line-strong': v('line-strong'),
        ink: v('ink'), muted: v('muted'), faint: v('faint'),
        accent: v('accent'), 'accent-ink': v('accent-ink'), 'accent-soft': v('accent-soft'),
        signal: v('signal'), 'signal-ink': v('signal-ink'),
        rail: v('rail'), 'rail-ink': v('rail-ink'), 'rail-accent': v('rail-accent'), 'rail-line': v('rail-line'),
        ok: v('ok'), warn: v('warn'), bad: v('bad'),
      },
      fontFamily: {
        sans: ['Barlow', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['"Barlow Condensed"', 'Barlow', 'ui-sans-serif', 'sans-serif'],
        // "mono" aqui é só para códigos e SKUs: condensada, de números tabulares.
        mono: ['"Barlow Condensed"', 'Barlow', 'ui-sans-serif', 'sans-serif'],
      },
      fontSize: {
        '2xs': ['12px', '16px'], xs: ['13px', '18px'], sm: ['14px', '20px'], base: ['15.5px', '22px'],
        md: ['17px', '24px'], lg: ['20px', '26px'], xl: ['26px', '30px'], '2xl': ['32px', '34px'], '3xl': ['40px', '40px'],
        '4xl': ['56px', '52px'], '5xl': ['84px', '76px'],
      },
      borderRadius: { DEFAULT: '4px', sm: '3px', md: '4px', lg: '8px' },
      boxShadow: { pop: '0 10px 28px -10px rgb(0 0 0 / 0.35), 0 0 0 1px rgb(var(--line-strong))' },
    },
  },
  plugins: [],
}
