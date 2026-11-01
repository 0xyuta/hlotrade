import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDeployments } from "../src/deployments.js";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const base = { token: A(1), mining: A(3), staking: A(4), buyback: A(5), splitter: A(6), profiles: A(7), pair: A(8), chainId: 998, deployBlock: 12 };
const write = (j: object) => {
  const f = join(mkdtempSync(join(tmpdir(), "dep-")), "d.json");
  writeFileSync(f, JSON.stringify(j));
  return f;
};

describe("loadDeployments", () => {
  it("reads the checkpoints key", () => {
    const d = loadDeployments(write({ ...base, checkpoints: A(2) }), 998);
    expect(d.checkpoints.toLowerCase()).toBe(A(2));
    expect(d.deployBlock).toBe(12n);
    expect("feed" in d).toBe(false);
  });
  it("rejects a file with only feed", () => {
    expect(() => loadDeployments(write({ ...base, feed: A(2) }), 998)).toThrow();
  });
  it("rejects another chain", () => {
    expect(() => loadDeployments(write({ ...base, checkpoints: A(2) }), 999)).toThrow(/chain/);
  });
});
