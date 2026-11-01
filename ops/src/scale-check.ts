import { createHash } from "node:crypto";
import { getHeapStatistics } from "node:v8";
import { gzipSync } from "node:zlib";
import { applyCheckpoint, buildTree, deserializeState, newCalcState, popMinimum, popOdds, serializeState, type Addr, type FeeRow, type Seed } from "@hlo/calc";
import type { Address, Hex } from "viem";
import { buildFiles, buildUserFiles, LATEST_PATH } from "./checkpoint-files.js";
import { toJson } from "./publish.js";

/**
 * `npm run scale-check -w ops -- 2000` (no number means 100,000): checkpoints at full size, for docs/OPS.md "Scale". Prints the time of each step, the
 * sizes and the memory. Not part of `npm test`. The first checkpoint has every wallet trading in minute 0 (the biggest table the
 * emission can see, and every wallet earns); the second is the steady state a poster runs in, a few wallets trading on top of the
 * full state with a refining share spread over all of them. The poster and the verifier both do `applyCheckpoint` + `buildTree`
 * every minute at that size.
 */
const WALLETS = Number(process.argv[2] ?? 100_000);
const TRADERS = 50;
const LAUNCH = 1_800_000_000;
const CHAIN = 999;
const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
const SIG = `0x${"11".repeat(65)}` as Hex;

/** Spread like real addresses (random first bytes), so the user files fill their 256 buckets the way they will. */
const addr = (i: number) => `0x${createHash("sha256").update(`wallet ${i}`).digest("hex").slice(0, 40)}` as Addr;
const timed = <T>(what: string, f: () => T): T => {
  const t = performance.now();
  const out = f();
  console.log(`${what}: ${((performance.now() - t) / 1000).toFixed(2)} s`);
  return out;
};
const mb = (n: number) => (n < 1e6 ? `${(n / 1e3).toFixed(1)} KB` : `${(n / 1e6).toFixed(2)} MB`);
const seed = (minute: number): Seed => ({ minute, block: BigInt(minute + 1), hash: `0x${"00".repeat(31)}${(minute + 1).toString(16).padStart(2, "0")}` as Hex });

if (!Number.isSafeInteger(WALLETS) || WALLETS < 1) throw new Error("usage: npm run scale-check -w ops -- 2000 (no number means 100,000)");
console.log(`${WALLETS} wallets (heap limit ${mb(getHeapStatistics().heap_size_limit)})`);

const state = newCalcState(LAUNCH, popOdds(CHAIN));
// Minute 0: every wallet trades.
const rows: FeeRow[] = Array.from({ length: WALLETS }, (_, i) => ({ minute: 0, user: addr(i + 1), fee: 100_000_000n + BigInt(i) }));
const result = timed("applyCheckpoint (minute 0, every wallet trades)", () => applyCheckpoint(state, { minimum: popMinimum(CHAIN), throughMinute: 0, refBlock: 2n, rows, seeds: [seed(0)], burned: 0n, refined: 0n, claimed: new Map() }));
const tree = timed("buildTree", () => buildTree(result.entitlements));
timed("all proofs", () => tree.proofs);
const args = { chainId: CHAIN, contract: CONTRACT, throughMinute: 0, refBlock: 2n, sig: SIG, publishedAt: LAUNCH + 70, rows: [], result, tree, pops: [] };
const { latest } = buildFiles(args);
console.log(`${LATEST_PATH}: ${mb(toJson(latest).length)} (table empty here; it holds one minute's rows)`);
const files = timed("buildUserFiles", () => buildUserFiles(args));
const bodies = timed("user files to JSON", () => [...files.values()].map(toJson));
const gz = timed("gzip all", () => bodies.map((b) => gzipSync(b).length));
console.log(`user files: ${files.size}; largest ${mb(Math.max(...bodies.map((b) => b.length)))} raw, ${mb(Math.max(...gz))} gzipped; total gzipped ${mb(gz.reduce((a, b) => a + b, 0))}`);

// Minute 1: the steady state. A few wallets trade; a refining share (from claims) is spread over every wallet with an unclaimed balance.
const second: FeeRow[] = Array.from({ length: Math.min(TRADERS, WALLETS) }, (_, i) => ({ minute: 1, user: addr(i + 1), fee: 50_000_000n }));
const claimed = new Map<Addr, bigint>(Array.from({ length: Math.min(TRADERS, WALLETS) }, (_, i) => [addr(i + 1), 1n] as const));
const copy = timed("state copy (serialize + deserialize, as the poster does each minute)", () => deserializeState(serializeState(state)));
const result2 = timed(`applyCheckpoint (minute 1, ${second.length} wallets trade, refining over all)`, () => applyCheckpoint(copy, { minimum: popMinimum(CHAIN), throughMinute: 1, refBlock: 3n, rows: second, seeds: [seed(1)], burned: 0n, refined: 10n ** 18n, claimed }));
const tree2 = timed("buildTree", () => buildTree(result2.entitlements));
console.log(`root ${tree2.root.slice(0, 10)}…, ${tree2.leaves} leaves`);

const saved = timed("serializeState", () => serializeState(copy));
console.log(`calc state: ${mb(saved.length)}`);
const m = process.memoryUsage();
console.log(`heap: ${mb(m.heapUsed)} now; rss: ${mb(m.rss)} now, ${mb(process.resourceUsage().maxRSS * 1024)} at its peak`);
