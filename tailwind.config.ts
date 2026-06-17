import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        castle: {
          void: "#0a0514",
          stone: "#1a0f2e",
          mortar: "#2d1b4e",
          brick: "#4a2c7a",
          gold: "#d4af37",
          ember: "#e85d04",
          mist: "#c4b5fd",
        },
      },
      fontFamily: {
        pixel: ['"Press Start 2P"', "cursive"],
        terminal: ["VT323", "monospace"],
        vt: ["VT323", "monospace"],
      },
      boxShadow: {
        pixel: "4px 4px 0 #0a0514",
        "pixel-gold": "4px 4px 0 #d4af37",
      },
    },
  },
  plugins: [],
};

export default config;
