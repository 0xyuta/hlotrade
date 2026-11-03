import { fileURLToPath } from "node:url";
import type { Addr } from "@hlo/calc";
import type { Hex } from "viem";
import type { R2Creds } from "./r2.js";

export type ChainId = 999 | 998 | 31337;

export interface Config {
  chainId: ChainId;
  rpcUrls: string[];
  deploymentsFile: string;
  stateDir: string;
  builder: Addr;
  /** The daily builder-file check (chain 999): where Hyperliquid's file is fetched from. */
  fills: { kind: "url"; template: string };
  hlApi: string;
  logChunk: bigint;
  fileDelayHours: number;
  pollSeconds: number;
  publish: { kind: "local"; dir: string } | { kind: "r2"; creds: R2Creds; prefix: string };
  /** True when PUBLISH was set in the env (so `publish` is not just the default local dir). */
  publishExplicit: boolean;
  /** http(s) base of the published rewards files (same meaning as the app config's rewardsBase). */
  rewardsUrl?: string;
  /** Wallet registry as a directory of JSON files; required on anvil, refused on mainnet. */
  registryDir?: string;
  /** A minute is settled on chain this many minutes after it ends. */
  settleAfterMinutes: number;
  /** The keeper sends buy() only when it would spend at least this much USDC (1e6); 0 buys any slice. */
  minBuy: bigint;
  /** Seconds past a minute's end before the poster lists the registry for it. */
  checkpointGraceSeconds: number;
  /** Follow Hyperliquid's public trades feed to read only the wallets that traded (spec 2026-10-31 §4). On by default except on anvil; never off on mainnet. */
  tradeFeed: boolean;
  /** Fill reads a minute per process, below the IP's 1,200 weight (a read weighs 20 and more with many fills). */
  hlFillsPerMinute: number;
  /** The verifier's hourly omission check reads every registered wallet only up to this many. */
  omissionFullMax: number;
  posterKey?: Hex;
  guardianKey?: Hex;
  /** The verifier's pause-only key (Checkpoints.pause()), on every chain. */
  pauserKey?: Hex;
  builderKey?: Hex;
  keeperKey?: Hex;
  /** Cloudflare R2 (all four R2_* vars): publishing with PUBLISH=r2, and the wallet registry when REGISTRY_DIR is unset. */
  r2?: R2Creds;
  forward: { reserve: bigint; minMove: bigint; minClaim: bigint; minHype: bigint };
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const KEY = /^0x[0-9a-fA-F]{64}$/;
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function atLeast(v: bigint, min: bigint, msg: string): bigint {
  if (v < min) throw new Error(msg);
  return v;
}

function decimal(s: string, decimals: number, name: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m || (m[2] ?? "").length > decimals) throw new Error(`${name} must be a decimal number`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0"));
}

function hours(env: Record<string, string | undefined>, k: string, d: string, positive = false): number {
  const raw = env[k]?.trim() || d;
  const n = /^(\d+(\.\d+)?)$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(n) || (positive ? n <= 0 : n < 0)) {
    throw new Error(`${k} must be a finite number ${positive ? "> 0" : ">= 0"}`);
  }
  return n;
}

/** Each deployment publishes under its own prefix (default `<chainId>/`), so two posters sharing a store never overwrite each other. */
export function publishPrefix(raw: string, chainId: ChainId): string {
  if (!raw) return `${chainId}/`;
  return raw.endsWith("/") ? raw : `${raw}/`;
}

/**
 * The env a command loads its config from. The keeper never publishes, so it ignores PUBLISH=r2:
 * a shared env without the R2_* vars must not stop it from starting.
 */
export function envFor(cmd: string | undefined, env: Record<string, string | undefined>): Record<string, string | undefined> {
  return cmd === "keeper" && env.PUBLISH?.trim() === "r2" ? { ...env, PUBLISH: undefined } : env;
}

/** The WebSocket URL for an API base: https → wss, http → ws, plus /ws. */
export const wsUrlFor = (hlApi: string): string => `${hlApi.replace(/\/+$/, "").replace(/^http/, "ws")}/ws`;

