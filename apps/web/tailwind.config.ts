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
        bg: "#050508",
        blue: {
          accent: "#4FC3F7",
          dim: "#29ABE2",
          glow: "rgba(79,195,247,0.15)",
        },
        purple: {
          accent: "#A78BFA",
          dim: "#7C3AED",
          glow: "rgba(167,139,250,0.15)",
        },
        surface: "#0D0D14",
        border: "#1A1A2E",
      },
      fontFamily: {
        mono: ["'JetBrains Mono'", "monospace"],
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      backgroundImage: {
        "grid-pattern":
          "linear-gradient(rgba(79,195,247,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(79,195,247,0.03) 1px,transparent 1px)",
        "hero-glow":
          "radial-gradient(ellipse 80% 50% at 50% 0%,rgba(79,195,247,0.12) 0%,transparent 70%)",
        "blue-glow":
          "radial-gradient(circle at center,rgba(79,195,247,0.2) 0%,transparent 70%)",
        "purple-glow":
          "radial-gradient(circle at center,rgba(167,139,250,0.2) 0%,transparent 70%)",
      },
      backgroundSize: {
        grid: "40px 40px",
      },
      animation: {
        "pulse-slow": "pulse 4s cubic-bezier(0.4,0,0.6,1) infinite",
        "fade-up": "fadeUp 0.6s ease-out forwards",
        "scan-line": "scanLine 3s linear infinite",
      },
      keyframes: {
        fadeUp: {
          "0%": { opacity: "0", transform: "translateY(20px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        scanLine: {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100vh)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
