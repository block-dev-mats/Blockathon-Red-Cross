import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { formatEther } from "viem";
import type { Hex } from "viem";
import { planSchema, journalSchema } from "../../shared/deployment.ts";
import type { DeploymentPlan } from "../../shared/deployment.ts";
import { hex32, parseConfig } from "../../shared/protocol.ts";
import type { TrustConfig } from "../../shared/protocol.ts";
import { confirmDeployment, connectDeployer, deploymentCacheKey, deployRequest, sendDeployment } from "./deploy.ts";
import "./live.css";
document.title = "Deploya · Krismeddelanden";

function Deploy() {
  const [plan, setPlan] = useState<DeploymentPlan>();
  const [started, setStarted] = useState(false), [hash, setHash] = useState<Hex>();
  const [manualHash, setManualHash] = useState("");
  const [complete, setComplete] = useState<TrustConfig>();
  const [status, setStatus] = useState("Läser Sepolia-inställningar och deploymentunderlag…"), [error, setError] = useState("");
  const [busy, setBusy] = useState(true), lock = useRef(false);
  async function load() {
    const data = await deployRequest("");
    if (data.deployed) { setComplete(parseConfig(data.deployed, "sepolia")); setStatus("Deployment finns. Starta om Sepolia för publicering och mottagning."); return; }
    const journal = data.journal ? journalSchema.parse(data.journal) : undefined;
    const p = journal?.plan ?? planSchema.parse(data.plan); setPlan(p);
    const saved = localStorage.getItem(deploymentCacheKey(p));
    const local = saved ? journalSchema.parse(JSON.parse(saved)) : undefined;
    if (local && JSON.stringify(local.plan) !== JSON.stringify(p)) throw new Error("Sparat browserunderlag avviker. Ingen ny deployment skickas.");
    setStarted(Boolean(journal || local)); setHash(journal?.txHash ?? local?.txHash);
    setStatus(journal || local ? "Ett deploymentförsök är sparat. Fortsätt kontrollen av samma transaktion." : "Kontrollera kontot i MetaMask och granska kostnaden före deployment.");
  }
  useEffect(() => { void load().catch(e => setError(e.message)).finally(() => setBusy(false)); }, []);
  async function run(action: () => Promise<void>) {
    if (lock.current) return; lock.current = true; setBusy(true); setError("");
    try { await action(); }
    catch (e) {
      setError(e instanceof Error && !/HTTP|Request|fetch|Transaction|User rejected/i.test(e.message) ? e.message :
        "Kontrollen eller walletanropet kunde inte slutföras. Ett skickat anrop kan ha nått kedjan. Sparat försök behålls; ingen ny deployment skickas automatiskt.");
      // Refresh durable intent after failures (including a lost /begin response).
      try { await load(); } catch { /* Keep the already visible evidence and error. */ }
    } finally { lock.current = false; setBusy(false); }
  }
  function save(txHash?: Hex) {
    setStarted(true); if (txHash) setHash(txHash);
    localStorage.setItem(deploymentCacheKey(plan!), JSON.stringify({ plan, ...(txHash ? { txHash } : {}) }));
  }
  async function confirm(txHash: Hex) {
    setStatus("Kontrollerar receipt, kontraktskod och kontext via Sepolia…");
    const config = await confirmDeployment(plan!, txHash); setComplete(config); setStatus("Deployment verifierad och sparad. Kedjebekräftelse mottagen.");
  }
  return <main className="live-app">
    <nav className="topline"><span className="wordmark">Krismeddelanden</span><span>Sepolia · Demoorganisation</span></nav>
    <header className="page-heading"><h1>Deploya CrisisRegistry</h1></header>
    <p role="status">{status}</p>{error && <p className="notice warning" role="alert">{error}</p>}
    {complete ? <><p>Stoppa Sepolia-processen med Ctrl+C och kör <code>npm run sepolia:start</code>. Öppna sedan <a href="/publish">Publicera</a> eller <a href="/inbox">Inkorg</a>.</p>
      <details className="evidence"><summary>Visa kontrollunderlag</summary><p><a href={`https://sepolia.etherscan.io/address/${complete.domain.verifyingContract}`} target="_blank" rel="noreferrer">Kontrakt</a> · <a href={`https://sepolia.etherscan.io/tx/${complete.deploymentTxHash}`} target="_blank" rel="noreferrer">Deploymenttransaktion</a></p><dl><dt>Kontrakt</dt><dd>{complete.domain.verifyingContract}</dd><dt>Deploymentblock</dt><dd>{complete.deploymentBlock} · {complete.deploymentBlockHash}</dd><dt>Kodhash</dt><dd>{complete.codeHash}</dd></dl></details></> : plan && <>
      <dl className="evidence"><dt>Publisher</dt><dd>{plan.settings.publisher}</dd><dt>Deployer · välj detta konto</dt><dd>{plan.settings.deployer}</dd><dt>Uppskattad högsta kostnad</dt><dd>{formatEther(BigInt(plan.maxCost))} Sepolia ETH</dd></dl>
      {!started ? <div className="actions"><button disabled={busy} onClick={() => void run(async () => { await connectDeployer(plan, window.ethereum); setStatus(`Wallet kontrollerad: ${plan.settings.deployer} · Ethereum Sepolia.`); })}>Kontrollera MetaMask</button>
        <button disabled={busy} onClick={() => void run(async () => { setStatus("Godkänn deploymenttransaktionen i MetaMask…"); const sent = await sendDeployment(plan, window.ethereum, save); await confirm(sent); })}>Deploya på Sepolia</button></div> : <>
        {hash ? <p className="evidence">Sparad transaktion: <a href={`https://sepolia.etherscan.io/tx/${hash}`} target="_blank" rel="noreferrer">{hash}</a></p> : <p>Transaktionshash saknas. Kontrollera MetaMasks aktivitet. Om deploymenten skickades, klistra in dess publika transaktionshash nedan. Vid avbruten eller oklar dialog behålls försöket för manuell utredning.</p>}
        {!hash && <label>Deploymentens transaktionshash<input style={{ width: "100%", font: "inherit" }} value={manualHash} onChange={e => setManualHash(e.target.value)} placeholder="0x…" /></label>}
        <button disabled={busy || (!hash && !hex32.safeParse(manualHash).success)} onClick={() => void run(async () => { const txHash = hash ?? hex32.parse(manualHash); save(txHash); await confirm(txHash); })}>Fortsätt kontrollera deploymenten</button>
      </>}
    </>}
    {!plan && !complete && !busy && <button onClick={() => void run(load)}>Läs inställningarna igen</button>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Deploy />);