/** Mainnet's trades arrive at about 136 a second: a live feed socket with no readable trade for this long has lost its subscriptions. */
export const FEED_MAX_SILENCE_MS = 30_000;

/** The trade feed's silence rule (`TradeFeedDeps.maxSilenceMs`): on for 999 only. Testnet has quiet minutes, so there it is off (null). */
export const feedMaxSilenceMs = (chainId: number): number | null => (chainId === 999 ? FEED_MAX_SILENCE_MS : null);

/** Where a keeper or verifier reads the published rewards files: REWARDS_URL, else an explicit PUBLISH=local:<dir>. */
export function rewardsSource(cfg: Config): { kind: "url"; base: string } | { kind: "dir"; dir: string } {
  if (cfg.rewardsUrl) return { kind: "url", base: cfg.rewardsUrl };
  if (cfg.publishExplicit && cfg.publish.kind === "local") return { kind: "dir", dir: cfg.publish.dir };
  throw new Error("REWARDS_URL is required (or PUBLISH=local:<dir>)");
}

/** Where the poster or verifier lists registered wallets: REGISTRY_DIR, else R2 (the R2_* vars). */
export function registrySource(cfg: Config, cmd: "poster" | "verifier"): { kind: "dir"; dir: string } | { kind: "r2"; creds: R2Creds; chainId: ChainId } {
  if (cfg.registryDir) return { kind: "dir", dir: cfg.registryDir };
  if (cfg.r2) return { kind: "r2", creds: cfg.r2, chainId: cfg.chainId };
  throw new Error(`R2_* is required (or REGISTRY_DIR) for the ${cmd}`);
}

const R2_VARS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"] as const;
const R2_NEEDS = "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET";

/** The R2 credentials when all four vars are set, undefined when none is; a partial set is an error naming only the missing vars. */
function r2Creds(env: Record<string, string | undefined>): R2Creds | undefined {
  const v = R2_VARS.map((k) => env[k]?.trim() || "");
  if (v.every((x) => !x)) return undefined;
  const missing = R2_VARS.filter((_k, i) => !v[i]);
  if (missing.length) throw new Error(`R2 needs ${R2_NEEDS} (missing: ${missing.join(", ")})`);
  return { accountId: v[0], accessKeyId: v[1], secretAccessKey: v[2], bucket: v[3] };
}

