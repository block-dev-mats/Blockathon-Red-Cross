// Offline test infrastructure ONLY. A real temporary EVM uses Sepolia's chain ID.
// This facade substitutes the genesis hash and HTTPS destination to exercise the
// unchanged production validators. It is not evidence of public Sepolia or CORS.
import { createWalletClient, http, keccak256, parseEther, toHex } from "viem";
import type { LocalAccount } from "viem";
import type { BrowserContext } from "playwright";
import { chainFor } from "../shared/chain.ts";
import { parseConfig } from "../shared/protocol.ts";
import { SEPOLIA_GENESIS } from "../shared/profiles.ts";
import { deploymentData } from "../scripts/contract.ts";
import { resumeDeployment } from "../scripts/sepolia-deployment.ts";
import { sepoliaClient, settingsSchema } from "../scripts/sepolia-preflight.ts";

export type RpcRequest = { id: number; method: string; params: unknown[] };
export async function sepoliaFixture(loopback: string, account: LocalAccount) {
  if (!loopback.startsWith("http://127.0.0.1:")) throw new Error("Tests require loopback.");
  const originalFetch = globalThis.fetch;
  const url = `https://sepolia.test.invalid/${new URL(loopback).port}`;
  let fault: ((request: RpcRequest) => Response | undefined) | undefined;
  const serve = async (body: string): Promise<Response> => {
    const request = JSON.parse(body) as RpcRequest;
    const failure = fault?.(request); if (failure) return failure;
    const response = await originalFetch(loopback, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    const json = await response.json();
    if (request.method === "eth_getBlockByNumber" && request.params[0] === "0x0" && json.result) json.result.hash = SEPOLIA_GENESIS;
    return Response.json(json);
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = input instanceof Request ? input.url : String(input);
    if (target !== url) return originalFetch(input, init);
    return serve(String(init?.body ?? (input instanceof Request ? await input.text() : "")));
  }) as typeof fetch;
  try {
    const settings = settingsSchema.parse({ chainId: 11155111, rpcUrl: url, rpcVisibility: "public-browser", publisher: account.address, deployer: account.address });
    const client = sepoliaClient(settings);
    if (await client.getChainId() !== 11155111) throw new Error("Test chain ID mismatch.");
    const admin = (method: string, params: unknown[] = []) => originalFetch(loopback, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then(r => r.json());
    await admin("anvil_setBalance", [account.address, toHex(parseEther("100"))]);
    const rawTransaction = await account.signTransaction({ chainId: 11155111, type: "eip1559", nonce: 0, data: await deploymentData(settings.publisher),
      gas: 2_000_000n, maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
    const journal = { settings, rawTransaction, txHash: keccak256(rawTransaction) };
    const config = parseConfig(await resumeDeployment(client, journal, settings), "sepolia");
    const wallet = createWalletClient({ account, chain: chainFor(config), transport: http(url) });
    return { config, wallet, settings, journal, serve, admin,
      setFault(value?: typeof fault) { fault = value; },
      async route(context: BrowserContext) {
        await context.route(url, async route => {
          const response = await serve(route.request().postData() ?? "");
          await route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() });
        });
      },
      close() { globalThis.fetch = originalFetch; },
    };
  } catch (error) { globalThis.fetch = originalFetch; throw error; }
}
