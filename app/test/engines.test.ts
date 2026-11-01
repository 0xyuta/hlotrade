import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** ">=22.12.0" → [22, 12, 0]; only the ">=" ranges these packages use. */
const floor = (range: string): number[] => {
  const m = /^>=(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim());
  if (!m) throw new Error(`not a >= range: ${range}`);
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
};
const atLeast = (a: number[], b: number[]) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];
const pkg = (p: string) => JSON.parse(readFileSync(p, "utf8")) as { engines?: { node?: string } };
/** A dependency's package.json, where npm put it (the app's own node_modules, else the workspace root's). */
const depPkg = (dep: string) => {
  const at = [join(__dirname, "../node_modules", dep, "package.json"), join(__dirname, "../../node_modules", dep, "package.json")].find((p) => existsSync(p));
  if (!at) throw new Error(`${dep} is not installed`);
  return pkg(at);
};

describe("engines.node (final review M8)", () => {
  const app = pkg(join(__dirname, "../package.json")).engines!.node!;
  const root = pkg(join(__dirname, "../../package.json")).engines!.node!;
  it("the app and the root ask for the same floor", () => {
    expect(app).toBe(root);
  });
  it("is no lower than what the browser dependencies need (@nktkas/hyperliquid needs 22.12), and stays open upward", () => {
    for (const dep of ["@nktkas/hyperliquid", "@wallet-standard/app", "@solana/kit"]) {
      const need = depPkg(dep).engines?.node;
      if (need) expect(atLeast(floor(app), floor(need)), `${dep} needs ${need}`).toBe(true);
    }
    expect(app.startsWith(">=")).toBe(true);
  });
});
