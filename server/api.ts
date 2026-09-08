import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { access } from "node:fs/promises";
import { z } from "zod";
import { hex32, verifyEnvelope } from "../shared/protocol.ts";
import type { TrustConfig } from "../shared/protocol.ts";
import { assertSnapshot, publicationProof, readSnapshot, rpcClient } from "../shared/chain.ts";
import { MessageStore } from "./storage.ts";
import { profileForChain } from "../shared/profiles.ts";

export async function input(req: IncomingMessage): Promise<unknown> {
  if (req.headers["content-type"] !== "application/json") throw new Error("JSON krävs.");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); length += bytes.length;
    if (length > 40000) throw new Error("Paketet är för stort.");
    chunks.push(bytes);
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
export async function startApi(config: TrustConfig, dbPath: string, port: number = profileForChain(config.domain.chainId).apiPort, origin = `http://127.0.0.1:${profileForChain(config.domain.chainId).frontendPort}`) {
  await access(dbPath); // Only explicit initialization may create a database.
  const client = rpcClient(config);
  await readSnapshot(client, config); // Fail closed before accepting traffic.
  const store = new MessageStore(dbPath);
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const reply = (status: number, data: unknown) => { res.writeHead(status); res.end(JSON.stringify(data)); };
    const allowedHost = `127.0.0.1:${(server.address() as { port: number }).port}`;
    if (req.headers.host !== allowedHost || (req.headers.origin && req.headers.origin !== origin)) {
      reply(403, { error: "Endast lokal appåtkomst tillåts." }); return;
    }
    try {
      if (req.method === "GET" && req.url === "/api/messages") { reply(200, { deliveries: store.list() }); return; }
      if (req.method === "GET" && req.url === "/api/health") { reply(200, { service: "crisis-local-api", profile: profileForChain(config.domain.chainId).id }); return; }
      if (req.method === "POST" && req.url === "/api/messages") {
        const packet = await verifyEnvelope(await input(req), config);
        const snapshot = await readSnapshot(client, config);
        const proof = await publicationProof(client, config, packet, snapshot);
        if (!proof && (packet.message.version !== snapshot.version + 1 || packet.message.previousDigest !== snapshot.digest))
          throw new Error("Serien har ändrats. Hämta aktuell version och granska igen.");
        await assertSnapshot(client, snapshot);
        store.put(packet);
        reply(200, { stored: true, packageDigest: packet.packageDigest }); return;
      }
      const match = req.url?.match(/^\/api\/messages\/(0x[0-9a-f]{64})\/confirm$/);
      if (req.method === "POST" && match) {
        const { txHash } = z.strictObject({ txHash: hex32 }).parse(await input(req));
        const packet = await verifyEnvelope(store.get(match[1]), config);
        const snapshot = await readSnapshot(client, config);
        const proof = await publicationProof(client, config, packet, snapshot);
        if (!proof || proof.txHash !== txHash) throw new Error("Transaktionen är inte en lyckad, matchande publicering.");
        await assertSnapshot(client, snapshot);
        store.confirm(packet.packageDigest, proof.txHash);
        reply(200, { confirmed: true, packageDigest: packet.packageDigest }); return;
      }
      reply(404, { error: "Resursen finns inte." });
    } catch (error) {
      // Do not echo payloads, RPC errors or database contents into logs/responses.
      reply(400, { error: error instanceof z.ZodError ? "Ogiltigt meddelandeformat." : "Åtgärden kunde inte bekräftas. Kontrollera lagring, paket och kedjestatus." });
    }
  });
  server.requestTimeout = profileForChain(config.domain.chainId).apiTimeout;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return { server, store, close: () => new Promise<void>((resolve, reject) => server.close(e => { store.close(); e ? reject(e) : resolve(); })) };
}
