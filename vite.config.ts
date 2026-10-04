import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

const here = import.meta.dirname;
const renderer = path.join(here, "src/renderer");

export default defineConfig({
  root: renderer,
  base: "./",
  plugins: [react()],
  build: {
    outDir: path.join(here, "dist/renderer"),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        index: path.join(renderer, "index.html"),
        settings: path.join(renderer, "settings.html")
      }
    }
  }
});
