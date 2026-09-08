import { assertRuntime } from "../shared/deployment.ts";
import { readFile } from "node:fs/promises";
import { encodeDeployData, keccak256, toBytes } from "viem";
import type { Abi, Address, Hex } from "viem";

export const demoContext = {
  organisation: keccak256(toBytes("Demoorganisation")), feed: keccak256(toBytes("Ovning Norr")), messageId: keccak256(toBytes("KRIS-DEMO-001")),
};
export async function contractArtifact() {
  const artifact = JSON.parse(await readFile(new URL("../artifacts/CrisisRegistry.sol/CrisisRegistry.json", import.meta.url), "utf8"));
  return artifact as { abi: Abi; bytecode: { object: Hex }; deployedBytecode: { object: Hex; immutableReferences: Record<string, { start: number; length: number }[]> } };
}
export async function deploymentData(publisher: Address) {
  const artifact = await contractArtifact();
  return encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object,
    args: [publisher, demoContext.organisation, demoContext.feed, demoContext.messageId] });
}
export async function assertCompiledCode(actual: Hex) {
  assertRuntime(actual, (await contractArtifact()).deployedBytecode);
}
