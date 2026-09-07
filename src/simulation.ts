import {
  CONTEXT,
  ORIGINAL,
  UPDATED,
  publish,
  statusEvidence,
  verify,
} from "./model.ts";
import type {
  Packet,
  Registry,
  StatusEvidence,
  Verification,
} from "./model.ts";

export type Scenario = "publication" | "forwarding" | "update" | "offline";
export type Delivery = Readonly<{
  id: number;
  route: "official" | "forwarded";
  packet: Packet;
}>;
export type Receipt = Delivery & {
  result: Verification | null;
  checking: boolean;
};
export type State = {
  scenario: Scenario;
  registry: Registry;
  localRegistry: Registry;
  subscription: string;
  draft: string;
  copy: Packet | null;
  deliveries: Delivery[];
  receipts: Receipt[];
  nextReceiptId: number;
  online: boolean;
  evidence: StatusEvidence | null;
  lastCheckedAt: string | null;
  syncRequested: boolean;
  generation: number;
  deliveryRevision: number;
  checkRevision: number;
  minute: number;
  event: string;
};
export type Action =
  | { type: "prepare"; scenario: Scenario }
  | { type: "reset" | "publish" | "forward" | "connection" }
  | { type: "draft" | "copy"; text: string }
  | { type: "delivered" | "checked"; generation: number; revision: number };

function queue(state: State, packet: Packet, route: Delivery["route"]): State {
  const delivery = Object.freeze({
    id: state.nextReceiptId,
    route,
    packet: Object.freeze({ ...packet }),
  });
  return {
    ...state,
    deliveries: [...state.deliveries, delivery],
    nextReceiptId: state.nextReceiptId + 1,
    deliveryRevision: state.deliveryRevision + 1,
  };
}

export function initial(
  scenario: Scenario = "publication",
  generation = 0,
): State {
  const state: State = {
    scenario,
    registry: [],
    localRegistry: [],
    subscription: CONTEXT,
    draft: ORIGINAL,
    copy: null,
    deliveries: [],
    receipts: [],
    nextReceiptId: 1,
    online: true,
    evidence: null,
    lastCheckedAt: null,
    syncRequested: false,
    generation,
    deliveryRevision: 0,
    checkRevision: 0,
    minute: 50,
    event: "ready",
  };
  if (scenario === "publication") return state;
  const { registry, packet } = publish([], ORIGINAL);
  const evidence = statusEvidence(registry, "13.50");
  return {
    ...state,
    registry,
    localRegistry: registry,
    copy: { ...packet },
    draft: scenario === "forwarding" ? ORIGINAL : UPDATED,
    evidence,
    lastCheckedAt: evidence.checkedAt,
    receipts: [
      {
        id: 1,
        route: "official",
        packet,
        result: verify(packet, registry, evidence),
        checking: false,
      },
    ],
    nextReceiptId: 2,
    event:
      scenario === "forwarding"
        ? "copy-ready"
        : scenario === "offline"
          ? "connection-ready"
          : "update-ready",
  };
}

// Transport metadata never grants approval. Unchecked or failed copies of a known
// reference cannot become official heads or replace an official receipt.
export function currentOfficial(state: State): Receipt | undefined {
  return [...state.receipts]
    .reverse()
    .find(
      (r) =>
        r.route === "official" &&
        !r.checking &&
        r.result?.integrity === "intact" &&
        r.result.authority === "authorized" &&
        r.result.status === "current",
    );
}

export function reducer(state: State, action: Action): State {
  if (action.type === "prepare")
    return initial(action.scenario, state.generation + 1);
  if (action.type === "reset")
    return initial(state.scenario, state.generation + 1);
  if (action.type === "draft") return { ...state, draft: action.text };
  if (action.type === "copy" && state.copy) {
    // Only the unsent editor changes. In-flight and received snapshots survive.
    return {
      ...state,
      copy: { ...state.copy, text: action.text },
      event: "copy",
    };
  }
  if (action.type === "publish" && state.draft.trim()) {
    const previous = state.registry.at(-1);
    if (previous?.text === state.draft) return state;
    const { registry, packet } = publish(
      state.registry,
      state.draft,
      undefined,
      undefined,
      previous?.reference ?? null,
    );
    const next = {
      ...state,
      registry,
      copy: { ...packet },
      event: state.online ? "published" : "published-offline",
    };
    // Recipient-local data is untouched until transport completes.
    return state.online && packet.context === state.subscription
      ? queue({ ...next, syncRequested: true }, packet, "official")
      : next;
  }
  if (
    action.type === "forward" &&
    state.scenario === "forwarding" &&
    state.copy &&
    state.online &&
    state.copy.text.trim()
  ) {
    return queue({ ...state, event: "forwarded" }, state.copy, "forwarded");
  }
  if (action.type === "delivered") {
    if (
      !state.online ||
      action.generation !== state.generation ||
      action.revision !== state.deliveryRevision ||
      (!state.deliveries.length && !state.syncRequested)
    )
      return state;
    const minute = state.minute + 1;
    const total = 13 * 60 + minute;
    const time = `${String(Math.floor(total / 60) % 24).padStart(2, "0")}.${String(total % 60).padStart(2, "0")}`;
    const localRegistry = state.registry;
    const evidence = statusEvidence(localRegistry, time);
    return {
      ...state,
      localRegistry,
      evidence,
      minute,
      deliveries: [],
      syncRequested: false,
      receipts: [
        ...state.receipts.map((r) =>
          state.syncRequested ? { ...r, checking: true } : r,
        ),
        ...state.deliveries.map((d) => ({
          ...d,
          result: null,
          checking: true,
        })),
      ],
      checkRevision: state.checkRevision + 1,
      event: "received",
    };
  }
  if (action.type === "checked") {
    if (
      !state.online ||
      action.generation !== state.generation ||
      action.revision !== state.checkRevision ||
      !state.receipts.some((r) => r.checking)
    )
      return state;
    return {
      ...state,
      receipts: state.receipts.map((r) =>
        r.checking
          ? {
              ...r,
              checking: false,
              result: verify(
                r.packet,
                state.localRegistry,
                state.evidence,
                state.subscription,
              ),
            }
          : r,
      ),
      event: "checked",
      lastCheckedAt: state.evidence?.checkedAt ?? state.lastCheckedAt,
    };
  }
  if (action.type === "connection") {
    const evidence = state.evidence
      ? { ...state.evidence, current: false }
      : null;
    let next: State = {
      ...state,
      online: !state.online,
      evidence,
      syncRequested: !state.online,
      generation: state.generation + 1,
      deliveryRevision: state.deliveryRevision + 1,
      receipts: state.receipts.map((r) => ({
        ...r,
        checking: false,
        result: r.result ? { ...r.result, status: "unknown" } : null,
      })),
      event: state.online ? "offline" : "reconnected",
    };
    if (next.online) {
      for (const packet of next.registry) {
        const alreadyReceived = next.receipts.some(
          (r) =>
            r.route === "official" && r.packet.reference === packet.reference,
        );
        const alreadyQueued = next.deliveries.some(
          (d) =>
            d.route === "official" && d.packet.reference === packet.reference,
        );
        if (
          packet.context === next.subscription &&
          !alreadyReceived &&
          !alreadyQueued
        )
          next = queue(next, packet, "official");
      }
    }
    return next;
  }
  return state;
}
