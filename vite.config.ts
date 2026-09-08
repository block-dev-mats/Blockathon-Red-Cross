import { defineConfig } from "vite";
import { readFile } from "node:fs/promises";

export default defineConfig({
  plugins: [{ name: "local-deployment-trust", configureServer(server) {
    server.middlewares.use("/deployment.json", async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "application/json");
      if (req.method !== "GET") { res.statusCode = 405; res.end(); return; }
      try { res.end(await readFile(new URL("./.local/deployment.json", import.meta.url), "utf8")); }
      catch { res.statusCode = 503; res.end('{"error":"Lokal deployment saknas. Kör local:init."}'); }
    });
  } }],
  server: {
    host: "127.0.0.1", port: 5175, strictPort: true,
    fs: { deny: [".env", ".env.*", "*.{crt,pem,key}", "**/.git/**", "**/.local/**", "**/.local-backups/**"] },
    proxy: { "/api": { target: "http://127.0.0.1:3001", changeOrigin: true } },
  },
});
