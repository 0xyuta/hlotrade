#!/usr/bin/env node
/**
 * HLO sample bot: buys a fixed amount of one market on a schedule, with the HLO builder fee on every order, and stops once
 * the position reaches MAX_USD. It never sells. A starting point for your own strategy, not advice: trading can lose money.
 * Never trade between your own wallets or send orders only to create volume: Hyperliquid's Terms ban it (§3.1.4).
 *
 *   npm i @nktkas/hyperliquid@0.33.3 viem@2.57.12        (Node 22.12 or newer)
 *
 * Env: ACCOUNT (your wallet), API_WALLET_KEY (only with LIVE=1; an API wallet from Hyperliquid's API page, never your main
 * wallet's key), HLO_NETWORK (testnet, the default, or mainnet), COIN (BTC), USD_EACH (12), EVERY_MINUTES (60), MAX_USD (100).
 * Without LIVE=1 it sends nothing. --once runs one pass and exits.
 */
import { pathToFileURL } from "node:url";

/** The builder per network; null until HLO is live there. */
export const BUILDERS = { testnet: "0xe6aa440e01bfeffb8914fd9861c6daf57cc4ee14", mainnet: null };
export const SITES = { testnet: "https://testnet.hlotrade.xyz", mainnet: "https://hlotrade.xyz" };
/** Tenths of a basis point: 100 is the 0.1% that counts. */
export const BUILDER_F = 100;
/** Hyperliquid refuses an order under $10. */
export const MIN_ORDER_USD = 10;
/** A buy is sent as immediate-or-cancel at this much over the mid, so it fills now or not at all. */
export const SLIPPAGE = 0.01;
const PERP_MAX_DECIMALS = 6;

const number = (env, name, fallback) => {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a number above 0`);
  return n;
};

/** Reads the settings. A bad key is refused without repeating it. */
export function parseConfig(env) {
  const network = env.HLO_NETWORK || "testnet";
  if (!Object.hasOwn(BUILDERS, network)) throw new Error("HLO_NETWORK must be testnet or mainnet");
  const builder = BUILDERS[network];
  if (!builder) throw new Error(`HLO is not live on ${network} yet`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(env.ACCOUNT ?? "")) throw new Error("ACCOUNT must be your wallet's address");
  const live = env.LIVE === "1";
  if (live && !/^0x[0-9a-fA-F]{64}$/.test(env.API_WALLET_KEY ?? "")) throw new Error("LIVE=1 needs API_WALLET_KEY, your API wallet's key (0x and 64 hex characters)");
  const usdEach = number(env, "USD_EACH", 12);
  if (usdEach < MIN_ORDER_USD) throw new Error(`USD_EACH must be at least ${MIN_ORDER_USD}: Hyperliquid refuses smaller orders`);
  const everyMinutes = number(env, "EVERY_MINUTES", 60);
  if (everyMinutes < 1) throw new Error("EVERY_MINUTES must be at least 1");
  return {
    network, builder, site: SITES[network], user: env.ACCOUNT.toLowerCase(), live, coin: env.COIN || "BTC", usdEach, everyMinutes,
    maxUsd: number(env, "MAX_USD", 100),
  };
}

const plain = (v, decimals) => {
  const s = v.toFixed(decimals);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
};

/** Hyperliquid's price rule for perps: at most 6 − szDecimals decimals and 5 significant figures. Rounded up, for a buy. */
export function roundPriceUp(px, szDecimals) {
  const intDigits = Math.floor(Math.log10(px)) + 1;
  const decimals = Math.max(0, Math.min(Math.max(PERP_MAX_DECIMALS - szDecimals, 0), 5 - intDigits));
  const f = 10 ** decimals;
  return plain(Math.ceil(Number((px * f).toFixed(6))) / f, decimals);
}

export function roundSizeDown(sz, szDecimals) {
  const f = 10 ** szDecimals;
  return plain(Math.floor(Number((sz * f).toFixed(6))) / f, szDecimals);
}

/** Whether to buy, and how much, given what the position is worth. Never past `maxUsd`. */
export function nextBuyUsd({ positionUsd, usdEach, maxUsd }) {
  const room = maxUsd - positionUsd;
  if (room < MIN_ORDER_USD) return 0;
  return Math.min(usdEach, room);
}

/** One immediate-or-cancel buy with the builder on it; null when the size rounds below Hyperliquid's minimum. */
export function planBuy({ assetIndex, szDecimals, mid, usd, builder }) {
  const s = roundSizeDown(usd / mid, szDecimals);
  if (Number(s) * mid < MIN_ORDER_USD) return null;
  return {
    orders: [{ a: assetIndex, b: true, p: roundPriceUp(mid * (1 + SLIPPAGE), szDecimals), s, r: false, t: { limit: { tif: "Ioc" } } }],
    grouping: "na",
    builder: { b: builder.toLowerCase(), f: BUILDER_F },
  };
}

/** Registers the wallet (a repeat changes nothing). A trade from an unregistered wallet does not mine, so a failure stops the bot. */
export async function register(cfg, fetchFn = fetch) {
  const r = await fetchFn(`${cfg.site}/api/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: cfg.user }) });
  if (r.status === 451) throw new Error("HLO is not available in your region.");
  if (!r.ok) throw new Error(`could not register the wallet (HTTP ${r.status}). Press Enable trading at ${cfg.site}`);
}

