import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { EIP1193Provider } from "viem";
import { freezeDraft, parseConfig } from "../../shared/protocol.ts";
import type { TrustConfig } from "../../shared/protocol.ts";
import { readSnapshot, rpcClient } from "../../shared/chain.ts";
import type { ChainSnapshot } from "../../shared/chain.ts";
import { cacheKey, emptyInbox, InboxVerifier } from "./inbox.ts";
import type { CheckedMessage, InboxState } from "./inbox.ts";
import { publishAttempt, restoreAttempt } from "./publish.ts";
import type { Attempt, Stage } from "./publish.ts";
import { activeProfile, readSaved, storageKey } from "./profile.ts";
import "./live.css";

declare global { interface Window { ethereum?: EIP1193Provider } }
const clock = (iso?: string) => iso ? new Date(iso).toLocaleTimeString("sv-SE") : "–";
function Details({ entry, config, snapshot }: { entry?: CheckedMessage; config: TrustConfig; snapshot?: ChainSnapshot }) {
  return <details className="evidence"><summary>Visa kontrollunderlag</summary><dl>
    <dt>Behörig avsändare</dt><dd>{config.publisher}</dd>
    <dt>Kontrakt · nätverk</dt><dd>{config.domain.verifyingContract} · {config.domain.chainId}</dd>
    {activeProfile.id === "sepolia" && <><dt>Sepolia-explorer</dt><dd><a href={`https://sepolia.etherscan.io/address/${config.domain.verifyingContract}`} target="_blank" rel="noreferrer">Kontrakt</a>{entry?.proof && <> · <a href={`https://sepolia.etherscan.io/tx/${entry.proof.txHash}`} target="_blank" rel="noreferrer">Publiceringstransaktion</a></>}</dd></>}
    {entry?.packet && <><dt>Innehållshash · exakt UTF-8-text</dt><dd>{entry.packet.message.bodyHash}</dd>
      <dt>Paketdigest · EIP-712</dt><dd>{entry.packet.packageDigest}</dd>
      <dt>Föregående paketdigest</dt><dd>{entry.packet.message.previousDigest}</dd></>}
    {entry?.proof && <><dt>Bekräftad transaktion</dt><dd>{entry.proof.txHash}</dd></>}
    {snapshot && <><dt>Kontrollblock</dt><dd>{snapshot.blockNumber.toString()} · {snapshot.blockHash}</dd></>}
  </dl></details>;
}
function MessageCard({ entry, config, snapshot, checking }: { entry: CheckedMessage; config: TrustConfig; snapshot?: ChainSnapshot; checking: boolean }) {
  const labels = { current: "Aktuell version", superseded: "Ersatt version", pending: "Väntar på kontroll", failed: "Underkänd leverans", unavailable: "Aktuell status okänd" };
  return <article className={`message ${entry.status}`} data-testid="message" data-status={entry.status}>
    <div className="message-meta"><strong>{entry.signature === "failed" ? "Underkänd leverans" : `Alex · Version ${entry.packet?.message.version}`}</strong>
      <span className="status">{labels[entry.status]}</span></div>
    <p className="message-body" data-testid="message-body">{entry.body}</p>
    <p className="signature">{entry.signature === "passed" ? "✓ Text och signatur stämmer" : "× Text, signatur eller sammanhang stämmer inte"}
      {entry.cached ? " · Sparad kopia" : ""}</p>
    {entry.reason && <p className="muted">{entry.reason}</p>}
    {snapshot && !checking && entry.proof && <p className="muted">Status kontrollerad {clock(snapshot.checkedAt)}</p>}
    <Details entry={entry} config={config} snapshot={checking ? undefined : snapshot} />
  </article>;
}
function Inbox({ config }: { config: TrustConfig }) {
  const [state, setState] = useState<InboxState>(emptyInbox);
  useEffect(() => {
    let initial: unknown[] = [];
    try { const value = JSON.parse(readSaved("inbox", config) ?? "[]"); if (Array.isArray(value)) initial = value; } catch { /* re-fetch */ }
    const verifier = new InboxVerifier(config, undefined, initial, packets => localStorage.setItem(cacheKey(config), JSON.stringify(packets)));
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await verifier.refresh(next => { if (!disposed) setState(next); });
      if (!disposed) timer = setTimeout(() => { void tick(); }, activeProfile.pollInterval);
    };
    void tick();
    return () => { disposed = true; clearTimeout(timer); verifier.dispose(); };
  }, [config]);
  return <>
    <header className="page-heading"><p className="eyebrow">KIM · PRENUMERERAR</p><h1>Övning Norr</h1><p>Meddelanden från Alex kontrolleras automatiskt.</p></header>
    <div className="feed-summary" role="status" aria-live="polite">
      {state.checking ? "Kontrollerar meddelanden och aktuell status…" : state.chainError ?? `Senast lyckad statuskontroll ${clock(state.lastSuccess)}`}
    </div>
    {state.chainError && state.lastSuccess && <p className="muted">Tidigare lyckad kontroll {clock(state.lastSuccess)}. Den visar inte aktuell status.</p>}
    {state.deliveryError && <p className="notice warning" role="alert">{state.deliveryError}</p>}
    {state.missingHead && <p className="notice warning" data-testid="missing-head" role="alert">Innehåll saknas i leveransen för kedjans senaste version {state.snapshot?.version}. {state.entries.some(e => e.cached && e.status === "current") ? "En tidigare sparad kopia visas nedan." : "En äldre version är inte aktuell."}</p>}
    {!state.entries.length && !state.checking && <div className="empty"><span aria-hidden="true">↳</span><h2>{state.snapshot?.version ? "Meddelandets innehåll saknas" : state.snapshot ? "Inget meddelande ännu" : "Kontrollen kunde inte genomföras"}</h2><p>{state.snapshot?.version ? "Kedjans hash kan inte återskapa texten." : "Nya meddelanden visas här automatiskt."}</p></div>}
    <section className="message-list" aria-label="Meddelandeflöde">{state.entries.map((entry, index) => <MessageCard key={index} entry={entry} config={config} snapshot={state.snapshot} checking={state.checking} />)}</section>
  </>;
}
const stageLabels: Record<Stage, string> = {
  wallet: "Kontrollerar wallet…", signing: "Godkänn signaturen i din wallet…", storing: "Lagrar det signerade paketet…",
  transaction: "Godkänn publiceringstransaktionen i din wallet…", confirming: "Inväntar lyckad kedjebekräftelse och lagringskvitto…", complete: "Publicerat och bekräftat",
};
function Publisher({ config }: { config: TrustConfig }) {
  const [body, setBody] = useState("Samling vid övningsplats Norr klockan 14.00. Ta med reflexväst och vatten.");
  const [head, setHead] = useState<ChainSnapshot>();
  const [attempt, setAttempt] = useState<Attempt>();
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<Stage>();
  const [error, setError] = useState("");
  const [published, setPublished] = useState<CheckedMessage>();
  const inFlight = useRef(false);
  const attemptKey = storageKey("publish", config);
  useEffect(() => {
    let active = true;
    void readSnapshot(rpcClient(config), config).then(value => { if (active) setHead(value); }).catch(() => { if (active) setError("Nätverk eller kontrakt kunde inte kontrolleras."); });
    try {
      const saved = JSON.parse(readSaved("publish", config) ?? "null");
      if (saved) {
        const restored = restoreAttempt(saved, config);
        setAttempt(restored); setBody(restored.draft.body);
      }
    } catch { setError("Det sparade utkastet kunde inte läsas. Granska texten på nytt."); }
    return () => { active = false; };
  }, [config, attemptKey]);
  const persist = (value: Attempt) => {
    setAttempt({ ...value });
    try { localStorage.setItem(attemptKey, JSON.stringify(value)); } catch { /* same-session retry remains available */ }
  };
  const clearAttempt = () => { try { localStorage.setItem(attemptKey, "null"); } catch { /* tombstone prevents restoring the retained legacy attempt */ } };
  const review = async () => {
    if (inFlight.current) return; inFlight.current = true; setBusy(true); setError(""); setPublished(undefined); setStage(undefined);
    try {
      const latest = await readSnapshot(rpcClient(config), config); setHead(latest);
      persist({ draft: freezeDraft(body, config, latest) });
    } catch { setError("Utkastet kunde inte förberedas. Kontrollera text, nätverk och kontrakt."); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const send = async () => {
    if (!attempt || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const result = await publishAttempt(config, window.ethereum, attempt, setStage, persist);
      setPublished({ body: result.packet.body, packet: result.packet, proof: result.proof, signature: "passed", status: result.packet.packageDigest === result.snapshot.digest ? "current" : "superseded", cached: false });
      setAttempt(undefined); clearAttempt();
      setHead(result.snapshot);
    } catch (cause) {
      setStage(undefined);
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
      const message = cause instanceof Error ? cause.message : "";
      setError(code === 4001 || /rejected|denied/i.test(message) ? "Walletdialogen avbröts. Publiceringen är inte färdig. Du kan försöka igen med samma paket." :
        /wallet|konto|nätverk|version|Lagring|lagring|Transaktion|publiceringspost|Serien|Granska/i.test(message) && message.length < 250 ? message :
          `Bekräftelsen kunde inte slutföras. Kontrollera wallet, API och ${activeProfile.label}. Ett skickat paket behålls; fortsätt för att kontrollera utfallet.`);
    } finally { inFlight.current = false; setBusy(false); }
  };
  return <>
    <header className="page-heading"><p className="eyebrow">ALEX · PUBLICERARE</p><h1>Ett tydligt meddelande.</h1><p>Publicera till volontärflödet Övning Norr.</p></header>
    <section className="composer">
      <div className="message-meta"><h2>{attempt ? `Granska version ${attempt.draft.message.version}` : head?.version ? `Skriv uppdatering · Version ${head.version + 1}` : "Skriv ett meddelande"}</h2><span className="muted">Till Kim</span></div>
      {attempt ? <><p className="message-body review-text" data-testid="frozen-body">{attempt.draft.body}</p><p className="muted">Den här exakta texten ingår i signeringen.</p></> :
        <><label htmlFor="message-text">Meddelande</label><textarea id="message-text" value={body} maxLength={4000} disabled={busy} onChange={event => setBody(event.target.value)} rows={6} /><p className="character-count">{body.length} / 4 000</p></>}
      <div className="actions">{attempt ? <>
        <button className="primary" disabled={busy} onClick={() => { void send(); }}>{attempt.packet ? "Fortsätt publiceringen" : "Signera och publicera"}<span aria-hidden="true">↗</span></button>
        <button className="secondary" disabled={busy || !!attempt.txHash || attempt.transactionRequested} onClick={() => { setAttempt(undefined); setStage(undefined); setError(""); clearAttempt(); }}>Redigera texten</button>
      </> : <button className="primary" disabled={busy || !body.length} onClick={() => { void review(); }}>{busy ? "Förbereder…" : "Granska meddelandet"}<span aria-hidden="true">→</span></button>}</div>
      {stage && <p className={`notice ${stage === "complete" ? "success" : ""}`} role="status">{stageLabels[stage]}{stage === "complete" && published?.packet ? ` · Version ${published.packet.message.version}` : ""}</p>}
      {error && <p className="notice warning" role="alert">{error}</p>}
      {attempt?.txHash && <p className="muted">Transaktionen har skickats. Fortsätt med samma paket för att kontrollera utfallet.</p>}
    </section>
    <Details entry={published} config={config} snapshot={head} />
  </>;
}
function App() {
  const [config, setConfig] = useState<TrustConfig>();
  const [error, setError] = useState("");
  useEffect(() => {
    document.title = location.pathname === "/publish" ? "Publicera · Krismeddelanden" : "Övning Norr · Krismeddelanden";
    const controller = new AbortController();
    void fetch("/deployment.json", { cache: "no-store", signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(); return parseConfig(await response.json(), activeProfile.id);
    }).then(setConfig).catch(() => { if (!controller.signal.aborted) setError(`Deploymentkonfiguration för ${activeProfile.label} saknas eller är ogiltig. Kontrollera ${activeProfile.id === "local" ? "local:init" : "sepolia:check"} före uppstart.`); });
    return () => controller.abort();
  }, []);
  const publisher = location.pathname === "/publish";
  return <main className={`live-app ${publisher ? "publisher" : "inbox"}`}>
    <nav className="topline"><a className="wordmark" href={publisher ? "/publish" : "/inbox"}>Krismeddelanden<span aria-hidden="true">↗</span></a><span>{activeProfile.label} · Demoorganisation</span></nav>
    {config ? publisher ? <Publisher config={config} /> : <Inbox config={config} /> : <p className="notice" role="status">{error || "Läser lokal tillitskonfiguration…"}</p>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
