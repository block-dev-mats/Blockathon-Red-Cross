export type ProfileId = "local" | "sepolia";
export const profiles = {
  local: { id: "local", chainId: 31337, label: "Lokalt EVM-nät", directory: ".local", frontendPort: 5175, apiPort: 3001,
    rpcTimeout: 3500, apiTimeout: 10000, pollInterval: 2500, receiptTimeout: 25000, receiptPollInterval: 500 },
  sepolia: { id: "sepolia", chainId: 11155111, label: "Sepolia", directory: ".sepolia", frontendPort: 5176, apiPort: 3002,
    rpcTimeout: 12000, apiTimeout: 45000, pollInterval: 15000, receiptTimeout: 45000, receiptPollInterval: 4000 },
} as const;
export function profileById(id: unknown) {
  if (id !== "local" && id !== "sepolia") throw new Error("Välj uttryckligen profilen local eller sepolia.");
  return profiles[id];
}
export function profileForChain(chainId: number) {
  if (chainId === 31337) return profiles.local;
  if (chainId === 11155111) return profiles.sepolia;
  throw new Error("Endast Anvil 31337 och Ethereum Sepolia 11155111 tillåts.");
}
export function validRpcUrl(chainId: number, value: string) {
  if (chainId === 31337) return /^http:\/\/127\.0\.0\.1:[0-9]{2,5}$/.test(value);
  if (chainId !== 11155111) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
// Ethereum execution genesis, from https://github.com/eth-clients/sepolia.
export const SEPOLIA_GENESIS = "0x25a5cc106eea7138acab33231d7160d69cb777ee0c2c553fcddf5138993e6dd9" as const;
