import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.KRINO_PORT ?? "4174"}`, rewrite: (path) => path.replace(/^\/api/, "") } },
  },
  test: { environment: "jsdom", setupFiles: "./src/test-setup.ts" },
});
