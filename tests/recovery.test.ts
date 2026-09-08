import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { createServer } from "vite";
import { parseAbi, zeroHash } from "viem";
import type { Hex, PublicClient } from "viem";
import { environment, testDevice } from "./helpers.ts";
import { profileViteConfig } from "../server/profile-config.ts";
import { publicationProof, readSnapshot, ChainCheckUnavailable, pacedFetch } from "../shared/chain.ts";
import { verifyEnvelope, freezeDraft } from "../shared/protocol.ts";
import { isCompletedAttempt } from "../src/live/publish.ts";

// Real generated EOA, typed signature, EIP-7702 authorization and nested EVM
// transaction. Browser has no key. No testnet or MetaMask-dialog claim.
test("mined EIP-7702 publication recovers on reload without wallet and unlocks version 2", { timeout: 120000 }, async t => {
  const env = await environment({ profile: "sepolia" }); t.after(() => env.close());
  const deployFixture = async (name: string) => {
    const a = JSON.parse(await readFile(`artifacts/RecoveryWallet.sol/${name}.json`, "utf8"));
    const hash = await env.wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object });
    return (await env.client.waitForTransactionReceipt({ hash })).contractAddress!;
  };
  const delegate = await deployFixture("RecoveryWallet"), router = await deployFixture("RecoveryRouter");
  const routerAbi = parseAbi(["function forward(address account, address target, bytes data)"]);
  const vite = await createServer({ ...profileViteConfig("sepolia", { readDeployment: async () => env.config, frontendPort: env.frontendPort, apiPort: Number(new URL(env.apiUrl).port) }), configFile: false });
  await vite.listen(); t.after(() => vite.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext(); await env.fixture!.route(context);
  const page = await context.newPage(); page.setDefaultTimeout(30000);
  let blockConfirmation = true, unknownSend = false, forbidWallet = false;
  const methods: string[] = []; let publishedHash: Hex | undefined;
  const device = testDevice(env);
  await context.exposeBinding("walletRequest", async (_source, r: { method: string; params: {to:Hex; data:Hex}[] }) => {
    methods.push(r.method); if (forbidWallet) throw new Error("Recovery must not use the wallet");
    if (r.method !== "eth_sendTransaction") return device.request(r as never);
    if (unknownSend) throw new Error("Wallet transport outcome unknown");
    const authorization = await env.wallet.signAuthorization({ contractAddress: delegate, executor: "self" });
    publishedHash = await env.wallet.writeContract({ address: router, abi: routerAbi, functionName: "forward",
      args: [env.account.address, r.params[0].to, r.params[0].data], authorizationList: [authorization], gas: 500000n });
    await env.client.waitForTransactionReceipt({ hash: publishedHash });
    return publishedHash;
  });
  await context.addInitScript("window.ethereum = {request: r => window.walletRequest(r)};");
  await page.route("**/api/messages/*/confirm", route => blockConfirmation ? route.fulfill({ status: 503, body: '{}' }) : route.continue());
  await page.goto(`http://127.0.0.1:${env.frontendPort}/publish`);
  await page.getByRole("button", {name:"Review message"}).click();
  await page.getByRole("button", {name:"Sign and publish"}).click();
  await page.getByRole("alert").waitFor();
  assert.ok(publishedHash);
  const snapshot = await readSnapshot(env.client, env.config); assert.equal(snapshot.version, 1);
  const packet = await verifyEnvelope((await env.receive())[0], env.config);
  const receipt = await env.client.getTransactionReceipt({hash: publishedHash});
  assert.equal(receipt.status, "success"); assert.equal(receipt.to?.toLowerCase(), router.toLowerCase());
  assert.notEqual(receipt.to?.toLowerCase(), env.config.domain.verifyingContract);
  assert.equal((await publicationProof(env.client, env.config, packet, snapshot))?.txHash, publishedHash);
  assert.equal(env.api.store.db.prepare("SELECT tx_hash FROM messages").get()!.tx_hash, null);
  assert.equal(await page.getByRole("button", {name:"Edit message"}).isDisabled(), true);
  const saved = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([k]) => k.startsWith("crisis-publish:"))));
  assert.ok(JSON.parse(Object.values(saved)[0]).txHash);
  assert.equal(isCompletedAttempt(JSON.parse(Object.values(saved)[0]), env.config, packet), true);
  assert.equal(isCompletedAttempt({ draft: freezeDraft("Ett annat utkast", env.config, snapshot) }, env.config, packet), false);
  const before = methods.length; forbidWallet = true; blockConfirmation = false;
  await env.restartApi(); await page.reload();
  await page.getByRole("heading", {name:"Write update · Version 2"}).waitFor();
  await page.getByRole("status").filter({hasText:"Version 1 was already published and has been recovered."}).waitFor();
  assert.equal(methods.length, before); assert.equal(env.api.store.db.prepare("SELECT tx_hash FROM messages").get()!.tx_hash, publishedHash);
  assert.equal(await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith("crisis-publish:")).every(([,v]) => v === "null")), true);

  for (const bad of [
    {...receipt, logs: []}, {...receipt, from: router}, {...receipt, status: "reverted"},
    {...receipt, transactionHash: zeroHash},
    {...receipt, logs: receipt.logs.map(l => ({...l,address:router}))},
    {...receipt, logs: receipt.logs.map(l => ({...l,topics:[...l.topics.slice(0,2),zeroHash]}))},
    {...receipt, logs: receipt.logs.map(l => ({...l,blockHash:zeroHash}))},
  ]) {
    const corrupt = new Proxy(env.client,{get(target,key){return key === "getTransactionReceipt" ? async()=>bad : Reflect.get(target,key);}});
    await assert.rejects(publicationProof(corrupt as PublicClient,env.config,packet,snapshot));
  }
  // Unknown outcome keeps both actual stored bytes and the no-discard barrier.
  forbidWallet = false; unknownSend = true;
  await page.getByLabel("Message",{exact:true}).fill("Samling 16.00.");
  await page.getByRole("button",{name:"Review message"}).click(); await page.getByRole("button",{name:"Sign and publish"}).click();
  await page.getByRole("alert").waitFor(); const unknownCalls = methods.length; forbidWallet = true;
  await page.reload(); await page.getByRole("button",{name:"Continue checking"}).waitFor();
  assert.equal(await page.getByRole("button",{name:"Edit message"}).isDisabled(),true);
  await page.getByRole("button",{name:"Continue checking"}).click(); await page.getByRole("alert").filter({hasText:"outcome is unknown"}).waitFor();
  assert.equal(methods.length,unknownCalls); assert.equal((await readSnapshot(env.client,env.config)).version,1);
});

