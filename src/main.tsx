import { StrictMode, useEffect, useReducer } from "react";
import { createRoot } from "react-dom/client";
import { difference, SENDERS } from "./model.ts";
import type { Packet } from "./model.ts";
import { currentOfficial, initial, reducer } from "./simulation.ts";
import type { Receipt, Scenario } from "./simulation.ts";
import { VerificationDetails } from "./VerificationDetails.tsx";
import { StoragePanel } from "./StoragePanel.tsx";
import "./styles.css";

const scenarios: { id: Scenario; name: string }[] = [
  { id: "publication", name: "Publicering" },
  { id: "forwarding", name: "Vidarebefordran" },
  { id: "update", name: "Uppdatering" },
  { id: "offline", name: "Utan uppkoppling" },
  { id: "database", name: "Databasmanipulation" },
];
const notes: Record<string, string> = {
  "storage-ready":
    "”Simulera ny hämtning” representerar nästa läsning från meddelandetjänsten; databasändringar når inte Kim förrän dess.",
  "storage-saved":
    "Bara lagringens text ändras; publiceringsunderlaget och Kims redan kontrollerade paket ligger kvar oförändrade.",
  "storage-deleted":
    "Posten är borttagen ur lagringen; nästa hämtning kan misslyckas även när publiceringsbeviset finns kvar.",
  "storage-fetching":
    "Lagringssvaret fryses för den här hämtningen; senare databasändringar påverkar först nästa läsning.",
  "storage-missing":
    "Ett publiceringsbevis kan styrka ett paket, men varken signatur eller hash återskapar en raderad meddelandetext.",
  ready:
    "Kim prenumererar på Övning Norr; publicering skickar paketet direkt via en meddelandetjänst utanför kedjan.",
  published:
    "Först levererar meddelandetjänsten hela paketet, därefter kontrollerar mottagarappen det mot publiceringsunderlaget.",
  "published-offline":
    "Publiceringen finns hos Alex, men varken det nya paketet eller dess status når Kim under avbrottet.",
  "copy-ready":
    "Originalet har levererats direkt; kopian visar en alternativ transportväg med samma ursprung och verifieringsreferens.",
  copy: "Redigering påverkar bara nästa kopia som skickas; redan mottagna paket och deras kontroller ligger kvar.",
  forwarded:
    "En kopia får en egen mottagning och kontroll, även när den hänvisar till ett redan känt original.",
  received:
    "Mottagning ger inget godkännande i sig; text, identiteter och sammanhang kontrolleras tillsammans innan ett paket kan bli aktuellt.",
  checked:
    "Appen jämför paketet med rätt publiceringspost och kontrollerar signatur, behörighet och färsk status var för sig.",
  "update-ready":
    "En uppdatering är ett nytt godkänt paket som uttryckligen ersätter den tidigare versionen och levereras till prenumeranterna.",
  "connection-ready":
    "Lokal signaturkontroll kan bestå utan uppkoppling, men färska ersättningar och återkallelser kräver nytt statusunderlag.",
  offline:
    "Det lokala paketet kan fortfarande kontrolleras, men utan färskt underlag går det inte att veta om det har ersatts eller återkallats.",
  reconnected:
    "Återanslutning hämtar både missade officiella paket och färskt statusunderlag för automatisk kontroll.",
};

function Icon({
  kind,
}: {
  kind:
    "send" | "arrow" | "check" | "warning" | "reset" | "offline" | "document";
}) {
  const paths = {
    send: (
      <>
        <path d="m21 3-7 18-4-7-7-4 18-7Z" />
        <path d="m10 14 5-5" />
      </>
    ),
    arrow: (
      <>
        <path d="M4 12h16m-6-6 6 6-6 6" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    warning: (
      <>
        <path d="m12 3 10 18H2L12 3Z" />
        <path d="M12 9v5m0 3v.2" />
      </>
    ),
    reset: (
      <>
        <path d="M4 10a8 8 0 1 1 1 8M4 4v6h6" />
      </>
    ),
    offline: (
      <>
        <path d="m3 3 18 18M3 9a15 15 0 0 1 4-2m5-1a15 15 0 0 1 9 3M6 13a10 10 0 0 1 5-2m7 2-1-1M9 17a5 5 0 0 1 6 0m-3 3v.1" />
      </>
    ),
    document: (
      <>
        <path d="M6 3h8l4 4v14H6V3Zm8 0v5h4M9 12h6m-6 4h4" />
      </>
    ),
  };
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[kind]}
    </svg>
  );
}

