import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseEther, toHex, toBytes } from "viem";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { configSchema } from "../shared/protocol.ts";

export async function launchAnvil(port: number, statePath?: string) {
  const child = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--accounts", "0", "--silent",
    ...(statePath ? ["--state", statePath, "--state-interval", "1", "--preserve-historical-states"] : [])], { stdio: ["ignore", "ignore", "pipe"] });
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
export async function fund(rpcUrl: string, address: Address) {
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
  const artifact = JSON.parse(await readFile(new URL("../artifacts/CrisisRegistry.sol/CrisisRegistry.json", import.meta.url), "utf8"));
  const organisation = keccak256(toBytes("Demoorganisation"));
  const feed = keccak256(toBytes("Ovning Norr"));
  const messageId = keccak256(toBytes("KRIS-DEMO-001"));
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
