import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_NAME, AGENT_VALID_DAYS, PHONE_AGENT_NAME, PHONE_AGENT_VALID_DAYS, agentNameWithExpiry, agentStorageKey } from "../src/hl/agent";
import { CUTOFF_UNCONFIRMED_TEXT, CUTOFF_VALID_MS, CutOffUnconfirmedError, approvePhoneAgent, cutOffPhone, enableTrading, parseExtraAgents, tradingStatus } from "../src/hl/enable";
import { injectedHlWallet } from "../src/hl/injected";

const MASTER = "0x1111111111111111111111111111111111111111";
const BUILDER = "0x2222222222222222222222222222222222222222";
const AGENT = { key: `0x${"ab".repeat(32)}` as const, address: "0x3333333333333333333333333333333333333333" as const, validUntil: 0 };

describe("tradingStatus", () => {
  it("builder ok at ≥ 100 (0.1%) [T §2.3]; agent ok when our agent is listed and not expired", () => {
    const agents = [{ name: "hlo", address: AGENT.address, validUntil: 2_000 }];
    expect(tradingStatus({ maxBuilderFee: 100, agents, local: AGENT, nowMs: 1_000 })).toEqual({ builderOk: true, maxBuilderFee: 100, agentOk: true, agentValidUntil: 2_000 });
    expect(tradingStatus({ maxBuilderFee: 99, agents, local: AGENT, nowMs: 3_000 })).toMatchObject({ builderOk: false, agentOk: false });
    expect(tradingStatus({ maxBuilderFee: 100, agents: [], local: AGENT, nowMs: 0 }).agentOk).toBe(false);
    expect(tradingStatus({ maxBuilderFee: 100, agents, local: null, nowMs: 0 }).agentOk).toBe(false);
    expect(tradingStatus({ maxBuilderFee: 100, agents: [{ ...agents[0], validUntil: null }], local: AGENT, nowMs: 9e15 }).agentOk).toBe(true);
  });
  it("parseExtraAgents keeps well-formed rows only", () => {
    expect(parseExtraAgents([{ name: "hlo", address: AGENT.address, validUntil: 5 }, { name: 1 }, "x"])).toEqual([{ name: "hlo", address: AGENT.address, validUntil: 5 }]);
    expect(parseExtraAgents(null)).toEqual([]);
  });
});

describe("enableTrading", () => {
  afterEach(() => vi.unstubAllGlobals());
  const SIG = `0x${"11".repeat(32)}${"22".repeat(32)}1b`;
  const eth = { request: async ({ method }: { method: string }) => (method === "eth_chainId" ? "0xa4b1" : SIG) };
  const mem = () => {
    const m = new Map<string, string>();
    return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };
  function stub() {
    const actions: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      actions.push(JSON.parse(init?.body ? String(init.body) : await (input as Request).clone().text()).action);
      return new Response(JSON.stringify({ status: "ok", response: { type: "default" } }), { headers: { "content-type": "application/json" } });
    }));
    return actions;
  }
  it("approves the builder fee (0.1%) first, then a fresh agent named 'hlo valid_until …', and stores it", async () => {
    const actions = stub();
    const kv = mem();
    const a = await enableTrading({ net: "testnet", wallet: injectedHlWallet(eth, MASTER), master: MASTER, builder: BUILDER, builderOk: false, kv, nowMs: 1_000 });
    expect(actions.map((x) => x.type)).toEqual(["approveBuilderFee", "approveAgent"]);
    expect(actions[0]).toMatchObject({ maxFeeRate: "0.1%", builder: BUILDER });
    expect(actions[1]).toMatchObject({ agentAddress: a.address.toLowerCase(), agentName: `hlo valid_until ${1_000 + 179 * 86_400_000}` });
    expect(JSON.parse(kv.m.get(agentStorageKey("testnet", MASTER))!).key).toBe(a.key);
  });
  it("skips the builder approval when it is already in place", async () => {
    const actions = stub();
    await enableTrading({ net: "testnet", wallet: injectedHlWallet(eth, MASTER), master: MASTER, builder: BUILDER, builderOk: true, kv: mem(), nowMs: 1 });
    expect(actions.map((x) => x.type)).toEqual(["approveAgent"]);
  });
});

