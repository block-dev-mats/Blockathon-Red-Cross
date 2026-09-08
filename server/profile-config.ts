import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { UserConfig } from "vite";
import { parseConfig } from "../shared/protocol.ts";
import { profileById } from "../shared/profiles.ts";
import type { ProfileId } from "../shared/profiles.ts";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export const profileDirectory = (id: ProfileId) => `${projectRoot}${profileById(id).directory}`;
export async function loadDeployment(id: ProfileId) {
  try { return parseConfig(JSON.parse(await readFile(`${profileDirectory(id)}/deployment.json`, "utf8")), id); }
  catch { throw new Error(`Giltig deployment för ${id} saknas. Kör ${id === "local" ? "local:init" : "sepolia:check och explicit sepolia:deploy"}.`); }
}
export function profileViteConfig(id: ProfileId, overrides: {
  readDeployment?: () => Promise<unknown>; frontendPort?: number; apiPort?: number;
} = {}): UserConfig {
  const profile = profileById(id);
  return {
    root: projectRoot,
    cacheDir: `node_modules/.vite/${id}${overrides.frontendPort ? `-${overrides.frontendPort}` : ""}`,
    envDir: false,
    envPrefix: [], // Public trust is the validated deployment endpoint, never environment variables.
    define: { __APP_PROFILE__: JSON.stringify(id) },
    build: { outDir: `dist/${id}` },
    plugins: [{ name: "profile-deployment-trust", configureServer(server) {
      server.middlewares.use("/deployment.json", async (req, res) => {
        res.setHeader("Cache-Control", "no-store"); res.setHeader("Content-Type", "application/json");
        if (req.method !== "GET" || (req.url !== "/" && req.url !== "")) { res.statusCode = 404; res.end(); return; }
        try {
          const config = parseConfig(await (overrides.readDeployment?.() ?? loadDeployment(id)), id);
          res.end(JSON.stringify(config));
        } catch { res.statusCode = 503; res.end(JSON.stringify({ error: `Deployment för ${id} saknas eller är ogiltig.` })); }
      });
    } }],
    server: { host: "127.0.0.1", port: overrides.frontendPort ?? profile.frontendPort, strictPort: true,
      fs: { deny: [".env", ".env.*", "*.{crt,pem,key,keystore}", "**/.git/**", "**/.local/**", "**/.local-backups/**", "**/.sepolia/**"] },
      proxy: { "/api": { target: `http://127.0.0.1:${overrides.apiPort ?? profile.apiPort}`, changeOrigin: true } },
    },
  };
}
