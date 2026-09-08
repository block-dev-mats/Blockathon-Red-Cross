import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";
import type { EIP1193Provider, Hex } from "viem";
import { zeroHash } from "viem";
import { environment, testDevice, unusedPort } from "./helpers.ts";
import { startDeploymentApi } from "../server/deployment-api.ts";
import { startApi } from "../server/api.ts";
import { profileViteConfig } from "../server/profile-config.ts";
import { exists } from "../scripts/sepolia-deployment.ts";
import { deploymentIdentity, verifyDeployment } from "../shared/deployment.ts";
import { confirmDeployment, sendDeployment } from "../src/live/deploy.ts";

// Real transactions and generated test accounts on an isolated local EVM.
// The Sepolia facade does not demonstrate public RPC or MetaMask dialogs.
test("browser deployment, durable intent and server trust write boundary", { timeout: 120000 }, async t => {
  const env = await environment({ profile: "sepolia" }); t.after(() => env.close());
  const fixture = env.fixture!, settings = fixture.settings;
  const root = `${env.root}/setup`; await mkdir(root); await writeFile(`${root}/settings.json`, JSON.stringify(settings));
  const apiPort = await unusedPort(), origin = `http://127.0.0.1:${env.frontendPort}`;
  let api = await startDeploymentApi(root, apiPort, origin); t.after(() => api.close());
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/deploy${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", Connection: "close", Origin: origin }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
  };
  const plan = (await call("")).plan;
  assert.equal(await exists(`${root}/demo.sqlite`), false);
  assert.equal(await exists(`${root}/deployment.json`), false);
  const device = testDevice(env); let sends = 0;
  const counted = { request: async (r: { method: string }) => { if (r.method === "eth_sendTransaction") sends++; return device.request(r as never); } } as EIP1193Provider;
  for (const overrides of [{ eth_accounts: [] }, { eth_chainId: "0x7a69" }]) {
    await assert.rejects(sendDeployment(plan, testDevice(env, overrides), () => {}, call), /Fel konto|Fel nätverk/);
    assert.equal(await exists(`${root}/pending-deployment.json`), false);
  }
  await assert.rejects(sendDeployment(plan, undefined, () => {}, call), /Ingen browser-wallet/);
  const blocked = await fetch(`http://127.0.0.1:${apiPort}/api/deploy/begin`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://foreign.invalid" }, body: JSON.stringify({ identity: deploymentIdentity(plan) }) });
  assert.equal(blocked.status, 403);
  await fixture.admin("evm_setAutomine", [false]);
  let saved = "";
  const hash = await sendDeployment(plan, counted, txHash => { saved = JSON.stringify({ plan, txHash }); }, call);
  assert.ok(hash); assert.equal(sends, 1);
  await assert.rejects(call("/confirm", { txHash: hash })); // pending receipt cannot create trust/DB
  assert.equal(await exists(`${root}/demo.sqlite`), false); assert.equal(await exists(`${root}/deployment.json`), false);
  await assert.rejects(sendDeployment(plan, counted, () => {}, call)); assert.equal(sends, 1);
  await api.close(); api = await startDeploymentApi(root, apiPort, origin);
  assert.equal((await call("")).journal.txHash, hash);
  fixture.setFault(r => r.method === "eth_getTransactionReceipt" ? new Response("429", { status: 429 }) : undefined);
  await assert.rejects(confirmDeployment(plan, hash, call)); assert.equal(sends, 1);
  assert.equal(await exists(`${root}/deployment.json`), false);
  fixture.setFault(); await fixture.admin("evm_setAutomine", [true]); await fixture.admin("evm_mine");
  const config = await confirmDeployment(JSON.parse(saved).plan, JSON.parse(saved).txHash, call);
  assert.equal(config.deploymentTxHash, hash); assert.equal(sends, 1);
  assert.deepEqual(JSON.parse(await readFile(`${root}/deployment.json`, "utf8")), config);
  assert.equal(await exists(`${root}/demo.sqlite`), true);
  assert.deepEqual(await confirmDeployment(plan, hash, call), config);
  await assert.rejects(call("/confirm", { txHash: zeroHash }));
  await assert.rejects(verifyDeployment(env.client, { ...plan, data: `${plan.data}00` as Hex }, hash));
  await assert.rejects(verifyDeployment(env.client, { ...plan, settings: { ...settings, publisher: config.domain.verifyingContract } }, hash));
  const wrongGenesis = new Proxy(env.client, { get(target, key) {
    return key === "getBlock" ? async () => ({ hash: zeroHash }) : Reflect.get(target, key);
  } });
  await assert.rejects(verifyDeployment(wrongGenesis, plan, hash));
});

test("real EIP1193 test device drives /deploy then shared publish/inbox; unknown send never resends", { timeout: 180000 }, async t => {
  const env = await environment({ profile: "sepolia" }); t.after(() => env.close());
  const fixture = env.fixture!, settings = fixture.settings;
  const root = `${env.root}/browser-setup`; await mkdir(root); await writeFile(`${root}/settings.json`, JSON.stringify(settings));
  const apiPort = await unusedPort(), origin = `http://127.0.0.1:${env.frontendPort}`;
  let api: { close: () => Promise<void> } = await startDeploymentApi(root, apiPort, origin); t.after(() => api.close());
  let vite = await createServer({ ...profileViteConfig("sepolia", { setup: true, frontendPort: env.frontendPort, apiPort }), configFile: false });
  await vite.listen(); t.after(() => vite.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const publisherContext = await browser.newContext(), recipientContext = await browser.newContext();
  await fixture.route(publisherContext); await fixture.route(recipientContext);
  const device = testDevice(env); let sends = 0;
  await publisherContext.exposeBinding("walletRequest", (_source, r: { method: string }) => { if (r.method === "eth_sendTransaction") sends++; return device.request(r as never); });
  await publisherContext.addInitScript("window.ethereum = { request: r => window.walletRequest(r) };");
  const page = await publisherContext.newPage(), recipient = await recipientContext.newPage();
  page.setDefaultTimeout(45000); recipient.setDefaultTimeout(45000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(`${origin}/publish`); assert.equal(new URL(page.url()).pathname, "/deploy");
  await page.getByRole("button", { name: "Kontrollera MetaMask" }).click();
  await page.getByRole("status").filter({ hasText: "Wallet kontrollerad" }).waitFor();
  await page.getByRole("button", { name: "Deploya på Sepolia", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Deployment verifierad och sparad" }).waitFor(); assert.equal(sends, 1);
  await page.reload(); await page.getByText("Deployment finns. Starta om", { exact: false }).waitFor(); assert.equal(sends, 1);
  const config = JSON.parse(await readFile(`${root}/deployment.json`, "utf8"));
  await vite.close(); await api.close();
  api = await startApi(config, `${root}/demo.sqlite`, apiPort, origin);
  vite = await createServer({ ...profileViteConfig("sepolia", { readDeployment: async () => config, frontendPort: env.frontendPort, apiPort }), configFile: false }); await vite.listen();
  assert.equal((await fetch(`${origin}/deploy`)).status, 404);
  await recipient.goto(`${origin}/inbox`); assert.equal(await recipient.evaluate(() => typeof window.ethereum), "undefined");
  await page.goto(`${origin}/publish`);
  await page.getByRole("button", { name: "Review message" }).click();
  await page.getByRole("button", { name: "Sign and publish" }).click();
  await page.getByRole("status").filter({ hasText: "Published and confirmed" }).waitFor();
  await recipient.locator('[data-status="current"]').waitFor(); await recipient.reload(); await recipient.locator('[data-status="current"]').waitFor();
  assert.equal(sends, 2); assert.deepEqual(errors, []);

  // Independent next setup: lose the response AFTER a real EVM deployment.
  const unknownRoot = `${env.root}/unknown`; await mkdir(unknownRoot); await writeFile(`${unknownRoot}/settings.json`, JSON.stringify(settings));
  const unknownPort = await unusedPort(); const unknownApi = await startDeploymentApi(unknownRoot, unknownPort, origin); t.after(() => unknownApi.close());
  const request = async (path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${unknownPort}/api/deploy${path}`, { method: body === undefined ? "GET" : "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await r.json(); if (!r.ok) throw new Error(data.error); return data;
  };
  const plan = (await request("")).plan; let lostSends = 0; let actualHash: Hex | undefined;
  const lost = { on() {}, removeListener() {}, request: async (r: { method: string }) => {
    const result = await device.request(r as never);
    if (r.method === "eth_sendTransaction") { lostSends++; actualHash = result as Hex; throw new Error("Response lost"); } return result;
  } } as EIP1193Provider;
  await assert.rejects(sendDeployment(plan, lost, () => {}, request));
  await assert.rejects(sendDeployment(plan, lost, () => {}, request)); assert.equal(lostSends, 1);
  assert.equal((await request("")).journal.txHash, undefined);
  assert.equal(await exists(`${unknownRoot}/deployment.json`), false);
  await confirmDeployment(plan, actualHash!, request); assert.equal(lostSends, 1);
});