describe("approvePhoneAgent (the phone's own key, a second named agent)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const SIG = `0x${"11".repeat(32)}${"22".repeat(32)}1b`;
  const eth = { request: async ({ method }: { method: string }) => (method === "eth_chainId" ? "0xa4b1" : SIG) };
  function stub() {
    const actions: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      actions.push(JSON.parse(init?.body ? String(init.body) : await (input as Request).clone().text()).action);
      return new Response(JSON.stringify({ status: "ok", response: { type: "default" } }), { headers: { "content-type": "application/json" } });
    }));
    return actions;
  }
  it("signs one approveAgent named 'hlo phone valid_until …' for a fresh key and returns it (the caller shows it once and does not store it)", async () => {
    const actions = stub();
    const a = await approvePhoneAgent({ net: "testnet", wallet: injectedHlWallet(eth, MASTER), nowMs: 1_000 });
    expect(actions.map((x) => x.type)).toEqual(["approveAgent"]);
    expect(actions[0]).toMatchObject({ agentAddress: a.address.toLowerCase(), agentName: `hlo phone valid_until ${1_000 + 30 * 86_400_000}` });
    expect(a.key).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("the phone's agent lives 30 days, the computer's stays 179 (a shorter life bounds a code that was seen)", async () => {
    expect(PHONE_AGENT_VALID_DAYS).toBe(30);
    expect(AGENT_VALID_DAYS).toBe(179);
    const actions = stub();
    const phone = await approvePhoneAgent({ net: "testnet", wallet: injectedHlWallet(eth, MASTER), nowMs: 5_000 });
    expect(phone.validUntil).toBe(5_000 + 30 * 86_400_000);
    const desk = await enableTrading({ net: "testnet", wallet: injectedHlWallet(eth, MASTER), master: MASTER, builder: BUILDER, builderOk: true, kv: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, nowMs: 5_000 });
    expect(desk.validUntil).toBe(5_000 + 179 * 86_400_000);
    expect(actions.map((x) => x.agentName)).toEqual([`hlo phone valid_until ${5_000 + 30 * 86_400_000}`, `hlo valid_until ${5_000 + 179 * 86_400_000}`]);
  });
  it("is a different key each time", async () => {
    stub();
    const w = injectedHlWallet(eth, MASTER);
    const [a, b] = [await approvePhoneAgent({ net: "testnet", wallet: w, nowMs: 1 }), await approvePhoneAgent({ net: "testnet", wallet: w, nowMs: 1 })];
    expect(a.key).not.toBe(b.key);
  });
});

describe("a network switch while signing", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("approveAgent and approveBuilderFee are retried once when the wallet reports a chainId mismatch [T §1.4]", async () => {
    const SIG = `0x${"11".repeat(32)}${"22".repeat(32)}1b`;
    let signs = 0;
    const eth = {
      request: async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return "0xa4b1";
        if (++signs % 2 === 1) throw new Error('Provided chainId "42161" must match the active chainId "999"');
        return SIG;
      },
    };
    const actions: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      actions.push(JSON.parse(init?.body ? String(init.body) : await (input as Request).clone().text()).action);
      return new Response(JSON.stringify({ status: "ok", response: { type: "default" } }), { headers: { "content-type": "application/json" } });
    }));
    const m = new Map<string, string>();
    const kv = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    await enableTrading({ net: "testnet", wallet: injectedHlWallet(eth, MASTER), master: MASTER, builder: BUILDER, builderOk: false, kv, nowMs: 1 });
    expect(actions.map((x) => x.type)).toEqual(["approveBuilderFee", "approveAgent"]); // each posted once
    expect(signs).toBe(4); // each signed twice: the first try hit the mismatch
    await approvePhoneAgent({ net: "testnet", wallet: injectedHlWallet(eth, MASTER), nowMs: 1 });
    expect(actions.map((x) => x.type)).toEqual(["approveBuilderFee", "approveAgent", "approveAgent"]);
  });
});

