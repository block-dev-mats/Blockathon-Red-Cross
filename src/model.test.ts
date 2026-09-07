import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT,
  ORIGINAL,
  UPDATED,
  difference,
  publish,
  statusEvidence,
  verify,
} from "./model.ts";
import type { Packet } from "./model.ts";
import { initial, reducer } from "./simulation.ts";
import type { Scenario, State } from "./simulation.ts";

const base = () => publish([], ORIGINAL);
const check = (state: State) =>
  reducer(state, { type: "checked", generation: state.generation });

test("published packages and registries are immutable; a transport copy preserves authority", () => {
  const { registry, packet } = base();
  assert.ok(Object.isFrozen(registry) && Object.isFrozen(packet));
  const result = verify(
    { ...packet },
    registry,
    statusEvidence(registry, "13.50"),
  );
  assert.deepEqual(
    [result.integrity, result.authority, result.status],
    ["intact", "authorized", "current"],
  );
});

for (const [field, value] of Object.entries({
  text: "Gå till södra entrén nu! 🌧",
  id: "new-id",
  version: 99,
  sender: "arbitrary-wallet",
  context: "another-operation",
  replaces: "invented-proof",
})) {
  test(`the published evidence binds ${field}`, () => {
    const { registry, packet } = base();
    const copy = { ...packet, [field]: value } as Packet;
    const result = verify(copy, registry, statusEvidence(registry, "13.50"));
    assert.equal(result.integrity, "changed");
    assert.equal(result.status, "unknown");
    assert.equal(packet.text, ORIGINAL);
  });
}

test("unknown reference is unavailable, never proof of manipulation or authorization", () => {
  const { registry, packet } = base();
  assert.deepEqual(
    verify(
      { ...packet, reference: "missing", id: "new" },
      registry,
      statusEvidence(registry, "13.50"),
    ),
    { integrity: "unavailable", authority: "unavailable", status: "unknown" },
  );
});

test("explicit sender and context allowlist applies to publication and verification", () => {
  assert.throws(() => publish([], ORIGINAL, "arbitrary-wallet"));
  assert.throws(() => publish([], ORIGINAL, "demo-alex", "another-operation"));
  const { packet } = base();
  const unauthorized = { ...packet, sender: "arbitrary-wallet" };
  assert.equal(
    verify(unauthorized, [unauthorized], null).authority,
    "unauthorized",
  );
  assert.equal(
    verify(packet, [packet], null, "another-operation").authority,
    "unauthorized",
  );
  assert.equal(packet.context, CONTEXT);
});

test("missing, stale and incomplete status evidence never claims current status", () => {
  const { registry, packet } = base();
  for (const evidence of [
    null,
    { ...statusEvidence(registry, "13.50"), current: false },
    { checkedAt: "13.50", current: true, entries: {} },
  ]) {
    const result = verify(packet, registry, evidence);
    assert.equal(result.integrity, "intact");
    assert.equal(result.authority, "authorized");
    assert.equal(result.status, "unknown");
  }
  assert.equal(
    verify(packet, registry, {
      checkedAt: "13.51",
      current: true,
      entries: { [packet.reference]: "revoked" },
    }).status,
    "revoked",
  );
});

test("legitimate update has its own evidence and explicitly supersedes the previous version", () => {
  const { registry, packet } = base();
  const update = publish(
    registry,
    UPDATED,
    undefined,
    undefined,
    packet.reference,
  );
  const evidence = statusEvidence(update.registry, "13.51");
  assert.equal(update.packet.id, packet.id);
  assert.equal(update.packet.version, 2);
  assert.equal(update.packet.replaces, packet.reference);
  assert.notEqual(update.packet.reference, packet.reference);
  assert.equal(verify(packet, update.registry, evidence).status, "replaced");
  assert.equal(
    verify(update.packet, update.registry, evidence).integrity,
    "intact",
  );
  assert.equal(
    verify(update.packet, update.registry, evidence).status,
    "current",
  );
  assert.throws(() =>
    publish(
      update.registry,
      "Conflicting update",
      undefined,
      undefined,
      packet.reference,
    ),
  );
  assert.throws(() =>
    publish(registry, UPDATED, undefined, undefined, "missing"),
  );
});

