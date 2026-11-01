import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { parseTableCsv, popOdds, tableCsv, type Addr, type CheckpointResult, type FeeRow, type RewardsTree } from "@hlo/calc";
import type { Address, Hex } from "viem";

export interface CheckpointFile {
  v: 1;
  chainId: number;
  contract: Address;
  throughMinute: number;
  refBlock: string;
  root: Hex;
  totalEntitled: string;
  sig: Hex;
  publishedAt: number;
  /** tableCsv of the minutes this checkpoint added (`minute,user,fee`). */
  table: string;
}

export interface UserEntry {
  entitlement: string;
  fees: string;
  mined: string;
  fromVault: string; // shares of vault pops
  refined: string;
  /** Points since the last pop, in fee units (1e-8 USDC). */
  points: string;
}

export interface UserFileEntry extends UserEntry {
  /** Empty for a wallet that is not in the tree (entitlement 0). */
  proof: Hex[];
}

/** Stands alone: it carries its checkpoint's signed fields, so the app checks it like latest.json. */
export interface UserFile {
  v: 1;
  chainId: number;
  contract: Address;
  throughMinute: number;
  refBlock: string;
  root: Hex;
  totalEntitled: string;
  sig: Hex;
  publishedAt: number;
  vault: { amount: string; pointsTotal: string };
  users: Record<string, UserFileEntry>;
}

export interface PopEntry {
  minute: number;
  /** The minute's seed block: the first block at or after the minute's end. */
  block: string;
  amount: string;
  /** What stayed in the vault (10% plus dust, or all of it when nobody had points). */
  kept: string;
  recipients: number;
}

/** One small file a minute: no wallet's numbers and no tree. Those are in `users/<xx>.json` (`UserFile`), which a wallet reads for its own proof. */
export interface LatestFile extends CheckpointFile {
  /** `odds`: each minute the vault pops with a 1-in-odds chance (popOdds(chainId)); `lastPopMinute` is -1 before the first pop. */
  vault: { amount: string; pointsTotal: string; odds: number; lastPopMinute: number };
  /** The newest pops first, at most MAX_POPS. */
  pops: PopEntry[];
}

export const LATEST_PATH = "latest.json";
export const checkpointPath = (m: number) => `checkpoints/${m}.json`;
export const MAX_POPS = 10;
/** One wallet's file: its address's first byte in lowercase hex. */
export const userFilePath = (user: string): string => `users/${user.slice(2, 4).toLowerCase()}.json`;
/**
 * Every multiple of ROUND is a round (user files written) at every wallet count, and while the poster is catching up too: each
 * `userFileEvery` below divides it. The keeper settles only such minutes, so a wallet's user file for the newest settled round
 * can always be read, even when the poster never returns (spec 2026-10-31 §8).
 */
export const ROUND = 15;
/** How often the user files are written: every proof changes with every checkpoint, so all files change together. Always a divisor of ROUND. */
export const userFileEvery = (wallets: number): number => (wallets < 2_000 ? 1 : wallets < 20_000 ? 5 : ROUND);
/** The minutes the keeper settles are the multiples of this: ROUND, and 1 on anvil, where the e2e's minutes are few. */
export const settleRound = (chainId: number): number => (chainId === 31337 ? 1 : ROUND);

// ---------------------------------------------------------------- parsing

const fail = (what: string): never => {
  throw new Error(`bad checkpoint file: ${what}`);
};
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const uint = (x: unknown, what: string): string => (typeof x === "string" && /^(0|[1-9]\d*)$/.test(x) ? x : fail(what));
const nat = (x: unknown, what: string): number => (typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : fail(what));
const int = (x: unknown, lowest: number, what: string): number => (typeof x === "number" && Number.isSafeInteger(x) && x >= lowest ? x : fail(what));
const hex = (x: unknown, bytes: number, what: string): Hex =>
  typeof x === "string" && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(x) ? (x as Hex) : fail(what);
const obj = (x: unknown, what: string): Record<string, unknown> => (isObj(x) ? x : fail(what));

function parseJson(text: string): Record<string, unknown> {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return fail("not JSON");
  }
  return obj(j, "not an object");
}

