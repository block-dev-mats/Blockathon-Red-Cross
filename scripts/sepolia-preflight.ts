import { createPublicClient, encodeFunctionData, http, numberToHex, zeroHash } from "viem";
import type { PublicClient } from "viem";
import { z } from "zod";
import { address, abi } from "../shared/protocol.ts";
import type { TrustConfig } from "../shared/protocol.ts";
import { SEPOLIA_GENESIS, validRpcUrl, profiles } from "../shared/profiles.ts";
import { assertSnapshot, readSnapshot } from "../shared/chain.ts";
import { deploymentData } from "./contract.ts";
import type { Page } from "playwright";

export const settingsSchema = z.strictObject({
  chainId: z.literal(11155111), rpcUrl: z.string().refine(url => validRpcUrl(11155111, url)),
  rpcVisibility: z.literal("public-browser"), publisher: address, deployer: address,
}).refine(s => s.publisher !== "0x0000000000000000000000000000000000000000" && s.deployer !== "0x0000000000000000000000000000000000000000", "Publika avsändaradresser måste anges.");
export type SepoliaSettings = z.infer<typeof settingsSchema>;
export const sepoliaClient = (s: SepoliaSettings) => createPublicClient({ transport: http(s.rpcUrl, { retryCount: 0, timeout: profiles.sepolia.rpcTimeout }), cacheTime: 0 });
export type ProbeRequest = { jsonrpc: "2.0"; id: number; method: string; params: unknown[] };
export async function networkPreflight(s: SepoliaSettings, config?: TrustConfig) {
  const client = sepoliaClient(s);
  if (await client.getChainId() !== 11155111) throw new Error("RPC:n är inte Ethereum Sepolia L1 (11155111).");
  if ((await client.getBlock({ blockNumber: 0n })).hash !== SEPOLIA_GENESIS) throw new Error("Fel Sepolia-genesis.");
  const block = await client.getBlock({ blockTag: "latest" });
  const publisherCode = await client.getCode({ address: s.publisher, blockNumber: block.number });
  if (publisherCode && publisherCode !== "0x") throw new Error("Publiceraren måste vara en EOA utan kontraktskod.");
  let receiptHash = block.transactions[0] ?? zeroHash;
  if (config) {
    const snapshot = await readSnapshot(client, config);
    await assertSnapshot(client, snapshot);
    const deployed = await client.getBlock({ blockNumber: BigInt(config.deploymentBlock) });
    receiptHash = config.deploymentTxHash ?? deployed.transactions[0] ?? receiptHash;
  }
  const blockTag = numberToHex(block.number);
  const target = config?.domain.verifyingContract ?? s.publisher;
  const pairs: [string, unknown[]][] = [
    ["eth_chainId", []], ["eth_getBlockByNumber", ["0x0", false]], ["eth_getBlockByNumber", [blockTag, false]],
    ["eth_getCode", [target, blockTag]],
    ["eth_call", [{ to: target, data: config ? encodeFunctionData({ abi, functionName: "context" }) : "0x" }, blockTag]],
    ["eth_getLogs", [{ address: target, fromBlock: config ? numberToHex(BigInt(config.deploymentBlock)) : blockTag, toBlock: config ? numberToHex(BigInt(config.deploymentBlock)) : blockTag }]],
    ["eth_getTransactionReceipt", [receiptHash]],
  ];
  if (config) pairs.push(["eth_getBlockByNumber", [numberToHex(BigInt(config.deploymentBlock)), false]],
    ["eth_call", [{ to: target, data: encodeFunctionData({ abi, functionName: "head" }) }, blockTag]]);
  const requests: ProbeRequest[] = pairs.map(([method, params], i) => ({ jsonrpc: "2.0", id: i + 1, method, params }));
  // Verify the same methods server-side; browserPreflight independently tests CORS.
  for (const request of requests) {
    try {
      const result = await client.request(request as Parameters<PublicClient["request"]>[0]);
      if (request.method === "eth_getTransactionReceipt" && receiptHash !== zeroHash && !result) throw new Error("Receipt saknas.");
    }
    catch { throw new Error(`RPC-underlag saknas: ${request.method}. Ingen verifieringskontroll har försvagats.`); }
  }
  return { client, requests, receiptEvidenceAvailable: receiptHash !== zeroHash };
}
export async function checkBrowserRpc(page: Page, s: SepoliaSettings, requests: ProbeRequest[]) {
  const failed = await page.evaluate(async input => {
    for (const request of input.requests) {
      try {
        const response = await fetch(input.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(12000) });
        if (!response.ok) return request.method;
        const data = await response.json();
        if (data.error || !("result" in data)) return request.method;
        if (request.method === "eth_chainId" && data.result !== "0xaa36a7") return request.method;
        if (request.method === "eth_getBlockByNumber" && request.params[0] === "0x0" && data.result?.hash !== input.genesis) return request.method;
        if (request.method === "eth_getTransactionReceipt" && request.params[0] !== input.emptyHash && !data.result) return request.method;
      } catch { return request.method; }
    }
    return null;
  }, { url: s.rpcUrl, requests, genesis: SEPOLIA_GENESIS, emptyHash: zeroHash });
  if (failed) throw new Error(`Browseråtkomst/CORS eller RPC-underlag saknas för ${failed} från ${new URL(page.url()).origin}.`);
}
export async function browserPreflight(s: SepoliaSettings, requests: ProbeRequest[]) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // A test document with the actual application origin. No server is replaced.
    await page.route("http://127.0.0.1:5176/__rpc_preflight__", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Sepolia RPC preflight</title>" }));
    await page.goto("http://127.0.0.1:5176/__rpc_preflight__");
    await checkBrowserRpc(page, s, requests);
  } finally { await browser.close(); }
}
export async function deploymentPlan(s: SepoliaSettings) {
  const { client } = await networkPreflight(s);
  const data = await deploymentData(s.publisher);
  const estimate = await client.estimateGas({ account: s.deployer, data });
  const gas = (estimate * 120n + 99n) / 100n;
  const fees = await client.estimateFeesPerGas();
  const balance = await client.getBalance({ address: s.deployer });
  const maxCost = gas * fees.maxFeePerGas;
  if (balance < maxCost) throw new Error(`Deploysigneraren saknar test-ETH. Behöver täcka högst ${maxCost} wei med aktuell gasuppskattning.`);
  return { data, nonce: await client.getTransactionCount({ address: s.deployer, blockTag: "pending" }), gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, maxCost };
}
