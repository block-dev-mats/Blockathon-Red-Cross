import { open, readFile } from "node:fs/promises";
import { getContractAddress, keccak256, parseTransaction, recoverTransactionAddress } from "viem";
import type { Hex, PublicClient, TransactionSerialized } from "viem";
import { z } from "zod";
import { hex32, parseConfig } from "../shared/protocol.ts";
import { assertSnapshot, readSnapshot } from "../shared/chain.ts";
import { profiles, SEPOLIA_GENESIS } from "../shared/profiles.ts";
import { assertCompiledCode, demoContext, deploymentData } from "./contract.ts";
import { settingsSchema } from "./sepolia-preflight.ts";
import type { SepoliaSettings } from "./sepolia-preflight.ts";

export const journalSchema = z.strictObject({ settings: settingsSchema, txHash: hex32,
  rawTransaction: z.string().regex(/^0x[0-9a-fA-F]+$/).transform(v => v as Hex) });
export type DeploymentJournal = z.infer<typeof journalSchema>;
export async function writeExclusive(path: string, data: unknown) {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(data, null, 2) + "\n"); await file.sync(); } finally { await file.close(); }
}
export async function validateJournal(journal: DeploymentJournal, settings: SepoliaSettings) {
  const tx = parseTransaction(journal.rawTransaction);
  if (JSON.stringify(journal.settings) !== JSON.stringify(settings) || keccak256(journal.rawTransaction) !== journal.txHash ||
      tx.chainId !== 11155111 || tx.to || (tx.value ?? 0n) !== 0n || tx.data !== await deploymentData(settings.publisher) ||
      (await recoverTransactionAddress({ serializedTransaction: journal.rawTransaction as TransactionSerialized })).toLowerCase() !== settings.deployer)
    throw new Error("Sparad deployment avviker från vald signerare, nätverk eller constructor. Ingen ny transaktion skickas.");
  return tx;
}
export async function resumeDeployment(client: PublicClient, journal: DeploymentJournal, settings: SepoliaSettings) {
  const tx = await validateJournal(journal, settings);
  if (await client.getChainId() !== 11155111 || (await client.getBlock({ blockNumber: 0n })).hash !== SEPOLIA_GENESIS)
    throw new Error("Fel nätverk före broadcast.");
  // Only an explicit not-found result permits broadcasting the same saved bytes.
  // Timeouts/rate limits never trigger another signature, nonce or deployment.
  let known = false;
  try { await client.getTransaction({ hash: journal.txHash }); known = true; }
  catch (error) {
    if (!(error instanceof Error) || error.name !== "TransactionNotFoundError") throw new Error("RPC kunde inte fastställa tidigare transaktion. Deploymentjournalen behålls.");
  }
  if (!known) {
    if (await client.getTransactionCount({ address: settings.deployer, blockTag: "latest" }) > tx.nonce!)
      throw new Error("Nonce har redan använts men deploymentunderlag saknas. Ingen ny deployment skapas.");
    try {
      const hash = await client.sendRawTransaction({ serializedTransaction: journal.rawTransaction });
      if (hash !== journal.txHash) throw new Error("Transaktionshashen avviker.");
    } catch { throw new Error("Broadcast kunde inte bekräftas. Samma signerade transaktion och hash är sparade; kör sepolia:deploy igen."); }
  }
  const receipt = await client.waitForTransactionReceipt({ hash: journal.txHash, confirmations: 1,
    timeout: profiles.sepolia.receiptTimeout, pollingInterval: profiles.sepolia.receiptPollInterval });
  const expectedAddress = getContractAddress({ from: settings.deployer, nonce: BigInt(tx.nonce!) });
  if (receipt.status !== "success" || receipt.from.toLowerCase() !== settings.deployer || receipt.to !== null ||
      receipt.contractAddress?.toLowerCase() !== expectedAddress.toLowerCase())
    throw new Error("Deploymenten saknar lyckad, matchande receipt. Journalen behålls.");
  const includedTx = await client.getTransaction({ hash: journal.txHash });
  if (includedTx.input !== tx.data || includedTx.blockHash !== receipt.blockHash) throw new Error("Inkluderad deployment avviker från godkänt underlag.");
  const code = await client.getCode({ address: expectedAddress, blockNumber: receipt.blockNumber });
  if (!code || code === "0x") throw new Error("Kontraktskod saknas.");
  await assertCompiledCode(code);
  const config = parseConfig({ domain: { name: "CrisisMessage", version: "1", chainId: 11155111, verifyingContract: expectedAddress },
    rpcUrl: settings.rpcUrl, rpcVisibility: settings.rpcVisibility, publisher: settings.publisher, ...demoContext,
    genesisHash: SEPOLIA_GENESIS, deploymentBlock: receipt.blockNumber.toString(), deploymentBlockHash: receipt.blockHash,
    deploymentTxHash: journal.txHash, codeHash: keccak256(code) }, "sepolia");
  const snapshot = await readSnapshot(client, config); await assertSnapshot(client, snapshot);
  return config;
}
export async function readJournal(path: string) { return journalSchema.parse(JSON.parse(await readFile(path, "utf8"))); }
