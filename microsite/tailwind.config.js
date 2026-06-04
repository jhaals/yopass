/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{js,jsx,ts,tsx,mdx}',
    './docs/**/*.{md,mdx}',
    './docusaurus.config.js',
  ],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        'brand-green': '#009643',
        'brand-teal': '#06637C',
        'brand-blue': '#1100E9',
        'surface': '#fafbfc',
        'tint-green': '#edf8f2',
        'tint-teal': '#eaf4f7',
        'tint-blue': '#eaf6fb',
      },
      fontFamily: {
        sans: ['DM Sans', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};
