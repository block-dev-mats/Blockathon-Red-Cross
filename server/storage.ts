import { DatabaseSync } from "node:sqlite";
import type { Envelope } from "../shared/protocol.ts";

export class MessageStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS messages (
        package_digest TEXT PRIMARY KEY, body TEXT NOT NULL, packet_json TEXT NOT NULL,
        tx_hash TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS demo_identity (name TEXT PRIMARY KEY);
      INSERT OR IGNORE INTO demo_identity VALUES ('crisis-mvp-synthetic');`);
  }
  put(packet: Envelope) {
    const existing = this.db.prepare("SELECT body, packet_json FROM messages WHERE package_digest = ?").get(packet.packageDigest);
    const { body, ...signed } = packet;
    const json = JSON.stringify(signed); // Storage encoding only; EIP-712 is the signing format.
    if (existing) {
      if (existing.body !== body || existing.packet_json !== json) throw new Error("Lagrad version avviker. Den får inte skrivas över.");
      return;
    }
    this.db.prepare("INSERT INTO messages (package_digest, body, packet_json) VALUES (?, ?, ?)").run(packet.packageDigest, body, json);
  }
  list(): unknown[] {
    return this.db.prepare("SELECT body, packet_json, tx_hash FROM messages ORDER BY created_at, rowid").all().map(row => {
      try { return { packet: { ...JSON.parse(String(row.packet_json)), body: row.body }, txHash: row.tx_hash }; }
      catch { return { packet: { body: row.body }, txHash: row.tx_hash }; }
    });
  }
  get(digest: string): unknown {
    const row = this.db.prepare("SELECT body, packet_json FROM messages WHERE package_digest = ?").get(digest);
    if (!row) throw new Error("Det signerade paketet saknas i lagringen.");
    return { ...JSON.parse(String(row.packet_json)), body: row.body };
  }
  confirm(digest: string, txHash: string) {
    const result = this.db.prepare("UPDATE messages SET tx_hash = ? WHERE package_digest = ? AND (tx_hash IS NULL OR tx_hash = ?)").run(txHash, digest, txHash);
    if (result.changes !== 1) throw new Error("Publiceringsreferensen kunde inte lagras.");
  }
  close() { this.db.close(); }
}