function Meta({ packet }: { packet: Packet }) {
  const sender = SENDERS.find((s) => s.id === packet.sender);
  return (
    <div className="message-meta">
      <span>{sender ? `${sender.name} · Samordning` : "Okänd avsändare"}</span>
      <span>Version {packet.version}</span>
    </div>
  );
}

function Message({ receipt, current }: { receipt: Receipt; current: boolean }) {
  const { packet, result, checking: pending } = receipt;
  const isCopy = receipt.route === "forwarded";
  const isStorage = receipt.route === "storage";
  const changed = result?.integrity === "changed";
  const unavailable =
    !result ||
    result.integrity === "unavailable" ||
    result.authority === "unavailable";
  const replaced = result?.status === "replaced";
  const diff =
    changed && result.original
      ? difference(result.original.text, packet.text)
      : null;
  const label = pending
    ? "Kontrollerar…"
    : unavailable
      ? "Kan inte verifieras"
      : changed
        ? isStorage
          ? "Hämtat innehåll matchar inte publiceringen"
          : "Ändrat innehåll"
        : result?.authority === "unauthorized"
          ? "Avsändaren saknar behörighet"
          : result?.status === "revoked"
            ? "Återkallat"
            : replaced
              ? "Ersatt av ny version"
              : current
                ? "Behörig avsändare · Aktuell"
                : "Behörig avsändare · Oförändrat";
  const tone = pending
    ? "neutral"
    : changed ||
        unavailable ||
        result?.authority === "unauthorized" ||
        result?.status === "revoked"
      ? "danger"
      : replaced || result?.status === "unknown"
        ? "neutral"
        : "success";
  return (
    <article
      className={`message received ${replaced ? "replaced" : ""} ${isCopy || isStorage ? "received-copy" : ""}`}
      data-receipt-id={receipt.id}
      data-route={receipt.route}
    >
      {isCopy && <p className="copy-title">Mottagen kopia</p>}
      {isStorage && <p className="copy-title">Ny hämtning</p>}
      <Meta packet={packet} />
      <p className="message-text">
        {isStorage && changed ? (
          <mark>{packet.text || "(Tom text)"}</mark>
        ) : diff ? (
          <>
            {diff.prefix}
            {diff.removed && (
              <del aria-label={`Borttaget: ${diff.removed}`}>
                {diff.removed}
              </del>
            )}
            {diff.added && (
              <mark aria-label={`Tillagt: ${diff.added}`}>{diff.added}</mark>
            )}
            {diff.suffix}
          </>
        ) : (
          packet.text
        )}
      </p>
      <div className={`result ${tone}`} role="status">
        <Icon
          kind={
            pending
              ? "document"
              : tone === "danger"
                ? "warning"
                : replaced
                  ? "arrow"
                  : "check"
          }
        />
        <span>{label}</span>
      </div>
      {!pending &&
        result?.status === "unknown" &&
        !changed &&
        !unavailable &&
        result?.authority === "authorized" && (
          <p className="status-unknown">Aktuell status okänd</p>
        )}
    </article>
  );
}

