import { SENDERS } from "./model.ts";
import type { State } from "./simulation.ts";

export function VerificationDetails({ state }: { state: State }) {
  const sentCopy = [...state.receipts]
    .reverse()
    .find((r) => r.route === "forwarded");
  const packet =
    state.scenario === "database"
      ? state.fetchOutcome
        ? state.receipts.find((r) => r.id === state.fetchOutcome?.id)?.packet
        : state.storage[state.storageReference ?? ""]?.packet
      : state.scenario === "forwarding"
        ? (sentCopy?.packet ?? state.copy)
        : state.registry.at(-1);
  const replaces = packet?.replaces
    ? state.registry.find((p) => p.reference === packet.replaces)
    : null;
  const example =
    state.scenario === "database" && !packet
      ? null
      : {
          text: packet?.text ?? state.draft,
          meddelandeId: packet?.id ?? "Tilldelas vid publicering",
          version: packet?.version ?? 1,
          avsändare: packet?.sender ?? SENDERS[0].id,
          nyckelidentitet: packet?.keyId ?? SENDERS[0].keyId,
          sammanhang: packet?.context ?? state.subscription,
          ersätter: replaces
            ? { meddelandeId: replaces.id, version: replaces.version }
            : null,
        };
  return (
    <details className="verification-details">
      <summary>Så fungerar verifieringen</summary>
      <div className="details-body">
        <p className="architecture-label">Föreslagen målarkitektur</p>
        <div className="mechanism-grid">
          <section className="package-example">
            <h3>
              {state.scenario === "database"
                ? state.fetchOutcome
                  ? "Senaste lagringssvar"
                  : "Post i lagringen"
                : state.scenario === "forwarding"
                  ? sentCopy
                    ? "Senast mottagna kopia"
                    : "Kopia att skicka"
                  : packet
                    ? "Senast publicerade paket"
                    : "Förberett paket"}
            </h3>
            <pre aria-label="Paketexempel">
              {example === null
                ? "Inget meddelandepaket att visa."
                : JSON.stringify(example, null, 2)}
            </pre>
            <p>Värden från modellen; nyckelidentiteten är en demoidentitet.</p>
          </section>
          <div className="mechanism-blocks">
            {state.scenario === "database" && (
              <section>
                <h3>Efter intrånget: bara lagringen är angripen</h3>
                <p>
                  Här börjar demonstrationen efter ett antaget intrång och visar
                  upptäckt och hantering, inte intrångsprevention. Angriparen
                  kan skriva och radera i meddelandelagringen. Alex
                  signeringsbehörighet, organisationens betrodda nyckelkoppling,
                  kedjans publiceringsunderlag och mottagarens verifieringskod
                  ligger utanför angreppet.
                </p>
              </section>
            )}
            {state.scenario === "database" && (
              <section>
                <h3>Databasens påstående är inte ett godkännande</h3>
                <p>
                  Mottagaren kontrollerar det hämtade paketets signatur och
                  fingeravtryck mot separat betrott underlag. Databasens egen
                  ”verifierad”-flagga är obetrodd metadata och ignoreras vid
                  kontrollen; inte heller ett nytt hashvärde i samma databas
                  skapar organisationsgodkännande.
                </p>
              </section>
            )}
            {state.scenario === "database" && (
              <section>
                <h3>Upptäckt utan återställningslöfte</h3>
                <p>
                  Signaturkontroll kan upptäcka ändringar utan blockchain.
                  Kedjan tillför ett separat kontrollerbart
                  publiceringsregister. Varken signatur eller hash återställer
                  raderad text; bara en redan mottagen lokal kopia kan finnas
                  kvar här.
                </p>
              </section>
            )}
            <section>
              <h3>Paket → entydiga byte</h3>
              <p>
                Text, ID, version, avsändar- och nyckelidentitet, sammanhang och
                ersättningshänvisning binds ihop. Båda sidor använder samma
                entydiga byte-representation; inga blanksteg trimmas och inget
                innehåll ändras tyst.
              </p>
            </section>
            <section>
              <h3>Hash → rätt publiceringspost</h3>
              <p>
                Ett kryptografiskt fingeravtryck beräknas för paketet.
                Mottagaren beräknar sitt eget för jämförelse med rätt post:{" "}
                <code>H(mottaget paket) = H(publicerat paket)</code>. En
                matchning bevisar inte ensam vem som godkänt paketet.
              </p>
            </section>
            <section>
              <h3>Signatur + rätt behörighet</h3>
              <p>
                Alex signerar paketet med sin privata nyckel. Appen kontrollerar
                signaturen med motsvarande publika nyckel och att organisationen
                har gett den nyckeln publiceringsbehörighet för just detta
                sammanhang. Kim behöver ingen wallet.
              </p>
            </section>
            <section>
              <h3>Kedjan är register, inte transport</h3>
              <p>
                Ett betrott, känt register på kedjan knyter fingeravtryck och
                publiceringshändelse till behörig publicerare och version.
                Texten lagras och distribueras utanför kedjan av en vanlig
                meddelandetjänst. Registret kan kontrolleras även utanför vår
                databas; det intygar inte saklig sanning.
              </p>
            </section>
            <section>
              <h3>Ny version och aktuell status</h3>
              <p>
                En uppdatering är ett nytt godkänt paket med koppling till
                föregående version. Signaturkontroll kan göras lokalt med
                betrodda nycklar, men ersättnings- och återkallelsestatus kräver
                färskt underlag.
              </p>
            </section>
            <section>
              <h3>Två vägar, samma ursprung</h3>
              <p>
                Direktleverans går till Kims förinställda prenumeration.
                Vidarebefordran är en alternativ väg för samma ursprungspaket;
                transportören blir inte publicerare. Båda vägarna kontrolleras
                mot samma publiceringsunderlag.
              </p>
            </section>
          </div>
        </div>
      </div>
    </details>
  );
}
