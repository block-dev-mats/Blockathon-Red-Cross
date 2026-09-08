import { mkdir, readFile, writeFile, access, rename, chmod } from "node:fs/promises";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { parseConfig } from "../shared/protocol.ts";
import { launchAnvil, deploy } from "./evm.ts";
import { startApi } from "../server/api.ts";
import { readSnapshot, rpcClient } from "../shared/chain.ts";
import { MessageStore } from "../server/storage.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
export const localPath = `${root}.local`;
const statePath = `${localPath}/chain.json`;
const configPath = `${localPath}/deployment.json`;
export async function loadConfig() { return parseConfig(JSON.parse(await readFile(configPath, "utf8")), "local"); }
async function exists(path: string) { try { await access(path); return true; } catch { return false; } }
async function portOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}
async function freePorts(ports: number[]) {
  for (const port of ports) if (await portOpen(port)) throw new Error(`Port ${port} används redan. Stoppa den berörda lokala tjänsten först.`);
}
async function initialize() {
  await freePorts([8545, 3001]);
  if (await exists(configPath) || await exists(statePath)) throw new Error("Lokal miljö finns redan. Använd normal uppstart eller uttrycklig local:reset.");
  await mkdir(localPath, { recursive: true, mode: 0o700 });
  await chmod(localPath, 0o700);
  // Reuse only a key left by an interrupted first initialization, never replace it.
  const keyPath = `${localPath}/publisher.key`;
  const key: Hex = await exists(keyPath) ? (await readFile(keyPath, "utf8")).trim() as Hex : generatePrivateKey();
  if (!await exists(keyPath)) await writeFile(keyPath, key, { mode: 0o600, flag: "wx" });
  const network = await launchAnvil(8545, statePath);
  try {
    const config = await deploy(network.url, privateKeyToAccount(key).address);
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    new MessageStore(`${localPath}/demo.sqlite`).close();
    console.log("Lokal deployment och tom SQLite-databas skapade. Testwallet finns i .local/publisher.key (visas inte i loggen).");
    console.log(`Behörig publik adress: ${config.publisher}`);
  } finally { await network.stop(); }
}
async function main() {
  const command = process.argv[2];
  if (command === "init") { await initialize(); return; }
  if (command === "reset") {
    if (!process.argv.includes("--confirm-local-reset")) throw new Error("Ange --confirm-local-reset för att arkivera hela lokala miljön och skapa en ny.");
    await freePorts([8545, 3001, 5175]);
    await mkdir(`${root}.local-backups`, { recursive: true, mode: 0o700 });
    await rename(localPath, `${root}.local-backups/${Date.now()}`);
    await initialize(); return;
  }
  const config = await loadConfig();
  if (command === "api") {
    const api = await startApi(config, `${localPath}/demo.sqlite`);
    console.log("SQLite/API: http://127.0.0.1:3001");
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void api.close().then(() => process.exit(0)); });
    return;
  }
  if (!["chain", "start", "services"].includes(command)) throw new Error("Använd init, chain, api, start, services eller reset.");
  await access(statePath); // Never silently recreate a missing chain on normal startup.
  await freePorts(command === "start" ? [8545, 3001, 5175] : command === "services" ? [8545, 3001] : [8545]);
  const network = await launchAnvil(8545, statePath, 31337, config.genesisHash);
  let api: Awaited<ReturnType<typeof startApi>> | undefined;
  let frontend: ReturnType<typeof spawn> | undefined;
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    frontend?.kill("SIGTERM"); await api?.close(); await network.stop();
  };
  try {
    await readSnapshot(rpcClient(config), config);
    console.log("Bestående lokalt EVM-nät: http://127.0.0.1:8545");
    if (command !== "chain") {
      api = await startApi(config, `${localPath}/demo.sqlite`);
      console.log("SQLite/API: http://127.0.0.1:3001");
    }
    if (command === "start") {
      frontend = spawn(process.execPath, [`${root}node_modules/vite/bin/vite.js`, "--mode", "app-local", "--host", "127.0.0.1", "--port", "5175", "--strictPort"], { cwd: root, stdio: "inherit" });
      frontend.once("exit", () => { void stop(); });
    }
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void stop().then(() => process.exit(0)); });
  } catch (error) { await stop(); throw error; }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : "Lokal uppstart misslyckades."); process.exitCode = 1; });
}
