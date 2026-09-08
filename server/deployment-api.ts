import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { deploymentIdentity, sepoliaClient, verifyDeployment } from "../shared/deployment.ts";
import type { DeploymentPlan } from "../shared/deployment.ts";
import { hex32, parseConfig } from "../shared/protocol.ts";
import { exists, loadSettings, ordinaryFile, prepareDeployment, readJournal, updateJournal, writeExclusive } from "../scripts/sepolia-deployment.ts";
import { networkPreflight } from "../scripts/sepolia-preflight.ts";
import { MessageStore } from "./storage.ts";
import { input } from "./api.ts";

// Setup-only listener: it never has a wallet, signs, or broadcasts. No arbitrary
// address/config/file path from a request becomes a trust root.
export async function startDeploymentApi(directory: string, port = 3002, origin = "http://127.0.0.1:5176") {
  let plan: DeploymentPlan | undefined, busy = false;
  const journalPath = `${directory}/pending-deployment.json`, configPath = `${directory}/deployment.json`;
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    const reply = (code: number, body: unknown) => { res.writeHead(code); res.end(JSON.stringify(body)); };
    if (req.headers.host !== `127.0.0.1:${(server.address() as { port: number }).port}` ||
      (req.headers.origin && req.headers.origin !== origin) || (req.method === "POST" && req.headers.origin !== origin)) {
      reply(403, { error: "Endast lokal appåtkomst tillåts." }); return;
    }
    if (!req.url?.startsWith("/api/deploy")) { reply(503, { error: "Deploymentläge. Öppna /deploy; starta om med sepolia:start efter lyckad deployment." }); return; }
    if (busy) { reply(409, { error: "En kontroll pågår. Vänta och fortsätt sedan samma försök." }); return; }
    busy = true;
    try {
      const settings = await loadSettings(directory);
      if (await exists(configPath)) {
        await ordinaryFile(configPath);
        const config = parseConfig(JSON.parse(await readFile(configPath, "utf8")), "sepolia");
        if (req.method === "GET" && req.url === "/api/deploy") { reply(200, { deployed: config }); return; }
        // Idempotent confirmation after a lost response, never replacement.
        if (req.method !== "POST" || !["/api/deploy/confirm", "/api/deploy/hash"].includes(req.url ?? "")) throw new Error("Deployment finns redan.");
        const { txHash } = z.strictObject({ txHash: hex32 }).parse(await input(req));
        if (txHash !== config.deploymentTxHash) throw new Error("Deployment finns redan.");
        const journal = await readJournal(journalPath, settings);
        const checked = await verifyDeployment(sepoliaClient(settings), journal.plan, txHash);
        if (JSON.stringify(checked) !== JSON.stringify(config)) throw new Error("Deployment avviker.");
        reply(200, { deployed: checked }); return;
      }
      const journal = await exists(journalPath) ? await readJournal(journalPath, settings) : undefined;
      if (req.method === "GET" && req.url === "/api/deploy") {
        if (journal) { plan = journal.plan; reply(200, { journal }); return; }
        const prepared = await prepareDeployment(settings); plan = prepared.plan; reply(200, prepared); return;
      }
      if (req.method === "POST" && req.url === "/api/deploy/begin") {
        const { identity } = z.strictObject({ identity: hex32 }).parse(await input(req));
        if (journal || !plan || deploymentIdentity(plan) !== identity || JSON.stringify(plan.settings) !== JSON.stringify(settings))
          throw new Error("Ett försök finns redan eller underlaget ändrades. Läs /deploy igen; ingen ny transaktion ska skickas.");
        const { client } = await networkPreflight(settings);
        if (await client.getTransactionCount({ address: settings.deployer, blockTag: "pending" }) !== plan.nonce ||
          await client.getBalance({ address: settings.deployer }) < BigInt(plan.maxCost)) throw new Error("Saldo eller nonce har ändrats. Kontrollera underlaget igen.");
        await writeExclusive(journalPath, { plan }); // BEFORE permission to call eth_sendTransaction; excludes other tabs.
        reply(200, { plan }); return;
      }
      if (req.method === "POST" && (req.url === "/api/deploy/hash" || req.url === "/api/deploy/confirm")) {
        const { txHash } = z.strictObject({ txHash: hex32 }).parse(await input(req));
        if (!journal || (journal.txHash && journal.txHash !== txHash)) throw new Error("Deploymentförsök saknas eller har annan transaktionshash.");
        if (!journal.txHash) { journal.txHash = txHash; await updateJournal(journalPath, journal); }
        if (req.url === "/api/deploy/hash") { reply(200, { journal }); return; }
        const config = await verifyDeployment(sepoliaClient(settings), journal.plan, txHash);
        if (await exists(`${directory}/demo.sqlite`)) await ordinaryFile(`${directory}/demo.sqlite`);
        else new MessageStore(`${directory}/demo.sqlite`).close();
        await writeExclusive(configPath, config);
        reply(200, { deployed: config }); return;
      }
      reply(404, { error: "Resursen finns inte." });
    } catch (error) {
      const publicError = error instanceof Error && (error.message.startsWith("Sepolia saknar .sepolia/settings.json") || error.message.startsWith("RPC-underlag saknas:"));
      reply(400, { error: publicError ? error.message : "Deploymenten kunde inte bekräftas. Kontrollera settings, RPC, saldo och sparat försök. Ingen ny transaktion skickas av servern." });
    } finally { busy = false; }
  });
  server.requestTimeout = 60000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return { server, close: () => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())) };
}
