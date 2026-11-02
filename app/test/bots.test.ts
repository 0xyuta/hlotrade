import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mainnet from "../src/config/mainnet.json";
import testnet from "../src/config/testnet.json";
import { BUILDER_F, MIN_ORDER_USD } from "../src/hl/math";
import { MIN_BUILDER_FEE } from "../src/register/rules";
import { BOT_FILE, BOT_RULES, BOT_SAMPLE_TEXT, botCommands, botSteps, builderField } from "../src/rewards/bots";

/* eslint-disable @typescript-eslint/no-explicit-any */
let bot: any;
const USER = "0x517b22f40b1b9bebf1776fa9d732e2c27fdeb590";
const KEY = `0x${"ab".repeat(32)}`;
const ok = { ACCOUNT: USER };
const BUILDER = "0xe6aa440e01bfeffb8914fd9861c6daf57cc4ee14";
beforeAll(async () => {
  bot = await import(/* @vite-ignore */ pathToFileURL(resolve(__dirname, "../public/bots/hlo-bot.mjs")).href);
});

describe("the sample bot's values match the app", () => {
  it("its builders are the configs' builders, in lowercase; mainnet stays null until mainnet.json has one", () => {
    expect(bot.BUILDERS.testnet).toBe(testnet.builder.toLowerCase());
    expect(bot.BUILDERS.mainnet).toBe((mainnet as { builder?: string }).builder?.toLowerCase() ?? null);
  });
  it("its fee and minimum are the app's", () => {
    expect(bot.BUILDER_F).toBe(BUILDER_F);
    expect(bot.BUILDER_F).toBe(MIN_BUILDER_FEE);
    expect(bot.MIN_ORDER_USD).toBe(MIN_ORDER_USD);
  });
});

describe("parseConfig", () => {
  it("defaults to testnet and practice", () => {
    expect(bot.parseConfig(ok)).toMatchObject({ network: "testnet", live: false, builder: BUILDER, user: USER, coin: "BTC", usdEach: 12, everyMinutes: 60, maxUsd: 100 });
  });
  it("is live only on exactly LIVE=1, and then needs a key", () => {
    expect(bot.parseConfig({ ...ok, LIVE: "true" }).live).toBe(false);
    expect(() => bot.parseConfig({ ...ok, LIVE: "1" })).toThrow(/API_WALLET_KEY/);
    expect(bot.parseConfig({ ...ok, LIVE: "1", API_WALLET_KEY: KEY }).live).toBe(true);
  });
  it("never repeats a bad key in its error", () => {
    const bad = "0xsecretsecretsecret";
    let text = "";
    try {
      bot.parseConfig({ ...ok, LIVE: "1", API_WALLET_KEY: bad });
    } catch (e) {
      text = (e as Error).message;
    }
    expect(text).toMatch(/API_WALLET_KEY/);
    expect(text).not.toContain(bad);
  });
  it("takes mainnet with mainnet's builder, and refuses an unknown network", () => {
    expect(bot.parseConfig({ ...ok, HLO_NETWORK: "mainnet" }).builder).toBe((mainnet as { builder: string }).builder.toLowerCase());
    expect(() => bot.parseConfig({ ...ok, HLO_NETWORK: "x" })).toThrow(/HLO_NETWORK/);
  });
  it.each([
    [{ USD_EACH: "9" }, /at least 10/],
    [{ USD_EACH: "abc" }, /USD_EACH/],
    [{ EVERY_MINUTES: "0.5" }, /at least 1/],
    [{ MAX_USD: "-1" }, /MAX_USD/],
    [{ ACCOUNT: "nope" }, /ACCOUNT/],
  ])("refuses %j", (over, msg) => expect(() => bot.parseConfig({ ...ok, ...over })).toThrow(msg));
});

describe("nextBuyUsd", () => {
  it("buys the set amount, less near the limit, none under Hyperliquid's minimum of room", () => {
    expect(bot.nextBuyUsd({ positionUsd: 0, usdEach: 12, maxUsd: 100 })).toBe(12);
    expect(bot.nextBuyUsd({ positionUsd: 85, usdEach: 20, maxUsd: 100 })).toBe(15);
    expect(bot.nextBuyUsd({ positionUsd: 95, usdEach: 12, maxUsd: 100 })).toBe(0);
    expect(bot.nextBuyUsd({ positionUsd: 150, usdEach: 12, maxUsd: 100 })).toBe(0);
  });
});

