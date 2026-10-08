import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    fs: {
      strict: true,
      allow: [fileURLToPath(new URL(".", import.meta.url)), fileURLToPath(new URL("../node_modules", import.meta.url))],
      deny: [".env", ".env.*", "*.{crt,pem,key}", "**/.git/**", "**/.codex/**", "**/config.local.json"]
    }
  },
  build: { target: "es2022", sourcemap: false }
});
