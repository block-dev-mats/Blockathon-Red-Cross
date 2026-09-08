import { createConnection } from "node:net";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { startApi } from "../server/api.ts";
import { loadDeployment, profileDirectory, profileViteConfig } from "../server/profile-config.ts";
import { profileById } from "../shared/profiles.ts";
import type { ProfileId } from "../shared/profiles.ts";

export async function freePorts(ports: readonly number[]) {
  for (const port of ports) {
    const occupied = await new Promise<boolean>(resolve => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (occupied) throw new Error(`Port ${port} används redan. Ingen process har stoppats.`);
  }
}
export async function startProfile(id: ProfileId, frontend = true) {
  const profile = profileById(id);
  await freePorts(frontend ? [profile.apiPort, profile.frontendPort] : [profile.apiPort]);
  const config = await loadDeployment(id);
  const api = await startApi(config, `${profileDirectory(id)}/demo.sqlite`, profile.apiPort, `http://127.0.0.1:${profile.frontendPort}`);
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    if (frontend) { vite = await createServer({ ...profileViteConfig(id), configFile: false }); await vite.listen(); }
  } catch (error) { await api.close(); throw error; }
  console.log(`${profile.label}: API http://127.0.0.1:${profile.apiPort}${frontend ? ` · app http://127.0.0.1:${profile.frontendPort}` : ""}`);
  return { close: async () => { await vite?.close(); await api.close(); } };
}
async function main() {
  const id = profileById(process.argv[2]).id;
  const runtime = await startProfile(id);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void runtime.close().then(() => process.exit(0)); });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error instanceof Error ? error.message : "Uppstart misslyckades."); process.exitCode = 1; });
