import { createWalletClient, custom } from "viem";
import type { EIP1193Provider, Hex } from "viem";
import { abi, assertContext, bodyHash, envelopeSchema, packageDigest, typedData, unsignedSchema, verifyEnvelope } from "../../shared/protocol.ts";
import type { Envelope, TrustConfig, Unsigned } from "../../shared/protocol.ts";
import { assertSnapshot, chainFor, publicationProof, readSnapshot, rpcClient } from "../../shared/chain.ts";
import { profileForChain } from "../../shared/profiles.ts";
import { z } from "zod";

export type Attempt = { draft: Unsigned; packet?: Envelope; txHash?: Hex; transactionRequested?: boolean };
export function restoreAttempt(raw: unknown, config: TrustConfig): Attempt {
  const attempt = z.strictObject({ draft: unsignedSchema, packet: envelopeSchema.optional(),
    txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(), transactionRequested: z.boolean().optional() }).parse(raw);
  assertContext(attempt.draft, config);
  if (bodyHash(attempt.draft.body) !== attempt.draft.message.bodyHash ||
      ((attempt.txHash || attempt.transactionRequested) && !attempt.packet) ||
      (attempt.packet && (packageDigest(attempt.packet) !== packageDigest(attempt.draft) || attempt.packet.body !== attempt.draft.body)))
    throw new Error("Det sparade paketet motsvarar inte den granskade texten.");
  Object.freeze(attempt.draft.domain); Object.freeze(attempt.draft.message); Object.freeze(attempt.draft);
  return attempt as Attempt;
}
export function isCompletedAttempt(raw: unknown, config: TrustConfig, packet: Envelope) {
  const current = restoreAttempt(raw, config);
  return current.draft.body === packet.body && JSON.stringify(current.draft.domain) === JSON.stringify(packet.domain) &&
    JSON.stringify(current.draft.message) === JSON.stringify(packet.message) &&
    (!current.packet || JSON.stringify(current.packet) === JSON.stringify(packet));
}
export type Stage = "wallet" | "signing" | "storing" | "transaction" | "confirming" | "complete";
export class StorageCheckUnavailable extends Error {}
export async function apiPost(path: string, body: unknown, timeout = 10000) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  if (!response.ok) {
    const detail = z.object({ code: z.literal("CHAIN_CHECK_UNAVAILABLE"), error: z.string().max(200) }).safeParse(await response.json().catch(() => null));
    throw new StorageCheckUnavailable(detail.success ? `Lagringens kedjekontroll: ${detail.data.error}` : "Lagringen kunde inte bekräftas. Försök igen med samma paket.");
  }
}
const defaultPost = (config: TrustConfig) => (path: string, body: unknown) => apiPost(path, body, profileForChain(config.domain.chainId).apiTimeout);
export async function reconcileAttempt(config: TrustConfig, value: Attempt, post = defaultPost(config), client = rpcClient(config)) {
  const attempt = restoreAttempt(value, config);
  const packet = attempt.packet ? await verifyEnvelope(attempt.packet, config) : undefined;
  const snapshot = await readSnapshot(client, config);
  const proof = packet ? await publicationProof(client, config, packet, snapshot) : null;
  await assertSnapshot(client, snapshot);
  if (!packet || !proof) return { snapshot, result: null };
  // Durable storage/confirmation can be retried without ANY wallet access.
  await post("/api/messages", packet);
  await post(`/api/messages/${packet.packageDigest}/confirm`, { txHash: proof.txHash });
  const latest = await readSnapshot(client, config);
  await assertSnapshot(client, snapshot); await assertSnapshot(client, latest);
  return { snapshot: latest, result: { packet, proof, snapshot: latest, recovered: true } };
}
export function mayHaveSent(attempt: Attempt) { return Boolean(attempt.txHash || attempt.transactionRequested); }
export async function publishAttempt(config: TrustConfig, provider: EIP1193Provider | undefined, attempt: Attempt,
  stage: (stage: Stage) => void, persist: (attempt: Attempt) => void, post = defaultPost(config)) {
  const restored = restoreAttempt(attempt, config);
  attempt.draft = restored.draft;
  const profile = profileForChain(config.domain.chainId);
  const client = rpcClient(config);
  if (attempt.packet) {
    stage("confirming");
    const recovered = await reconcileAttempt(config, attempt, post, client);
    if (recovered.result) { stage("complete"); return recovered.result; }
    if (attempt.txHash) {
      const receipt = await client.waitForTransactionReceipt({ hash: attempt.txHash, confirmations: 1, timeout: profile.receiptTimeout, pollingInterval: profile.receiptPollInterval });
      if (receipt.status !== "success") throw new Error("Transaktionen misslyckades. Försöket behålls för kontroll.");
      const after = await reconcileAttempt(config, attempt, post, client);
      if (!after.result) throw new Error("Matchande publiceringspost saknas.");
      stage("complete"); return after.result;
    }
    if (attempt.transactionRequested) throw new Error("Walletens transaktionsutfall är okänt. Fortsätt kontrollera samma paket; ingen ny transaktion skickas.");
  }
  stage("wallet");
  if (!provider) throw new Error("Ingen browser-wallet hittades. Öppna publiceringsvyn i en webbläsare med en installerad wallet.");
  const wallet = createWalletClient({ chain: chainFor(config), transport: custom(provider, { retryCount: 0 }) });
  const ensureAccount = async () => {
    const accounts = await wallet.getAddresses();
    if (accounts[0]?.toLowerCase() !== config.publisher) throw new Error("Fel konto. Välj Alex förkonfigurerade testwallet.");
    if (await wallet.getChainId() !== config.domain.chainId) throw new Error(`Fel nätverk. Välj ${profile.label} med chain ID ${profile.chainId}.`);
  };
  await wallet.requestAddresses(); await ensureAccount();
  let snapshot = await readSnapshot(client, config);
  if (!attempt.packet) {
    if (attempt.draft.message.version !== snapshot.version + 1 || attempt.draft.message.previousDigest !== snapshot.digest)
      throw new Error("En ny version har publicerats. Granska texten igen mot aktuell head.");
    stage("signing"); await ensureAccount();
    const signature = await wallet.signTypedData({ account: config.publisher, ...typedData(attempt.draft) });
    attempt.packet = envelopeSchema.parse({ ...attempt.draft, signature, packageDigest: packageDigest(attempt.draft) });
    persist({ ...attempt });
  }
  const packet = await verifyEnvelope(attempt.packet, config);
  stage("storing");
  await post("/api/messages", packet); // No transaction if durable storage fails.
  snapshot = await readSnapshot(client, config);
  let proof = await publicationProof(client, config, packet, snapshot);
  if (!proof) {
    if (!attempt.txHash) {
      if (attempt.transactionRequested) throw new Error("Walletens transaktionsutfall är okänt. Kontrollera dess historik och försök kontrollera samma paket igen. Ingen ny transaktion skickas.");
      if (packet.message.version !== snapshot.version + 1 || packet.message.previousDigest !== snapshot.digest)
        throw new Error("Versionskonflikt. En annan uppdatering har redan publicerats.");
      stage("transaction"); await ensureAccount();
      attempt.transactionRequested = true; persist({ ...attempt });
      try {
        attempt.txHash = await wallet.writeContract({ account: config.publisher, address: config.domain.verifyingContract, abi, functionName: "publish", args: [packet.message, packet.signature] });
      } catch (error) {
        if (error instanceof Error && /rejected|denied/i.test(error.message)) { attempt.transactionRequested = false; persist({ ...attempt }); }
        throw error;
      }
      persist({ ...attempt });
    }
    stage("confirming");
    const receipt = await client.waitForTransactionReceipt({ hash: attempt.txHash, confirmations: 1, timeout: profile.receiptTimeout, pollingInterval: profile.receiptPollInterval });
    if (receipt.status !== "success") {
      delete attempt.txHash; attempt.transactionRequested = false; persist({ ...attempt });
      throw new Error("Transaktionen misslyckades. Publiceringen är inte färdig.");
    }
    snapshot = await readSnapshot(client, config);
    proof = await publicationProof(client, config, packet, snapshot);
    if (!proof || proof.txHash !== receipt.transactionHash) throw new Error("Matchande publiceringspost saknas.");
  }
  stage("confirming");
  await assertSnapshot(client, snapshot);
  attempt.txHash = proof.txHash; persist({ ...attempt });
  await post(`/api/messages/${packet.packageDigest}/confirm`, { txHash: proof.txHash });
  stage("complete");
  return { packet, proof, snapshot, recovered: false };
}
