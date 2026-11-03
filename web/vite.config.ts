import { defineConfig } from "vite";

// The FastAPI server in ../shrewd_studio serves the built files from its static/ folder.
// In dev, Vite serves the app and forwards /api to a server started with `shrewd-studio --port 8765 --no-browser`.
export default defineConfig({
  clearScreen: false,
  server: { proxy: { "/api": "http://127.0.0.1:8765" } },
  build: { target: "es2022", outDir: "../shrewd_studio/static", emptyOutDir: true },
});
