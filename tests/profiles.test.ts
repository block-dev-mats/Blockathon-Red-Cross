import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";
import type { EIP1193Provider, PublicClient, Hex } from "viem";
import { keccak256, zeroHash } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { environment, signed, testDevice, unusedPort } from "./helpers.ts";
import { abi, freezeDraft, parseConfig, typedData, verifyEnvelope } from "../shared/protocol.ts";
import { readSnapshot, assertSnapshot } from "../shared/chain.ts";
import { profileById, profiles, validRpcUrl } from "../shared/profiles.ts";
import { profileDirectory, profileViteConfig } from "../server/profile-config.ts";
import { freePorts } from "../scripts/runtime.ts";
import { checkBrowserRpc, deploymentPlan, networkPreflight } from "../scripts/sepolia-preflight.ts";
import { resumeDeployment, validateJournal, writeExclusive, readJournal } from "../scripts/sepolia-deployment.ts";
import { assertCompiledCode } from "../scripts/contract.ts";
import { castSignArguments } from "../scripts/sepolia.ts";
import { demoAction } from "../scripts/demo.ts";
import { publishAttempt, restoreAttempt } from "../src/live/publish.ts";
import type { Attempt } from "../src/live/publish.ts";
import { cacheKey, InboxVerifier } from "../src/live/inbox.ts";
import type { InboxState } from "../src/live/inbox.ts";

test("exactly two explicit profiles and fixed loopback routes", () => {
  for (const id of [undefined, "development", "mainnet", "11155111", ""]) assert.throws(() => profileById(id));
  assert.deepEqual([profiles.local.chainId, profiles.local.frontendPort, profiles.local.apiPort], [31337, 5175, 3001]);
  assert.deepEqual([profiles.sepolia.chainId, profiles.sepolia.frontendPort, profiles.sepolia.apiPort], [11155111, 5176, 3002]);
  assert.notEqual(profileDirectory("local"), profileDirectory("sepolia"));
  for (const id of ["local", "sepolia"] as const) {
    const vite = profileViteConfig(id);
    assert.equal(vite.server?.host, "127.0.0.1"); assert.equal(vite.server?.strictPort, true);
    assert.equal(vite.define?.__APP_PROFILE__, JSON.stringify(id));
    assert.equal((vite.server?.proxy?.["/api"] as { target: string }).target, `http://127.0.0.1:${profiles[id].apiPort}`);
    assert.equal(vite.envDir, false);
  }
  for (const url of ["http://sepolia.invalid", "https://token@sepolia.invalid", "https://sepolia.invalid?key=secret", "https://sepolia.invalid/#secret"])
    assert.equal(validRpcUrl(11155111, url), false);
  assert.equal(validRpcUrl(1, "https://mainnet.invalid"), false);
});