/** One pass. `exchange` is used only with LIVE=1. An order is sent once: an unclear answer waits for the next pass, whose position read tells. */
export async function runOnce({ cfg, info, exchange, log, fetchFn }) {
  const fee = await info.maxBuilderFee({ user: cfg.user, builder: cfg.builder });
  if (fee < BUILDER_F) throw new Error(`the HLO builder fee is not approved for this wallet. Press Enable trading at ${cfg.site}`);
  if (cfg.live) await register(cfg, fetchFn);

  const [meta, ctxs] = await info.metaAndAssetCtxs();
  const assetIndex = meta.universe.findIndex((u) => u.name === cfg.coin && !u.isDelisted);
  if (assetIndex < 0) throw new Error(`${cfg.coin} is not a market on ${cfg.network}`);
  const mid = Number(ctxs[assetIndex].midPx ?? ctxs[assetIndex].markPx);
  if (!(mid > 0)) throw new Error(`no price for ${cfg.coin} right now`);

  const state = await info.clearinghouseState({ user: cfg.user });
  const held = state.assetPositions.find((p) => p.position.coin === cfg.coin)?.position;
  const positionUsd = held && Number(held.szi) > 0 ? Number(held.positionValue) : 0;

  const usd = nextBuyUsd({ positionUsd, usdEach: cfg.usdEach, maxUsd: cfg.maxUsd });
  if (usd === 0) return log(`${cfg.coin} position is $${positionUsd.toFixed(2)}, at your limit of $${cfg.maxUsd}: not buying`);
  const plan = planBuy({ assetIndex, szDecimals: meta.universe[assetIndex].szDecimals, mid, usd, builder: cfg.builder });
  if (!plan) return log(`$${usd} of ${cfg.coin} rounds below Hyperliquid's $${MIN_ORDER_USD} minimum: not buying`);
  const { s, p } = plan.orders[0];
  if (!cfg.live) return log(`practice: would buy ${s} ${cfg.coin} (about $${usd.toFixed(2)}) up to ${p}. Set LIVE=1 to send`);
  const res = await exchange.order(plan);
  log(`bought: ${JSON.stringify(res.response.data.statuses)}. Check Explore at ${cfg.site}/`);
}

async function main() {
  const cfg = parseConfig(process.env);
  const log = (s) => console.log(`[${new Date().toISOString()}] ${s}`);
  const { ExchangeClient, HttpTransport, InfoClient } = await import("@nktkas/hyperliquid");
  const transport = new HttpTransport({ isTestnet: cfg.network === "testnet" });
  const info = new InfoClient({ transport });
  let exchange = null;
  if (cfg.live) {
    const { privateKeyToAccount } = await import("viem/accounts");
    exchange = new ExchangeClient({ transport, wallet: privateKeyToAccount(process.env.API_WALLET_KEY) });
  }
  log(`${cfg.live ? "LIVE" : "practice"} on ${cfg.network}: ${cfg.coin}, $${cfg.usdEach} every ${cfg.everyMinutes} min, up to $${cfg.maxUsd}`);
  const pass = () => runOnce({ cfg, info, exchange, log }).catch((e) => log(`this pass failed: ${e.message}`));
  await pass();
  if (process.argv.includes("--once")) return;
  setInterval(pass, cfg.everyMinutes * 60_000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
