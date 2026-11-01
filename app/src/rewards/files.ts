import type { Address, Hex } from "viem";

/**
 * latest.json and users/<xx>.json, as the poster writes them (ops/src/checkpoint-files.ts `LatestFile` and `UserFile`;
 * test/publish-contract.test.ts feeds real ones through `parseLatest` and `parseUserFile`). Amounts stay digit strings here,
 * exactly as published; the model turns them into bigints.
 * Storage is untrusted (docs/OPS.md §10): the signature, the root and every proof are checked before anything is used (model.ts, proof.ts).
 */
export interface LatestUser {
  entitlement: string;
  fees: string;
  mined: string;
  fromVault: string;
  refined: string;
  /** Points since the last pop, in fee units (1e-8 USDC). */
  points: string;
}
export interface UserFileEntry extends LatestUser {
  /** Empty for a wallet that is not in the tree (entitlement 0). */
  proof: Hex[];
}
/** users/<xx>.json, as the poster writes it (ops/src/checkpoint-files.ts `UserFile`). Untrusted like latest.json: model.ts checks its signature and every proof. */
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
  /** The wallets whose address starts with the file's byte, keyed by lowercase address. */
  users: Record<string, UserFileEntry>;
}
export interface LatestPop {
  minute: number;
  /** The minute's seed block, as a decimal string. */
  block: string;
  amount: string;
  kept: string;
  recipients: number;
}
/** checkpoints/<m>.json: the signed fields and that checkpoint's fee rows. It never changes once published. */
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
  table: string;
}
export interface LatestFile {
  v: 1;
  chainId: number;
  contract: Address;
  throughMinute: number;
  refBlock: string;
  root: Hex;
  totalEntitled: string;
  sig: Hex;
  publishedAt: number;
  /** The fee rows of the minutes this checkpoint added (csv). The app does not read it. */
  table: string;
  /** `odds`: 1 in odds each minute; `lastPopMinute` is -1 before the first pop. */
  vault: { amount: string; pointsTotal: string; odds: number; lastPopMinute: number };
  /** The newest pops first (at most 10). */
  pops: LatestPop[];
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
/** Digit strings only (no sign, no leading zero, at most 78 digits: 2^256 has 78), so a hostile file cannot make BigInt chew on a huge string. */
const uint = (x: unknown): string | null => (typeof x === "string" && /^(0|[1-9]\d{0,77})$/.test(x) ? x : null);
const nat = (x: unknown): number | null => (typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : null);
const hex = (x: unknown, bytes: number): Hex | null => (typeof x === "string" && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(x) ? (x as Hex) : null);

/** secp256k1n / 2: Checkpoints.sol refuses a signature with a larger s (HALF_N). */
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
/** What Checkpoints.sol accepts of a signature: 65 bytes, v of 27 or 28 (ecrecover takes no other), and s at most n/2. */
export function contractAcceptsSig(sig: string): boolean {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) return false;
  const v = parseInt(sig.slice(130), 16);
  return (v === 27 || v === 28) && BigInt(`0x${sig.slice(66, 130)}`) <= HALF_N;
}

/** The fields the poster signed, which latest.json and every user file carry (ops' `signedFrom`): null unless all are well formed and the contract would accept the signature. */
function signedFields(json: Record<string, unknown>): Pick<LatestFile, "v" | "chainId" | "contract" | "throughMinute" | "refBlock" | "root" | "totalEntitled" | "sig" | "publishedAt"> | null {
  if (json.v !== 1) return null;
  const chainId = nat(json.chainId);
  const contract = hex(json.contract, 20);
  const throughMinute = nat(json.throughMinute);
  const refBlock = uint(json.refBlock);
  const root = hex(json.root, 32);
  const totalEntitled = uint(json.totalEntitled);
  const sig = hex(json.sig, 65);
  if (sig && !contractAcceptsSig(sig)) return null; // the contract would refuse it: nothing to settle with
  const publishedAt = nat(json.publishedAt);
  if (chainId === null || !contract || throughMinute === null || refBlock === null || !root || totalEntitled === null || !sig || publishedAt === null) return null;
  return { v: 1, chainId, contract, throughMinute, refBlock, root, totalEntitled, sig, publishedAt };
}