test("RPC pacing spaces starts, cancels queued calls and never retries", async () => {
  const starts: number[] = [];
  const paced = pacedFetch(60, async () => { starts.push(Date.now()); return new Response("ok"); });
  const abort = new AbortController();
  const first = paced("https://rpc.invalid");
  const cancelled = paced("https://rpc.invalid", {signal: abort.signal});
  abort.abort(); await assert.rejects(cancelled);
  await Promise.all([first, paced("https://rpc.invalid")]);
  assert.equal(starts.length, 2); assert.ok(starts[1] - starts[0] >= 100);
  let calls = 0;
  const failing = pacedFetch(1, async () => { calls++; throw new Error("429"); });
  await assert.rejects(failing("https://rpc.invalid")); assert.equal(calls, 1);
});

test("snapshot names the failed RPC step without leaking provider data", async () => {
  const env = await environment();
  try {
    const rateLimited = new Proxy(env.client,{get(target,key){return key === "readContract" ? async(args:{functionName:string})=> {
      if(args.functionName === "context") throw new Error("rate limit exceeded: private provider details");
      return target.readContract(args as never);
    } : Reflect.get(target,key);}});
    await assert.rejects(readSnapshot(rateLimited,env.config), e => e instanceof ChainCheckUnavailable && e.step === "immutable kontext" && /begränsar anropstakten/.test(e.message) && !e.message.includes("private"));
  } finally {await env.close();}
});
