import type { Config } from 'tailwindcss';

const config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        ink: '#12231f',
        forest: '#123d35',
        mint: '#b8f3d2',
        paper: '#f6f7f1',
        coral: '#b53b28',
      },
      boxShadow: {
        card: '0 12px 40px rgb(18 35 31 / 8%)',
      },
    },
  },
  plugins: [],
} satisfies Config;

export default config;