/** The signed fields every published file carries. */
function signedFrom(j: Record<string, unknown>) {
  if (j.v !== 1) fail("v must be 1");
  return {
    v: 1 as const,
    chainId: nat(j.chainId, "chainId"),
    contract: hex(j.contract, 20, "contract") as Address,
    throughMinute: nat(j.throughMinute, "throughMinute"),
    refBlock: uint(j.refBlock, "refBlock"),
    root: hex(j.root, 32, "root"),
    totalEntitled: uint(j.totalEntitled, "totalEntitled"),
    sig: hex(j.sig, 65, "sig"),
    publishedAt: nat(j.publishedAt, "publishedAt"),
  };
}

function checkpointFrom(j: Record<string, unknown>): CheckpointFile {
  const signed = signedFrom(j);
  if (typeof j.table !== "string") fail("table");
  try {
    parseTableCsv(j.table as string);
  } catch (e) {
    fail(`table: ${(e as Error).message}`);
  }
  return { ...signed, table: j.table as string };
}

function userFrom(u: string, raw: unknown): UserEntry {
  if (!/^0x[0-9a-f]{40}$/.test(u)) fail(`user ${u}`);
  const e = obj(raw, `user ${u}`);
  return {
    entitlement: uint(e.entitlement, `${u}.entitlement`),
    fees: uint(e.fees, `${u}.fees`),
    mined: uint(e.mined, `${u}.mined`),
    fromVault: uint(e.fromVault, `${u}.fromVault`),
    refined: uint(e.refined, `${u}.refined`),
    points: uint(e.points, `${u}.points`),
  };
}

function vaultFrom(raw: unknown) {
  const v = obj(raw, "vault");
  return { amount: uint(v.amount, "vault.amount"), pointsTotal: uint(v.pointsTotal, "vault.pointsTotal") };
}

/** Reads the checkpoint fields; works on an archive file and on latest.json (extra fields are dropped). */
export function parseCheckpointFile(text: string): CheckpointFile {
  return checkpointFrom(parseJson(text));
}

export function parseLatestFile(text: string): LatestFile {
  const j = parseJson(text);
  const base = checkpointFrom(j); // a `tree` or `users` an older poster wrote is not read
  const v = obj(j.vault, "vault");
  const vault = {
    ...vaultFrom(v),
    odds: int(v.odds, 1, "vault.odds"),
    lastPopMinute: int(v.lastPopMinute, -1, "vault.lastPopMinute"),
  };
  if (!Array.isArray(j.pops)) fail("pops");
  const pops = (j.pops as unknown[]).map((raw, i) => {
    const o = obj(raw, `pops[${i}]`);
    return {
      minute: nat(o.minute, `pops[${i}].minute`),
      block: uint(o.block, `pops[${i}].block`),
      amount: uint(o.amount, `pops[${i}].amount`),
      kept: uint(o.kept, `pops[${i}].kept`),
      recipients: nat(o.recipients, `pops[${i}].recipients`),
    };
  });
  return { ...base, vault, pops };
}

/**
 * Reads one `users/<xx>.json` as strictly as latest.json. A tree holds only entitlements above zero (and the sentinel), so
 * an entry with an entitlement has a proof of at least one hash and an entry without one has none: anything else is refused.
 */
export function parseUserFile(text: string): UserFile {
  const j = parseJson(text);
  const base = signedFrom(j);
  const vault = vaultFrom(j.vault);
  const users: Record<string, UserFileEntry> = {};
  for (const [u, raw] of Object.entries(obj(j.users, "users"))) {
    const entry = userFrom(u, raw);
    const p = (raw as Record<string, unknown>).proof;
    if (!Array.isArray(p)) fail(`${u}.proof`);
    const proof = (p as unknown[]).map((h, i) => hex(h, 32, `${u}.proof[${i}]`));
    // A nonzero entitlement with no proof is refused here as malformed. How the app reports it is the app's call, wallet by
    // wallet (spec §8: an unverified number is never shown), not by refusing the whole file.
    if ((entry.entitlement === "0") !== (proof.length === 0)) fail(`${u}.proof (${proof.length} hashes for entitlement ${entry.entitlement})`);
    users[u] = { ...entry, proof };
  }
  return { ...base, vault, users };
}

// ---------------------------------------------------------------- building

