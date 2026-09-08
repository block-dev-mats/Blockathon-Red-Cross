import { createWalletClient, custom } from "viem";
import type { EIP1193Provider, Hex } from "viem";
import { sepolia } from "viem/chains";
import { deploymentIdentity, planSchema, sepoliaClient, verifyDeployment } from "../../shared/deployment.ts";
import type { DeploymentPlan } from "../../shared/deployment.ts";
import { profiles, SEPOLIA_GENESIS } from "../../shared/profiles.ts";
import { hex32 } from "../../shared/protocol.ts";

export const deploymentCacheKey = (p: DeploymentPlan) => `crisis-deployment:${deploymentIdentity(p)}`;
export async function deployRequest(path: string, body?: unknown) {
  const response = await fetch(`/api/deploy${path}`, { method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Deploymentkontrollen kunde inte genomföras.");
  return result;
}
export async function connectDeployer(plan: DeploymentPlan, provider?: EIP1193Provider) {
  if (!provider) throw new Error("Ingen browser-wallet hittades. Öppna vyn i webbläsaren med MetaMask.");
  const wallet = createWalletClient({ chain: sepolia, transport: custom(provider, { retryCount: 0 }) });
  await wallet.requestAddresses();
  const check = async () => {
    if ((await wallet.getAddresses())[0]?.toLowerCase() !== plan.settings.deployer)
      throw new Error(`Fel konto. Välj deployer ${plan.settings.deployer} i MetaMask.`);
    if (await wallet.getChainId() !== 11155111) throw new Error("Fel nätverk. Välj Ethereum Sepolia (11155111) i MetaMask.");
  };
  await check();
  const client = sepoliaClient(plan.settings);
  if (await client.getChainId() !== 11155111 || (await client.getBlock({ blockNumber: 0n })).hash !== SEPOLIA_GENESIS)
    throw new Error("Browser-RPC:n motsvarar inte Sepolia.");
  const block = await client.getBlock();
  for (const address of [plan.settings.publisher, plan.settings.deployer]) {
    const code = await client.getCode({ address, blockNumber: block.number });
    if (code && code !== "0x") throw new Error("Publisher och deployer måste vara EOA utan kontraktskod.");
  }
  if (await client.getBalance({ address: plan.settings.deployer }) < BigInt(plan.maxCost)) throw new Error("Kontot saknar tillräckligt Sepolia test-ETH för uppskattad kostnad.");
  return { wallet, check };
}
export async function sendDeployment(plan: DeploymentPlan, provider: EIP1193Provider | undefined,
  save: (hash?: Hex) => void, request = deployRequest) {
  const { wallet, check } = await connectDeployer(plan, provider);
  const response = await request("/begin", { identity: deploymentIdentity(plan) });
  if (JSON.stringify(planSchema.parse(response.plan)) !== JSON.stringify(plan)) throw new Error("Deploymentunderlaget ändrades. Ingen transaktion skickas.");
  save(); // Browser durable intent too. A storage error prevents sending.
  await check();
  // A rejection or unknown send outcome never clears the durable intent or
  // silently sends again. A public hash from wallet history can resume it.
  const hash = hex32.parse(await wallet.sendTransaction({ account: plan.settings.deployer, data: plan.data,
    nonce: plan.nonce, gas: BigInt(plan.gas), maxFeePerGas: BigInt(plan.maxFeePerGas), maxPriorityFeePerGas: BigInt(plan.maxPriorityFeePerGas), value: 0n }));
  save(hash); // Before any API/RPC wait; timeout retains the exact hash.
  await request("/hash", { txHash: hash });
  return hash;
}
export async function confirmDeployment(plan: DeploymentPlan, hash: Hex, request = deployRequest) {
  await request("/hash", { txHash: hash });
  const client = sepoliaClient(plan.settings);
  await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: profiles.sepolia.receiptTimeout, pollingInterval: profiles.sepolia.receiptPollInterval });
  const browserConfig = await verifyDeployment(client, plan, hash);
  const { deployed } = await request("/confirm", { txHash: hash });
  if (JSON.stringify(deployed) !== JSON.stringify(browserConfig)) throw new Error("Serverns deployment avviker från browserkontrollen.");
  return browserConfig;
}