test("shared product with two isolated profiles (Sepolia settings emulated offline)", { timeout: 240000 }, async t => {
  const local = await environment(); t.after(() => local.close());
  const sepolia = await environment({ profile: "sepolia", account: local.account }); t.after(() => sepolia.close());
  const fixture = sepolia.fixture!;
  const text = "Samling 14.00. Samma publicerare och exakta bytes på två nät.";
  const localPacket = await signed(local, text), sepoliaPacket = await signed(sepolia, text);
  const fresh = (): Attempt => ({ draft: freezeDraft(text, sepolia.config, { version: 0, digest: zeroHash }) });
  const post = async (path: string, body: unknown) => { const response = await sepolia.post(path, body); assert.equal(response.status, 200, await response.text()); };
  const stateOf = async (verifier: InboxVerifier) => { let state!: InboxState; await verifier.refresh(value => { state = value; }); return state; };
  const counts = { signs: 0, transactions: 0 };
  const device = testDevice(sepolia);
  const counted = { request: async (args: { method: string; params?: unknown }) => {
    if (args.method === "eth_signTypedData_v4") counts.signs++;
    if (args.method === "eth_sendTransaction") counts.transactions++;
    return device.request(args as never);
  } } as EIP1193Provider;

  await t.test("configuration, signature, API and contract reject the other domain", async () => {
    assert.equal(local.config.publisher, sepolia.config.publisher);
    assert.equal(localPacket.message.bodyHash, sepoliaPacket.message.bodyHash);
    assert.notEqual(localPacket.packageDigest, sepoliaPacket.packageDigest);
    assert.notEqual(cacheKey(local.config), cacheKey(sepolia.config));
    assert.notEqual(cacheKey(local.config), cacheKey({ ...local.config, domain: { ...local.config.domain, chainId: 11155111 } }));
    assert.notEqual(cacheKey(local.config), cacheKey({ ...local.config, deploymentBlockHash: zeroHash }));
    assert.throws(() => parseConfig(local.config, "sepolia"));
    assert.throws(() => parseConfig(sepolia.config, "local"));
    assert.throws(() => parseConfig({ ...sepolia.config, genesisHash: zeroHash }, "sepolia"));
    assert.throws(() => parseConfig({ ...sepolia.config, rpcVisibility: undefined }, "sepolia"));
    assert.throws(() => parseConfig({ ...sepolia.config, domain: { ...sepolia.config.domain, chainId: 1 } }, "sepolia"));
    await assert.rejects(verifyEnvelope(localPacket, sepolia.config));
    await assert.rejects(verifyEnvelope(sepoliaPacket, local.config));
    await assert.rejects(verifyEnvelope({ ...sepoliaPacket, signature: localPacket.signature }, sepolia.config));
    const wrongContract = { ...sepoliaPacket, domain: { ...sepoliaPacket.domain, verifyingContract: local.config.domain.verifyingContract } };
    await assert.rejects(verifyEnvelope({ ...wrongContract, signature: await local.account.signTypedData(typedData(wrongContract)) }, sepolia.config));
    assert.equal((await sepolia.post("/api/messages", localPacket)).status, 400);
    assert.equal((await local.post("/api/messages", sepoliaPacket)).status, 400);
    await assert.rejects(readSnapshot(local.client, sepolia.config));
    await assert.rejects(readSnapshot(sepolia.client, { ...sepolia.config, domain: wrongContract.domain }));
    await assert.rejects(sepolia.client.simulateContract({ account: sepolia.config.publisher, address: sepolia.config.domain.verifyingContract,
      abi, functionName: "publish", args: [sepoliaPacket.message, localPacket.signature] }));
    assert.equal(await sepolia.client.readContract({ address: sepolia.config.domain.verifyingContract, abi, functionName: "digest", args: [sepoliaPacket.message] }), sepoliaPacket.packageDigest);
    assert.throws(() => restoreAttempt({ draft: localPacket }, sepolia.config));
  });

  await t.test("preflight, code check and saved deployment resume without another broadcast", async () => {
    const result = await networkPreflight(fixture.settings, sepolia.config);
    assert.ok(result.receiptEvidenceAvailable);
    const plan = await deploymentPlan(fixture.settings); assert.ok(plan.gas > 0n); assert.ok(plan.maxCost > 0n);
    // Cast's actual CLI signs the same constructor/gas plan from an encrypted
    // disposable test keystore. No browser extension dialog is claimed here.
    const key = generatePrivateKey(), password = randomBytes(24).toString("hex");
    const passwordFile = `${sepolia.root}/test-password`;
    await writeFile(passwordFile, password, { mode: 0o600 });
    const childEnv = { PATH: process.env.PATH, HOME: sepolia.root, CAST_UNSAFE_PASSWORD: password };
    const imported = spawnSync("cast", ["wallet", "import", "test-deployer", "--keystore-dir", sepolia.root, "--private-key", key], { env: childEnv, encoding: "utf8" });
    assert.equal(imported.status, 0, "Disposable encrypted test keystore import failed");
    const s = { ...fixture.settings, deployer: privateKeyToAccount(key).address.toLowerCase() as Hex };
    // Cast can work fully offline with these explicit tx fields; substitute
    // loopback only for its own RPC transport (the JS facade is process-local).
    const args = castSignArguments({ ...s, rpcUrl: `http://127.0.0.1:${new URL(fixture.settings.rpcUrl).pathname.slice(1)}` }, plan, `${sepolia.root}/test-deployer`);
    args.splice(1, 0, "--password-file", passwordFile);
    const signedTx = spawnSync("cast", args, { env: { PATH: process.env.PATH, HOME: sepolia.root }, encoding: "utf8" });
    assert.equal(signedTx.status, 0, "Cast mktx failed for the explicit local test plan");
    const rawTransaction = signedTx.stdout.trim() as Hex;
    await validateJournal({ settings: s, rawTransaction, txHash: keccak256(rawTransaction) }, s);
    const code = await sepolia.client.getCode({ address: sepolia.config.domain.verifyingContract });
    await assertCompiledCode(code!); await assert.rejects(assertCompiledCode("0x1234"));
    const path = `${sepolia.root}/pending-deployment.json`;
    await writeExclusive(path, fixture.journal);
    await assert.rejects(writeExclusive(path, fixture.journal));
    const journal = await readJournal(path);
    await assert.rejects(validateJournal({ ...journal, txHash: zeroHash }, fixture.settings));
    await assert.rejects(validateJournal(journal, { ...fixture.settings, publisher: local.config.domain.verifyingContract }));
    let broadcasts = 0;
    const failing = new Proxy(sepolia.client, { get(target, key) {
      if (key === "waitForTransactionReceipt") return async () => { throw new Error("Receipt timeout / 429"); };
      if (key === "sendRawTransaction") return async () => { broadcasts++; throw new Error("Must not rebroadcast a known transaction"); };
      return Reflect.get(target, key);
    } });
    await assert.rejects(resumeDeployment(failing, journal, fixture.settings));
    assert.equal((await readJournal(path)).txHash, journal.txHash);
    const resumed = await resumeDeployment(sepolia.client, await readJournal(path), fixture.settings);
    assert.deepEqual(resumed, sepolia.config); assert.equal(broadcasts, 0);
    // The first broadcast reached the EVM but the response was lost. Resume
    // from the file written before sending; exactly one deployment is mined.
    const beforeNonce = await sepolia.client.getTransactionCount({ address: fixture.settings.deployer });
    const nextRaw = await sepolia.account.signTransaction({ chainId: 11155111, type: "eip1559", nonce: beforeNonce,
      data: plan.data, gas: plan.gas, maxFeePerGas: plan.maxFeePerGas, maxPriorityFeePerGas: plan.maxPriorityFeePerGas });
    const nextJournal = { settings: fixture.settings, rawTransaction: nextRaw, txHash: keccak256(nextRaw) };
    const nextPath = `${sepolia.root}/ambiguous-deployment.json`; await writeExclusive(nextPath, nextJournal);
    let sent = 0;
    const lostResponse = new Proxy(sepolia.client, { get(target, key) {
      if (key === "sendRawTransaction") return async (args: Parameters<typeof target.sendRawTransaction>[0]) => {
        sent++; await target.sendRawTransaction(args); throw new Error("Response timeout after send");
      };
      return Reflect.get(target, key);
    } });
    await assert.rejects(resumeDeployment(lostResponse, await readJournal(nextPath), fixture.settings), /Broadcast/);
    const recovered = await resumeDeployment(lostResponse, await readJournal(nextPath), fixture.settings);
    assert.notEqual(recovered.domain.verifyingContract, sepolia.config.domain.verifyingContract);
    assert.equal(sent, 1); assert.equal(await sepolia.client.getTransactionCount({ address: fixture.settings.deployer }), beforeNonce + 1);
    const snapshot = await readSnapshot(sepolia.client, sepolia.config);
    const changedBlock = new Proxy(sepolia.client, { get(target, key) { return key === "getBlock" ? async () => ({ hash: zeroHash }) : Reflect.get(target, key); } });
    await assert.rejects(assertSnapshot(changedBlock as PublicClient, snapshot));
  });

  await t.test("wallet account and network are checked again before signing and sending", async () => {
    for (const [changeAt, field] of [[2, "eth_accounts"], [3, "eth_accounts"], [2, "eth_chainId"], [3, "eth_chainId"]] as const) {
      let calls = 0, signCount = 0, txCount = 0;
      const moving = { request: async (args: { method: string; params?: unknown }) => {
        if (args.method === "eth_signTypedData_v4") signCount++;
        if (args.method === "eth_sendTransaction") txCount++;
        if (args.method === field && ++calls === changeAt) return field === "eth_accounts" ? [] : "0x7a69";
        return device.request(args as never);
      } } as EIP1193Provider;
      await assert.rejects(publishAttempt(sepolia.config, moving, fresh(), () => {}, () => {}, post));
      assert.equal(txCount, 0); assert.equal(signCount, changeAt === 2 ? 0 : 1);
    }
    assert.equal((await readSnapshot(sepolia.client, sepolia.config)).version, 0);
  });

  const attempt = fresh();
  await t.test("pending, receipt timeout/429 and reload resume retain one signature and transaction", async () => {
    await fixture.admin("evm_setAutomine", [false]);
    // Shorten only the test clock, not the production timeout or confirmation policy.
    const timing = profiles.sepolia as { receiptTimeout: number; receiptPollInterval: number };
    const original = { receiptTimeout: timing.receiptTimeout, receiptPollInterval: timing.receiptPollInterval };
    timing.receiptTimeout = 150; timing.receiptPollInterval = 40;
    let saved = "";
    try {
      await assert.rejects(publishAttempt(sepolia.config, counted, attempt, () => {}, value => { saved = JSON.stringify(value); }, post));
      assert.ok(attempt.packet); assert.ok(attempt.txHash); assert.equal(attempt.transactionRequested, true);
      assert.equal((await stateOf(new InboxVerifier(sepolia.config, sepolia.receive))).entries[0].status, "pending");
      fixture.setFault(request => request.method === "eth_getTransactionReceipt" ? new Response("rate limited", { status: 429 }) : undefined);
      const reloaded = restoreAttempt(JSON.parse(saved), sepolia.config);
      await assert.rejects(publishAttempt(sepolia.config, counted, reloaded, () => {}, () => {}, post));
      assert.equal(reloaded.txHash, attempt.txHash); assert.deepEqual(counts, { signs: 1, transactions: 1 });
    } finally { fixture.setFault(); Object.assign(timing, original); await fixture.admin("evm_setAutomine", [true]); await fixture.admin("evm_mine"); }
    await sepolia.restartApi();
    const result = await publishAttempt(sepolia.config, counted, restoreAttempt(JSON.parse(saved), sepolia.config), () => {}, () => {}, post);
    assert.equal(result.proof.txHash, attempt.txHash); assert.deepEqual(counts, { signs: 1, transactions: 1 });
    assert.equal((await sepolia.receive()).length, 1); assert.equal((await local.receive()).length, 0);
  });

  await t.test("simultaneous browser origins use the same views with isolated API/cache/attempts", async () => {
    const browser = await chromium.launch({ headless: true });
    const servers: Awaited<ReturnType<typeof createServer>>[] = [];
    try {
      const context = await browser.newContext(); await fixture.route(context);
      const receiverContext = await browser.newContext({ viewport: { width: 390, height: 844 } }); await fixture.route(receiverContext);
      const localPage = await context.newPage(), publisher = await context.newPage(), recipient = await receiverContext.newPage();
      publisher.setDefaultTimeout(30000); recipient.setDefaultTimeout(30000);
      const errors: string[] = [];
      for (const page of [localPage, publisher, recipient]) page.on("pageerror", e => errors.push(e.message));
      await context.exposeBinding("testWalletRequest", (_source, request: { method: string; params?: unknown }) => counted.request(request as never));
      await context.addInitScript("window.ethereum = { request: args => window.testWalletRequest(args) };");
      for (const [id, env] of [["local", local], ["sepolia", sepolia]] as const) {
        const server = await createServer({ ...profileViteConfig(id, { readDeployment: async () => env.config, frontendPort: env.frontendPort, apiPort: Number(new URL(env.apiUrl).port) }), configFile: false });
        await server.listen(); servers.push(server);
        const base = `http://127.0.0.1:${env.frontendPort}`;
        assert.deepEqual(await (await fetch(`${base}/deployment.json`)).json(), env.config);
        assert.equal((await (await fetch(`${base}/api/health`)).json()).profile, id);
        await assert.rejects(freePorts([env.frontendPort]));
        assert.equal((await fetch(`${base}/api/health`)).status, 200); // Port conflict killed nothing.
      }
      const l = `http://127.0.0.1:${local.frontendPort}`, s = `http://127.0.0.1:${sepolia.frontendPort}`;
      await localPage.goto(`${l}/publish`); await localPage.getByText("Lokalt EVM-nät · Demoorganisation", { exact: true }).waitFor();
      await localPage.getByRole("button", { name: "Granska meddelandet" }).click(); await localPage.getByTestId("frozen-body").waitFor();
      const localStorageCopy = await localPage.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
      const localAttemptKey = Object.keys(localStorageCopy).find(k => k.startsWith("crisis-publish:"))!;
      const legacyKey = `crisis-publish:${local.config.domain.verifyingContract}:${local.config.codeHash}`;
      await localPage.evaluate(({ key, old, value }) => { localStorage.removeItem(key); localStorage.setItem(old, value); }, { key: localAttemptKey, old: legacyKey, value: localStorageCopy[localAttemptKey] });
      await localPage.reload(); await localPage.getByTestId("frozen-body").waitFor();
      await localPage.getByRole("button", { name: "Redigera texten" }).click(); await localPage.reload();
      assert.equal(await localPage.getByTestId("frozen-body").count(), 0);
      assert.ok(await localPage.evaluate(key => localStorage.getItem(key), legacyKey)); // Original data retained, not destructively migrated.
      await publisher.goto(`${s}/publish`); await publisher.getByText("Sepolia · Demoorganisation", { exact: true }).waitFor();
      assert.equal(await publisher.getByTestId("frozen-body").count(), 0);
      await publisher.evaluate(value => { for (const [key, data] of Object.entries(value)) localStorage.setItem(key, data); }, localStorageCopy);
      await publisher.reload(); assert.equal(await publisher.getByTestId("frozen-body").count(), 0);
      await recipient.goto(`${s}/inbox`); await recipient.locator('[data-status="current"]').waitFor();
      assert.equal(await recipient.evaluate(() => typeof window.ethereum), "undefined");
      await recipient.locator("summary").first().click();
      assert.equal(await recipient.getByRole("link", { name: "Kontrakt", exact: true }).getAttribute("href"), `https://sepolia.etherscan.io/address/${sepolia.config.domain.verifyingContract}`);
      await publisher.getByLabel("Meddelande", { exact: true }).fill("Sepolia-profilens uppdatering 16.00.");
      await publisher.getByRole("button", { name: "Granska meddelandet" }).click(); await publisher.getByTestId("frozen-body").waitFor();
      const keys = await publisher.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("crisis-publish:")));
      assert.equal(keys.length, 2); assert.ok(keys.includes(localAttemptKey));
      const activeKey = keys.find(k => k !== localAttemptKey)!;
      const goodAttempt = await publisher.evaluate(key => localStorage.getItem(key)!, activeKey);
      await publisher.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: activeKey, value: localStorageCopy[localAttemptKey] });
      await publisher.reload(); await publisher.getByRole("alert").filter({ hasText: "Det sparade utkastet" }).waitFor();
      assert.equal(await publisher.getByTestId("frozen-body").count(), 0);
      await publisher.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: activeKey, value: goodAttempt });
      await publisher.reload(); await publisher.getByRole("button", { name: "Signera och publicera" }).click();
      await publisher.getByRole("status").filter({ hasText: "Publicerat och bekräftat" }).waitFor();
      await recipient.locator('[data-status="current"]').filter({ hasText: "Version 2" }).waitFor();
      await recipient.locator('[data-status="superseded"]').waitFor();
      assert.equal(await recipient.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(counts, { signs: 2, transactions: 2 });
      await sepolia.restartApi(); await recipient.reload(); await recipient.locator('[data-status="current"]').waitFor();
      await localPage.goto(`${l}/inbox`); await localPage.getByRole("heading", { name: "Inget meddelande ännu" }).waitFor();
      assert.equal((await local.receive()).length, 0); assert.equal((await sepolia.receive()).length, 2);
      // Test-controlled sentinel files, never deployment secrets or keystores.
      const created: string[] = [];
      try {
        for (const id of ["local", "sepolia"] as const) {
          await mkdir(profileDirectory(id), { recursive: true, mode: 0o700 });
          const sentinel = `${profileDirectory(id)}/test-deny-${process.pid}.txt`;
          await writeFile(sentinel, "private-test-sentinel", { flag: "wx" }); created.push(sentinel);
          for (const base of [l, s]) for (const path of [`/${profiles[id].directory}/${sentinel.split("/").at(-1)}?raw`, `/@fs${sentinel}`]) {
            const response = await fetch(`${base}${path}`); assert.ok(!response.ok); assert.ok(!(await response.text()).includes("private-test-sentinel"));
          }
        }
      } finally { for (const path of created) await rm(path); }
      assert.deepEqual(errors, []);
    } finally { await browser.close(); for (const server of servers) await server.close(); }
  });

  await t.test("Sepolia settings keep tamper, withheld-head, missing evidence and RPC failures fail-closed", async () => {
    const receiver = new InboxVerifier(sepolia.config, sepolia.receive);
    assert.ok((await stateOf(receiver)).entries.some(e => e.status === "current"));
    await demoAction(sepolia.dbPath, sepolia.backupPath, "snapshot");
    await demoAction(sepolia.dbPath, sepolia.backupPath, "tamper-text");
    const altered = await stateOf(receiver); assert.ok(altered.entries.some(e => e.signature === "failed"));
    assert.ok(altered.entries.some(e => e.cached && e.body.includes("14.00")));
    await demoAction(sepolia.dbPath, sepolia.backupPath, "restore");
    await demoAction(sepolia.dbPath, sepolia.backupPath, "serve-v1");
    const cold = await stateOf(new InboxVerifier(sepolia.config, sepolia.receive));
    assert.equal(cold.missingHead, true); assert.equal(cold.snapshot?.version, 2); assert.equal(cold.entries[0].status, "superseded");
    await demoAction(sepolia.dbPath, sepolia.backupPath, "delete-content");
    const empty = await stateOf(new InboxVerifier(sepolia.config, sepolia.receive)); assert.equal(empty.missingHead, true); assert.equal(empty.entries.length, 0);
    await demoAction(sepolia.dbPath, sepolia.backupPath, "restore");
    fixture.setFault(request => request.method === "eth_getLogs" ? Response.json({ jsonrpc: "2.0", id: request.id, result: [] }) : undefined);
    assert.ok((await stateOf(receiver)).entries.every(e => e.status === "unavailable"));
    fixture.setFault(() => new Response("rate limited", { status: 429 }));
    const down = await stateOf(receiver); assert.ok(down.chainError); assert.ok(down.lastSuccess); assert.equal(down.snapshot, undefined);
    assert.ok(down.entries.every(e => e.status === "unavailable"));
    fixture.setFault(); assert.ok((await stateOf(receiver)).entries.some(e => e.status === "current"));
    assert.equal((await readSnapshot(local.client, local.config)).version, 0);
  });
  await t.test("ambiguous wallet send never silently retries or creates another transaction", async () => {
    let sends = 0, signs = 0;
    const lostResponse = { on() {}, removeListener() {}, request: async (args: { method: string; params?: unknown }) => {
      if (args.method === "eth_signTypedData_v4") signs++;
      const result = await device.request(args as never);
      if (args.method === "eth_sendTransaction") { sends++; throw Object.assign(new Error("Response lost after send"), { code: 429 }); }
      return result;
    } } as EIP1193Provider;
    const attempt: Attempt = { draft: freezeDraft("Fördröjt svar 18.00.", sepolia.config, await readSnapshot(sepolia.client, sepolia.config)) };
    await assert.rejects(publishAttempt(sepolia.config, lostResponse, attempt, () => {}, () => {}, post));
    assert.equal(attempt.transactionRequested, true); assert.equal(attempt.txHash, undefined);
    await publishAttempt(sepolia.config, lostResponse, restoreAttempt(JSON.parse(JSON.stringify(attempt)), sepolia.config), () => {}, () => {}, post);
    assert.equal(sends, 1); assert.equal(signs, 1); assert.equal((await readSnapshot(sepolia.client, sepolia.config)).version, 3);
    const unknown: Attempt = { draft: freezeDraft("Okänt walletutfall.", sepolia.config, await readSnapshot(sepolia.client, sepolia.config)) };
    const unavailable = testDevice(sepolia, { eth_sendTransaction: Object.assign(new Error("Wallet transport unavailable"), { code: 429 }) });
    await assert.rejects(publishAttempt(sepolia.config, unavailable, unknown, () => {}, () => {}, post));
    await assert.rejects(publishAttempt(sepolia.config, device, unknown, () => {}, () => {}, post), /utfall är okänt/);
    assert.equal((await readSnapshot(sepolia.client, sepolia.config)).version, 3);
  });
});

