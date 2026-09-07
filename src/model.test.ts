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
import { currentOfficial, initial, reducer } from "./simulation.ts";
import type { Scenario, State } from "./simulation.ts";

const base = () => publish([], ORIGINAL);
const deliver = (state: State) =>
  reducer(state, {
    type: "delivered",
    generation: state.generation,
    revision: state.deliveryRevision,
  });
const check = (state: State) =>
  reducer(state, {
    type: "checked",
    generation: state.generation,
    revision: state.checkRevision,
  });
const settle = (state: State) => check(deliver(state));

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
  keyId: "another-key",
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

test("direct publication separates delivery from approval and preserves exact whitespace", () => {
  let state = reducer(initial(), {
    type: "draft",
    text: "  Samling\n14.00.  ",
  });
  state = reducer(state, { type: "publish" });
  assert.equal(state.receipts.length, 0);
  assert.equal(currentOfficial(state), undefined);
  assert.equal(state.localRegistry.length, 0);
  assert.equal(state.deliveries[0].packet.text, "  Samling\n14.00.  ");
  state = deliver(state);
  assert.equal(state.receipts.length, 1);
  assert.equal(state.receipts[0].result, null);
  assert.equal(currentOfficial(state), undefined);
  state = check(state);
  assert.equal(currentOfficial(state)?.packet.text, "  Samling\n14.00.  ");
});

test("an update is delivered and checked without forwarding; original text stays immutable", () => {
  let state = reducer(initial("update"), { type: "publish" });
  const oldPacket = state.receipts[0].packet;
  state = deliver(state);
  assert.equal(state.receipts[1].packet.text, UPDATED);
  assert.equal(currentOfficial(state), undefined);
  state = check(state);
  assert.equal(currentOfficial(state)?.packet.version, 2);
  assert.equal(state.receipts[0].result?.status, "replaced");
  assert.equal(state.receipts[0].packet, oldPacket);
  assert.equal(oldPacket.text, ORIGINAL);
});

test("forwarded copies get independent identities and never replace official receipts", () => {
  let state = initial("forwarding");
  const official = state.receipts[0];
  state = settle(reducer(state, { type: "forward" }));
  assert.equal(state.receipts[1].result?.integrity, "intact");
  state = reducer(state, {
    type: "copy",
    text: "Valfri ändring, inte ett klockslag",
  });
  state = settle(reducer(state, { type: "forward" }));
  assert.equal(state.receipts[2].result?.integrity, "changed");
  assert.equal(state.receipts[2].result?.status, "unknown");
  assert.equal(state.receipts[0], official);
  assert.equal(currentOfficial(state), official);
  assert.equal(state.receipts.filter((r) => r.route === "official").length, 1);
  assert.equal(new Set(state.receipts.map((r) => r.id)).size, 3);
  assert.equal(new Set(state.receipts.map((r) => r.packet.reference)).size, 1);
});

for (const editBeforeDelivery of [true, false]) {
  test(`copy editing preserves the sent snapshot ${editBeforeDelivery ? "during transport" : "during verification"}`, () => {
    let state = reducer(initial("forwarding"), {
      type: "copy",
      text: "Skickad text",
    });
    state = reducer(state, { type: "forward" });
    if (!editBeforeDelivery) state = deliver(state);
    const generation = state.generation;
    const checkRevision = state.checkRevision;
    state = reducer(state, { type: "copy", text: "Senare redigering" });
    assert.equal(state.generation, generation);
    assert.equal(state.checkRevision, checkRevision);
    state = settle(state);
    assert.equal(state.receipts[1].packet.text, "Skickad text");
    assert.equal(state.receipts[1].result?.integrity, "changed");
    assert.ok(Object.isFrozen(state.receipts[1].packet));
    state = settle(reducer(state, { type: "forward" }));
    assert.equal(state.receipts[2].packet.text, "Senare redigering");
    assert.equal(state.receipts[1].packet.text, "Skickad text");
  });
}

