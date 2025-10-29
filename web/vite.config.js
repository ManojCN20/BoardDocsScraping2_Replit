import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5000,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      "/api": "http://localhost:3000",
    },
    watch: {
      ignored: [
        "**/node_modules/**",
        "**/.git/**",
        "../server/**",
        "../**/downloads_*/**",
        "../**/downloads/**",
        "../**/dist/**",
        "../**/.cache/**",
      ],
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    },
  },
});
