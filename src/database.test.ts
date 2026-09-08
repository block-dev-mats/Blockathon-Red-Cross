import { test } from "node:test";
import assert from "node:assert/strict";
import { ORIGINAL, SENDERS, UPDATED } from "./model.ts";
import { currentOfficial, initial, reducer } from "./simulation.ts";
import type { State } from "./simulation.ts";

const deliver = (s: State) =>
  reducer(s, {
    type: "delivered",
    generation: s.generation,
    revision: s.deliveryRevision,
  });
const check = (s: State) =>
  reducer(s, {
    type: "checked",
    generation: s.generation,
    revision: s.checkRevision,
  });
const fetch = (s: State) => reducer(s, { type: "storage-fetch" });
const settle = (s: State) => check(deliver(s));
const save = (s: State, text: string) =>
  reducer(reducer(s, { type: "storage-draft", text }), {
    type: "storage-save",
  });

test("storage is separate from trusted evidence and the approved local original", () => {
  const s = initial("database");
  const row = s.storage[s.storageReference!];
  assert.notEqual(row.packet, s.registry[0]);
  assert.notEqual(row.packet, s.receipts[0].packet);
  const changed = save(s, UPDATED);
  assert.equal(changed.storage[s.storageReference!].verified, true);
  assert.equal(changed.registry, s.registry);
  assert.equal(changed.localRegistry, s.localRegistry);
  assert.equal(changed.evidence, s.evidence);
  assert.equal(changed.receipts, s.receipts);
  assert.equal(changed.registry[0].text, ORIGINAL);
  assert.deepEqual(SENDERS, [
    {
      id: "demo-alex",
      keyId: "demo-key-alex",
      name: "Alex",
      context: "ovning-norr:volontarer",
    },
  ]);
});

for (const text of [
  ORIGINAL,
  UPDATED,
  "Valfri annan text 🌧",
  " " + ORIGINAL,
  "",
  "   ",
]) {
  test(`actual storage bytes determine verification: ${JSON.stringify(text)}`, () => {
    const base = initial("database");
    const saved = save(base, text);
    const state = settle(fetch(saved));
    const retrieved = state.receipts.at(-1)!;
    assert.equal(retrieved.packet.text, text);
    assert.equal(retrieved.packet.reference, base.receipts[0].packet.reference);
    assert.equal(retrieved.packet.id, base.receipts[0].packet.id);
    assert.equal(retrieved.packet.version, base.receipts[0].packet.version);
    assert.equal(retrieved.storageVerified, true);
    assert.notEqual(retrieved.id, base.receipts[0].id);
    assert.equal(
      retrieved.result?.integrity,
      text === ORIGINAL ? "intact" : "changed",
    );
    assert.equal(
      retrieved.result?.status,
      text === ORIGINAL ? "current" : "unknown",
    );
    assert.equal(currentOfficial(state), base.receipts[0]);
    assert.equal(state.registry, base.registry);
    assert.equal(state.receipts[0], base.receipts[0]);
  });
}

test("a forged storage flag never substitutes for missing evidence", () => {
  let state = initial("database");
  const row = state.storage[state.storageReference!];
  state = {
    ...state,
    storage: {
      [state.storageReference!]: {
        ...row,
        packet: { ...row.packet, reference: "unknown" },
      },
    },
  };
  state = settle(fetch(state));
  assert.equal(state.receipts.at(-1)?.storageVerified, true);
  assert.equal(state.receipts.at(-1)?.result?.integrity, "unavailable");
  assert.equal(state.receipts.at(-1)?.result?.authority, "unavailable");
  assert.equal(state.receipts.at(-1)?.result?.status, "unknown");
});

for (const cached of [true, false]) {
  test(`deleted storage returns an error without reconstruction; cache=${cached}`, () => {
    let state = initial("database");
    if (!cached)
      state = {
        ...state,
        receipts: [],
        localRegistry: [],
        evidence: null,
        lastCheckedAt: null,
      };
    const previous = state;
    state = reducer(state, { type: "storage-delete" });
    assert.equal(state.receipts, previous.receipts);
    assert.equal(state.fetchOutcome, null);
    state = settle(fetch(state));
    assert.equal(state.fetchOutcome?.status, "missing");
    assert.deepEqual(state.receipts, previous.receipts);
    assert.equal(state.registry, previous.registry);
    assert.equal(
      currentOfficial(state)?.packet.text,
      cached ? ORIGINAL : undefined,
    );
    // Reconnection must not silently read content out of the trusted register.
    state = settle(
      reducer(reducer(state, { type: "connection" }), { type: "connection" }),
    );
    assert.equal(state.receipts.length, cached ? 1 : 0);
    assert.equal(state.fetchOutcome?.status, "missing");
  });
}

