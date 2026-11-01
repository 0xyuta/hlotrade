/**
 * Deployment config validation, shared by the browser (load.ts) and the build (vite.config.ts).
 * No imports and no browser or Node APIs, so both can bundle it.
 *   empty   — `{}`: the build succeeds and renders "not deployed yet";
 *   invalid — a filled file that is wrong: the build FAILS;
 *   ok      — a config the app can use.
 */
export type Network = "mainnet" | "testnet";
export type Flavour = "mainnet" | "testnet" | "dev";
export type Address = `0x${string}`;

export interface Contracts {
  token: Address;
  checkpoints: Address;
  mining: Address;
  staking: Address;
  buyback: Address;
  splitter: Address;
  profiles: Address;
  pair: Address;
}

export interface AppConfig {
  network: Network;
  hyperEvmChainId: 999 | 998;
  hyperEvmRpc: string;
  arbitrumRpc: string;
  ethereumRpc: string;
  /**
   * Withdrawals (the Withdraw button's routes) are offered only when true. The mainnet config must say false until the
   * W1 withdraw test has passed on testnet (docs/APP.md section 6). Deposits are unaffected.
   */
  withdrawEnabled: boolean;
  /**
   * The Solana route (Plan 4 C) is offered only when true; its withdrawals also need withdrawEnabled. testnet.json and
   * mainnet.json say false until SOL1–SOL3 (docs/APP.md section 6) pass; mainnet also needs HLO_ALLOW_MAINNET_SOLANA=1.
   */
  solanaEnabled: boolean;
  /** The Solana JSON-RPC (https); required when solanaEnabled. Its origin goes into the CSP connect-src. */
  solanaRpc: string | null;
  /** The https base of the poster's published files, ending in "/" (e.g. https://files.hlotrade.xyz/999/); required with a deployment. Its origin goes into the CSP connect-src. */
  rewardsBase: string | null;
  /** Lowercase builder address; null keeps trading read-only. */
  builder: Address | null;
  /** From contracts/deployments/<chainId>.json; null = rewards "not deployed yet". */
  contracts: Contracts | null;
  deployBlock: number | null;
  /**
   * Hyperliquid referral code that Enable trading sets for an account with no referrer (spec 2026-10-30 referrals §2–3);
   * null = none. A `?ref=CODE` link the user arrived with wins over it (hl/referral.ts).
   */
  referralCode: string | null;
}

export type ConfigValidation = { kind: "ok"; config: AppConfig } | { kind: "empty" } | { kind: "invalid"; reason: string };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/;
/** A Hyperliquid referral code as HLO accepts it: 1–20 letters and digits (Hyperliquid allows 1–20 characters). */
export const REFERRAL_CODE = /^[A-Za-z0-9]{1,20}$/;
const CONTRACT_KEYS = ["token", "checkpoints", "mining", "staking", "buyback", "splitter", "profiles", "pair"] as const;
const KEYS = new Set(["network", "hyperEvmRpc", "arbitrumRpc", "ethereumRpc", "withdrawEnabled", "solanaEnabled", "solanaRpc", "rewardsBase", "builder", "deployment", "referralCode"]);

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isAddr = (x: unknown): x is Address => typeof x === "string" && ADDRESS.test(x) && !ZERO.test(x);

const HOST = /^[a-z0-9.-]+(:\d+)?$/i;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1)(:\d+)?$/i;

/**
 * An origin-safe URL: https, or (dev only) http on localhost / 127.0.0.1. The host must be plain
 * letters, digits, dots and hyphens with an optional port, so no `*`, `;`, quote, space, userinfo,
 * query or fragment can reach the CSP built from it.
 */
