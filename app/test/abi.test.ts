import { existsSync, readFileSync } from "node:fs";
import type { Abi, AbiParameter } from "viem";
import { describe, expect, it } from "vitest";
import { buybackAbi, checkpointsAbi, miningAbi, profilesAbi, stakingAbi, tokenAbi } from "../src/evm/abi";

const out = (c: string) => new URL(`../../contracts/out/${c}.sol/${c}.json`, import.meta.url);
const type = (p: AbiParameter): string =>
  p.type.startsWith("tuple") ? `(${(p as { components: readonly AbiParameter[] }).components.map(type).join(",")})${p.type.slice(5)}` : p.type;
const sig = (i: Abi[number]) =>
  i.type === "function" ? `function ${i.name}(${i.inputs.map(type)})->(${i.outputs.map(type)}) ${i.stateMutability}`
  : i.type === "error" ? `error ${i.name}(${i.inputs.map(type)})` : "";

describe("app ABIs match contracts/out", () => {
  it("Mining carries the claim allowance read and its error", () => {
    expect(miningAbi.some((i) => i.type === "function" && i.name === "claimAvailable")).toBe(true);
    expect(miningAbi.some((i) => i.type === "error" && i.name === "ClaimLimitReached")).toBe(true);
  });
  for (const [name, abi] of [["Checkpoints", checkpointsAbi], ["Mining", miningAbi], ["HloToken", tokenAbi], ["Staking", stakingAbi], ["Buyback", buybackAbi], ["Profiles", profilesAbi]] as const) {
    it(name, () => {
      const file = out(name);
      if (!existsSync(file)) throw new Error(`run \`forge build\` in contracts/ first (${file.pathname} missing)`);
      const compiled = new Set((JSON.parse(readFileSync(file, "utf8")).abi as Abi).map(sig));
      for (const item of abi) if (item.type === "function" || item.type === "error") expect(compiled.has(sig(item)), sig(item)).toBe(true);
    });
  }
});
