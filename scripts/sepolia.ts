import { access, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { keccak256, parseTransaction, recoverTransactionAddress } from "viem";
import type { Hex, TransactionSerialized } from "viem";
import { parseConfig } from "../shared/protocol.ts";
import { profileDirectory } from "../server/profile-config.ts";
import { MessageStore } from "../server/storage.ts";
import { browserPreflight, deploymentPlan, networkPreflight, settingsSchema } from "./sepolia-preflight.ts";
import type { SepoliaSettings } from "./sepolia-preflight.ts";
import { readJournal, resumeDeployment, validateJournal, writeExclusive } from "./sepolia-deployment.ts";
import { demoContext } from "./contract.ts";

const directory = profileDirectory("sepolia");
const configPath = `${directory}/deployment.json`, journalPath = `${directory}/pending-deployment.json`;
const keystorePath = `${directory}/deployer`;
async function exists(path: string) { try { await access(path); return true; } catch { return false; } }
async function ordinaryFile(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path) throw new Error("En vanlig fil i projektets .sepolia-katalog krävs.");
  return stat;
}
async function checkKeystore(settings: SepoliaSettings) {
  const stat = await ordinaryFile(keystorePath).catch(() => { throw new Error("Deploysignerare saknas: importera en krypterad testnet-keystore till .sepolia/deployer enligt README."); });
  if (stat.mode & 0o077) throw new Error("Keystore måste ha rättighet 0600: chmod 600 .sepolia/deployer");
  const metadata = JSON.parse(await readFile(keystorePath, "utf8"));
  if (metadata.version !== 3 || !metadata.crypto?.ciphertext || `0x${String(metadata.address).replace(/^0x/, "").toLowerCase()}` !== settings.deployer)
    throw new Error("Keystore måste vara krypterad V3 och motsvara uttryckligen vald deployer-adress.");
}
export function castSignArguments(s: SepoliaSettings, plan: Awaited<ReturnType<typeof deploymentPlan>>, path: string) {
  return ["mktx", "--rpc-url", s.rpcUrl, "--chain", "11155111", "--from", s.deployer,
    "--keystore", path, "--nonce", String(plan.nonce), "--gas-limit", String(plan.gas),
    "--gas-price", String(plan.maxFeePerGas), "--priority-gas-price", String(plan.maxPriorityFeePerGas), "--value", "0", "--create", plan.data];
}
async function signWithKeystore(s: SepoliaSettings, plan: Awaited<ReturnType<typeof deploymentPlan>>): Promise<Hex> {
  await checkKeystore(s);
  if (!process.stdin.isTTY) throw new Error("Kör sepolia:deploy i en egen terminal. Keystore-lösenord anges dolt till Cast där, aldrig i chatten.");
  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn("cast", castSignArguments(s, plan, keystorePath),
      { stdio: ["inherit", "pipe", "inherit"], env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: process.env.TERM, LANG: process.env.LANG } });
    let output = ""; child.stdout.on("data", bytes => { output += bytes; });
    child.once("error", () => reject(new Error("Cast kunde inte startas.")));
    child.once("exit", code => code === 0 ? resolve(output.trim()) : reject(new Error("Signeringen avbröts eller misslyckades. Ingen broadcast har gjorts.")));
  });
  if (!/^0x[0-9a-fA-F]+$/.test(raw)) throw new Error("Cast returnerade ingen signerad transaktion.");
  const tx = parseTransaction(raw as Hex);
  if (tx.nonce !== plan.nonce || tx.gas !== plan.gas || tx.maxFeePerGas !== plan.maxFeePerGas || tx.maxPriorityFeePerGas !== plan.maxPriorityFeePerGas ||
      (await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized })).toLowerCase() !== s.deployer)
    throw new Error("Signerad transaktion avviker från granskad gas/nonce/signerare.");
  return raw as Hex;
}
async function main() {
  const command = process.argv[2];
  if (!["check", "deploy"].includes(command)) throw new Error("Använd sepolia:check eller sepolia:deploy.");
  if (!await exists(`${directory}/settings.json`)) throw new Error("Sepolia saknar inställningar: kopiera config/sepolia.example.json till .sepolia/settings.json och ange publik browser-RPC, publisher och deployer. Ingen deployment är genomförd.");
  if (await realpath(directory) !== directory) throw new Error(".sepolia får inte vara en symlänk.");
  await ordinaryFile(`${directory}/settings.json`);
  const settings = settingsSchema.parse(JSON.parse(await readFile(`${directory}/settings.json`, "utf8")));
  if (await exists(configPath)) await ordinaryFile(configPath);
  const existing = await exists(configPath) ? parseConfig(JSON.parse(await readFile(configPath, "utf8")), "sepolia") : undefined;
  if (existing && (existing.publisher !== settings.publisher || existing.rpcUrl !== settings.rpcUrl)) throw new Error("Inställningarna avviker från befintlig deployment. Den ersätts inte automatiskt.");
  const network = await networkPreflight(settings, existing);
  await browserPreflight(settings, network.requests);
  console.log("Sepolia L1: nätverk och nödvändiga RPC-metoder kontrollerade även från browser-origin 127.0.0.1:5176.");
  if (existing) { console.log(`Befintlig deployment verifierad: ${existing.domain.verifyingContract}. Ingen ny deployment utförs.`); return; }
  let journal;
  if (await exists(journalPath)) { await ordinaryFile(journalPath); journal = await readJournal(journalPath); await validateJournal(journal, settings); }
  else {
    await checkKeystore(settings);
    const plan = await deploymentPlan(settings);
    console.log(JSON.stringify({ chainId: 11155111, deployer: settings.deployer, publisher: settings.publisher, ...demoContext,
      nonce: plan.nonce, gasLimit: plan.gas.toString(), maxFeePerGas: plan.maxFeePerGas.toString(), maxCostWei: plan.maxCost.toString() }, null, 2));
    if (command === "check" || !process.argv.includes("--broadcast")) { console.log("Preflight klar. Explicit deployment: npm run sepolia:deploy -- --broadcast"); return; }
    const rawTransaction = await signWithKeystore(settings, plan);
    journal = { settings, rawTransaction, txHash: keccak256(rawTransaction) };
    await validateJournal(journal, settings);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeExclusive(journalPath, journal); // Durable BEFORE the first network broadcast.
  }
  console.log(`Sparad deploymenttransaktion: ${journal.txHash}`);
  if (command === "check" || !process.argv.includes("--broadcast")) return;
  const config = await resumeDeployment(network.client, journal, settings);
  const after = await networkPreflight(settings, config); await browserPreflight(settings, after.requests);
  if (!await exists(`${directory}/demo.sqlite`)) new MessageStore(`${directory}/demo.sqlite`).close();
  await writeExclusive(configPath, config);
  console.log(`Sepolia-kontrakt: ${config.domain.verifyingContract}. Lyckad kedjebekräftelse och kontext verifierade; detta är inte finalitet.`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => {
  // Never dump RPC request bodies, keystore material or provider URLs/errors.
  console.error(error instanceof Error && !/viem|Request|HTTP|fetch|Transaction receipt/i.test(error.message) ? error.message :
    "Sepolia-kontrollen kunde inte slutföras. RPC/receipt kan vara fördröjd eller otillgänglig. Sparad transaktion behålls; kör samma kommando igen.");
  process.exitCode = 1;
});