/** The same checks as ops' parseLatestFile (every field typed, amounts digit strings, root and sig hex of the right length), returning null instead of throwing. */
export function parseLatest(json: unknown): LatestFile | null {
  if (!isObj(json) || typeof json.table !== "string" || !isObj(json.vault) || !Array.isArray(json.pops)) return null;
  const signed = signedFields(json);
  if (!signed) return null;

  const v = json.vault;
  const [vaultAmount, pointsTotal] = [uint(v.amount), uint(v.pointsTotal)];
  const odds = nat(v.odds);
  const lastPopMinute = typeof v.lastPopMinute === "number" && Number.isSafeInteger(v.lastPopMinute) && v.lastPopMinute >= -1 ? v.lastPopMinute : null;
  if (vaultAmount === null || pointsTotal === null || odds === null || odds < 1 || lastPopMinute === null) return null;

  const pops: LatestPop[] = [];
  for (const raw of json.pops as unknown[]) {
    if (!isObj(raw)) return null;
    const [minute, recipients] = [nat(raw.minute), nat(raw.recipients)];
    const [block, amount, kept] = [uint(raw.block), uint(raw.amount), uint(raw.kept)];
    if (minute === null || recipients === null || block === null || amount === null || kept === null) return null;
    pops.push({ minute, block, amount, kept, recipients });
  }
  return { ...signed, table: json.table, vault: { amount: vaultAmount, pointsTotal, odds, lastPopMinute }, pops };
}

/** The same strictness for an archive file. The signature covers the root, not the table: see rewards/explore.ts. */
export function parseCheckpointFile(json: unknown): CheckpointFile | null {
  if (!isObj(json) || typeof json.table !== "string") return null;
  const signed = signedFields(json);
  return signed && { ...signed, table: json.table };
}

/** The most hashes a proof can have: a tree of 2^64 leaves. Real ones have about 17 at 100,000 wallets. */
const MAX_PROOF = 64;

/**
 * The same strictness as parseLatest, returning null instead of throwing. A nonzero entitlement with an empty proof parses (ops'
 * parser refuses it as malformed): model.ts makes it a mismatch for that wallet alone, so one bad entry cannot hide the others.
 */
export function parseUserFile(json: unknown): UserFile | null {
  if (!isObj(json) || !isObj(json.users) || !isObj(json.vault)) return null;
  const signed = signedFields(json);
  if (!signed) return null;
  const [amount, pointsTotal] = [uint(json.vault.amount), uint(json.vault.pointsTotal)];
  if (amount === null || pointsTotal === null) return null;

  const users: Record<string, UserFileEntry> = {};
  for (const [u, raw] of Object.entries(json.users)) {
    if (!/^0x[0-9a-f]{40}$/.test(u) || !isObj(raw) || !Array.isArray(raw.proof) || raw.proof.length > MAX_PROOF) return null;
    const [entitlement, fees, mined, fromVault, refined, points] = [raw.entitlement, raw.fees, raw.mined, raw.fromVault, raw.refined, raw.points].map(uint);
    if (entitlement === null || fees === null || mined === null || fromVault === null || refined === null || points === null) return null;
    const proof: Hex[] = [];
    for (const p of raw.proof as unknown[]) {
      const h = hex(p, 32);
      if (!h) return null;
      proof.push(h);
    }
    users[u] = { entitlement, fees, mined, fromVault, refined, points, proof };
  }
  return { ...signed, vault: { amount, pointsTotal }, users };
}