function App() {
  const [state, dispatch] = useReducer(reducer, undefined, () => initial());
  const latest = state.registry.at(-1);
  const showCopy = state.scenario === "forwarding";
  const showStorage = state.scenario === "database";
  const fetched =
    state.fetchOutcome?.status === "received"
      ? state.receipts.find((r) => r.id === state.fetchOutcome?.id)
      : undefined;
  const official = state.receipts.filter((r) => r.route === "official");
  const lastCopy = [...state.receipts]
    .reverse()
    .find((r) => r.route === "forwarded");
  const current = currentOfficial(state);
  const hasDelivery =
    state.online && (state.deliveries.length > 0 || state.syncRequested);
  const hasChecks = state.online && state.receipts.some((r) => r.checking);
  useEffect(() => {
    if (!hasDelivery) return;
    const timer = window.setTimeout(
      () =>
        dispatch({
          type: "delivered",
          generation: state.generation,
          revision: state.deliveryRevision,
        }),
      180,
    );
    return () => window.clearTimeout(timer);
  }, [hasDelivery, state.generation, state.deliveryRevision]);
  useEffect(() => {
    if (!hasChecks) return;
    const timer = window.setTimeout(
      () =>
        dispatch({
          type: "checked",
          generation: state.generation,
          revision: state.checkRevision,
        }),
      550,
    );
    return () => window.clearTimeout(timer);
  }, [hasChecks, state.generation, state.checkRevision]);

  return (
    <main>
      <div className="controls">
        <div
          className="scenario-picker"
          role="group"
          aria-label="Välj scenario"
        >
          {scenarios.map(({ id, name }) => (
            <button
              key={id}
              aria-pressed={state.scenario === id}
              onClick={() => dispatch({ type: "prepare", scenario: id })}
            >
              {name}
            </button>
          ))}
        </div>
        <button className="reset" onClick={() => dispatch({ type: "reset" })}>
          <Icon kind="reset" />
          Återställ
        </button>
      </div>

      <div className="scene-context">
        <span>
          Fiktivt scenario <span aria-hidden="true">/</span> Övning Norr
        </span>
        {state.scenario === "offline" && (
          <button
            className="connection"
            onClick={() => dispatch({ type: "connection" })}
          >
            <Icon kind="offline" />
            {state.online ? "Koppla från volontären" : "Återanslut volontären"}
          </button>
        )}
        {showStorage && (
          <button
            className="connection"
            onClick={() => dispatch({ type: "storage-fetch" })}
            disabled={!state.online}
          >
            Simulera ny hämtning
          </button>
        )}
      </div>

      <div
        className={`scene ${showCopy || showStorage ? "with-copy" : "direct"} ${showStorage ? "database-scene" : ""}`}
      >
        <section className="stage" aria-labelledby="coordinator-title">
          <div className="stage-heading">
            <div>
              <span className="eyebrow">Officiell publicering</span>
              <h1 id="coordinator-title">Samordnare</h1>
            </div>
            <span className="flow-arrow">
              <Icon kind="arrow" />
            </span>
          </div>
          <div className="phone coordinator">
            <div className="person">
              <span className="avatar">A</span>
              <div>
                <strong>{SENDERS[0].name}</strong>
                <span>Behörig publicerare</span>
              </div>
              <span className="person-mark">
                <Icon kind="document" />
              </span>
            </div>
            <div className="phone-body">
              <div className="section-label">
                <span>Till volontärer</span>
                <span>Övning Norr</span>
              </div>
              <label className="editor-label" htmlFor="official-message">
                {latest ? "Nästa version" : "Nytt meddelande"}
              </label>
              <textarea
                id="official-message"
                value={state.draft}
                onChange={(e) =>
                  dispatch({ type: "draft", text: e.target.value })
                }
                maxLength={500}
                spellCheck={false}
              />
              {latest && (
                <p className="replacement-hint">
                  Ersätter version {latest.version} vid publicering.
                </p>
              )}
              <button
                className="primary"
                onClick={() => dispatch({ type: "publish" })}
                disabled={!state.draft.trim() || state.draft === latest?.text}
              >
                <Icon kind="send" />
                {latest ? "Publicera uppdatering" : "Publicera"}
              </button>
              {latest && (
                <div className="published-original">
                  <div className="section-label">
                    <span>Publicerat original</span>
                    <span>v{latest.version}</span>
                  </div>
                  <p>{latest.text}</p>
                </div>
              )}
            </div>
          </div>
        </section>

        {showCopy && (
          <section className="stage" aria-labelledby="forward-title">
            <div className="stage-heading">
              <div>
                <span className="eyebrow">Alternativ transportväg</span>
                <h2 id="forward-title">Vidarebefordran</h2>
              </div>
              <span className="flow-arrow">
                <Icon kind="arrow" />
              </span>
            </div>
            <div className="phone transport">
              <div className="transport-heading">
                <Icon kind="document" />
                <strong>Vidarebefordrad kopia</strong>
              </div>
              <div className="phone-body">
                {state.copy ? (
                  <>
                    <div className="message copy-message">
                      <Meta packet={state.copy} />
                      <label className="sr-only" htmlFor="forwarded-message">
                        Text i kopian
                      </label>
                      <textarea
                        id="forwarded-message"
                        value={state.copy.text}
                        onChange={(e) =>
                          dispatch({ type: "copy", text: e.target.value })
                        }
                        maxLength={500}
                        spellCheck={false}
                      />
                    </div>
                    <p className="copy-hint">Prova att ändra kopians text.</p>
                    <button
                      className="primary dark"
                      onClick={() => dispatch({ type: "forward" })}
                      disabled={!state.online || !state.copy.text.trim()}
                    >
                      <Icon kind="arrow" />
                      Vidarebefordra
                    </button>
                    {!state.online && (
                      <p className="delivery-block">
                        Volontären är frånkopplad. Kopian stannar här.
                      </p>
                    )}
                  </>
                ) : (
                  <div className="empty">
                    <span className="empty-icon">
                      <Icon kind="document" />
                    </span>
                    <strong>Här hamnar kopian</strong>
                    <p>
                      Publicera ett meddelande
                      <br />
                      för att börja.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {showStorage && <StoragePanel state={state} dispatch={dispatch} />}
        <section className="stage" aria-labelledby="volunteer-title">
          <div className="stage-heading">
            <div>
              <span className="eyebrow">Automatisk kontroll</span>
              <h2 id="volunteer-title">Volontär</h2>
            </div>
          </div>
          <div
            className={`phone volunteer ${!state.online ? "is-offline" : ""}`}
          >
            <div className="person">
              <span className="avatar volunteer-avatar">K</span>
              <div>
                <strong>Kim</strong>
                <span>Prenumererar på Övning Norr</span>
              </div>
            </div>
            <div className="phone-body inbox">
              {!state.online && (
                <div className="offline-status" role="status">
                  <Icon kind="offline" />
                  <span>
                    Offline ·{" "}
                    {state.lastCheckedAt
                      ? `Senast kontrollerat ${state.lastCheckedAt}`
                      : "Ingen slutförd kontroll"}
                  </span>
                </div>
              )}
              {hasDelivery && (
                <p className="delivery-status" role="status">
                  Tar emot…
                </p>
              )}
              {[...official].reverse().map((r) => (
                <Message
                  key={r.id}
                  receipt={r}
                  current={r.id === current?.id}
                />
              ))}
              {lastCopy && <Message receipt={lastCopy} current={false} />}
              {fetched && <Message receipt={fetched} current={false} />}
              {state.fetchOutcome?.status === "missing" && (
                <p className="fetch-error" role="status">
                  <Icon kind="warning" />
                  Meddelandet kunde inte hämtas
                </p>
              )}
              {!state.receipts.length &&
                !hasDelivery &&
                !state.fetchOutcome && (
                  <div className="empty">
                    <span className="empty-icon">
                      <Icon kind="send" />
                    </span>
                    <strong>Inget meddelande ännu</strong>
                    <p>Nästa publicering kommer hit automatiskt.</p>
                  </div>
                )}
            </div>
          </div>
        </section>
      </div>

      <aside className="technical" aria-label="Teknikanteckningar">
        <span className="technical-symbol" aria-hidden="true">
          ↳
        </span>
        <div>
          <p className="simulation-label">
            Leverans, signering och kedjekontroll simuleras.
          </p>
          <p>{notes[state.event]}</p>
        </div>
      </aside>
      <VerificationDetails
        key={`${state.scenario}-${state.generation}`}
        state={state}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
