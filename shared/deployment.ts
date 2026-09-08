import { z } from "zod";
import { createPublicClient, http, getContractAddress, keccak256, encodeAbiParameters } from "viem";
import type { Hex, PublicClient } from "viem";
import { address, hex32, parseConfig } from "./protocol.ts";
import { profiles, SEPOLIA_GENESIS, validRpcUrl } from "./profiles.ts";
import { assertSnapshot, readSnapshot } from "./chain.ts";

export const settingsSchema = z.strictObject({ chainId: z.literal(11155111),
  rpcUrl: z.string().refine(url => validRpcUrl(11155111, url)), rpcVisibility: z.literal("public-browser"), publisher: address, deployer: address,
}).refine(s => s.publisher !== `0x${"0".repeat(40)}` && s.deployer !== `0x${"0".repeat(40)}`, "Publika avsändaradresser måste anges.");
export type SepoliaSettings = z.infer<typeof settingsSchema>;
export const sepoliaClient = (s: SepoliaSettings) => createPublicClient({ transport: http(s.rpcUrl, { retryCount: 0, timeout: profiles.sepolia.rpcTimeout }), cacheTime: 0 });
const bytes = z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/).transform(v => v as Hex);
const integer = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const runtimeSchema = z.strictObject({ object: bytes,
  immutableReferences: z.record(z.string(), z.array(z.strictObject({ start: z.number().int().nonnegative(), length: z.number().int().positive() }))) });
export const planSchema = z.strictObject({ settings: settingsSchema, data: bytes, runtime: runtimeSchema,
  organisation: hex32, feed: hex32, messageId: hex32, nonce: z.number().int().nonnegative(),
  gas: integer, maxFeePerGas: integer, maxPriorityFeePerGas: integer, maxCost: integer });
export type DeploymentPlan = z.infer<typeof planSchema>;
export const journalSchema = z.strictObject({ plan: planSchema, txHash: hex32.optional() });
export type DeploymentJournal = z.infer<typeof journalSchema>;
// This identifies a local attempt, not the EIP-712 message signing format.
export function deploymentIdentity(p: DeploymentPlan) {
  return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }, { type: "string" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    [11155111n, SEPOLIA_GENESIS, p.settings.rpcUrl, p.settings.deployer, keccak256(p.data), BigInt(p.nonce), BigInt(p.gas), BigInt(p.maxFeePerGas), BigInt(p.maxPriorityFeePerGas)]));
}
export function assertRuntime(actual: Hex, artifact: z.infer<typeof runtimeSchema>) {
  let observed = actual.slice(2).toLowerCase(), expected = artifact.object.slice(2).toLowerCase();
  if (observed.length !== expected.length) throw new Error("Kontraktets kodlängd avviker från det kompilerade kontraktet.");
  for (const refs of Object.values(artifact.immutableReferences)) for (const { start, length } of refs) {
    const blank = "0".repeat(length * 2), at = start * 2;
    if (at + blank.length > expected.length) throw new Error("Ogiltigt kodunderlag.");
    observed = observed.slice(0, at) + blank + observed.slice(at + blank.length);
    expected = expected.slice(0, at) + blank + expected.slice(at + blank.length);
  }
  if (observed !== expected) throw new Error("Deploymenten motsvarar inte kompilerad CrisisRegistry-kod.");
}
export async function verifyDeployment(client: PublicClient, p: DeploymentPlan, txHash: Hex) {
  if (await client.getChainId() !== 11155111 || (await client.getBlock({ blockNumber: 0n })).hash !== SEPOLIA_GENESIS)
    throw new Error("Fel Sepolia-nätverk eller genesis.");
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  const tx = await client.getTransaction({ hash: txHash });
  const expectedAddress = getContractAddress({ from: p.settings.deployer, nonce: BigInt(p.nonce) });
  if (receipt.status !== "success" || receipt.transactionHash !== txHash || receipt.from.toLowerCase() !== p.settings.deployer || receipt.to !== null ||
    receipt.contractAddress?.toLowerCase() !== expectedAddress.toLowerCase() || tx.hash !== txHash || tx.chainId !== 11155111 ||
    tx.from.toLowerCase() !== p.settings.deployer || tx.to !== null || tx.value !== 0n || tx.nonce !== p.nonce || tx.input !== p.data ||
    tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber)
    throw new Error("Lyckad deployment med förväntad signerare och constructor saknas.");
  const code = await client.getCode({ address: expectedAddress, blockNumber: receipt.blockNumber });
  if (!code || code === "0x") throw new Error("Kontraktskod saknas.");
  assertRuntime(code, p.runtime);
  const config = parseConfig({ domain: { name: "CrisisMessage", version: "1", chainId: 11155111, verifyingContract: expectedAddress },
    rpcUrl: p.settings.rpcUrl, rpcVisibility: p.settings.rpcVisibility, publisher: p.settings.publisher,
    organisation: p.organisation, feed: p.feed, messageId: p.messageId,
    genesisHash: SEPOLIA_GENESIS, deploymentBlock: receipt.blockNumber.toString(), deploymentBlockHash: receipt.blockHash,
    deploymentTxHash: txHash, codeHash: keccak256(code) }, "sepolia");
  const snapshot = await readSnapshot(client, config); await assertSnapshot(client, snapshot);
  return config;
}
