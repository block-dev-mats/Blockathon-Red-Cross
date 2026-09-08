import { createPublicClient, defineChain, http, keccak256, zeroHash, encodeEventTopics } from "viem";
import type { PublicClient, Hex } from "viem";
import { abi, publicationEvent } from "./protocol.ts";
import type { Envelope, TrustConfig } from "./protocol.ts";
import { profileForChain } from "./profiles.ts";

export function chainFor(config: TrustConfig) {
  return defineChain({ id: config.domain.chainId, name: profileForChain(config.domain.chainId).label, nativeCurrency: { name: "Test Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } });
}
export function rpcClient(config: TrustConfig) {
  const profile = profileForChain(config.domain.chainId);
  let fetchFn = pacedEndpoints.get(config.rpcUrl);
  if (profile.rpcMinInterval && !fetchFn) {
    fetchFn = pacedFetch(profile.rpcMinInterval);
    pacedEndpoints.set(config.rpcUrl, fetchFn);
  }
  return createPublicClient({ chain: chainFor(config), transport: http(config.rpcUrl, { retryCount: 0, timeout: profile.rpcTimeout, fetchFn }), cacheTime: 0 });
}
// Shared by clients in this browser tab/server process. Bound the queue and
// space request starts; never retry, cache evidence or change RPC endpoints.
const pacedEndpoints = new Map<string, typeof fetch>();
export function pacedFetch(interval: number, send: typeof fetch = fetch): typeof fetch {
  let next = 0, queued = 0;
  return async (input, init) => {
    if (queued >= 32) throw new Error("RPC rate limit: kontrollkön är full");
    const delay = Math.max(0, next - Date.now()); next = Date.now() + delay + interval;
    queued++;
    try {
      if (delay) await new Promise<void>((resolve, reject) => {
        const signal = init?.signal;
        const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("RPC timeout")); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, delay);
        if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      });
      init?.signal?.throwIfAborted();
      return await send(input, init);
    } finally { queued--; }
  };
}
export type ChainSnapshot = { version: number; digest: Hex; blockNumber: bigint; blockHash: Hex; checkedAt: string };
export type PublicationProof = { txHash: Hex; publicationBlock: bigint };
export class VerificationMismatch extends Error {}
export class ChainCheckUnavailable extends Error {
  constructor(readonly step: string, cause: unknown) {
    const details = cause instanceof Error ? `${cause.name} ${cause.message}` : "";
    const reason = /rate limit|exceeds defined limit|429/i.test(details) ? "RPC:n begränsar anropstakten" :
      /timeout|timed out/i.test(details) ? "RPC-anropet tog för lång tid" : "RPC-underlaget kunde inte läsas";
    super(`${reason} · ${step}. Försök kontrollera igen.`, { cause });
  }
}
async function checked<T>(step: string, read: () => Promise<T>): Promise<T> {
  try { return await read(); } catch (cause) { throw new ChainCheckUnavailable(step, cause); }
}
export async function readSnapshot(client: PublicClient, config: TrustConfig): Promise<ChainSnapshot> {
  const chainId = await checked("chain ID", () => client.getChainId());
  if (chainId !== config.domain.chainId) throw new Error("Fel EVM-nät.");
  const block = await checked("aktuellt kontrollblock", () => client.getBlock({ blockTag: "latest" }));
  const blockNumber = block.number;
  if (blockNumber < BigInt(config.deploymentBlock)) throw new Error("Deployment saknas på nätet.");
  const [genesis, deployment, code, context, head] = await Promise.all([
    checked("genesis", () => client.getBlock({ blockNumber: 0n })),
    checked("deploymentblock", () => client.getBlock({ blockNumber: BigInt(config.deploymentBlock) })),
    checked("kontraktskod", () => client.getCode({ address: config.domain.verifyingContract, blockNumber })),
    checked("immutable kontext", () => client.readContract({ address: config.domain.verifyingContract, abi, functionName: "context", blockNumber })),
    checked("head", () => client.readContract({ address: config.domain.verifyingContract, abi, functionName: "head", blockNumber })),
  ]);
  if (genesis.hash !== config.genesisHash || deployment.hash !== config.deploymentBlockHash ||
      !code || keccak256(code) !== config.codeHash) throw new Error("Nätet eller kontraktet motsvarar inte vald deployment.");
  if (context[0].toLowerCase() !== config.publisher || context[1] !== config.organisation || context[2] !== config.feed || context[3] !== config.messageId)
    throw new Error("Kontraktets behörighet eller sammanhang är fel.");
  if ((head[0] === 0) !== (head[1] === zeroHash)) throw new Error("Ogiltig registerstatus.");
  return { version: head[0], digest: head[1], blockNumber, blockHash: block.hash, checkedAt: new Date().toISOString() };
}
export async function assertSnapshot(client: PublicClient, snapshot: ChainSnapshot) {
  if ((await checked("kontrollblockets hash", () => client.getBlock({ blockNumber: snapshot.blockNumber }))).hash !== snapshot.blockHash)
    throw new Error("Kontrollblocket ändrades. En ny kontroll krävs.");
}
export async function readRecord(client: PublicClient, config: TrustConfig, version: number, snapshot: ChainSnapshot) {
  return checked("versionsregister", () => client.readContract({ address: config.domain.verifyingContract, abi, functionName: "records", args: [version], blockNumber: snapshot.blockNumber }));
}
export async function publicationProof(client: PublicClient, config: TrustConfig, packet: Envelope, snapshot: ChainSnapshot): Promise<PublicationProof | null> {
  const [digest, publicationBlock] = await readRecord(client, config, packet.message.version, snapshot);
  if (digest === zeroHash) return null;
  if (digest !== packet.packageDigest) throw new VerificationMismatch("En annan publicering finns för denna version.");
  if (packet.message.version > 1) {
    const previous = await readRecord(client, config, packet.message.version - 1, snapshot);
    if (previous[0] !== packet.message.previousDigest) throw new VerificationMismatch("Föregångaren stämmer inte med registret.");
  }
  const logs = await checked("Published-event", () => client.getLogs({ address: config.domain.verifyingContract, event: publicationEvent,
    args: { version: packet.message.version, packageDigest: packet.packageDigest }, fromBlock: publicationBlock, toBlock: publicationBlock, strict: true }));
  if (logs.length !== 1) throw new Error("Publiceringsunderlag saknas.");
  const log = logs[0];
  const topics = encodeEventTopics({ abi: [publicationEvent], eventName: "Published",
    args: { version: packet.message.version, packageDigest: packet.packageDigest } });
  const matchesEvent = (entry: { address: string; topics: readonly Hex[]; data: Hex }) =>
    entry.address.toLowerCase() === config.domain.verifyingContract && entry.data === "0x" &&
    entry.topics.length === topics.length && entry.topics.every((topic, index) => topic === topics[index]);
  if (!matchesEvent(log) || log.removed || log.blockNumber !== publicationBlock) throw new Error("Registereventet avviker.");
  const receipt = await checked("publiceringens receipt", () => client.getTransactionReceipt({ hash: log.transactionHash }));
  const included = receipt.logs.filter(matchesEvent);
  // EIP-7702 wallets may enter via a router. The publication authority is the
  // exact registry event IN this successful receipt, not its outer `to` field.
  if (receipt.status !== "success" || receipt.transactionHash !== log.transactionHash || receipt.blockNumber !== publicationBlock ||
      receipt.blockHash !== log.blockHash || receipt.from.toLowerCase() !== config.publisher || publicationBlock > snapshot.blockNumber ||
      included.length !== 1 || included[0].transactionHash !== receipt.transactionHash || included[0].blockHash !== receipt.blockHash ||
      included[0].blockNumber !== publicationBlock || included[0].logIndex !== log.logIndex || included[0].removed)
    throw new Error("Lyckad och matchande kedjebekräftelse saknas.");
  if ((await checked("publiceringsblockets hash", () => client.getBlock({ blockNumber: publicationBlock }))).hash !== receipt.blockHash)
    throw new Error("Publiceringsblocket ändrades. En ny kontroll krävs.");
  return { txHash: receipt.transactionHash, publicationBlock };
}
