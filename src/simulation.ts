import { ORIGINAL, UPDATED, publish, statusEvidence, verify } from "./model.ts";
import type {
  Packet,
  Registry,
  StatusEvidence,
  Verification,
} from "./model.ts";

export type Scenario = "unchanged" | "changed" | "update" | "offline";
export type Receipt = { packet: Packet; result: Verification | null };
export type State = {
  scenario: Scenario;
  registry: Registry;
  draft: string;
  copy: Packet | null;
  receipts: Receipt[];
  online: boolean;
  evidence: StatusEvidence | null;
  pending: boolean;
  generation: number;
  minute: number;
  event: string;
};
export type Action =
  | { type: "prepare"; scenario: Scenario }
  | { type: "reset" }
  | { type: "publish" }
  | { type: "forward" }
  | { type: "connection" }
  | { type: "draft" | "copy"; text: string }
  | { type: "checked"; generation: number };

export function initial(
  scenario: Scenario = "unchanged",
  generation = 0,
): State {
  const base: State = {
    scenario,
    registry: [],
    draft: ORIGINAL,
    copy: null,
    receipts: [],
    online: true,
    evidence: null,
    pending: false,
    generation,
    minute: 50,
    event: "ready",
  };
  if (scenario === "unchanged") return base;
  const { registry, packet } = publish([], ORIGINAL);
  const evidence = statusEvidence(registry, "13.50");
  if (scenario === "changed")
    return {
      ...base,
      registry,
      copy: { ...packet, text: UPDATED },
      event: "copy",
    };
  return {
    ...base,
    registry,
    copy: { ...packet },
    draft: UPDATED,
    evidence,
    receipts: [{ packet, result: verify(packet, registry, evidence) }],
    event: scenario === "offline" ? "connection-ready" : "update-ready",
  };
}

export function reducer(state: State, action: Action): State {
  if (action.type === "prepare")
    return initial(action.scenario, state.generation + 1);
  if (action.type === "reset")
    return initial(state.scenario, state.generation + 1);
  if (action.type === "checked") {
    if (
      action.generation !== state.generation ||
      !state.pending ||
      !state.online
    )
      return state;
    const minute = state.minute + 1;
    const total = 13 * 60 + minute;
    const time = `${String(Math.floor(total / 60)).padStart(2, "0")}.${String(total % 60).padStart(2, "0")}`;
    const evidence = statusEvidence(state.registry, time);
    return {
      ...state,
      minute,
      evidence,
      pending: false,
      receipts: state.receipts.map((r) => ({
        ...r,
        result: verify(r.packet, state.registry, evidence),
      })),
    };
  }
  if (action.type === "draft") return { ...state, draft: action.text };
  if (action.type === "copy" && state.copy) {
    // Invalidate outstanding work; a later callback may never revive an old result.
    return {
      ...state,
      copy: { ...state.copy, text: action.text },
      generation: state.generation + 1,
      receipts: state.receipts.filter((r) => r.result !== null),
      pending: state.pending && state.receipts.some((r) => r.result !== null),
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
    return {
      ...state,
      registry,
      copy: { ...packet },
      pending: state.online && state.receipts.length > 0,
      generation: state.generation + 1,
      event: previous ? "updated" : "published",
    };
  }
  if (action.type === "forward" && state.copy && state.online) {
    const packet = Object.freeze({ ...state.copy });
    const receipts = state.receipts.filter(
      (r) => r.packet.reference !== packet.reference,
    );
    return {
      ...state,
      receipts: [...receipts, { packet, result: null }],
      pending: true,
      generation: state.generation + 1,
      event: "received",
    };
  }
  if (action.type === "connection") {
    const online = !state.online;
    const evidence = state.evidence
      ? { ...state.evidence, current: false }
      : null;
    return {
      ...state,
      online,
      evidence,
      receipts: state.receipts
        .filter((r) => r.result !== null)
        .map((r) => ({
          ...r,
          result: verify(r.packet, state.registry, evidence),
        })),
      pending: online && state.receipts.some((r) => r.result !== null),
      generation: state.generation + 1,
      event: online ? "reconnected" : "offline",
    };
  }
  return state;
}
