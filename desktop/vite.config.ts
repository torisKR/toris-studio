import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

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
      // A linked worktree may itself live under ~/.codex/worktrees. Restrict
      // private repo files without denying every source in that ancestor.
      // fs.allow still excludes the user's ~/.codex/auth.json and siblings.
      deny: [".env", ".env.*", "*.{crt,pem,key}", "**/.git/**", `${repositoryRoot}/.codex/**`, "**/config.local.json"]
    }
  },
  build: { target: "es2022", sourcemap: false }
});
