import { deploymentIdentity } from "../../shared/protocol.ts";
import type { TrustConfig } from "../../shared/protocol.ts";
import { profileById } from "../../shared/profiles.ts";
declare const __APP_PROFILE__: "local" | "sepolia";
// Injected by the explicitly selected server profile, never by wallet or packets.
export const activeProfile = profileById(__APP_PROFILE__);
export const storageKey = (kind: "inbox" | "publish", c: TrustConfig) => `crisis-${kind}:${deploymentIdentity(c)}`;
export function readSaved(kind: "inbox" | "publish", c: TrustConfig): string | null {
  const value = localStorage.getItem(storageKey(kind, c));
  if (value !== null || c.domain.chainId !== 31337) return value;
  // Non-destructive compatibility with the original local deployment. Consumers
  // revalidate these bytes; no approval flags or Sepolia data are migrated.
  return localStorage.getItem(`crisis-${kind}:${c.domain.verifyingContract}:${c.codeHash}`);
}
