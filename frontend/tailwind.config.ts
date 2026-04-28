import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    "./src/store/**/*.{ts,tsx}",
    "./src/lib/**/*.{ts,tsx}",
    "./tests/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: "#020911",
        panel: "#091722",
        cyan: "#72eaff",
        electric: "#33c9ff",
        amber: "#ffbf63",
        alert: "#ff6e57",
        frost: "rgba(171, 232, 255, 0.18)",
      },
      boxShadow: {
        glow: "0 24px 80px rgba(18, 165, 224, 0.18)",
        glass: "0 24px 80px rgba(0, 0, 0, 0.36), inset 0 1px 0 rgba(255, 255, 255, 0.08)",
        halo: "0 0 90px rgba(79, 218, 255, 0.24)",
      },
      backgroundImage: {
        "sphere-space":
          "radial-gradient(circle at 50% 36%, rgba(71, 175, 214, 0.2), transparent 24%), radial-gradient(circle at 20% 12%, rgba(34, 148, 204, 0.22), transparent 30%), radial-gradient(circle at 82% 14%, rgba(255, 165, 80, 0.1), transparent 24%), linear-gradient(180deg, rgba(2, 9, 17, 0.82), rgba(1, 4, 10, 0.98))",
      },
      fontFamily: {
        heading: ["var(--font-heading)", "sans-serif"],
        body: ["var(--font-body)", "sans-serif"],
        mono: ["var(--font-mono)", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