describe("cutOffPhone (Plan 4 B)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const SIG = `0x${"11".repeat(32)}${"22".repeat(32)}1b`;
  const eth = { request: async ({ method }: { method: string }) => (method === "eth_chainId" ? "0xa4b1" : SIG) };
  function stub() {
    const actions: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      actions.push(JSON.parse(init?.body ? String(init.body) : await (input as Request).clone().text()).action);
      return new Response(JSON.stringify({ status: "ok", response: { type: "default" } }), { headers: { "content-type": "application/json" } });
    }));
    return actions;
  }
  it("signs one approveAgent named 'hlo phone valid_until <now + 1 day>' for a fresh address, and returns no key", async () => {
    const actions = stub();
    const out = await cutOffPhone({ net: "testnet", wallet: injectedHlWallet(eth, MASTER), nowMs: 1_000 });
    expect(out).toBeUndefined();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "approveAgent", agentName: `hlo phone valid_until ${1_000 + CUTOFF_VALID_MS}` });
    expect(CUTOFF_VALID_MS).toBe(86_400_000);
    expect(actions[0].agentAddress).toMatch(/^0x[0-9a-f]{40}$/);
  });
  it("uses the phone's name, so Hyperliquid replaces the paired phone's agent; a different address every time", async () => {
    const actions = stub();
    await cutOffPhone({ net: "testnet", wallet: injectedHlWallet(eth, MASTER), nowMs: 1 });
    await cutOffPhone({ net: "testnet", wallet: injectedHlWallet(eth, MASTER), nowMs: 1 });
    expect(actions.map((a) => String(a.agentName).split(" valid_until")[0])).toEqual(["hlo phone", "hlo phone"]);
    expect(actions[0].agentAddress).not.toBe(actions[1].agentAddress);
  });
  it("never names the computer's 'hlo' agent", async () => {
    const actions = stub();
    await cutOffPhone({ net: "testnet", wallet: injectedHlWallet(eth, MASTER), nowMs: 1 });
    const name = String(actions[0].agentName);
    expect(name.startsWith("hlo phone valid_until ")).toBe(true);
    // the base name (before " valid_until") is the phone's, never the computer's (Task 9 review m5)
    expect(name.split(" valid_until")[0]).not.toBe(AGENT_NAME);
    expect(name).not.toBe(agentNameWithExpiry(1 + CUTOFF_VALID_MS));
    expect(name).toBe(agentNameWithExpiry(1 + CUTOFF_VALID_MS, PHONE_AGENT_NAME));
  });
  it("a refused signature throws and posts nothing", async () => {
    const actions = stub();
    const refusing = { request: async ({ method }: { method: string }) => { if (method === "eth_chainId") return "0xa4b1"; throw Object.assign(new Error("User rejected"), { code: 4001 }); } };
    await expect(cutOffPhone({ net: "testnet", wallet: injectedHlWallet(refusing, MASTER), nowMs: 1 })).rejects.toThrow();
    expect(actions).toHaveLength(0);
  });
  it("a post with no answer, or a 5xx, is 'unconfirmed': the phone may already be cut off", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const noAnswer = cutOffPhone({ net: "testnet", wallet: injectedHlWallet(eth, MASTER), nowMs: 1 });
    await expect(noAnswer).rejects.toBeInstanceOf(CutOffUnconfirmedError);
    await expect(noAnswer).rejects.toThrow(CUTOFF_UNCONFIRMED_TEXT);
    expect(CUTOFF_UNCONFIRMED_TEXT).toMatch(/the phone may already be cut off\. Cutting it off again is safe\./);
    const fetchMock = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(cutOffPhone({ net: "testnet", wallet: injectedHlWallet(eth, MASTER), nowMs: 1 })).rejects.toBeInstanceOf(CutOffUnconfirmedError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // one post: a failed post never signs or posts again
  });
  it("an answer that refuses the approval is a plain error, not 'unconfirmed'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "err", response: "Extra agent already used." }), { headers: { "content-type": "application/json" } })));
    const p = cutOffPhone({ net: "testnet", wallet: injectedHlWallet(eth, MASTER), nowMs: 1 });
    await expect(p).rejects.toThrow();
    await expect(p).rejects.not.toBeInstanceOf(CutOffUnconfirmedError);
  });
});
