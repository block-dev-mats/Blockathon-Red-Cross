import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { environment, testDevice } from "./helpers.ts";
import { demoAction } from "../scripts/demo.ts";
import { profileViteConfig } from "../server/profile-config.ts";

test("separate publisher/recipient browser contexts, real API/SQLite/EVM and presentation", { timeout: 120000 }, async t => {
  const env = await environment(); t.after(() => env.close());
  const root = fileURLToPath(new URL("../", import.meta.url));
  const vite = await createServer({ ...profileViteConfig("local", { readDeployment: async () => env.config,
    frontendPort: env.frontendPort, apiPort: Number(new URL(env.apiUrl).port) }), configFile: false });
  await vite.listen(); t.after(() => vite.close());
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const publisherContext = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  const recipientContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const publisher = await publisherContext.newPage(), recipient = await recipientContext.newPage();
  publisher.setDefaultTimeout(10000); recipient.setDefaultTimeout(10000);
  const origin = `http://127.0.0.1:${env.frontendPort}`;
  const errors: string[] = [];
  for (const page of [publisher, recipient]) page.on("pageerror", error => errors.push(error.message));
  let rejectSign = false, rejectTransaction = false;
  const walletMethods: string[] = [];
  const device = testDevice(env);
  await publisherContext.exposeBinding("testWalletRequest", async (_source, request: { method: string; params: never }) => {
    walletMethods.push(request.method);
    if ((request.method === "eth_signTypedData_v4" && rejectSign) || (request.method === "eth_sendTransaction" && rejectTransaction)) throw new Error("User rejected request");
    return device.request(request as never);
  });
  // Plain source avoids compiler-injected helper references in serialized code.
  // Test-only provider installed by the harness. No key enters this page.
  await publisherContext.addInitScript("window.ethereum = { request: args => window.testWalletRequest(args) };");
  const text = "Samling 14.00.\nTa med vatten och reflexväst. 🌧";
  await t.test("author reviews exact text; cancellation is honest and retry survives reload", async () => {
    await recipient.goto(`${origin}/inbox`);
    await recipient.getByRole("heading", { name: "Inget meddelande ännu" }).waitFor();
    assert.equal(await recipient.evaluate(() => typeof window.ethereum), "undefined");
    await publisher.goto(`${origin}/publish`);
    assert.equal(await publisher.evaluate(() => typeof window.ethereum?.request), "function");
    await publisher.getByLabel("Meddelande", { exact: true }).fill(text);
    await publisher.getByRole("button", { name: "Granska meddelandet" }).click();
    await publisher.getByTestId("frozen-body").waitFor();
    assert.equal(await publisher.getByTestId("frozen-body").textContent(), text);
    rejectSign = true;
    await publisher.getByRole("button", { name: "Signera och publicera" }).click();
    await publisher.getByRole("alert").waitFor();
    assert.match(await publisher.getByRole("alert").innerText(), /Walletdialogen avbröts/, walletMethods.join(", "));
    rejectSign = false; rejectTransaction = true;
    await publisher.getByRole("button", { name: "Signera och publicera" }).click();
    await publisher.getByRole("button", { name: "Fortsätt publiceringen" }).waitFor();
    await publisher.getByRole("alert").filter({ hasText: "Walletdialogen avbröts" }).waitFor();
    assert.equal((await env.receive()).length, 1);
    await publisher.reload(); rejectTransaction = false;
    await publisher.getByRole("button", { name: "Fortsätt publiceringen" }).click();
    await publisher.getByRole("status").filter({ hasText: "Publicerat och bekräftat" }).waitFor();
    const current = recipient.locator('[data-status="current"]');
    await current.waitFor(); assert.equal(await current.getByTestId("message-body").textContent(), text);
    await recipient.reload(); await recipient.locator('[data-status="current"]').waitFor();
  });
  await t.test("tampered SQLite response is rejected while previously verified bytes survive", async () => {
    await demoAction(env.dbPath, env.backupPath, "snapshot");
    await demoAction(env.dbPath, env.backupPath, "tamper-text");
    await recipient.locator('[data-status="failed"]').waitFor();
    assert.match(await recipient.locator('[data-status="failed"]').innerText(), /16\.00/);
    assert.equal(await recipient.locator('[data-status="current"] [data-testid="message-body"]').textContent(), text);
    await recipient.getByTestId("missing-head").waitFor();
    await demoAction(env.dbPath, env.backupPath, "restore");
  });
  await t.test("legitimate update arrives automatically and old text remains superseded", async () => {
    await publisher.getByLabel("Meddelande", { exact: true }).fill("Samling 16.00. Ta med vatten.");
    await publisher.getByRole("button", { name: "Granska meddelandet" }).click();
    await publisher.getByRole("button", { name: "Signera och publicera" }).click();
    await publisher.getByRole("status").filter({ hasText: "Publicerat och bekräftat" }).waitFor();
    await recipient.locator('[data-status="current"]').filter({ hasText: "Version 2" }).waitFor();
    assert.equal(await recipient.locator('[data-status="superseded"] [data-testid="message-body"]').textContent(), text);
    assert.equal(await recipient.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await mkdir(`${root}output/playwright`, { recursive: true });
    await recipient.screenshot({ path: `${root}output/playwright/mvp-inbox-mobile.png`, fullPage: true });
    await publisher.screenshot({ path: `${root}output/playwright/mvp-publish.png`, fullPage: true });
  });
  await t.test("backend restart preserves automatic delivery after page reload", async () => {
    await env.restartApi();
    await recipient.reload();
    await recipient.locator('[data-status="current"]').filter({ hasText: "Version 2" }).waitFor();
    assert.equal((await env.receive()).length, 2);
  });
  await t.test("fresh receiver detects withheld version 2 and deleted content from chain head", async () => {
    await demoAction(env.dbPath, env.backupPath, "snapshot");
    await demoAction(env.dbPath, env.backupPath, "serve-v1");
    const coldContext = await browser.newContext();
    const cold = await coldContext.newPage();
    await cold.goto(`${origin}/inbox`);
    await cold.getByTestId("missing-head").filter({ hasText: "version 2" }).waitFor();
    assert.equal(await cold.locator('[data-status="current"]').count(), 0);
    await cold.locator('[data-status="superseded"]').waitFor();
    await demoAction(env.dbPath, env.backupPath, "delete-content");
    await cold.evaluate(() => localStorage.clear()); await cold.reload();
    await cold.getByRole("heading", { name: "Meddelandets innehåll saknas" }).waitFor();
    assert.equal(await cold.getByTestId("message-body").count(), 0);
    await coldContext.close(); await demoAction(env.dbPath, env.backupPath, "restore");
  });
  await t.test("RPC outage removes unqualified current status", async () => {
    await recipient.route(`${env.config.rpcUrl}/**`, route => route.abort());
    await recipient.route(env.config.rpcUrl, route => route.abort());
    await recipient.locator('[data-status="unavailable"]').first().waitFor();
    assert.equal(await recipient.locator('[data-status="current"]').count(), 0);
    await recipient.getByRole("status").filter({ hasText: "Aktuell status kan inte kontrolleras" }).waitFor();
    await recipient.unrouteAll();
    await recipient.locator('[data-status="current"]').waitFor();
  });
  await t.test("unmodified presentation still has five scenarios and working publication", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(origin);
    for (const name of ["Publicering", "Vidarebefordran", "Uppdatering", "Utan uppkoppling", "Databasmanipulation"]) await page.getByRole("button", { name, exact: true }).waitFor();
    await page.getByRole("button", { name: "Publicera", exact: true }).click();
    await page.getByText("Behörig avsändare · Aktuell", { exact: true }).first().waitFor();
    await page.screenshot({ path: `${root}output/playwright/presentation-preserved.png`, fullPage: true });
    await page.close();
  });
  assert.deepEqual(errors, []);
});