function safeUrl(x: unknown, allowLocalHttp: boolean): URL | null {
  if (typeof x !== "string" || /[\s"'`<>\\]/.test(x)) return null;
  let u: URL;
  try {
    u = new URL(x);
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash) return null;
  if (!HOST.test(u.host)) return null;
  if (u.protocol === "https:") return u;
  if (allowLocalHttp && u.protocol === "http:" && LOCAL_HOST.test(u.host)) return u;
  return null;
}

function url(x: unknown, allowLocalHttp: boolean): string | null {
  return safeUrl(x, allowLocalHttp) ? (x as string) : null;
}

export function validateConfig(raw: unknown, flavour: Flavour): ConfigValidation {
  if (raw === undefined || raw === null) return { kind: "empty" };
  if (!isObj(raw)) return { kind: "invalid", reason: "config is not a JSON object" };
  if (Object.keys(raw).length === 0) return { kind: "empty" };
  const bad = (reason: string): ConfigValidation => ({ kind: "invalid", reason });
  for (const k of Object.keys(raw)) if (!KEYS.has(k)) return bad(`unknown key "${k}"`);

  const network = raw.network;
  if (network !== "mainnet" && network !== "testnet") return bad('network must be "mainnet" or "testnet"');
  if (flavour !== "dev" && network !== flavour) return bad(`a ${flavour} build needs network "${flavour}", got "${network}"`);
  const allowLocalHttp = flavour === "dev";
  const hyperEvmRpc = url(raw.hyperEvmRpc, allowLocalHttp);
  const arbitrumRpc = url(raw.arbitrumRpc, allowLocalHttp);
  const ethereumRpc = url(raw.ethereumRpc, allowLocalHttp);
  if (!hyperEvmRpc) return bad("hyperEvmRpc must be an https URL (plain host, no wildcard, userinfo, query or fragment)");
  if (!arbitrumRpc) return bad("arbitrumRpc must be an https URL (plain host, no wildcard, userinfo, query or fragment)");
  if (!ethereumRpc) return bad("ethereumRpc must be an https URL (plain host, no wildcard, userinfo, query or fragment)");

  if (typeof raw.withdrawEnabled !== "boolean") return bad("withdrawEnabled must be true or false (mainnet: false until the testnet withdraw test passes)");
  const withdrawEnabled = raw.withdrawEnabled;

  if (typeof raw.solanaEnabled !== "boolean") return bad("solanaEnabled must be true or false (false until the Solana checks SOL1–SOL3 pass on testnet)");
  const solanaEnabled = raw.solanaEnabled;
  let solanaRpc: string | null = null;
  if (raw.solanaRpc !== undefined && raw.solanaRpc !== null) {
    solanaRpc = url(raw.solanaRpc, allowLocalHttp);
    if (!solanaRpc) return bad("solanaRpc must be an https URL (plain host, no wildcard, userinfo, query or fragment)");
  }
  if (solanaEnabled && !solanaRpc) return bad("solanaRpc is required when solanaEnabled is true");

  let builder: Address | null = null;
  if (raw.builder !== undefined && raw.builder !== null) {
    if (!isAddr(raw.builder)) return bad("builder must be a non-zero address");
    builder = raw.builder.toLowerCase() as Address;
  }

  const hyperEvmChainId = network === "mainnet" ? 999 : 998;
  let contracts: Contracts | null = null;
  let deployBlock: number | null = null;
  if (raw.deployment !== undefined && raw.deployment !== null) {
    const d = raw.deployment;
    if (!isObj(d)) return bad("deployment must be the object in contracts/deployments/<chainId>.json");
    if (d.chainId !== hyperEvmChainId) return bad(`deployment.chainId must be ${hyperEvmChainId} for ${network}`);
    if ("feed" in d) return bad("deployment.feed is the old FeeFeed; the deployment must have checkpoints (contracts/deployments/<chainId>.json from the minute-settlement deploy)");
    const out: Partial<Contracts> = {};
    for (const k of CONTRACT_KEYS) {
      if (!isAddr(d[k])) return bad(`deployment.${k} must be a non-zero address`);
      out[k] = d[k] as Address;
    }
    if (typeof d.deployBlock !== "number" || !Number.isInteger(d.deployBlock) || d.deployBlock < 0) {
      return bad("deployment.deployBlock must be an integer ≥ 0");
    }
    contracts = out as Contracts;
    deployBlock = d.deployBlock;
  }

  let rewardsBase: string | null = null;
  if (raw.rewardsBase !== undefined && raw.rewardsBase !== null) {
    if (typeof raw.rewardsBase !== "string" || !raw.rewardsBase.endsWith("/") || !safeUrl(raw.rewardsBase, allowLocalHttp)) {
      return bad("rewardsBase must be an https URL ending in / (plain host, no userinfo, query or fragment)");
    }
    rewardsBase = raw.rewardsBase;
  }
  if (contracts && !rewardsBase) return bad("rewardsBase is required when the config has a deployment");

  let referralCode: string | null = null;
  if (raw.referralCode !== undefined && raw.referralCode !== null) {
    if (typeof raw.referralCode !== "string" || !REFERRAL_CODE.test(raw.referralCode)) return bad("referralCode must be 1–20 letters and digits (A–Z, a–z, 0–9)");
    referralCode = raw.referralCode;
  }

  return { kind: "ok", config: { network, hyperEvmChainId, hyperEvmRpc, arbitrumRpc, ethereumRpc, withdrawEnabled, solanaEnabled, solanaRpc, rewardsBase, builder, contracts, deployBlock, referralCode } };
}

/** The env var that lets a mainnet build ship with withdrawals on. Set it (to "1") only after W1 passed (docs/APP.md §6). */
export const ALLOW_MAINNET_WITHDRAW_ENV = "HLO_ALLOW_MAINNET_WITHDRAW";

/**
 * Build-time go/no-go (final review M3): a mainnet build with `withdrawEnabled: true` is refused unless
 * HLO_ALLOW_MAINNET_WITHDRAW=1 is set, so turning withdrawals on for mainnet is a deliberate act, not one JSON edit.
 * Returns the reason to refuse, or null. Testnet and dev builds are never refused here.
 */
export function mainnetWithdrawProblem(config: AppConfig | null, flavour: Flavour, allow: string | undefined): string | null {
  if (flavour !== "mainnet" || !config?.withdrawEnabled) return null;
  if (allow === "1") return null;
  return `mainnet.json has "withdrawEnabled": true. Withdrawals stay off on mainnet until W1 (docs/APP.md section 6) has passed on testnet; then build with ${ALLOW_MAINNET_WITHDRAW_ENV}=1.`;
}

/** The env var that lets a mainnet build ship with the Solana route on. Set it (to "1") only after SOL1–SOL6 passed. */
export const ALLOW_MAINNET_SOLANA_ENV = "HLO_ALLOW_MAINNET_SOLANA";

/**
 * Build-time go/no-go for Solana (Plan 4 C): a mainnet build with `solanaEnabled: true` is refused unless
 * HLO_ALLOW_MAINNET_SOLANA=1 is set. Returns the reason to refuse, or null. Testnet and dev builds are never refused here.
 */
export function mainnetSolanaProblem(config: AppConfig | null, flavour: Flavour, allow: string | undefined): string | null {
  if (flavour !== "mainnet" || !config?.solanaEnabled) return null;
  if (allow === "1") return null;
  return `mainnet.json has "solanaEnabled": true. The Solana route stays off on mainnet until SOL1–SOL6 (docs/APP.md section 6) have passed; then build with ${ALLOW_MAINNET_SOLANA_ENV}=1.`;
}
