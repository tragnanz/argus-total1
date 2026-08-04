import type { Config } from "tailwindcss";

// Palette "Argus Smart" (ispirata al design Ceres): verde primario, menta
// d'accento, neutri salvia, ambra/ruggine/rosso per gli stati.
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#038037",   // verde ufficiale del logo Argus
          dark: "#036a2d",
          darker: "#08341c",
          mid: "#05602a",
          light: "#1a9a49",
          mint: "#46d98a",
        },
        panel: "#eef3ef",
        sage: { DEFAULT: "#7a8c81", light: "#96a99c", dark: "#3b5654" },
        danger: "#d92d20",
        rust: "#b23b1e",
        amber: "#f0b429",
      },
      boxShadow: {
        widget: "0 6px 24px -6px rgba(13,59,38,.28), 0 2px 6px -2px rgba(13,59,38,.16)",
        pill: "0 2px 10px -2px rgba(13,59,38,.35)",
      },
      borderRadius: { xl2: "1.1rem" },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
      },
    },
  },
  plugins: [],
};
export default config;
