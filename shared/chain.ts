import { createPublicClient, defineChain, http, keccak256, zeroHash } from "viem";
import type { PublicClient, Hex } from "viem";
import { abi, publicationEvent } from "./protocol.ts";
import type { Envelope, TrustConfig } from "./protocol.ts";

export function chainFor(config: TrustConfig) {
  return defineChain({ id: config.domain.chainId, name: "Lokalt EVM-nät", nativeCurrency: { name: "Test Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } });
}
export function rpcClient(config: TrustConfig) {
  return createPublicClient({ chain: chainFor(config), transport: http(config.rpcUrl, { retryCount: 0, timeout: 3500 }), cacheTime: 0 });
}
export type ChainSnapshot = { version: number; digest: Hex; blockNumber: bigint; blockHash: Hex; checkedAt: string };
export type PublicationProof = { txHash: Hex; publicationBlock: bigint };
export class VerificationMismatch extends Error {}
export async function readSnapshot(client: PublicClient, config: TrustConfig): Promise<ChainSnapshot> {
  const chainId = await client.getChainId();
  if (chainId !== config.domain.chainId) throw new Error("Fel EVM-nät.");
  const block = await client.getBlock({ blockTag: "latest" });
  const blockNumber = block.number;
  if (blockNumber < BigInt(config.deploymentBlock)) throw new Error("Deployment saknas på nätet.");
  const [genesis, deployment, code, context, head] = await Promise.all([
    client.getBlock({ blockNumber: 0n }),
    client.getBlock({ blockNumber: BigInt(config.deploymentBlock) }),
    client.getCode({ address: config.domain.verifyingContract, blockNumber }),
    client.readContract({ address: config.domain.verifyingContract, abi, functionName: "context", blockNumber }),
    client.readContract({ address: config.domain.verifyingContract, abi, functionName: "head", blockNumber }),
  ]);
  if (genesis.hash !== config.genesisHash || deployment.hash !== config.deploymentBlockHash ||
      !code || keccak256(code) !== config.codeHash) throw new Error("Nätet eller kontraktet motsvarar inte lokal deployment.");
  if (context[0].toLowerCase() !== config.publisher || context[1] !== config.organisation || context[2] !== config.feed || context[3] !== config.messageId)
    throw new Error("Kontraktets behörighet eller sammanhang är fel.");
  if ((head[0] === 0) !== (head[1] === zeroHash)) throw new Error("Ogiltig registerstatus.");
  return { version: head[0], digest: head[1], blockNumber, blockHash: block.hash, checkedAt: new Date().toISOString() };
}
export async function assertSnapshot(client: PublicClient, snapshot: ChainSnapshot) {
  if ((await client.getBlock({ blockNumber: snapshot.blockNumber })).hash !== snapshot.blockHash)
    throw new Error("Kontrollblocket ändrades. En ny kontroll krävs.");
}
export async function readRecord(client: PublicClient, config: TrustConfig, version: number, snapshot: ChainSnapshot) {
  return client.readContract({ address: config.domain.verifyingContract, abi, functionName: "records", args: [version], blockNumber: snapshot.blockNumber });
}
export async function publicationProof(client: PublicClient, config: TrustConfig, packet: Envelope, snapshot: ChainSnapshot): Promise<PublicationProof | null> {
  const [digest, publicationBlock] = await readRecord(client, config, packet.message.version, snapshot);
  if (digest === zeroHash) return null;
  if (digest !== packet.packageDigest) throw new VerificationMismatch("En annan publicering finns för denna version.");
  if (packet.message.version > 1) {
    const previous = await readRecord(client, config, packet.message.version - 1, snapshot);
    if (previous[0] !== packet.message.previousDigest) throw new VerificationMismatch("Föregångaren stämmer inte med registret.");
  }
  const logs = await client.getLogs({ address: config.domain.verifyingContract, event: publicationEvent,
    args: { version: packet.message.version, packageDigest: packet.packageDigest }, fromBlock: publicationBlock, toBlock: publicationBlock, strict: true });
  if (logs.length !== 1) throw new Error("Publiceringsunderlag saknas.");
  const receipt = await client.getTransactionReceipt({ hash: logs[0].transactionHash });
  if (receipt.status !== "success" || receipt.blockNumber !== publicationBlock || receipt.blockHash !== logs[0].blockHash ||
      receipt.to?.toLowerCase() !== config.domain.verifyingContract || receipt.from.toLowerCase() !== config.publisher || publicationBlock > snapshot.blockNumber)
    throw new Error("Lyckad och matchande kedjebekräftelse saknas.");
  return { txHash: receipt.transactionHash, publicationBlock };
}
