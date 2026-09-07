// A deterministic evidence simulator, deliberately without cryptography or network I/O.
export const CONTEXT = "ovning-norr:volontarer";
export const SENDERS = Object.freeze(
  [
    { id: "demo-alex", keyId: "demo-key-alex", name: "Alex", context: CONTEXT },
  ].map((sender) => Object.freeze(sender)),
);
export const ORIGINAL = "Samling vid Norra mötesplatsen kl. 14.00.";
export const UPDATED = "Samling vid Norra mötesplatsen kl. 16.00.";

export type Packet = Readonly<{
  reference: string;
  id: string;
  version: number;
  sender: string;
  keyId: string;
  context: string;
  text: string;
  replaces: string | null;
}>;
export type Registry = readonly Packet[];
export type StatusEvidence = Readonly<{
  checkedAt: string;
  current: boolean;
  entries: Readonly<Record<string, "current" | "replaced" | "revoked">>;
}>;
export type Verification = {
  integrity: "intact" | "changed" | "unavailable";
  authority: "authorized" | "unauthorized" | "unavailable";
  status: "current" | "replaced" | "revoked" | "unknown";
  original?: Packet;
};

export function publish(
  registry: Registry,
  text: string,
  sender = "demo-alex",
  context = CONTEXT,
  replaces: string | null = null,
): { registry: Registry; packet: Packet } {
  if (!text.trim()) throw new Error("Meddelandet får inte vara tomt.");
  if (!SENDERS.some((s) => s.id === sender && s.context === context))
    throw new Error("Obehörig publicerare.");
  const previous = replaces
    ? registry.find((p) => p.reference === replaces)
    : undefined;
  if (
    replaces &&
    (!previous ||
      previous.context !== context ||
      registry.some((p) => p.replaces === replaces))
  )
    throw new Error("Ogiltig ersättning.");
  const sequence = registry.length + 1;
  const packet: Packet = Object.freeze({
    reference: `proof-${sequence}`,
    id: previous?.id ?? `message-${sequence}`,
    version: previous ? previous.version + 1 : 1,
    sender,
    keyId: SENDERS.find((s) => s.id === sender)!.keyId,
    context,
    text,
    replaces,
  });
  return { registry: Object.freeze([...registry, packet]), packet };
}

export function statusEvidence(
  registry: Registry,
  checkedAt: string,
): StatusEvidence {
  return Object.freeze({
    checkedAt,
    current: true,
    entries: Object.freeze(
      Object.fromEntries(
        registry.map((p) => [
          p.reference,
          registry.some((next) => next.replaces === p.reference)
            ? ("replaced" as const)
            : ("current" as const),
        ]),
      ),
    ),
  });
}

export function verify(
  packet: Packet,
  registry: Registry,
  evidence: StatusEvidence | null,
  expectedContext = CONTEXT,
): Verification {
  const original = registry.find((p) => p.reference === packet.reference);
  if (!original)
    return {
      integrity: "unavailable",
      authority: "unavailable",
      status: "unknown",
    };
  const fields = [
    "id",
    "version",
    "sender",
    "keyId",
    "context",
    "text",
    "replaces",
  ] as const;
  const integrity = fields.every((field) => packet[field] === original[field])
    ? "intact"
    : "changed";
  const authority = SENDERS.some(
    (s) =>
      s.id === packet.sender &&
      s.keyId === packet.keyId &&
      s.context === packet.context &&
      s.context === expectedContext,
  )
    ? "authorized"
    : "unauthorized";
  const status =
    integrity === "intact" && authority === "authorized" && evidence?.current
      ? (evidence.entries[packet.reference] ?? "unknown")
      : "unknown";
  return { integrity, authority, status, original };
}

// Minimal changed span works for arbitrary Unicode text, additions and deletions.
export function difference(before: string, after: string) {
  const a = Array.from(before),
    b = Array.from(after);
  let start = 0,
    end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  return {
    prefix: b.slice(0, start).join(""),
    removed: a.slice(start, a.length - end).join(""),
    added: b.slice(start, b.length - end).join(""),
    suffix: b.slice(b.length - end).join(""),
  };
}
