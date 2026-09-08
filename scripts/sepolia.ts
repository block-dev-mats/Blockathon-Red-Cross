import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { parseConfig } from "../shared/protocol.ts";
import { profileDirectory } from "../server/profile-config.ts";
import { browserPreflight, networkPreflight } from "./sepolia-preflight.ts";
import { exists, loadSettings, ordinaryFile, prepareDeployment, readJournal } from "./sepolia-deployment.ts";
import { verifyDeployment, sepoliaClient } from "../shared/deployment.ts";

async function main() {
  const directory = profileDirectory("sepolia"), settings = await loadSettings(directory);
  const configPath = `${directory}/deployment.json`;
  let existing;
  if (await exists(configPath)) { await ordinaryFile(configPath); existing = parseConfig(JSON.parse(await readFile(configPath, "utf8")), "sepolia"); }
  if (existing && (existing.publisher !== settings.publisher || existing.rpcUrl !== settings.rpcUrl)) throw new Error("Inställningarna avviker från befintlig deployment.");
  const network = await networkPreflight(settings, existing);
  await browserPreflight(settings, network.requests);
  console.log("Sepolia L1: nätverk, EOA och nödvändiga RPC-metoder kontrollerade även från browser-origin 127.0.0.1:5176.");
  if (existing) {
    const journal = await readJournal(`${directory}/pending-deployment.json`, settings);
    await verifyDeployment(sepoliaClient(settings), journal.plan, existing.deploymentTxHash!);
    console.log(`Befintlig deployment verifierad: ${existing.domain.verifyingContract}.`); return;
  }
  if (await exists(`${directory}/pending-deployment.json`)) {
    const journal = await readJournal(`${directory}/pending-deployment.json`, settings);
    console.log(journal.txHash ? `Sparad transaktion: ${journal.txHash}. Fortsätt kontrollen på /deploy.` : "Ett walletförsök har påbörjats. Kontrollera walletens historik på /deploy; ingen ny deployment skickas."); return;
  }
  const { plan, sufficientBalance, balance } = await prepareDeployment(settings);
  console.log(JSON.stringify({ chainId: 11155111, publisher: settings.publisher, deployer: settings.deployer,
    nonce: plan.nonce, gasLimit: plan.gas, maxCostWei: plan.maxCost, balanceWei: balance, sufficientBalance }, null, 2));
  if (!sufficientBalance) console.log("Deployer-saldot verkar otillräckligt. Fyll på Sepolia test-ETH före deployment.");
  console.log("Kontrollen skickade ingen transaktion. Kör npm run sepolia:deploy och öppna http://127.0.0.1:5176/deploy.");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error instanceof Error && !/viem|Request|HTTP|fetch|Transaction receipt/i.test(error.message) ? error.message :
    "Sepolia-kontrollen kunde inte slutföras. RPC-underlag kan vara fördröjt eller otillgängligt; ingen transaktion har skickats.");
  process.exitCode = 1;
});