export interface BuildArgs {
  chainId: number;
  contract: Address;
  throughMinute: number;
  refBlock: bigint;
  sig: Hex;
  publishedAt: number;
  /** The fee rows of the minutes this checkpoint added. */
  rows: readonly FeeRow[];
  result: CheckpointResult;
  tree: RewardsTree;
  /** Newest first; the poster keeps these in its state. Only the first MAX_POPS are published; the first is `vault.lastPopMinute`. */
  pops: readonly { minute: number; block: bigint; amount: bigint; kept: bigint; recipients: number }[];
}

/** The fields the poster signed, as every published file carries them. */
function signedFields(a: BuildArgs) {
  return {
    v: 1 as const,
    chainId: a.chainId,
    contract: a.contract,
    throughMinute: a.throughMinute,
    refBlock: a.refBlock.toString(),
    root: a.tree.root,
    totalEntitled: a.result.totalEntitled.toString(),
    sig: a.sig,
    publishedAt: a.publishedAt,
  };
}

/** Every wallet a checkpoint knows: one with an entitlement, points or totals. A wallet stays in the totals for good, so a user file's bucket never empties and leaves an old file behind. */
export const knownWallets = (r: CheckpointResult): Set<Addr> => new Set([...r.entitlements.keys(), ...r.points.keys(), ...r.totals.keys()]);

function userEntries(r: CheckpointResult): Record<string, UserEntry> {
  const users: Record<string, UserEntry> = {};
  for (const u of [...knownWallets(r)].sort()) {
    const t = r.totals.get(u);
    users[u] = {
      entitlement: (r.entitlements.get(u) ?? 0n).toString(),
      fees: (t?.fees ?? 0n).toString(),
      mined: (t?.mined ?? 0n).toString(),
      fromVault: (t?.fromVault ?? 0n).toString(),
      refined: (t?.refined ?? 0n).toString(),
      points: (r.points.get(u) ?? 0n).toString(),
    };
  }
  return users;
}

export function buildFiles(a: BuildArgs): { archive: CheckpointFile; latest: LatestFile } {
  const r = a.result;
  const archive: CheckpointFile = { ...signedFields(a), table: tableCsv(a.rows) };
  const latest: LatestFile = {
    ...archive,
    vault: {
      amount: r.vault.toString(),
      pointsTotal: r.sharePoints.toString(), // what a wallet's share is out of: the points at the minimum
      odds: popOdds(a.chainId),
      lastPopMinute: a.pops[0]?.minute ?? -1,
    },
    pops: a.pops.slice(0, MAX_POPS).map((p) => ({
      minute: p.minute, block: p.block.toString(), amount: p.amount.toString(), kept: p.kept.toString(), recipients: p.recipients,
    })),
  };
  return { archive, latest };
}

/**
 * The wallets' files by path: each wallet in the one its address names, only files with a wallet in them. An entry's proof is
 * the tree's; a wallet with an entitlement the tree has no matching leaf for fails the build (an unverifiable number is never written).
 */
export function buildUserFiles(a: BuildArgs): Map<string, UserFile> {
  const signed = signedFields(a);
  const vault = { amount: a.result.vault.toString(), pointsTotal: a.result.sharePoints.toString() };
  const out = new Map<string, UserFile>();
  for (const [u, e] of Object.entries(userEntries(a.result))) {
    let proof: Hex[] = [];
    if (e.entitlement !== "0") {
      const leaf = a.tree.proofs.get(u as Addr);
      if (!leaf || leaf.entitlement !== BigInt(e.entitlement)) throw new Error(`user file: no proof for ${u} in the tree (entitlement ${e.entitlement})`);
      proof = leaf.proof;
    }
    const path = userFilePath(u);
    let f = out.get(path);
    if (!f) out.set(path, (f = { ...signed, vault, users: {} }));
    f.users[u] = { ...e, proof };
  }
  return out;
}

// ---------------------------------------------------------------- reading

/**
 * Reads a published file: an http(s) GET under `base` (null on 404), or a file under `{ dir }` (null when absent).
 * Any other failure throws, so a caller never mistakes an outage for a missing file.
 */
export async function readPublished(base: string | { dir: string }, path: string): Promise<string | null> {
  if (typeof base !== "string") {
    const root = resolve(base.dir);
    const file = resolve(root, path);
    if (!file.startsWith(root + sep)) throw new Error(`path ${path} escapes ${root}`);
    try {
      return readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  const url = `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.text();
}
