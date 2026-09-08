import { z } from "zod";
import { hashTypedData, keccak256, parseAbi, recoverTypedDataAddress, toBytes, zeroHash } from "viem";
import { profileById, SEPOLIA_GENESIS, validRpcUrl } from "./profiles.ts";
import type { ProfileId } from "./profiles.ts";

export const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(v => v.toLowerCase() as `0x${string}`);
export const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(v => v.toLowerCase() as `0x${string}`);
const wellFormed = (s: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s);
export const bodySchema = z.string().min(1).max(4000).refine(wellFormed, "Texten innehåller ogiltig Unicode.");
export const messageSchema = z.strictObject({
  bodyHash: hex32, sender: address, organisation: hex32, feed: hex32, messageId: hex32,
  version: z.number().int().min(1).max(4294967295), previousDigest: hex32,
});
export const domainSchema = z.strictObject({
  name: z.literal("CrisisMessage"), version: z.literal("1"), chainId: z.union([z.literal(31337), z.literal(11155111)]), verifyingContract: address,
});
export const unsignedSchema = z.strictObject({ body: bodySchema, domain: domainSchema, message: messageSchema });
export const envelopeSchema = unsignedSchema.extend({
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform(v => v.toLowerCase() as `0x${string}`),
  packageDigest: hex32,
});
export const configSchema = z.strictObject({
  domain: domainSchema,
  rpcUrl: z.string(),
  rpcVisibility: z.literal("public-browser").optional(),
  deploymentTxHash: hex32.optional(),
  publisher: address, organisation: hex32, feed: hex32, messageId: hex32,
  genesisHash: hex32, deploymentBlock: z.string().regex(/^[0-9]+$/), deploymentBlockHash: hex32, codeHash: hex32,
}).refine(c => validRpcUrl(c.domain.chainId, c.rpcUrl), "RPC-adressen är inte tillåten för nätverket.")
  .refine(c => c.domain.chainId !== 11155111 || c.rpcVisibility === "public-browser", "Sepolia kräver en uttryckligen publik browser-RPC.");
export type TrustConfig = z.infer<typeof configSchema>;
export function parseConfig(raw: unknown, profile: ProfileId): TrustConfig {
  const config = configSchema.parse(raw);
  if (config.domain.chainId !== profileById(profile).chainId) throw new Error("Deploymenten tillhör inte den valda profilen.");
  if (profile === "sepolia" && config.genesisHash !== SEPOLIA_GENESIS) throw new Error("Fel genesis för Ethereum Sepolia L1.");
  return config;
}
export const deploymentIdentity = (c: TrustConfig) => `${c.domain.chainId}:${c.genesisHash}:${c.domain.verifyingContract}:${c.deploymentBlockHash}:${c.codeHash}`;
export type Unsigned = z.infer<typeof unsignedSchema>;
export type Envelope = z.infer<typeof envelopeSchema>;
export const types = { Message: [
  { name: "bodyHash", type: "bytes32" }, { name: "sender", type: "address" },
  { name: "organisation", type: "bytes32" }, { name: "feed", type: "bytes32" },
  { name: "messageId", type: "bytes32" }, { name: "version", type: "uint32" },
  { name: "previousDigest", type: "bytes32" },
] } as const;
export const abi = parseAbi([
  "function context() view returns (address, bytes32, bytes32, bytes32)",
  "function head() view returns (uint32, bytes32)",
  "function records(uint32) view returns (bytes32 packageDigest, uint256 blockNumber)",
  "function digest((bytes32 bodyHash, address sender, bytes32 organisation, bytes32 feed, bytes32 messageId, uint32 version, bytes32 previousDigest) m) view returns (bytes32)",
  "function publish((bytes32 bodyHash, address sender, bytes32 organisation, bytes32 feed, bytes32 messageId, uint32 version, bytes32 previousDigest) m, bytes signature)",
  "event Published(uint32 indexed version, bytes32 indexed packageDigest)",
]);
export const publicationEvent = abi[5];
export function typedData(packet: Unsigned) {
  return { domain: packet.domain, types, primaryType: "Message" as const, message: packet.message };
}
export const bodyHash = (body: string) => keccak256(toBytes(bodySchema.parse(body)));
export const packageDigest = (packet: Unsigned) => hashTypedData(typedData(packet));
export function freezeDraft(body: string, config: TrustConfig, head: {version: number; digest: `0x${string}`}): Unsigned {
  const packet = unsignedSchema.parse({ body, domain: config.domain, message: {
    bodyHash: bodyHash(body), sender: config.publisher, organisation: config.organisation,
    feed: config.feed, messageId: config.messageId, version: head.version + 1, previousDigest: head.digest,
  } });
  Object.freeze(packet.domain); Object.freeze(packet.message); return Object.freeze(packet);
}
export function assertContext(packet: Unsigned, config: TrustConfig) {
  const m = packet.message, d = packet.domain, expected = config.domain;
  if (d.name !== expected.name || d.version !== expected.version || d.chainId !== expected.chainId ||
      d.verifyingContract !== expected.verifyingContract || m.sender !== config.publisher ||
      m.organisation !== config.organisation || m.feed !== config.feed || m.messageId !== config.messageId)
    throw new Error("Fel avsändare, sammanhang eller signeringsdomän.");
  if ((m.version === 1) !== (m.previousDigest === zeroHash)) throw new Error("Ogiltig versionsföljd.");
}
export async function verifyEnvelope(raw: unknown, config: TrustConfig): Promise<Envelope> {
  const packet = envelopeSchema.parse(raw);
  assertContext(packet, config);
  if (bodyHash(packet.body) !== packet.message.bodyHash) throw new Error("Texten stämmer inte med innehållshashen.");
  if (packageDigest(packet) !== packet.packageDigest) throw new Error("Paketets digest stämmer inte.");
  const signer = await recoverTypedDataAddress({ ...typedData(packet), signature: packet.signature });
  if (signer.toLowerCase() !== config.publisher) throw new Error("Signaturen är inte från den behöriga publiceraren.");
  Object.freeze(packet.domain); Object.freeze(packet.message); return Object.freeze(packet);
}
