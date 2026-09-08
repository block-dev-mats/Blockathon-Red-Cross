import { access, lstat, readFile, realpath, open, rename, unlink, link } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { settingsSchema, planSchema, journalSchema } from "../shared/deployment.ts";
import type { SepoliaSettings, DeploymentJournal } from "../shared/deployment.ts";
import { deploymentPlan } from "./sepolia-preflight.ts";
import { contractArtifact, deploymentData, demoContext } from "./contract.ts";

export async function exists(path: string) { try { await access(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
export async function ordinaryFile(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path) throw new Error("En vanlig fil i projektets Sepolia-katalog krävs.");
}
export async function loadSettings(directory: string) {
  if (!await exists(`${directory}/settings.json`)) throw new Error("Sepolia saknar .sepolia/settings.json. Ange publik browser-RPC, publisher och deployer enligt README.");
  if (await realpath(directory) !== directory) throw new Error("Sepolia-katalogen får inte vara en symlänk.");
  await ordinaryFile(`${directory}/settings.json`);
  return settingsSchema.parse(JSON.parse(await readFile(`${directory}/settings.json`, "utf8")));
}
async function syncDirectory(path: string) {
  const handle = await open(dirname(path), "r"); try { await handle.sync(); } finally { await handle.close(); }
}
export async function writeExclusive(path: string, data: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(data, null, 2) + "\n"); await file.sync(); await file.close();
    await link(temporary, path); // Atomic no-replace publication, never a partially written trust file.
    await syncDirectory(path);
  } finally { await file.close(); await unlink(temporary); }
}
export async function updateJournal(path: string, journal: DeploymentJournal) {
  await ordinaryFile(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeExclusive(temporary, journal); await rename(temporary, path); await syncDirectory(path); }
  finally { if (await exists(temporary)) await unlink(temporary); }
}
export async function readJournal(path: string, settings: SepoliaSettings) {
  await ordinaryFile(path);
  const journal = journalSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (JSON.stringify(journal.plan.settings) !== JSON.stringify(settings) || journal.plan.data !== await deploymentData(settings.publisher) ||
    JSON.stringify(journal.plan.runtime) !== JSON.stringify(await runtimeArtifact()))
    throw new Error("Sparad deployment avviker från settings eller kontraktsbuild. Journalen behålls; ingen ny deployment skapas.");
  for (const field of ["organisation", "feed", "messageId"] as const) if (journal.plan[field] !== demoContext[field]) throw new Error("Sparad kontext avviker.");
  return journal;
}
export async function prepareDeployment(settings: SepoliaSettings) {
  const estimate = await deploymentPlan(settings);
  const plan = planSchema.parse({ settings, data: estimate.data, runtime: await runtimeArtifact(),
    ...demoContext, nonce: estimate.nonce, gas: String(estimate.gas), maxFeePerGas: String(estimate.maxFeePerGas),
    maxPriorityFeePerGas: String(estimate.maxPriorityFeePerGas), maxCost: String(estimate.maxCost) });
  return { plan, balance: String(estimate.balance), sufficientBalance: estimate.sufficientBalance };
}

export async function runtimeArtifact() { const { object, immutableReferences } = (await contractArtifact()).deployedBytecode; return { object, immutableReferences }; }