function integer(env: Record<string, string | undefined>, k: string, d: string, min: number): number {
  const raw = env[k]?.trim() || d;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`${k} must be an integer >= ${min}`);
  return n;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const get = (k: string, d?: string) => {
    const v = env[k]?.trim();
    if (v) return v;
    if (d !== undefined) return d;
    throw new Error(`${k} is required`);
  };
  const id = Number(get("CHAIN_ID"));
  if (id !== 999 && id !== 998 && id !== 31337) throw new Error(`CHAIN_ID ${id} not supported (999, 998, 31337)`);
  const chainId = id as ChainId;
  const builder = get("BUILDER");
  if (!ADDR.test(builder)) throw new Error("BUILDER must be an address");
  const key = (k: string): Hex | undefined => {
    const v = env[k]?.trim();
    if (!v) return undefined;
    // never echo the value; a key outside the curve's range would make viem throw an error that prints it
    if (!KEY.test(v) || BigInt(v) === 0n || BigInt(v) >= SECP256K1_N) throw new Error(`${k} must be a 32-byte hex private key`);
    return v as Hex;
  };
  const net = chainId === 999 ? "Mainnet" : "Testnet";
  const registryDir = env.REGISTRY_DIR?.trim() || undefined;
  if (chainId === 31337 && !registryDir) throw new Error("REGISTRY_DIR is required on anvil");
  if (chainId === 999 && registryDir) throw new Error("REGISTRY_DIR is not allowed on mainnet (999)");
  const rawFeed = env.TRADE_FEED?.trim();
  if (rawFeed && rawFeed !== "on" && rawFeed !== "off") throw new Error("TRADE_FEED must be on or off");
  if (rawFeed === "off" && chainId === 999) throw new Error("TRADE_FEED=off is not allowed on mainnet (999)");
  const tradeFeed = rawFeed ? rawFeed === "on" : chainId !== 31337;
  const rewardsUrl = env.REWARDS_URL?.trim() || undefined;
  if (rewardsUrl && !/^https?:\/\/\S+$/.test(rewardsUrl)) throw new Error("REWARDS_URL must be an http(s) URL");
  const stateDir = get("STATE_DIR", fileURLToPath(new URL(`../state/${chainId}`, import.meta.url)));
  const logChunk = get("LOG_CHUNK", "1000");
  if (!/^\d+$/.test(logChunk) || BigInt(logChunk) <= 0n) throw new Error("LOG_CHUNK must be an integer > 0");
  const fileDelayHours = hours(env, "FILE_DELAY_HOURS", "2");
  const pollSeconds = hours(env, "POLL_SECONDS", "60", true);
  const publish = get("PUBLISH", `local:${stateDir}/public`);
  const r2 = r2Creds(env);
  if (env.BLOB_PREFIX?.trim()) throw new Error("BLOB_PREFIX was renamed PUBLISH_PREFIX");
  let published: Config["publish"];
  if (publish === "blob") throw new Error("PUBLISH=blob was removed: use PUBLISH=r2 (Cloudflare R2) or local:<dir>");
  if (publish === "r2") {
    if (!r2) throw new Error(`PUBLISH=r2 needs ${R2_NEEDS}`);
    published = { kind: "r2", creds: r2, prefix: publishPrefix(get("PUBLISH_PREFIX", ""), chainId) };
  } else if (publish.startsWith("local:")) published = { kind: "local", dir: publish.slice("local:".length) };
  else throw new Error('PUBLISH must be "r2" or "local:<dir>"');
  return {
    chainId,
    rpcUrls: get("RPC_URL").split(",").map((u) => u.trim()).filter(Boolean),
    deploymentsFile: get("DEPLOYMENTS", fileURLToPath(new URL(`../../contracts/deployments/${chainId}.json`, import.meta.url))),
    stateDir,
    builder: builder.toLowerCase() as Addr,
    fills: {
      kind: "url",
      template: get("FILLS_URL", `https://stats-data.hyperliquid.xyz/${net}/builder_fills/{builder}/{yyyymmdd}.csv.lz4`),
    },
    hlApi: get("HL_API", chainId === 999 ? "https://api.hyperliquid.xyz" : "https://api.hyperliquid-testnet.xyz"),
    logChunk: BigInt(logChunk),
    fileDelayHours,
    pollSeconds,
    publish: published,
    publishExplicit: !!env.PUBLISH?.trim(),
    rewardsUrl,
    registryDir,
    settleAfterMinutes: integer(env, "SETTLE_AFTER_MINUTES", "60", 1),
    minBuy: decimal(get("MIN_BUY_USD", "0"), 6, "MIN_BUY_USD"),
    checkpointGraceSeconds: integer(env, "CHECKPOINT_GRACE_SECONDS", "10", 0),
    tradeFeed,
    hlFillsPerMinute: integer(env, "HL_FILLS_PER_MINUTE", "50", 1),
    omissionFullMax: integer(env, "OMISSION_FULL_MAX", "2000", 0),
    r2,
    posterKey: key("POSTER_KEY"),
    guardianKey: key("GUARDIAN_KEY"),
    pauserKey: key("PAUSER_KEY"),
    builderKey: key("BUILDER_KEY"),
    keeperKey: key("KEEPER_KEY"),
    forward: {
      reserve: decimal(get("RESERVE_USD", "110"), 6, "RESERVE_USD"),
      minMove: decimal(get("MIN_MOVE_USD", "10"), 6, "MIN_MOVE_USD"),
      minClaim: atLeast(decimal(get("MIN_CLAIM_USD", "1"), 6, "MIN_CLAIM_USD"), 1_000_000n, "MIN_CLAIM_USD must be at least 1 (Hyperliquid refuses claimRewards below 1 USDC)"),
      minHype: decimal(get("MIN_HYPE", "0.05"), 18, "MIN_HYPE"),
    },
  };
}
