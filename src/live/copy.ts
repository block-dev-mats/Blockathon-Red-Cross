// Presentation-only translations. Never pass signed message bodies through this
// function: their exact received bytes must remain visible and verifiable.
const notices: Record<string, string> = {
  "Text, signatur eller sammanhang stämmer inte.": "Text, signature or context mismatch.",
  "Ingen bekräftad publiceringspost ännu.": "No confirmed publication yet.",
  "Publiceringsunderlaget kunde inte bekräftas.": "Publication evidence is unavailable.",
  "En annan publicering finns för denna version.": "A different publication exists for this version.",
  "Föregångaren stämmer inte med registret.": "The previous version does not match the registry.",
  "Aktuell status kan inte kontrolleras. Anslutningen till det betrodda nätet saknas eller stämmer inte.": "Current status unavailable. The trusted network cannot be reached or does not match.",
  "Meddelanden kunde inte hämtas. Sparade kopior kontrolleras separat.": "Unable to fetch messages. Saved copies are checked separately.",
  "Det sparade paketet motsvarar inte den granskade texten.": "The saved message does not match the reviewed text.",
  "Lagringen kunde inte bekräftas. Försök igen med samma paket.": "Storage could not be confirmed. Retry the same message.",
  "Transaktionen misslyckades. Försöket behålls för kontroll.": "Transaction failed. The attempt is kept for review.",
  "Matchande publiceringspost saknas.": "No matching publication record.",
  "Walletens transaktionsutfall är okänt. Fortsätt kontrollera samma paket; ingen ny transaktion skickas.": "Transaction outcome is unknown. Keep checking this message; no new transaction will be sent.",
  "Walletens transaktionsutfall är okänt. Kontrollera dess historik och försök kontrollera samma paket igen. Ingen ny transaktion skickas.": "Transaction outcome is unknown. Check your wallet history and retry verification. No new transaction will be sent.",
  "Ingen browser-wallet hittades. Öppna publiceringsvyn i en webbläsare med en installerad wallet.": "No wallet found. Open this page in a browser with a wallet installed.",
  "Fel konto. Välj Alex förkonfigurerade testwallet.": "Wrong account. Select Alex's configured wallet.",
  "En ny version har publicerats. Granska texten igen mot aktuell head.": "A newer version was published. Review your message again.",
  "Versionskonflikt. En annan uppdatering har redan publicerats.": "Version conflict. Another update was already published.",
  "Transaktionen misslyckades. Publiceringen är inte färdig.": "Transaction failed. Publication is not complete.",
};
const rpcTerms: Record<string, string> = {
  "RPC:n begränsar anropstakten": "RPC rate limit reached",
  "RPC-anropet tog för lång tid": "RPC request timed out",
  "RPC-underlaget kunde inte läsas": "RPC evidence unavailable",
  "aktuellt kontrollblock": "current verification block", "genesis": "genesis",
  "deploymentblock": "deployment block", "kontraktskod": "contract code",
  "immutable kontext": "immutable context", "head": "latest version", "chain ID": "chain ID",
  "kontrollblockets hash": "verification block hash", "versionsregister": "version record",
  "Published-event": "publication event", "publiceringens receipt": "publication receipt",
  "publiceringsblockets hash": "publication block hash",
};
export function englishNotice(text: string): string {
  if (notices[text]) return notices[text];
  if (text.startsWith("Lagringens kedjekontroll: ")) return `Storage verification: ${englishNotice(text.slice("Lagringens kedjekontroll: ".length))}`;
  const rpc = text.match(/^(.*?) · (.*?)\. Försök kontrollera igen\.$/);
  if (rpc) return `${rpcTerms[rpc[1]] ?? "RPC evidence unavailable"} · ${rpcTerms[rpc[2]] ?? "verification"}. Try checking again.`;
  const network = text.match(/^Fel nätverk\. Välj .* med chain ID (\d+)\.$/);
  if (network) return `Wrong network. Select ${network[1] === "11155111" ? "Sepolia" : "Anvil"} (chain ID ${network[1]}).`;
  return text;
}
