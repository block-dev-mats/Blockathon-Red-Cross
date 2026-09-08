import { deploymentIdentity, verifyEnvelope } from "../../shared/protocol.ts";
import type { Envelope, TrustConfig } from "../../shared/protocol.ts";
import { assertSnapshot, publicationProof, readSnapshot, rpcClient, VerificationMismatch, ChainCheckUnavailable } from "../../shared/chain.ts";
import type { ChainSnapshot, PublicationProof } from "../../shared/chain.ts";
import { profileForChain } from "../../shared/profiles.ts";

export type CheckedMessage = {
  packet?: Envelope; body: string; signature: "passed" | "failed";
  status: "current" | "superseded" | "pending" | "failed" | "unavailable";
  reason?: string; proof?: PublicationProof; cached: boolean;
};
export type InboxState = {
  checking: boolean; entries: CheckedMessage[]; snapshot?: ChainSnapshot;
  lastSuccess?: string; chainError?: string; deliveryError?: string; missingHead: boolean;
};
export const emptyInbox: InboxState = { checking: true, entries: [], missingHead: false };
export async function fetchDeliveries(timeout = 4500): Promise<unknown[]> {
  const response = await fetch("/api/messages", { cache: "no-store", signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error("Meddelandetjänsten svarar inte.");
  const text = await response.text();
  if (text.length > 4_000_000) throw new Error("Leveransen är för stor.");
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.deliveries) || data.deliveries.length > 1000) throw new Error("Ogiltigt leveransformat.");
  return data.deliveries.map((item: unknown) => item && typeof item === "object" && "packet" in item ? item.packet : item);
}
export const cacheKey = (config: TrustConfig) => `crisis-inbox:${deploymentIdentity(config)}`;

// A generation identifies this exact fetch/check operation. No result is keyed by a
// database ID or a claimed digest. Every fetched and cached packet is revalidated.
export class InboxVerifier {
  private generation = 0;
  private accepted: unknown[];
  private state: InboxState = emptyInbox;
  readonly client;
  constructor(readonly config: TrustConfig, readonly receive = () => fetchDeliveries(profileForChain(config.domain.chainId).apiTimeout), initialCache: unknown[] = [],
    readonly save: (packets: Envelope[]) => void = () => {}) {
    this.accepted = initialCache.slice(0, 1000);
    this.client = rpcClient(config);
  }
  dispose() { this.generation++; }
  async refresh(onChange: (state: InboxState) => void): Promise<void> {
    const generation = ++this.generation;
    this.state = { ...this.state, checking: true, snapshot: undefined, missingHead: false,
      entries: this.state.entries.map(e => ({ ...e, status: e.signature === "failed" ? "failed" : "pending" })) };
    onChange(this.state);
    const [delivery, chain] = await Promise.allSettled([this.receive(), readSnapshot(this.client, this.config)]);
    if (generation !== this.generation) return;
    let snapshot = chain.status === "fulfilled" ? chain.value : undefined;
    const fetched = delivery.status === "fulfilled" ? delivery.value : [];
    const check = async (raw: unknown, cached: boolean): Promise<CheckedMessage> => {
      let packet: Envelope;
      try { packet = await verifyEnvelope(raw, this.config); }
      catch {
        const body = raw && typeof raw === "object" && "body" in raw && typeof raw.body === "string" ? raw.body.slice(0, 4000) : "Text is missing or the message format is invalid.";
        return { body, signature: "failed", status: "failed", reason: "Text, signatur eller sammanhang stämmer inte.", cached };
      }
      if (!snapshot) return { packet, body: packet.body, signature: "passed", status: "unavailable", cached };
      try {
        const proof = await publicationProof(this.client, this.config, packet, snapshot);
        if (!proof) return { packet, body: packet.body, signature: "passed", status: "pending", reason: "Ingen bekräftad publiceringspost ännu.", cached };
        return { packet, body: packet.body, signature: "passed", status: packet.packageDigest === snapshot.digest ? "current" : "superseded", proof, cached };
      } catch (error) {
        if (error instanceof VerificationMismatch) return { packet, body: packet.body, signature: "passed", status: "failed", reason: error.message, cached };
        // A matching signature does not prove publication. Missing/failed RPC
        // evidence is conservatively unavailable, never a positive result.
        return { packet, body: packet.body, signature: "passed", status: "unavailable", reason: error instanceof ChainCheckUnavailable ? error.message : "Publiceringsunderlaget kunde inte bekräftas.", cached };
      }
    };
    // Collapse byte-identical deliveries within this fetch only. This is never
    // an approval cache: each distinct actual payload is checked again below.
    const rawBytes = new Set<string>();
    const distinct = fetched.filter(raw => { const bytes = JSON.stringify(raw); if (rawBytes.has(bytes)) return false; rawBytes.add(bytes); return true; });
    // Bound RPC pressure on public endpoints. A new poll starts only after this
    // one settles; abandoned generations stop scheduling further packet checks.
    const checkBatch = async (packets: unknown[], fromCache: boolean) => {
      const results: CheckedMessage[] = []; let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, packets.length) }, async () => {
        while (next < packets.length && generation === this.generation) {
          const index = next++; results[index] = await check(packets[index], fromCache);
        }
      }));
      return results;
    };
    const received = await checkBatch(distinct, false);
    const cached = await checkBatch(this.accepted, true);
    if (snapshot) {
      try { await assertSnapshot(this.client, snapshot); }
      catch { snapshot = undefined; }
    }
    if (generation !== this.generation) return;
    // This comparison is only for display deduplication AFTER independent checks.
    const sameBytes = (a: Envelope, b: Envelope) => JSON.stringify(a) === JSON.stringify(b);
    const uniqueReceived = received.filter((entry, i, all) => !entry.packet || !all.slice(0, i).some(other => other.packet && sameBytes(other.packet, entry.packet!)));
    const entries = [...uniqueReceived, ...cached.filter(c => c.packet && !uniqueReceived.some(r => r.packet && sameBytes(r.packet, c.packet!)))];
    if (!snapshot) for (const entry of entries) if (entry.signature === "passed") { entry.status = "unavailable"; delete entry.proof; }
    entries.sort((a, b) => (b.packet?.message.version ?? 0) - (a.packet?.message.version ?? 0));
    const verified = entries.filter(e => e.packet && e.proof && ["current", "superseded"].includes(e.status)).map(e => e.packet!);
    if (snapshot) {
      // Only fully verified received packets may enter the saved collection.
      // Keep historical copies during outages or hostile deliveries.
      const canonicalCache = cached.flatMap(entry => entry.packet ? [entry.packet] : []);
      const merged = [...verified, ...canonicalCache.filter(p => !verified.some(v => sameBytes(v, p)))];
      this.accepted = merged.filter((p, i) => !merged.slice(0, i).some(other => sameBytes(p, other))).slice(0, 1000);
      try { this.save(this.accepted as Envelope[]); } catch { /* memory copy remains; next startup rechecks storage */ }
    }
    this.state = {
      checking: false, entries, snapshot, lastSuccess: snapshot?.checkedAt ?? this.state.lastSuccess,
      chainError: snapshot ? undefined : "Aktuell status kan inte kontrolleras. Anslutningen till det betrodda nätet saknas eller stämmer inte.",
      deliveryError: delivery.status === "rejected" ? "Meddelanden kunde inte hämtas. Sparade kopior kontrolleras separat." : undefined,
      missingHead: !!snapshot && snapshot.version > 0 && !received.some(e => e.status === "current" && e.proof),
    };
    onChange(this.state);
  }
}