test("offline publication cannot alter recipient data; reconnect catches up all missed versions", () => {
  let state = reducer(initial("offline"), { type: "connection" });
  const receipts = state.receipts;
  const localRegistry = state.localRegistry;
  const evidence = state.evidence;
  assert.equal(receipts[0].result?.integrity, "intact");
  assert.equal(receipts[0].result?.status, "unknown");
  assert.equal(evidence?.checkedAt, "13.50");
  state = reducer(state, { type: "publish" });
  state = reducer(state, { type: "draft", text: "Samling 17.00." });
  state = reducer(state, { type: "publish" });
  assert.equal(state.receipts, receipts);
  assert.equal(state.localRegistry, localRegistry);
  assert.equal(state.evidence, evidence);
  assert.equal(state.deliveries.length, 0);
  assert.equal(currentOfficial(state), undefined);
  state = reducer(state, { type: "connection" });
  assert.equal(state.receipts.length, 1);
  assert.equal(state.deliveries.length, 2);
  state = settle(state);
  assert.equal(state.receipts.length, 3);
  assert.equal(currentOfficial(state)?.packet.version, 3);
  assert.equal(state.receipts[1].packet.text, UPDATED);
  assert.equal(state.receipts[0].result?.status, "replaced");
  assert.equal(state.receipts[1].result?.status, "replaced");
  // Reconnect without new publications refreshes status but adds no duplicates.
  state = settle(
    reducer(reducer(state, { type: "connection" }), { type: "connection" }),
  );
  assert.equal(state.receipts.length, 3);
  assert.equal(currentOfficial(state)?.packet.version, 3);
});

test("failed or unavailable official update never becomes the current official version", () => {
  for (const change of [
    { text: "Manipulated" },
    { reference: "missing" },
    { keyId: "unknown-key" },
  ]) {
    let state = reducer(initial("update"), { type: "publish" });
    state = {
      ...state,
      deliveries: state.deliveries.map((d) => ({
        ...d,
        packet: Object.freeze({ ...d.packet, ...change }),
      })),
    };
    state = deliver(state);
    assert.equal(currentOfficial(state), undefined);
    state = check(state);
    assert.equal(currentOfficial(state), undefined);
    assert.notEqual(state.receipts[1].result?.status, "current");
    assert.equal(state.receipts[0].packet.text, ORIGINAL);
  }
});

test("subscription scope limits delivery and receiving context limits approval", () => {
  const state = reducer(
    { ...initial(), subscription: "another-operation" },
    { type: "publish" },
  );
  assert.equal(state.deliveries.length, 0);
  const known = initial("update");
  const result = check({
    ...known,
    subscription: "another-operation",
    receipts: known.receipts.map((r) => ({ ...r, checking: true })),
  });
  assert.equal(currentOfficial(result), undefined);
});

for (const scenario of [
  "publication",
  "forwarding",
  "update",
  "offline",
] as Scenario[]) {
  test(`reset and late callbacks are isolated in ${scenario}`, () => {
    let state = initial(scenario);
    state = reducer(
      state,
      scenario === "forwarding" ? { type: "forward" } : { type: "publish" },
    );
    const delivery = {
      type: "delivered",
      generation: state.generation,
      revision: state.deliveryRevision,
    } as const;
    const pending = deliver(state);
    const checked = {
      type: "checked",
      generation: pending.generation,
      revision: pending.checkRevision,
    } as const;
    for (const action of [
      { type: "reset" } as const,
      { type: "prepare", scenario: "publication" } as const,
      { type: "connection" } as const,
    ]) {
      const next = reducer(pending, action);
      assert.equal(reducer(next, delivery), next);
      assert.equal(reducer(next, checked), next);
    }
    const reset = reducer(pending, { type: "reset" });
    assert.deepEqual(reset, initial(scenario, reset.generation));
    const disconnected = reducer(pending, { type: "connection" });
    assert.equal(disconnected.receipts.length, pending.receipts.length);
    const reconnected = reducer(disconnected, { type: "connection" });
    assert.equal(reducer(reconnected, checked), reconnected);
    assert.ok(settle(reconnected).receipts.every((r) => r.result));
  });
}

test("late check revisions cannot approve or overwrite a later reception", () => {
  let state = deliver(reducer(initial("forwarding"), { type: "forward" }));
  const stale = {
    type: "checked",
    generation: state.generation,
    revision: state.checkRevision,
  } as const;
  state = reducer(state, { type: "copy", text: "Andra kopian" });
  state = deliver(reducer(state, { type: "forward" }));
  assert.equal(reducer(state, stale), state);
  state = check(state);
  assert.equal(state.receipts[1].result?.integrity, "intact");
  assert.equal(state.receipts[2].result?.integrity, "changed");
  assert.equal(state.receipts[0].result?.status, "current");
});

test("fetching evidence does not advance the last completed check time", () => {
  const state = deliver(reducer(initial("offline"), { type: "publish" }));
  assert.equal(state.evidence?.checkedAt, "13.51");
  assert.equal(state.lastCheckedAt, "13.50");
  const disconnected = reducer(state, { type: "connection" });
  assert.equal(disconnected.lastCheckedAt, "13.50");
  const resumed = settle(reducer(disconnected, { type: "connection" }));
  assert.equal(resumed.lastCheckedAt, "13.52");
});