describe("planBuy", () => {
  it("one immediate-or-cancel buy with the builder in lowercase at f 100, within Hyperliquid's price and size rules", () => {
    const p = bot.planBuy({ assetIndex: 3, szDecimals: 5, mid: 79_305.5, usd: 12, builder: "0xE6AA440E01BFEFFB8914FD9861C6DAF57CC4EE14" });
    expect(p).toEqual({
      orders: [{ a: 3, b: true, p: "80099", s: "0.00015", r: false, t: { limit: { tif: "Ioc" } } }],
      grouping: "na",
      builder: { b: BUILDER, f: 100 },
    });
  });
  it("a small price keeps 5 significant figures", () => {
    const p = bot.planBuy({ assetIndex: 0, szDecimals: 1, mid: 1.23456, usd: 12, builder: BUILDER });
    expect(p.orders[0].p).toBe("1.247"); // 1.2469056, rounded up at the 4 decimals 5 significant figures allow
    expect(p.orders[0].s).toBe("9.7");
  });
  it("a size that rounds under the minimum is no order", () => {
    expect(bot.planBuy({ assetIndex: 0, szDecimals: 0, mid: 7, usd: 12, builder: BUILDER })).toBeNull();
  });
});

const fakeInfo = (o: { fee?: number; szi?: string; value?: string } = {}) => ({
  maxBuilderFee: vi.fn(async () => o.fee ?? 100),
  metaAndAssetCtxs: vi.fn(async () => [{ universe: [{ name: "OLD", szDecimals: 2, isDelisted: true }, { name: "BTC", szDecimals: 5 }] }, [{ midPx: "1" }, { midPx: "79000.5", markPx: "79001" }]]),
  clearinghouseState: vi.fn(async () => ({ assetPositions: o.szi ? [{ position: { coin: "BTC", szi: o.szi, positionValue: o.value } }] : [] })),
});
const setup = (env: Record<string, string> = {}) => bot.parseConfig({ ...ok, ...env });
const liveEnv = { LIVE: "1", API_WALLET_KEY: KEY };
const registered = () => vi.fn(async () => new Response("{}", { status: 200 }));

