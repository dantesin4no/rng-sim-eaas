import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  // Relative asset paths: the build is served from a repo subpath on GitHub
  // Pages (/rng-sim-eaas/), not from the domain root.
  base: "./",
  plugins: [react()],
  server: {
    port: 5173,
  },
});