/** latest.json is small: a store that has not answered in this long is not answering. */
export const FETCH_TIMEOUT_MS = 10_000;
/**
 * The timeout covers the body too. A user file is about 230 KB at 100,000 wallets, which a phone under about 200 kbit/s
 * cannot read in 10 s: it would see "no answer after 10 s" on every poll.
 */
export const USER_FILE_TIMEOUT_MS = 20_000;

const trimSlashes = (base: string) => base.replace(/\/+$/, "");
/** `base` is the rewards base (config rewardsBase, ending in "/"); one without the slash gets it. */
export const latestUrl = (base: string) => `${trimSlashes(base)}/latest.json`;
/** The file that holds this wallet: its address's first byte in lowercase hex (ops' `userFilePath`). */
const userFileName = (user: Address) => `users/${user.slice(2, 4).toLowerCase()}.json`;
export const userFileUrl = (base: string, user: Address) => `${trimSlashes(base)}/${userFileName(user)}`;
export const checkpointUrl = (base: string, minute: number) => `${trimSlashes(base)}/checkpoints/${minute}.json`;

interface Source<T> {
  url: string;
  /** For the error texts: "latest.json", "users/ab.json". */
  name: string;
  /** What a body that fails `parse` is not: "checkpoint file", "user file". */
  what: string;
  parse(json: unknown): T | null;
  /** The fetch cache mode (see loadLatest and loadUserFile). */
  cache: RequestCache;
  /** Gives up this long after the request began, the body included. */
  timeoutMs: number;
}

/**
 * Reads one reward file: null when there is none yet (404); any other failure throws, so the screen can say the files are
 * unreachable instead of showing an empty vault. A store that hangs must not hold the screen: give up after the source's `timeoutMs`.
 */
async function loadJson<T>(src: Source<T>, fetchFn: typeof fetch): Promise<T | null> {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, src.timeoutMs);
  try {
    const r = await fetchFn(src.url, { cache: src.cache, signal: ctl.signal });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`reward file ${src.name}: HTTP ${r.status}`);
    const file = src.parse(await r.json());
    if (!file) throw new Error(`reward file ${src.name}: not a valid ${src.what}`);
    return file;
  } catch (e) {
    if (timedOut) throw new Error(`reward file ${src.name}: no answer after ${src.timeoutMs / 1000} s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** latest.json changes every minute and is small: `no-store`, so a poll always sees the newest. */
export const loadLatest = (base: string, fetchFn: typeof fetch = fetch): Promise<LatestFile | null> =>
  loadJson({ url: latestUrl(base), name: "latest.json", what: "checkpoint file", parse: parseLatest, cache: "no-store", timeoutMs: FETCH_TIMEOUT_MS }, fetchFn);

/**
 * The wallet's file, users/<xx>.json: null on a 404 (nothing written for this part of the address space yet: zero for the
 * wallet). It changes only on a round (every checkpoint under 2,000 wallets, every 15th above 20,000) and is about 250 KB at
 * 100,000 wallets, so `no-cache`: the browser asks the store whether it changed, an unchanged file costs a 304 with no body
 * (`no-store` would download it on every poll), and a changed one is never served from the cache unchecked.
 */
export const loadUserFile = (base: string, user: Address, fetchFn: typeof fetch = fetch): Promise<UserFile | null> =>
  loadJson({ url: userFileUrl(base, user), name: userFileName(user), what: "user file", parse: parseUserFile, cache: "no-cache", timeoutMs: USER_FILE_TIMEOUT_MS }, fetchFn);

/** One published minute: null on a 404. Published files are never revised, so the browser's normal cache is fine. */
export const loadCheckpoint = (base: string, minute: number, fetchFn: typeof fetch = fetch): Promise<CheckpointFile | null> =>
  loadJson({ url: checkpointUrl(base, minute), name: `checkpoints/${minute}.json`, what: "checkpoint file", parse: parseCheckpointFile, cache: "default", timeoutMs: FETCH_TIMEOUT_MS }, fetchFn);