describe("runOnce", () => {
  it("practice: logs what it would buy, registers nothing and sends nothing", async () => {
    const log = vi.fn();
    const exchange = { order: vi.fn() };
    const fetchFn = registered();
    await bot.runOnce({ cfg: setup(), info: fakeInfo(), exchange, log, fetchFn });
    expect(exchange.order).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(log.mock.calls[0][0]).toMatch(/practice: would buy 0\.00015 BTC/);
  });
  it("live: registers the wallet, then sends the order with the builder on it", async () => {
    const exchange = { order: vi.fn(async () => ({ response: { data: { statuses: [{ filled: {} }] } } })) };
    const fetchFn = registered();
    await bot.runOnce({ cfg: setup(liveEnv), info: fakeInfo(), exchange, log: vi.fn(), fetchFn });
    expect(fetchFn).toHaveBeenCalledWith("https://testnet.hlotrade.xyz/api/register", expect.objectContaining({ method: "POST", body: JSON.stringify({ user: USER }) }));
    expect(exchange.order).toHaveBeenCalledTimes(1);
    const sent = (exchange.order.mock.calls[0] as unknown as [{ orders: { a: number }[]; builder: unknown }])[0];
    expect(sent.builder).toEqual({ b: BUILDER, f: 100 });
    expect(sent.orders[0].a).toBe(1); // BTC's index, past the delisted market
  });
  it("refuses a wallet that has not approved the builder fee, before anything else", async () => {
    const exchange = { order: vi.fn() };
    const fetchFn = registered();
    await expect(bot.runOnce({ cfg: setup(liveEnv), info: fakeInfo({ fee: 99 }), exchange, log: vi.fn(), fetchFn })).rejects.toThrow(/not approved/);
    expect(exchange.order).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it.each([
    [451, /not available in your region/],
    [502, /could not register/],
  ])("a registration answering %i stops the pass: an unregistered trade would not mine", async (status, msg) => {
    const exchange = { order: vi.fn() };
    const fetchFn = vi.fn(async () => new Response("{}", { status }));
    await expect(bot.runOnce({ cfg: setup(liveEnv), info: fakeInfo(), exchange, log: vi.fn(), fetchFn })).rejects.toThrow(msg);
    expect(exchange.order).not.toHaveBeenCalled();
  });
  it("stops buying at the limit, which it reads from the position, so a restart keeps it", async () => {
    const exchange = { order: vi.fn() };
    const log = vi.fn();
    await bot.runOnce({ cfg: setup(liveEnv), info: fakeInfo({ szi: "0.002", value: "158" }), exchange, log, fetchFn: registered() });
    expect(exchange.order).not.toHaveBeenCalled();
    expect(log.mock.calls[0][0]).toMatch(/at your limit/);
  });
  it("a short position counts as nothing held", async () => {
    const exchange = { order: vi.fn(async () => ({ response: { data: { statuses: [] } } })) };
    await bot.runOnce({ cfg: setup(liveEnv), info: fakeInfo({ szi: "-0.002", value: "158" }), exchange, log: vi.fn(), fetchFn: registered() });
    expect(exchange.order).toHaveBeenCalledTimes(1);
  });
  it("an unknown market says so", async () => {
    await expect(bot.runOnce({ cfg: setup({ COIN: "OLD" }), info: fakeInfo(), exchange: null, log: vi.fn(), fetchFn: registered() })).rejects.toThrow(/not a market/);
  });
});

describe("the plan through the real Hyperliquid client", () => {
  let server: Server;
  let body: { action?: { type: string; builder: unknown; orders: unknown[]; grouping: string } } = {};
  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        body = JSON.parse(raw);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.00015", avgPx: "79000", oid: 1 } }] } } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  });
  afterAll(() => new Promise((r) => server.close(r)));

  it("the signed request carries the builder and the order as planned; the key is not in it", async () => {
    const transport = new HttpTransport({ isTestnet: true, apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    const key = generatePrivateKey();
    const exchange = new ExchangeClient({ transport, wallet: privateKeyToAccount(key) });
    const plan = bot.planBuy({ assetIndex: 3, szDecimals: 5, mid: 79_000.5, usd: 12, builder: BUILDER });
    const res = await exchange.order(plan);
    expect(res.response.data.statuses).toHaveLength(1);
    expect(body.action?.type).toBe("order");
    expect(body.action?.builder).toEqual({ b: BUILDER, f: 100 });
    expect(body.action?.grouping).toBe("na");
    expect(body.action?.orders).toEqual([{ a: 3, b: true, p: plan.orders[0].p, s: plan.orders[0].s, r: false, t: { limit: { tif: "Ioc" } } }]);
    expect(JSON.stringify(body)).not.toContain(key.slice(2));
  });
});

describe("the page's texts", () => {
  it("the builder field is the one the bot sends", () => {
    expect(builderField(testnet.builder)).toBe(`builder: { b: "${BUILDER}", f: 100 }`);
  });
  it("the steps name the register address on the page's host", () => {
    expect(botSteps({ origin: "https://x.example" })[0].text).toContain("https://x.example/api/register");
  });
  it("the commands fetch the published file, pin the versions and keep the key out of the shell history", () => {
    const c = botCommands("https://x.example");
    expect(c).toContain(`curl -O https://x.example${BOT_FILE}`);
    expect(c).toContain("@nktkas/hyperliquid@0.33.3");
    expect(c).toContain("read -rs API_WALLET_KEY");
    expect(c).not.toMatch(/API_WALLET_KEY=/);
  });
  it("states the wash-trading rule, the loss risk, and uses none of the project's banned words", () => {
    const all = [...BOT_RULES, BOT_SAMPLE_TEXT, ...botSteps({ origin: "x" }).map((s) => s.text)].join(" ");
    expect(all).toMatch(/wash trading/);
    expect(all).toMatch(/lose money/);
    expect(all).not.toMatch(/jackpot|lottery|prize|motherlode|\bwin\b|\bORE\b/i);
  });
});