test("browser preflight distinguishes a working server RPC from blocked CORS (offline probe)", { timeout: 30000 }, async t => {
  let cors = false;
  const documentServer = createHttpServer((_req, res) => { res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>CORS test</title>"); });
  const documentPort = await unusedPort(); await new Promise<void>(resolve => documentServer.listen(documentPort, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => documentServer.close(() => resolve())));
  const origin = `http://127.0.0.1:${documentPort}`;
  const server = createHttpServer((req, res) => {
    if (cors) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Access-Control-Allow-Headers", "content-type"); res.setHeader("Access-Control-Allow-Methods", "POST"); }
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xaa36a7" }));
  });
  const port = await unusedPort(); await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  // Deliberate probe-only HTTP fixture. Production settingsSchema rejects it.
  const settings = { chainId: 11155111 as const, rpcUrl: `http://127.0.0.1:${port}`, rpcVisibility: "public-browser" as const, publisher: `0x${"1".repeat(40)}` as const, deployer: `0x${"1".repeat(40)}` as const };
  const requests = [{ jsonrpc: "2.0" as const, id: 1, method: "eth_chainId", params: [] }];
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); await page.goto(origin);
  assert.equal((await fetch(settings.rpcUrl)).status, 200);
  await assert.rejects(checkBrowserRpc(page, settings, requests), /CORS/);
  cors = true; await checkBrowserRpc(page, settings, requests);
});