for (const duringCheck of [false, true]) {
  test(`storage writes cannot mutate a fetch snapshot; checking=${duringCheck}`, () => {
    let state = fetch(initial("database"));
    if (duringCheck) state = deliver(state);
    const revision = state.checkRevision;
    state = save(state, UPDATED);
    assert.equal(state.checkRevision, revision);
    state = settle(state);
    const first = state.receipts.at(-1)!;
    assert.equal(first.packet.text, ORIGINAL);
    assert.equal(first.result?.integrity, "intact");
    assert.ok(Object.isFrozen(first.packet));
    state = settle(fetch(state));
    assert.equal(state.receipts.at(-1)?.packet.text, UPDATED);
    assert.equal(state.receipts.at(-1)?.result?.integrity, "changed");
    assert.equal(state.receipts[1], first);
  });
}

test("deletion after fetch starts preserves that response and affects only the next fetch", () => {
  let s = fetch(initial("database"));
  s = reducer(s, { type: "storage-delete" });
  s = settle(s);
  assert.equal(s.receipts.at(-1)?.packet.text, ORIGINAL);
  const count = s.receipts.length;
  s = settle(fetch(s));
  assert.equal(s.fetchOutcome?.status, "missing");
  assert.equal(s.receipts.length, count);
});

test("reset cancels late success, failure and verification callbacks", () => {
  for (let s of [
    fetch(initial("database")),
    fetch(reducer(initial("database"), { type: "storage-delete" })),
  ]) {
    const lateDelivery = {
      type: "delivered",
      generation: s.generation,
      revision: s.deliveryRevision,
    } as const;
    const resetBeforeDelivery = reducer(s, { type: "reset" });
    assert.equal(
      reducer(resetBeforeDelivery, lateDelivery),
      resetBeforeDelivery,
    );
    s = deliver(s);
    const lateCheck = {
      type: "checked",
      generation: s.generation,
      revision: s.checkRevision,
    } as const;
    const reset = reducer(save(s, UPDATED), { type: "reset" });
    assert.equal(reducer(reset, lateCheck), reset);
    assert.deepEqual(reset, initial("database", reset.generation));
    const switched = reducer(s, { type: "prepare", scenario: "publication" });
    assert.equal(reducer(switched, lateCheck), switched);
    const disconnected = reducer(s, { type: "connection" });
    assert.equal(reducer(disconnected, lateCheck), disconnected);
  }
});

test("only a legitimate publication adds evidence and changes version status", () => {
  let s = initial("database");
  const old = s.receipts[0].packet;
  s = settle(fetch(save(s, UPDATED)));
  assert.equal(s.registry.length, 1);
  assert.equal(s.receipts[0].result?.status, "current");
  s = reducer(s, { type: "draft", text: "Officiell uppdatering 17.00." });
  s = settle(reducer(s, { type: "publish" }));
  assert.equal(s.registry.length, 2);
  assert.equal(s.receipts[0].packet, old);
  assert.equal(s.receipts[0].result?.status, "replaced");
  assert.equal(currentOfficial(s)?.packet.version, 2);
});

test("both true and false storage claims are ignored; control results are frozen", () => {
  let s = initial("database");
  const row = s.storage[s.storageReference!];
  s = { ...s, storage: { [s.storageReference!]: { ...row, verified: false } } };
  s = settle(fetch(s));
  assert.equal(s.receipts.at(-1)?.storageVerified, false);
  assert.equal(s.receipts.at(-1)?.result?.status, "current");
  assert.ok(Object.isFrozen(s.receipts.at(-1)?.result));
  s = reducer(s, { type: "connection" });
  assert.ok(Object.isFrozen(s.receipts[0].result));
});
