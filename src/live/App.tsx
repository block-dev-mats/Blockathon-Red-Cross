import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { EIP1193Provider } from "viem";
import { freezeDraft, parseConfig } from "../../shared/protocol.ts";
import type { TrustConfig } from "../../shared/protocol.ts";
import { readSnapshot, rpcClient, ChainCheckUnavailable } from "../../shared/chain.ts";
import type { ChainSnapshot } from "../../shared/chain.ts";
import { cacheKey, emptyInbox, InboxVerifier } from "./inbox.ts";
import type { CheckedMessage, InboxState } from "./inbox.ts";
import { publishAttempt, restoreAttempt, reconcileAttempt, mayHaveSent, isCompletedAttempt, StorageCheckUnavailable } from "./publish.ts";
import type { Attempt, Stage } from "./publish.ts";
import { activeProfile, readSaved, storageKey } from "./profile.ts";
import { englishNotice } from "./copy.ts";
import "./live.css";

declare global { interface Window { ethereum?: EIP1193Provider } }
const clock = (iso?: string) => iso ? new Date(iso).toLocaleTimeString("en-GB") : "–";
function Details({ entry, config, snapshot }: { entry?: CheckedMessage; config: TrustConfig; snapshot?: ChainSnapshot }) {
  return <details className="evidence"><summary>Verification details</summary><dl>
    <dt>Authorized sender</dt><dd>{config.publisher}</dd>
    <dt>Contract · network</dt><dd>{config.domain.verifyingContract} · {config.domain.chainId}</dd>
    {activeProfile.id === "sepolia" && <><dt>Explorer</dt><dd><a href={`https://sepolia.etherscan.io/address/${config.domain.verifyingContract}`} target="_blank" rel="noreferrer">Contract</a>{entry?.proof && <> · <a href={`https://sepolia.etherscan.io/tx/${entry.proof.txHash}`} target="_blank" rel="noreferrer">Publication transaction</a></>}</dd></>}
    {entry?.packet && <><dt>Content hash · exact UTF-8 text</dt><dd>{entry.packet.message.bodyHash}</dd>
      <dt>Package digest · EIP-712</dt><dd>{entry.packet.packageDigest}</dd>
      <dt>Previous package digest</dt><dd>{entry.packet.message.previousDigest}</dd></>}
    {entry?.proof && <><dt>Confirmed transaction</dt><dd>{entry.proof.txHash}</dd></>}
    {snapshot && <><dt>Verification block</dt><dd>{snapshot.blockNumber.toString()} · {snapshot.blockHash}</dd></>}
  </dl></details>;
}
function MessageCard({ entry, config, snapshot, checking }: { entry: CheckedMessage; config: TrustConfig; snapshot?: ChainSnapshot; checking: boolean }) {
  const labels = { current: "Current", superseded: "Superseded", pending: "Checking", failed: "Verification failed", unavailable: "Current status unknown" };
  return <article className={`message ${entry.status}`} data-testid="message" data-status={entry.status}>
    <div className="message-meta"><strong>{entry.signature === "failed" ? "Verification failed" : `Alex · Version ${entry.packet?.message.version}`}</strong>
      <span className="status">{labels[entry.status]}</span></div>
    <p className="message-body" data-testid="message-body">{entry.body}</p>
    <p className="signature">{entry.signature === "passed" ? "✓ Text and signature verified" : "× Text, signature or context mismatch"}
      {entry.cached ? " · Saved copy" : ""}</p>
    {entry.reason && <p className="muted">{englishNotice(entry.reason)}</p>}
    {snapshot && !checking && entry.proof && <p className="muted">Checked {clock(snapshot.checkedAt)}</p>}
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
    <header className="page-heading"><h1>North exercise</h1></header>
    <div className="feed-summary" role="status" aria-live="polite">
      {state.checking ? "Checking…" : (state.chainError ? englishNotice(state.chainError) : undefined) ?? `Last checked ${clock(state.lastSuccess)}`}
    </div>
    {state.chainError && state.lastSuccess && <p className="muted">Previously checked {clock(state.lastSuccess)}. Current status is unknown.</p>}
    {state.deliveryError && <p className="notice warning" role="alert">{englishNotice(state.deliveryError)}</p>}
    {state.missingHead && <p className="notice warning" data-testid="missing-head" role="alert">Content is missing for the latest published version {state.snapshot?.version}. {state.entries.some(e => e.cached && e.status === "current") ? "A previously saved copy is shown below." : "An older version is not current."}</p>}
    {!state.entries.length && !state.checking && <div className="empty"><span aria-hidden="true">↳</span><h2>{state.snapshot?.version ? "Message content missing" : state.snapshot ? "No messages yet" : "Unable to verify"}</h2><p>{state.snapshot?.version ? "The text cannot be recovered from its hash." : "New messages appear here automatically."}</p></div>}
    <section className="message-list" aria-label="Messages">{state.entries.map((entry, index) => <MessageCard key={index} entry={entry} config={config} snapshot={state.snapshot} checking={state.checking} />)}</section>
  </>;
}
const stageLabels: Record<Stage, string> = {
  wallet: "Checking wallet…", signing: "Approve the signature in your wallet…", storing: "Saving signed message…",
  transaction: "Approve publication in your wallet…", confirming: "Waiting for chain and storage confirmation…", complete: "Published and confirmed",
};
function Publisher({ config }: { config: TrustConfig }) {
  const [body, setBody] = useState("Meet at the North exercise site at 14.00. Bring a reflective vest and water.");
  const [head, setHead] = useState<ChainSnapshot>();
  const [attempt, setAttempt] = useState<Attempt>();
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<Stage>();
  const [error, setError] = useState("");
  const [published, setPublished] = useState<CheckedMessage>();
  const inFlight = useRef(false);
  const attemptKey = storageKey("publish", config);
  const [recovered, setRecovered] = useState(false);
  const boot = useRef<{ key: string; promise: ReturnType<typeof reconcileAttempt> } | undefined>(undefined);
  const finish = (result: Awaited<ReturnType<typeof publishAttempt>>) => {
    const saved = JSON.parse(readSaved("publish", config) ?? "null");
    if (saved && !isCompletedAttempt(saved, config, result.packet)) throw new Error("Another attempt was saved. Reload to check it; it has been kept.");
    setPublished({ body: result.packet.body, packet: result.packet, proof: result.proof, signature: "passed", status: result.packet.packageDigest === result.snapshot.digest ? "current" : "superseded", cached: false });
    setAttempt(undefined); clearAttempt(); setHead(result.snapshot); setStage("complete"); setRecovered(result.recovered); setError("");
  };
  useEffect(() => {
    let active = true;
    inFlight.current = true; setBusy(true); setError("");
    let raw: string | null, restored: Attempt | undefined;
    try {
      raw = readSaved("publish", config);
      const saved = JSON.parse(raw ?? "null");
      if (saved) { restored = restoreAttempt(saved, config); setAttempt(restored); setBody(restored.draft.body); }
    } catch { setError("The saved draft could not be read. Review the message again."); inFlight.current = false; setBusy(false); return; }
    const key = `${attemptKey}:${raw}`; // Actual bytes, never just a claimed ID/digest.
    if (boot.current?.key !== key) boot.current = { key, promise: restored ? reconcileAttempt(config, restored) :
      readSnapshot(rpcClient(config), config).then(snapshot => ({ snapshot, result: null })) };
    void boot.current.promise.then(value => {
      if (!active) return;
      setHead(value.snapshot);
      if (value.result) {
        const current = readSaved("publish", config);
        if (current !== raw && current !== "null") { setError("Another attempt was saved. Reload to check it; it has been kept."); return; }
        finish(value.result);
      } else if (restored && mayHaveSent(restored)) setError("Transaction outcome unknown. Keep this attempt and check again; no new transaction will be sent.");
    }).catch(cause => { if (active) setError(cause instanceof ChainCheckUnavailable || cause instanceof StorageCheckUnavailable ? cause.message : "Recovery could not finish. Check the connection, publication evidence and storage. Your attempt is kept."); })
      .finally(() => { if (active) { inFlight.current = false; setBusy(false); } });
    return () => { active = false; };
  }, [config, attemptKey]);
  const persist = (value: Attempt) => {
    setAttempt({ ...value });
    try { localStorage.setItem(attemptKey, JSON.stringify(value)); } catch { /* same-session retry remains available */ }
  };
  const clearAttempt = () => { try { localStorage.setItem(attemptKey, "null"); } catch { /* tombstone prevents restoring the retained legacy attempt */ } };
  const review = async () => {
    if (inFlight.current) return; inFlight.current = true; setBusy(true); setError(""); setPublished(undefined); setStage(undefined); setRecovered(false);
    try {
      const latest = await readSnapshot(rpcClient(config), config); setHead(latest);
      persist({ draft: freezeDraft(body, config, latest) });
    } catch { setError("Unable to prepare the draft. Check the text and network connection."); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const send = async () => {
    if (!attempt || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const result = await publishAttempt(config, window.ethereum, attempt, setStage, persist);
      finish(result);
    } catch (cause) {
      setStage(undefined);
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
      const message = cause instanceof Error ? cause.message : "";
      setError(cause instanceof ChainCheckUnavailable ? cause.message : code === 4001 || /rejected|denied/i.test(message) ? "Wallet request cancelled. Nothing is confirmed; retry the same message." :
        /wallet|konto|nätverk|version|Lagring|lagring|Transaktion|publiceringspost|Serien|Granska/i.test(message) && message.length < 250 ? message :
          "Confirmation could not finish. Your sent message is kept. Continue checking its outcome.");
    } finally { inFlight.current = false; setBusy(false); }
  };
  return <>
    <header className="page-heading"><p className="eyebrow">Alex</p><h1>New update</h1></header>
    <section className="composer">
      <div className="message-meta"><h2>{attempt ? `Review version ${attempt.draft.message.version}` : head?.version ? `Write update · Version ${head.version + 1}` : "New message"}</h2><span className="muted">To Kim</span></div>
      {attempt ? <><p className="message-body review-text" data-testid="frozen-body">{attempt.draft.body}</p><p className="muted">This exact text will be signed.</p></> :
        <><label htmlFor="message-text">Message</label><textarea id="message-text" value={body} maxLength={4000} disabled={busy} onChange={event => setBody(event.target.value)} rows={6} /><p className="character-count">{body.length} / 4 000</p></>}
      <div className="actions">{attempt ? <>
        <button className="primary" disabled={busy} onClick={() => { void send(); }}>{mayHaveSent(attempt) ? "Continue checking" : attempt.packet ? "Continue publishing" : "Sign and publish"}<span aria-hidden="true">↗</span></button>
        <button className="secondary" disabled={busy || mayHaveSent(attempt)} onClick={() => { setAttempt(undefined); setStage(undefined); setError(""); clearAttempt(); }}>Edit message</button>
      </> : <button className="primary" disabled={busy || !body.length} onClick={() => { void review(); }}>{busy ? "Preparing…" : "Review message"}<span aria-hidden="true">→</span></button>}</div>
      {stage && <p className={`notice ${stage === "complete" ? "success" : ""}`} role="status">{stage === "complete" && recovered && published?.packet ? `Version ${published.packet.message.version} was already published and has been recovered.` : <>{stageLabels[stage]}{stage === "complete" && published?.packet ? ` · Version ${published.packet.message.version}` : ""}</>}</p>}
      {error && <p className="notice warning" role="alert">{englishNotice(error)}</p>}
      {attempt?.txHash && <p className="muted">Transaction sent. Continue checking this message.</p>}
    </section>
    {attempt?.packet && <details className="evidence"><summary>Saved publication attempt</summary><dl>
      <dt>Package digest</dt><dd>{attempt.packet.packageDigest}</dd><dt>Transaction hash</dt><dd>{attempt.txHash ?? "Missing"}</dd>
      <dt>Transaction requested</dt><dd>{attempt.transactionRequested ? "Yes" : "No"}</dd>
    </dl></details>}
    <Details entry={published} config={config} snapshot={head} />
  </>;
}
function App() {
  const [config, setConfig] = useState<TrustConfig>();
  const [error, setError] = useState("");
  useEffect(() => {
    document.documentElement.lang = "en";
    document.title = location.pathname === "/publish" ? "Publish · Crisis messages" : "North exercise · Crisis messages";
    const controller = new AbortController();
    void fetch("/deployment.json", { cache: "no-store", signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(); return parseConfig(await response.json(), activeProfile.id);
    }).then(setConfig).catch(() => { if (!controller.signal.aborted) setError(`Deployment configuration is missing or invalid. Run ${activeProfile.id === "local" ? "local:init" : "sepolia:check"} before starting.`); });
    return () => controller.abort();
  }, []);
  const publisher = location.pathname === "/publish";
  return <main className={`live-app ${publisher ? "publisher" : "inbox"}`}>
    <nav className="topline"><a className="wordmark" href={publisher ? "/publish" : "/inbox"}>Crisis messages<span aria-hidden="true">↗</span></a></nav>
    {config ? publisher ? <Publisher config={config} /> : <Inbox config={config} /> : <p className="notice" role="status">{error || "Loading…"}</p>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
