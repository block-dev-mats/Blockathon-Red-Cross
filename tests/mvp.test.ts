import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { zeroHash, keccak256, toBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { abi, bodyHash, freezeDraft, packageDigest, typedData, verifyEnvelope } from "../shared/protocol.ts";
import { assertSnapshot, publicationProof, readSnapshot } from "../shared/chain.ts";
import { InboxVerifier } from "../src/live/inbox.ts";
import type { InboxState } from "../src/live/inbox.ts";
import { publishAttempt } from "../src/live/publish.ts";
import type { Attempt, Stage } from "../src/live/publish.ts";
import { demoAction } from "../scripts/demo.ts";
import { startApi } from "../server/api.ts";
import { environment, signed, testDevice } from "./helpers.ts";

test("real contract, SQLite, publication and independent recipient verification", { timeout: 120000 }, async t => {
  const env = await environment(); t.after(() => env.close());
  const { config, client, wallet } = env;
  const text = "  Samling 14.00. Åäö 🌧\nTa med vatten.\n";
  const v1 = await signed(env, text);
  const registry = config.domain.verifyingContract;
  const publish = (packet: typeof v1) => wallet.writeContract({ address: registry, abi, functionName: "publish", args: [packet.message, packet.signature] });
  const post = async (path: string, body: unknown) => { const response = await env.post(path, body); assert.equal(response.status, 200, await response.text()); };
  let current: InboxState | undefined;
  let saved: unknown[] = [];
  const receiver = new InboxVerifier(config, env.receive, [], packets => { saved = packets; });
  const refresh = async () => { await receiver.refresh(state => { current = state; }); return current!; };

  await t.test("typed digest parity, UTF-8 fidelity and frozen review", async () => {
    assert.equal(await client.readContract({ address: registry, abi, functionName: "digest", args: [v1.message] }), v1.packageDigest);
    assert.notEqual(v1.message.bodyHash, v1.packageDigest);
    assert.equal(v1.message.bodyHash, keccak256(toBytes(text)));
    assert.notEqual(bodyHash("å"), bodyHash("a\u030a"));
    const draft = freezeDraft(text, config, { version: 0, digest: zeroHash });
    assert.throws(() => { draft.body = "changed"; });
    assert.throws(() => { draft.message.version = 2; });
    assert.throws(() => bodyHash("\ud800"));
  });
  await t.test("text, every metadata field, signature, signer and domain tampering fail", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    const candidates: unknown[] = [
      { ...v1, body: text.replace("14.00", "16.00") }, { ...v1, body: text.trim() },
      { ...v1, signature: await stranger.signTypedData(typedData(v1)) },
      { ...v1, packageDigest: zeroHash }, { ...v1, verified: true },
      ...Object.keys(v1.message).map(key => ({ ...v1, message: { ...v1.message, [key]: key === "version" ? 2 : key === "sender" ? stranger.address : keccak256(toBytes(`changed-${key}`)) } })),
      ...["name", "version", "chainId", "verifyingContract"].map(key => ({ ...v1, domain: { ...v1.domain, [key]: key === "chainId" ? 1 : key === "verifyingContract" ? stranger.address : "wrong" } })),
    ];
    for (const candidate of candidates) await assert.rejects(verifyEnvelope(candidate, config));
    const wrongDomain = { ...v1, domain: { ...v1.domain, chainId: 1 } };
    const wrongSignature = await env.account.signTypedData({ ...typedData(v1), domain: wrongDomain.domain });
    await assert.rejects(publish({ ...v1, signature: wrongSignature }));
    await assert.rejects(publish({ ...v1, message: { ...v1.message, feed: zeroHash } }));
    await assert.rejects(publish({ ...v1, signature: await stranger.signTypedData(typedData(v1)) }));
    await assert.rejects(client.simulateContract({ account: stranger.address, address: registry, abi, functionName: "publish", args: [v1.message, v1.signature] }));
  });
  await t.test("missing wallet, wrong account/network, rejection and storage failure cannot publish", async () => {
    const fresh = (): Attempt => ({ draft: freezeDraft(text, config, { version: 0, digest: zeroHash }) });
    for (const provider of [undefined, testDevice(env, { eth_accounts: [] }), testDevice(env, { eth_chainId: "0x1" }),
      testDevice(env, { eth_signTypedData_v4: Object.assign(new Error("User rejected"), { code: 4001 }) })]) {
      await assert.rejects(publishAttempt(config, provider, fresh(), () => {}, () => {}, post));
    }
    const attempt = fresh(), stages: Stage[] = [];
    await assert.rejects(publishAttempt(config, testDevice(env), attempt, value => stages.push(value), () => {}, async () => { throw new Error("SQLite unavailable"); }));
    assert.ok(attempt.packet); assert.ok(!attempt.txHash); assert.ok(!stages.includes("transaction"));
    assert.equal((await readSnapshot(client, config)).version, 0);
    const before = await refresh(); assert.equal(before.entries.length, 0); assert.equal(before.missingHead, false);
  });
  await t.test("a mined reverted transaction does not become a publication", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    const hash = await wallet.writeContract({ address: registry, abi, functionName: "publish", args: [v1.message, await stranger.signTypedData(typedData(v1))], gas: 300000n });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "reverted");
    assert.equal((await readSnapshot(client, config)).version, 0);
    assert.equal(await publicationProof(client, config, v1, await readSnapshot(client, config)), null);
  });
  await t.test("signature and storage are distinct from mined confirmation; retry is idempotent", async () => {
    const attempt: Attempt = { draft: freezeDraft(text, config, { version: 0, digest: zeroHash }) };
    await assert.rejects(publishAttempt(config, testDevice(env, { eth_sendTransaction: Object.assign(new Error("User rejected"), { code: 4001 }) }), attempt, () => {}, () => {}, post));
    assert.equal((await env.receive()).length, 1);
    let state = await refresh(); assert.equal(state.entries[0].status, "pending"); assert.equal(state.entries[0].signature, "passed");
    const stages: Stage[] = [];
    const result = await publishAttempt(config, testDevice(env), attempt, value => stages.push(value), () => {}, post);
    assert.equal(result.packet.packageDigest, v1.packageDigest);
    assert.equal(stages.at(-1), "complete");
    const headBefore = await readSnapshot(client, config);
    await publishAttempt(config, testDevice(env), attempt, () => {}, () => {}, post);
    assert.equal((await readSnapshot(client, config)).blockNumber, headBefore.blockNumber);
    assert.equal((await env.receive()).length, 1);
    state = await refresh(); assert.equal(state.entries[0].body, text); assert.equal(state.entries[0].status, "current");
    const tx = await client.getTransaction({ hash: result.proof.txHash });
    assert.ok(!tx.input.includes(Buffer.from(text).toString("hex")));
    assert.equal((await env.post(`/api/messages/${v1.packageDigest}/confirm`, { txHash: zeroHash })).status, 400);
  });
  await t.test("SQLite writes cannot overwrite published bytes through the API", async () => {
    const forged = { ...v1, body: "16.00" };
    assert.equal((await env.post("/api/messages", forged)).status, 400);
    assert.equal((await env.post("/api/messages", { ...v1, verified: true })).status, 400);
    assert.equal((await fetch(`${env.apiUrl}/api/messages`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://attacker.invalid" }, body: JSON.stringify(v1) })).status, 403);
    assert.equal((await env.receive()).length, 1);
    const snapshot = await readSnapshot(client, config);
    const proof = (await publicationProof(client, config, v1, snapshot))!;
    env.api.store.db.prepare("UPDATE messages SET tx_hash = ?").run(zeroHash);
    assert.equal((await env.post(`/api/messages/${v1.packageDigest}/confirm`, { txHash: proof.txHash })).status, 400);
    env.api.store.db.prepare("UPDATE messages SET tx_hash = ?").run(proof.txHash);
  });
  await t.test("real SQLite text tampering is rejected without overwriting verified copy", async () => {
    await demoAction(env.dbPath, env.backupPath, "snapshot");
    await demoAction(env.dbPath, env.backupPath, "tamper-text");
    const state = await refresh();
    assert.ok(state.entries.some(e => e.signature === "failed" && e.body.includes("16.00")));
    assert.ok(state.entries.some(e => e.status === "current" && e.cached && e.body === text));
    assert.equal(state.missingHead, true);
    assert.equal(saved.length, 1);
    const fresh = new InboxVerifier(config, env.receive); let cold: InboxState | undefined;
    await fresh.refresh(state => { cold = state; });
    assert.ok(!cold!.entries.some(e => e.status === "current"));
    await demoAction(env.dbPath, env.backupPath, "restore");
  });
  await t.test("replay, arbitrary series ID, skipped version and competing predecessor are rejected", async () => {
    await assert.rejects(publish(v1));
    const draft = { ...v1, message: { ...v1.message, messageId: keccak256(toBytes("another-series")) } };
    await assert.rejects(publish({ ...draft, signature: await env.account.signTypedData(typedData(draft)) }));
    await assert.rejects(publish(await signed(env, "Skipped", 3, v1.packageDigest)));
    const v2 = await signed(env, "Samling 16.00. Ta med vatten.", 2, v1.packageDigest);
    const competing = await signed(env, "Samling 18.00.", 2, v1.packageDigest);
    await post("/api/messages", v2);
    const txHash = await publish(v2); await client.waitForTransactionReceipt({ hash: txHash });
    await post(`/api/messages/${v2.packageDigest}/confirm`, { txHash });
    await assert.rejects(publish(competing));
    assert.equal((await env.post("/api/messages", competing)).status, 400);
    const state = await refresh();
    assert.equal(state.entries.find(e => e.packet?.message.version === 1)?.status, "superseded");
    assert.equal(state.entries.find(e => e.packet?.message.version === 2)?.status, "current");
    assert.equal(await client.readContract({ address: registry, abi, functionName: "digest", args: [v2.message] }), v2.packageDigest);
  });
  await t.test("database rollback cannot hide the new head, including in a fresh receiver", async () => {
    await demoAction(env.dbPath, env.backupPath, "snapshot");
    await demoAction(env.dbPath, env.backupPath, "serve-v1");
    const cold = new InboxVerifier(config, env.receive); let state: InboxState | undefined;
    await cold.refresh(value => { state = value; });
    assert.equal(state!.snapshot!.version, 2); assert.equal(state!.missingHead, true);
    assert.equal(state!.entries.length, 1); assert.equal(state!.entries[0].status, "superseded");
    await demoAction(env.dbPath, env.backupPath, "restore");
  });
  await t.test("definitive chain mismatch fails; duplicate deliveries cannot evict saved versions", async () => {
    const conflicting = await signed(env, "Conflicting version", 2, v1.packageDigest);
    let state: InboxState | undefined;
    const conflict = new InboxVerifier(config, async () => [conflicting]);
    await conflict.refresh(value => { state = value; });
    assert.equal(state!.entries[0].signature, "passed"); assert.equal(state!.entries[0].status, "failed");
    const all = await env.receive();
    let kept: unknown[] = [];
    const duplicates = new InboxVerifier(config, async () => Array(1000).fill(all[1]), [all[0]], packets => { kept = packets; });
    await duplicates.refresh(value => { state = value; });
    assert.equal(kept.length, 2); assert.equal(state!.entries.length, 2);
    assert.ok(state!.entries.some(e => e.packet?.message.version === 1));
  });
  await t.test("deleted or withheld content and failed API never reconstruct text", async () => {
    await demoAction(env.dbPath, env.backupPath, "delete-content");
    const cold = new InboxVerifier(config, env.receive); let state: InboxState | undefined;
    await cold.refresh(value => { state = value; });
    assert.equal(state!.missingHead, true); assert.equal(state!.entries.length, 0); assert.equal(state!.snapshot!.version, 2);
    const failed = new InboxVerifier(config, async () => { throw new Error("API down"); });
    await failed.refresh(value => { state = value; });
    assert.equal(state!.snapshot!.version, 2); assert.ok(state!.deliveryError); assert.equal(state!.entries.length, 0);
    await demoAction(env.dbPath, env.backupPath, "restore");
  });
  await t.test("late responses cannot approve changed delivery with the same ID/digest", async () => {
    let release: (data: unknown[]) => void = () => {};
    let call = 0;
    const delayed = new InboxVerifier(config, async () => ++call === 1 ? new Promise(resolve => { release = resolve; }) : [{ ...v1, body: "forged" }]);
    let state: InboxState | undefined;
    const old = delayed.refresh(value => { state = value; });
    await delayed.refresh(value => { state = value; });
    release([v1]); await old;
    assert.equal(state!.entries[0].signature, "failed"); assert.equal(state!.entries[0].body, "forged");
  });
  await t.test("backend restart and chain restart preserve rows, history, receipts and trust", async () => {
    await assert.rejects(startApi(config, `${env.root}/missing.sqlite`, 0));
    await env.restartApi(); assert.equal((await env.receive()).length, 2);
    const before = await readSnapshot(client, config);
    await env.restartChain();
    const after = await readSnapshot(client, config);
    assert.equal(after.digest, before.digest); assert.equal(after.blockNumber, before.blockNumber);
    const proof = await publicationProof(client, config, v1, after); assert.ok(proof);
    await assertSnapshot(client, after);
    const state = await refresh(); assert.ok(state.entries.some(e => e.status === "current"));
    assert.ok((await readFile(env.statePath, "utf8")).length > 0);
  });
  await t.test("wrong trusted contract/network and unavailable publication evidence never pass", async () => {
    for (const bad of [{ ...config, codeHash: zeroHash }, { ...config, publisher: "0x0000000000000000000000000000000000000001" as const }, { ...config, genesisHash: zeroHash }])
      await assert.rejects(readSnapshot(client, bad));
    const head = await readSnapshot(client, config);
    const missingReceipt = new Proxy(client, { get(target, key) { return key === "getTransactionReceipt" ? async () => { throw new Error("missing receipt"); } : Reflect.get(target, key); } });
    await assert.rejects(publicationProof(missingReceipt, config, v1, head));
  });
  await t.test("RPC outage removes current approvals and retains separately checked signatures", async () => {
    const before = await refresh(); assert.ok(before.entries.some(e => e.status === "current"));
    await env.stopChain();
    const during = await refresh();
    assert.ok(during.chainError); assert.ok(during.lastSuccess); assert.equal(during.snapshot, undefined);
    assert.ok(during.entries.every(e => e.status === "unavailable"));
    assert.ok(during.entries.every(e => e.signature === "passed"));
  });
});
