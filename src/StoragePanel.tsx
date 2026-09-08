import type { Dispatch } from "react";
import type { Action, State } from "./simulation.ts";
import { SENDERS } from "./model.ts";

export function StoragePanel({
  state,
  dispatch,
}: {
  state: State;
  dispatch: Dispatch<Action>;
}) {
  const reference = state.storageReference;
  const row = reference ? state.storage[reference] : undefined;
  const index = state.registry.findIndex((p) => p.reference === reference);
  const proof = state.registry[index];
  const referenceLabel = index >= 0 ? `P${index + 1}` : "Okänd referens";
  return (
    <section className="stage storage-column" aria-labelledby="storage-title">
      <div className="stage-heading">
        <div>
          <span className="eyebrow">Teknisk panel · Skrivåtkomst</span>
          <h2 id="storage-title">Meddelandelagring</h2>
        </div>
      </div>
      <div className="storage-editor">
        <label htmlFor="stored-text">Lagrad meddelandetext</label>
        <textarea
          id="stored-text"
          value={row ? state.storageDraft : ""}
          disabled={!row}
          placeholder="Posten saknas"
          maxLength={500}
          spellCheck={false}
          onChange={(e) =>
            dispatch({ type: "storage-draft", text: e.target.value })
          }
        />
        <dl className="storage-metadata">
          <div>
            <dt>Publiceringsreferens</dt>
            <dd>{row ? referenceLabel : "Posten borttagen"}</dd>
          </div>
          <div>
            <dt>Databasens påstående</dt>
            <dd>{row ? `verifierad = ${String(row.verified)}` : "—"}</dd>
          </div>
        </dl>
        <div className="storage-actions">
          <button
            className="primary dark"
            onClick={() => dispatch({ type: "storage-save" })}
            disabled={!row || state.storageDraft === row.packet.text}
          >
            Spara databasändring
          </button>
          <button
            className="delete-row"
            onClick={() => dispatch({ type: "storage-delete" })}
            disabled={!row}
          >
            Ta bort posten
          </button>
        </div>
      </div>
      <section
        className="publication-evidence"
        aria-label="Betrott publiceringsunderlag"
      >
        <span className="eyebrow">
          Separat betrott underlag · Endast läsning
        </span>
        <h3>Ursprungligt publiceringsbevis</h3>
        {proof ? (
          <>
            <p>
              <strong>{referenceLabel}</strong> ·{" "}
              {SENDERS.find((s) => s.id === proof.sender)?.name ??
                "Okänd avsändare"}{" "}
              · Version {proof.version}
            </p>
            <code>H(publicerat paket)</code>
          </>
        ) : (
          <p>Underlag saknas</p>
        )}
      </section>
    </section>
  );
}