for (const [before, after] of [
  [ORIGINAL, UPDATED],
  [ORIGINAL, "Helt annan text!"],
  ["abc", "ac"],
  ["abc", "abXYZc"],
  ["🌧 Regn", "☀ Sol"],
  ["", "text"],
  ["text", ""],
  ["abc", "abc"],
]) {
  test(`difference reconstructs both arbitrary strings: ${before} → ${after}`, () => {
    const d = difference(before, after);
    assert.equal(d.prefix + d.removed + d.suffix, before);
    assert.equal(d.prefix + d.added + d.suffix, after);
  });
}

test("unchanged flow requires publish and forward, then checks automatically", () => {
  let state = initial();
  assert.equal(state.copy, null);
  state = reducer(state, { type: "publish" });
  assert.equal(state.receipts.length, 0);
  state = reducer(state, { type: "forward" });
  assert.equal(state.pending, true);
  assert.equal(state.receipts[0].result, null);
  state = check(state);
  assert.equal(state.receipts[0].result?.status, "current");
});

test("tampered copy is independent of original, and arbitrary edits drive the result", () => {
  let state = initial("changed");
  state = reducer(state, {
    type: "copy",
    text: "Valfri ändring, inte ett klockslag",
  });
  state = check(reducer(state, { type: "forward" }));
  assert.equal(state.registry[0].text, ORIGINAL);
  assert.equal(state.receipts[0].result?.integrity, "changed");
  state = reducer(state, { type: "copy", text: ORIGINAL });
  state = check(reducer(state, { type: "forward" }));
  assert.equal(state.receipts[0].result?.status, "current");
});

test("official update flow accepts new version and marks old receipt replaced", () => {
  let state = initial("update");
  state = check(reducer(state, { type: "publish" }));
  assert.equal(state.receipts[0].result?.status, "replaced");
  state = check(reducer(state, { type: "forward" }));
  assert.equal(state.receipts.length, 2);
  assert.equal(state.receipts[1].result?.status, "current");
  assert.equal(state.receipts[1].result?.integrity, "intact");
});

test("offline retains local integrity, blocks delivery, then automatically refreshes status", () => {
  let state = reducer(initial("offline"), { type: "connection" });
  assert.equal(state.evidence?.checkedAt, "13.50");
  assert.equal(state.receipts[0].result?.integrity, "intact");
  assert.equal(state.receipts[0].result?.status, "unknown");
  state = reducer(state, { type: "publish" });
  assert.equal(state.receipts[0].result?.status, "unknown");
  assert.equal(state.pending, false);
  assert.equal(reducer(state, { type: "forward" }), state);
  state = reducer(state, { type: "connection" });
  assert.equal(state.pending, true);
  assert.equal(state.receipts[0].result?.status, "unknown");
  state = check(state);
  assert.equal(state.receipts[0].result?.status, "replaced");
  assert.equal(state.receipts.length, 1);
});

test("late checks cannot overwrite reset, scenario change, edited copy or connection loss", () => {
  const pending = reducer(initial("changed"), { type: "forward" });
  for (const action of [
    { type: "reset" } as const,
    { type: "prepare", scenario: "update" } as const,
    { type: "copy", text: "New text" } as const,
    { type: "connection" } as const,
  ]) {
    const next = reducer(pending, action);
    assert.equal(
      reducer(next, { type: "checked", generation: pending.generation }),
      next,
    );
  }
});

for (const scenario of [
  "unchanged",
  "changed",
  "update",
  "offline",
] as Scenario[]) {
  test(`reset restores deterministic ${scenario} preparation`, () => {
    let state = initial(scenario);
    state = reducer(state, { type: "publish" });
    state = reducer(state, { type: "forward" });
    state = reducer(state, { type: "connection" });
    state = reducer(state, { type: "reset" });
    assert.deepEqual(state, initial(scenario, state.generation));
  });
}
