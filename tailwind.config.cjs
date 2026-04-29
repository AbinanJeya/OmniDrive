/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      boxShadow: {
        glow: '0 0 0 1px rgba(211, 228, 254, 0.1), 0 24px 70px rgba(0, 0, 0, 0.26), 0 20px 60px rgba(0, 240, 255, 0.05)',
      },
      fontFamily: {
        display: ['Space Grotesk', 'Inter', 'sans-serif'],
        sans: ['Inter', 'Segoe UI Variable Text', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
