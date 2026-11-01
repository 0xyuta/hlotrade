import { existsSync, readFileSync } from "node:fs";
import type { Abi, AbiParameter } from "viem";
import { describe, expect, it } from "vitest";
import { buybackAbi, checkpointsAbi, erc20Abi, miningAbi, splitterAbi, tokenAbi } from "../src/abi.js";

const out = (c: string) => new URL(`../../contracts/out/${c}.sol/${c}.json`, import.meta.url);
const type = (p: AbiParameter): string =>
  p.type.startsWith("tuple")
    ? `(${(p as { components: readonly AbiParameter[] }).components.map(type).join(",")})${p.type.slice(5)}`
    : p.type;
const sig = (i: Abi[number]) => {
  if (i.type === "function") return `function ${i.name}(${i.inputs.map(type)})->(${i.outputs.map(type)}) ${i.stateMutability}`;
  if (i.type === "error") return `error ${i.name}(${i.inputs.map(type)})`;
  if (i.type === "event") return `event ${i.name}(${i.inputs.map((p) => `${type(p)}${p.indexed ? " indexed" : ""}`)})`;
  return "";
};

describe("ABIs match the compiled contracts", () => {
  for (const [name, abi] of [["Checkpoints", checkpointsAbi], ["Mining", miningAbi], ["HloToken", tokenAbi], ["Splitter", splitterAbi], ["Buyback", buybackAbi]] as const) {
    it(name, () => {
      const file = out(name);
      if (!existsSync(file)) throw new Error(`run \`forge build\` in contracts/ first (${file.pathname} missing)`);
      const compiled = new Set((JSON.parse(readFileSync(file, "utf8")).abi as Abi).map(sig));
      for (const item of abi) expect(compiled.has(sig(item)), sig(item)).toBe(true);
    });
  }
  it("Checkpoints lists every compiled error", () => {
    const compiled = (JSON.parse(readFileSync(out("Checkpoints"), "utf8")).abi as Abi).filter((i) => i.type === "error").map(sig);
    const ours = new Set(checkpointsAbi.map(sig));
    for (const e of compiled) expect(ours.has(e), e).toBe(true);
  });
  it("Mining lists every compiled error and event", () => {
    const compiled = (JSON.parse(readFileSync(out("Mining"), "utf8")).abi as Abi).filter((i) => i.type === "error" || i.type === "event").map(sig);
    const ours = new Set(miningAbi.map(sig));
    for (const e of compiled) expect(ours.has(e), e).toBe(true);
  });
  it("Mining has settleAndClaim", () => {
    expect(miningAbi.some((i) => i.type === "function" && i.name === "settleAndClaim")).toBe(true);
  });
  it("erc20 subset is standard", () => {
    expect(erc20Abi.map(sig)).toContain("function approve(address,uint256)->(bool) nonpayable");
  });
});
