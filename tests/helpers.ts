import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { createWalletClient, http } from "viem";
import type { EIP1193Provider, Hex, LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { deploy, launchAnvil } from "../scripts/evm.ts";
import { startApi } from "../server/api.ts";
import { MessageStore } from "../server/storage.ts";
import { chainFor, rpcClient } from "../shared/chain.ts";
import { envelopeSchema, freezeDraft, packageDigest, typedData } from "../shared/protocol.ts";
import type { TrustConfig } from "../shared/protocol.ts";
import { sepoliaFixture } from "./sepolia-fixture.ts";

export async function unusedPort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
export async function environment(options: { profile?: "local" | "sepolia"; account?: LocalAccount } = {}) {
  const root = await mkdtemp("/private/tmp/crisis-mvp-test-");
  const chainPort = await unusedPort(), apiPort = await unusedPort(), frontendPort = await unusedPort();
  const statePath = `${root}/chain.json`, dbPath = `${root}/demo.sqlite`, backupPath = `${root}/snapshot.json`;
  const chainId = options.profile === "sepolia" ? 11155111 : 31337;
  let network = await launchAnvil(chainPort, statePath, chainId);
  const account = options.account ?? privateKeyToAccount(generatePrivateKey()); // Test process only; never returned to the browser.
  const fixture = options.profile === "sepolia" ? await sepoliaFixture(network.url, account) : undefined;
  const config = fixture?.config ?? await deploy(network.url, account.address);
  new MessageStore(dbPath).close();
  let api = await startApi(config, dbPath, apiPort, `http://127.0.0.1:${frontendPort}`);
  const client = rpcClient(config);
  const wallet = createWalletClient({ account, chain: chainFor(config), transport: http(config.rpcUrl) });
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  return {
    root, dbPath, backupPath, statePath, config, client, wallet, account, frontendPort, apiUrl, fixture,
    get api() { return api; },
    restartApi: async () => { await api.close(); api = await startApi(config, dbPath, apiPort, `http://127.0.0.1:${frontendPort}`); },
    stopChain: () => network.stop(),
    restartChain: async () => { await network.stop(); network = await launchAnvil(chainPort, statePath, chainId, fixture ? undefined : config.genesisHash); },
    close: async () => { await api.close(); await network.stop(); fixture?.close(); await rm(root, { recursive: true, force: true }); },
    post: async (path: string, data: unknown) => fetch(`${apiUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }),
    receive: async () => (await (await fetch(`${apiUrl}/api/messages`)).json()).deliveries.map((d: { packet: unknown }) => d.packet) as unknown[],
  };
}
export type Environment = Awaited<ReturnType<typeof environment>>;
export async function signed(env: Environment, body: string, version = 1, previousDigest: Hex = `0x${"0".repeat(64)}` as Hex) {
  const draft = freezeDraft(body, env.config, { version: version - 1, digest: previousDigest });
  return envelopeSchema.parse({ ...draft, packageDigest: packageDigest(draft), signature: await env.account.signTypedData(typedData(draft)) });
}
// Test-only EIP-1193 device: real viem signatures and raw local transactions.
// Installed explicitly by tests; the application cannot import it or enable it.
export function testDevice(env: Environment, overrides: Record<string, unknown> = {}): EIP1193Provider {
  return { request: async ({ method, params }: { method: string; params?: unknown }) => {
    if (Object.hasOwn(overrides, method)) {
      const override = overrides[method]; if (override instanceof Error) throw override; return override;
    }
    if (method === "eth_accounts" || method === "eth_requestAccounts") return [env.account.address];
    if (method === "eth_chainId") return `0x${env.config.domain.chainId.toString(16)}`;
    if (method === "eth_signTypedData_v4") {
      const data = JSON.parse((params as string[])[1]);
      return env.account.signTypedData(data);
    }
    if (method === "eth_sendTransaction") {
      const tx = (params as { to: Hex; data: Hex; gas?: Hex; value?: Hex }[])[0];
      return env.wallet.sendTransaction({ to: tx.to, data: tx.data, gas: tx.gas ? BigInt(tx.gas) : undefined, value: tx.value ? BigInt(tx.value) : undefined });
    }
    throw new Error(`Unsupported test-device method: ${method}`);
  } } as EIP1193Provider;
}
export function configAt(config: TrustConfig, rpcUrl: string): TrustConfig { return { ...config, rpcUrl }; }
