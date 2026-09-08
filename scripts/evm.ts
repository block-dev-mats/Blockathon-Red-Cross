import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseEther, toHex } from "viem";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { configSchema } from "../shared/protocol.ts";
import { contractArtifact, demoContext } from "./contract.ts";

async function spawnAnvil(port: number, chainId: 31337 | 11155111, persistence: string[]) {
  const child = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(chainId), "--accounts", "0", "--silent",
    ...persistence], { stdio: ["ignore", "ignore", "pipe"] });
  let spawnError = false;
  child.on("error", () => { spawnError = true; });
  const url = `http://127.0.0.1:${port}`;
  const client = createPublicClient({ transport: http(url, { retryCount: 0, timeout: 500 }) });
  for (let attempt = 0; attempt < 60; attempt++) {
    if (spawnError || child.exitCode !== null) throw new Error("Anvil kunde inte starta; kontrollera installation och port.");
    try {
      await client.getChainId();
      return { child, url, stop: async () => {
        if (child.exitCode !== null) return;
        const done = once(child, "exit"); child.kill("SIGINT"); await done;
      } };
    } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  child.kill("SIGINT"); throw new Error("Anvil svarar inte.");
}
export async function launchAnvil(port: number, statePath?: string, chainId: 31337 | 11155111 = 31337, genesisHash?: Hex) {
  if (!statePath || !genesisHash) return spawnAnvil(port, chainId, statePath ? ["--state", statePath, "--state-interval", "1", "--preserve-historical-states"] : []);
  // Foundry 1.5 snapshots can contain several genesis headers from earlier
  // restarts. Their load order otherwise determines the block-number-0 lookup.
  // Resolve the ORIGINAL trusted header by hash in a read-only probe, retain
  // every saved record and load that exact header last. Never change trust.
  const saved = JSON.parse(await readFile(statePath, "utf8"));
  const probe = await spawnAnvil(port, chainId, ["--load-state", statePath, "--preserve-historical-states"]);
  let timestamp: string;
  try {
    const client = createPublicClient({ transport: http(probe.url, { retryCount: 0 }) });
    const header = await client.request({ method: "eth_getBlockByHash", params: [genesisHash, false] });
    if (!header || header.number !== "0x0" || !Array.isArray(saved.blocks)) throw new Error("Sparad betrodd genesis saknas.");
    const index = saved.blocks.findIndex((block: { header: Record<string, unknown> }) =>
      Object.entries(block.header).every(([key, value]) => (header as unknown as Record<string, unknown>)[key] === value));
    if (index < 0) throw new Error("Betrodd genesisheader saknas i Anvil-historiken.");
    const [original] = saved.blocks.splice(index, 1); saved.blocks.push(original);
    timestamp = BigInt(header.timestamp).toString();
  } finally { await probe.stop(); }
  const directory = await mkdtemp(join(tmpdir(), "crisis-anvil-load-"));
  try {
    const loadPath = join(directory, "history.json");
    await writeFile(loadPath, JSON.stringify(saved), { mode: 0o600 });
    const network = await spawnAnvil(port, chainId, ["--timestamp", timestamp, "--load-state", loadPath,
      "--dump-state", statePath, "--state-interval", "1", "--preserve-historical-states"]);
    try {
      const client = createPublicClient({ transport: http(network.url, { retryCount: 0 }) });
      if ((await client.getBlock({ blockNumber: 0n })).hash !== genesisHash) throw new Error("Anvil kunde inte återläsa betrodd genesis.");
      return network;
    } catch (error) { await network.stop(); throw error; }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
export async function fund(rpcUrl: string, address: Address) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(rpcUrl)) throw new Error("Anvil-administration tillåts endast på loopback.");
  if (await createPublicClient({ transport: http(rpcUrl) }).getChainId() !== 31337) throw new Error("Anvil-administration kräver local-profilens chain ID.");
  const response = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [address, toHex(parseEther("100"))] }) });
  const result = await response.json(); if (result.error) throw new Error("Lokal testfinansiering misslyckades.");
}
export async function deploy(rpcUrl: string, publisher: Address) {
  const chain = defineChain({ id: 31337, name: "Local demo", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const client = createPublicClient({ chain, transport: http(rpcUrl), cacheTime: 0 });
  if (await client.getChainId() !== 31337 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(rpcUrl)) throw new Error("Endast lokalt demonnät tillåts.");
  // Ephemeral deployment key. Never used for publication and never written/logged.
  const deployer = privateKeyToAccount(generatePrivateKey());
  await fund(rpcUrl, deployer.address); await fund(rpcUrl, publisher);
  const wallet = createWalletClient({ chain, transport: http(rpcUrl), account: deployer });
  const artifact = await contractArtifact();
  const { organisation, feed, messageId } = demoContext;
  const tx = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object as Hex, args: [publisher, organisation, feed, messageId] });
  const receipt = await client.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("Deployment misslyckades.");
  const code = await client.getCode({ address: receipt.contractAddress });
  return configSchema.parse({ rpcUrl, publisher, organisation, feed, messageId,
    domain: { name: "CrisisMessage", version: "1", chainId: 31337, verifyingContract: receipt.contractAddress },
    genesisHash: (await client.getBlock({ blockNumber: 0n })).hash,
    deploymentBlock: receipt.blockNumber.toString(), deploymentBlockHash: receipt.blockHash, codeHash: keccak256(code!),
  });
}
