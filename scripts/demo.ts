import { DatabaseSync } from "node:sqlite";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export type DemoAction = "snapshot" | "tamper-text" | "serve-v1" | "delete-content" | "restore";
export async function demoAction(dbPath: string, backupPath: string, action: DemoAction) {
  if (!await lstat(dbPath).then(s => s.isFile() && !s.isSymbolicLink())) throw new Error("En vanlig lokal syntetisk SQLite-fil krävs.");
  const db = new DatabaseSync(dbPath);
  try {
    if (!db.prepare("SELECT name FROM demo_identity WHERE name = 'crisis-mvp-synthetic'").get()) throw new Error("Fel databas.");
    if (action === "snapshot") {
      await writeFile(backupPath, JSON.stringify(db.prepare("SELECT * FROM messages").all()), { mode: 0o600 }); return;
    }
    if (action === "restore") {
      const rows = JSON.parse(await readFile(backupPath, "utf8"));
      if (!Array.isArray(rows)) throw new Error("Ogiltig säkerhetskopia.");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("DELETE FROM messages");
        const insert = db.prepare("INSERT INTO messages (package_digest, body, packet_json, tx_hash, created_at) VALUES (?, ?, ?, ?, ?)");
        for (const row of rows) insert.run(row.package_digest, row.body, row.packet_json, row.tx_hash, row.created_at);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return;
    }
    // Refuse destructive demonstrations until a recoverable snapshot exists.
    await readFile(backupPath);
    if (action === "tamper-text") {
      const result = db.prepare("UPDATE messages SET body = replace(body, '14.00', '16.00') WHERE instr(body, '14.00') > 0").run();
      if (result.changes === 0) throw new Error("Ingen text med 14.00 hittades.");
    } else if (action === "serve-v1") {
      if (!db.prepare("SELECT 1 FROM messages WHERE json_extract(packet_json, '$.message.version') = 1").get()) throw new Error("Version 1 saknas.");
      db.exec("DELETE FROM messages WHERE json_extract(packet_json, '$.message.version') != 1");
    } else if (action === "delete-content") db.exec("DELETE FROM messages");
    else throw new Error("Okänt demokommando.");
  } finally { db.close(); }
}
async function main() {
  const local = fileURLToPath(new URL("../.local", import.meta.url));
  const db = resolve(local, "demo.sqlite"), backup = resolve(local, "demo-snapshot.json");
  if (await realpath(local) !== local || await realpath(db) !== db) throw new Error("Symlänkar till andra databasvägar tillåts inte.");
  try { if ((await lstat(backup)).isSymbolicLink()) throw new Error("Symlänk som säkerhetskopia tillåts inte."); }
  catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
  const action = process.argv[2] as DemoAction;
  if (process.argv.length !== 3 || !["snapshot", "tamper-text", "serve-v1", "delete-content", "restore"].includes(action))
    throw new Error("Använd snapshot, tamper-text, serve-v1, delete-content eller restore. Databasvägen är låst till .local/demo.sqlite.");
  await demoAction(db, backup, action);
  console.log(`Lokal syntetisk databas: ${action} klar. Kedja och tillitskonfiguration har inte ändrats.`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error instanceof Error ? error.message : "Demot misslyckades."); process.exitCode = 1; });
