import { describe, expect, it } from "vitest";
import { FEED_MAX_SILENCE_MS, envFor, feedMaxSilenceMs, loadConfig, registrySource, rewardsSource, wsUrlFor } from "../src/config.js";

const r2env = { R2_ACCOUNT_ID: "acc", R2_ACCESS_KEY_ID: "AKIDVALUE", R2_SECRET_ACCESS_KEY: "SECRETVALUE", R2_BUCKET: "hlo-testnet" };
const r2creds = { accountId: "acc", accessKeyId: "AKIDVALUE", secretAccessKey: "SECRETVALUE", bucket: "hlo-testnet" };
const base = { CHAIN_ID: "998", RPC_URL: "http://a,http://b", BUILDER: "0x00000000000000000000000000000000000000AA" };

describe("loadConfig", () => {
  it("PUBLISH=blob is refused: R2 is the store (Plan 8)", () => {
    expect(() => loadConfig({ ...base, PUBLISH: "blob" })).toThrow('PUBLISH=blob was removed: use PUBLISH=r2 (Cloudflare R2) or local:<dir>');
  });
  it("the keeper ignores PUBLISH=r2, so a shared env without R2 vars does not stop it", () => {
    expect(envFor("keeper", { ...base, PUBLISH: "r2" }).PUBLISH).toBeUndefined();
    expect(() => loadConfig(envFor("poster", { ...base, PUBLISH: "r2" }))).toThrow("PUBLISH=r2 needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET");
  });
  it("reads KEEPER_KEY and refuses a malformed one without echoing it", () => {
    const k = "0x" + "ab".repeat(32);
    expect(loadConfig({ ...base, KEEPER_KEY: k }).keeperKey).toBe(k);
    expect(() => loadConfig({ ...base, KEEPER_KEY: "0xnope" })).toThrow("KEEPER_KEY must be a 32-byte hex private key");
  });
  it("PAUSER_KEY is parsed like the other keys and never echoed", () => {
    const k = `0x${"1".repeat(64)}`;
    expect(loadConfig({ ...base, PAUSER_KEY: k }).pauserKey).toBe(k);
    expect(() => loadConfig({ ...base, PAUSER_KEY: "0xnope" })).toThrow("PAUSER_KEY must be a 32-byte hex private key");
  });
  it("refuses a key outside the curve's range (zero, or at or above its order) without echoing it", () => {
    for (const bad of [`0x${"0".repeat(64)}`, `0x${"f".repeat(64)}`, "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"]) {
      let msg = "";
      try {
        loadConfig({ ...base, POSTER_KEY: bad });
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toBe("POSTER_KEY must be a 32-byte hex private key");
    }
    const top = "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140";
    expect(loadConfig({ ...base, POSTER_KEY: top }).posterKey).toBe(top);
  });
  it("refuses MIN_CLAIM_USD under 1: Hyperliquid refuses claimRewards below 1 (testnet 2026-10-29)", () => {
    expect(() => loadConfig({ ...base, MIN_CLAIM_USD: "0.5" })).toThrow("MIN_CLAIM_USD must be at least 1");
    expect(loadConfig({ ...base, MIN_CLAIM_USD: "1" }).forward.minClaim).toBe(1_000_000n);
  });
  it("fills defaults per chain", () => {
    const c = loadConfig(base);
    expect(c.chainId).toBe(998);
    expect(c.rpcUrls).toEqual(["http://a", "http://b"]);
    expect(c.builder).toBe("0x00000000000000000000000000000000000000aa");
    expect(c.fills).toEqual({
      kind: "url",
      template: "https://stats-data.hyperliquid.xyz/Testnet/builder_fills/{builder}/{yyyymmdd}.csv.lz4",
    });
    expect(c.hlApi).toBe("https://api.hyperliquid-testnet.xyz");
    expect(c.deploymentsFile.endsWith("/contracts/deployments/998.json")).toBe(true);
    expect(c.stateDir.endsWith("/ops/state/998")).toBe(true);
    expect(c.fileDelayHours).toBe(2);
    expect(c.logChunk).toBe(1000n);
    expect(c.publish.kind).toBe("local");
    expect(c.forward).toEqual({ reserve: 110_000_000n, minMove: 10_000_000n, minClaim: 1_000_000n, minHype: 50_000_000_000_000_000n });
    expect(c.posterKey).toBeUndefined();
  });
  it("mainnet uses the Mainnet file path and API", () => {
    const c = loadConfig({ ...base, CHAIN_ID: "999" });
    expect(c.fills).toMatchObject({ template: expect.stringContaining("/Mainnet/") });
    expect(c.hlApi).toBe("https://api.hyperliquid.xyz");
  });
  it("rejects unknown chains, bad addresses and malformed keys without echoing the key", () => {
    expect(() => loadConfig({ ...base, CHAIN_ID: "1" })).toThrow(/CHAIN_ID/);
    expect(() => loadConfig({ ...base, BUILDER: "0x12" })).toThrow(/BUILDER/);
    const secret = "0x1234";
    let msg = "";
    try {
      loadConfig({ ...base, POSTER_KEY: secret });
    } catch (e) {
      msg = String(e);
    }
    expect(msg).toMatch(/POSTER_KEY/);
    expect(msg).not.toContain(secret);
  });
  it("parses keys", () => {
    const k = "0x" + "ab".repeat(32);
    expect(loadConfig({ ...base, POSTER_KEY: k }).posterKey).toBe(k);
  });
  it("PUBLISH_PREFIX defaults to the chain id and always ends with a slash; BLOB_PREFIX is refused", () => {
    const r2 = { ...base, ...r2env, PUBLISH: "r2" };
    expect(loadConfig(r2).publish).toMatchObject({ prefix: "998/" });
    expect(loadConfig({ ...r2, CHAIN_ID: "999" }).publish).toMatchObject({ prefix: "999/" });
    expect(loadConfig({ ...r2, PUBLISH_PREFIX: "prod" }).publish).toMatchObject({ prefix: "prod/" });
    expect(loadConfig({ ...r2, PUBLISH_PREFIX: "prod/" }).publish).toMatchObject({ prefix: "prod/" });
    expect(loadConfig({ ...r2, PUBLISH_PREFIX: "  " }).publish).toMatchObject({ prefix: "998/" });
    expect(() => loadConfig({ ...r2, BLOB_PREFIX: "x" })).toThrow("BLOB_PREFIX was renamed PUBLISH_PREFIX");
    expect(() => loadConfig({ ...base, BLOB_PREFIX: "  " })).not.toThrow();
  });
  it("validates numeric settings, naming the variable", () => {
    for (const [k, v] of [
      ["LOG_CHUNK", "0"], ["LOG_CHUNK", "1.5"], ["LOG_CHUNK", "abc"], ["LOG_CHUNK", "-3"],
      ["FILE_DELAY_HOURS", "-1"], ["FILE_DELAY_HOURS", "x"],
      ["POLL_SECONDS", "0"], ["POLL_SECONDS", "-5"],
    ] as const) {
      expect(() => loadConfig({ ...base, [k]: v }), `${k}=${v}`).toThrow(new RegExp(k));
    }
    expect(() => loadConfig({ ...base, FILE_DELAY_HOURS: "0" })).not.toThrow();
    expect(loadConfig({ ...base, LOG_CHUNK: "50", POLL_SECONDS: "0.5" }).logChunk).toBe(50n);
  });
});

describe("minute-settlement config", () => {
  it("ignores the daily system's leftover vars (old env files keep them), so a restart does not fail", () => {
    const leftovers = { FILLS_DIR: "/x", ROLES: "identity", EMPTY_AFTER_HOURS: "1", LATE_HOURS: "x", ALLOW_REPOST: "1", VERIFIER_KEY: "junk" };
    expect(() => loadConfig({ ...base, FILE_DELAY_HOURS: "2", ...leftovers })).not.toThrow();
  });
  it("a keeper given PUBLISH=local:<dir> keeps it; only r2 is dropped", () => {
    const env = { ...base, PUBLISH: "local:/tmp/pub" };
    expect(envFor("keeper", env)).toBe(env);
    expect(loadConfig(envFor("keeper", env)).publish).toEqual({ kind: "local", dir: "/tmp/pub" });
    expect(envFor("keeper", { ...env, PUBLISH: "r2" }).PUBLISH).toBeUndefined();
  });
  it("rewardsSource: URL first, then an explicit local publish dir, else an error", () => {
    expect(rewardsSource(loadConfig({ ...base, REWARDS_URL: "https://x.test/r", PUBLISH: "local:/tmp/p" }))).toEqual({ kind: "url", base: "https://x.test/r" });
    expect(rewardsSource(loadConfig({ ...base, PUBLISH: "local:/tmp/p" }))).toEqual({ kind: "dir", dir: "/tmp/p" });
    expect(() => rewardsSource(loadConfig(base))).toThrow("REWARDS_URL is required (or PUBLISH=local:<dir>)");
    expect(() => rewardsSource(loadConfig({ ...base, ...r2env, PUBLISH: "r2" }))).toThrow("REWARDS_URL is required");
  });
  it("REWARDS_URL must be http(s)", () => {
    expect(() => loadConfig({ ...base, REWARDS_URL: "ftp://x" })).toThrow("REWARDS_URL must be an http(s) URL");
    expect(() => loadConfig({ ...base, REWARDS_URL: "nope" })).toThrow("REWARDS_URL must be an http(s) URL");
    expect(loadConfig({ ...base, REWARDS_URL: "http://localhost:1/r" }).rewardsUrl).toBe("http://localhost:1/r");
    expect(loadConfig(base).rewardsUrl).toBeUndefined();
  });
  it("REGISTRY_DIR is required on anvil and refused on mainnet", () => {
    expect(() => loadConfig({ ...base, CHAIN_ID: "31337" })).toThrow("REGISTRY_DIR is required on anvil");
    expect(loadConfig({ ...base, CHAIN_ID: "31337", REGISTRY_DIR: "/r" }).registryDir).toBe("/r");
    expect(() => loadConfig({ ...base, CHAIN_ID: "999", REGISTRY_DIR: "/r" })).toThrow("REGISTRY_DIR is not allowed on mainnet (999)");
    expect(loadConfig(base).registryDir).toBeUndefined();
  });
  it("registrySource: the dir if set, else R2, else an error; BLOB_READ_WRITE_TOKEN is not read", () => {
    expect(registrySource(loadConfig({ ...base, REGISTRY_DIR: "/r" }), "poster")).toEqual({ kind: "dir", dir: "/r" });
    expect(registrySource(loadConfig({ ...base, ...r2env }), "verifier")).toMatchObject({ kind: "r2", chainId: 998 });
    expect(() => registrySource(loadConfig({ ...base, BLOB_READ_WRITE_TOKEN: "t" }), "poster")).toThrow("R2_* is required (or REGISTRY_DIR) for the poster");
    expect(() => registrySource(loadConfig(base), "verifier")).toThrow("for the verifier");
  });
  it("SETTLE_AFTER_MINUTES defaults to 60 (min 1); CHECKPOINT_GRACE_SECONDS to 10 (integer >= 0)", () => {
    const c = loadConfig(base);
    expect(c.settleAfterMinutes).toBe(60);
    expect(c.checkpointGraceSeconds).toBe(10);
    expect(loadConfig({ ...base, SETTLE_AFTER_MINUTES: "1", CHECKPOINT_GRACE_SECONDS: "0" })).toMatchObject({ settleAfterMinutes: 1, checkpointGraceSeconds: 0 });
    for (const v of ["0", "-1", "1.5", "x"]) expect(() => loadConfig({ ...base, SETTLE_AFTER_MINUTES: v })).toThrow("SETTLE_AFTER_MINUTES must be an integer >= 1");
    for (const v of ["-1", "1.5", "x"]) expect(() => loadConfig({ ...base, CHECKPOINT_GRACE_SECONDS: v })).toThrow("CHECKPOINT_GRACE_SECONDS must be an integer >= 0");
  });

  it("TRADE_FEED defaults to on for 998 and 999, off for anvil; on or off sets it; off is refused on mainnet", () => {
    const anvil = { ...base, CHAIN_ID: "31337", REGISTRY_DIR: "/r" };
    expect(loadConfig(base).tradeFeed).toBe(true);
    expect(loadConfig({ ...base, CHAIN_ID: "999" }).tradeFeed).toBe(true);
    expect(loadConfig(anvil).tradeFeed).toBe(false);
    expect(loadConfig({ ...base, TRADE_FEED: "off" }).tradeFeed).toBe(false);
    expect(loadConfig({ ...base, TRADE_FEED: "on" }).tradeFeed).toBe(true);
    expect(loadConfig({ ...anvil, TRADE_FEED: "on" }).tradeFeed).toBe(true);
    expect(loadConfig({ ...base, TRADE_FEED: " off " }).tradeFeed).toBe(false);
    expect(loadConfig({ ...base, CHAIN_ID: "999", TRADE_FEED: "on" }).tradeFeed).toBe(true);
    expect(() => loadConfig({ ...base, CHAIN_ID: "999", TRADE_FEED: "off" })).toThrow("TRADE_FEED=off is not allowed on mainnet (999)");
    for (const v of ["true", "1", "OFF", "yes", "x"]) expect(() => loadConfig({ ...base, TRADE_FEED: v })).toThrow("TRADE_FEED must be on or off");
    expect(() => loadConfig({ ...base, CHAIN_ID: "999", TRADE_FEED: "nope" })).toThrow("TRADE_FEED must be on or off");
    expect(loadConfig({ ...base, TRADE_FEED: "" }).tradeFeed).toBe(true); // empty is unset
  });
  it("HL_FILLS_PER_MINUTE defaults to 50 (min 1); OMISSION_FULL_MAX to 2000 (min 0)", () => {
    expect(loadConfig(base)).toMatchObject({ hlFillsPerMinute: 50, omissionFullMax: 2000 });
    expect(loadConfig({ ...base, HL_FILLS_PER_MINUTE: "1", OMISSION_FULL_MAX: "0" })).toMatchObject({ hlFillsPerMinute: 1, omissionFullMax: 0 });
    expect(loadConfig({ ...base, HL_FILLS_PER_MINUTE: "100", OMISSION_FULL_MAX: "5000" })).toMatchObject({ hlFillsPerMinute: 100, omissionFullMax: 5000 });
    for (const v of ["0", "-1", "1.5", "x"]) expect(() => loadConfig({ ...base, HL_FILLS_PER_MINUTE: v })).toThrow("HL_FILLS_PER_MINUTE must be an integer >= 1");
    for (const v of ["-1", "1.5", "x"]) expect(() => loadConfig({ ...base, OMISSION_FULL_MAX: v })).toThrow("OMISSION_FULL_MAX must be an integer >= 0");
  });
  it("wsUrlFor: https becomes wss, http becomes ws, plus /ws", () => {
    expect(wsUrlFor("https://api.hyperliquid.xyz")).toBe("wss://api.hyperliquid.xyz/ws");
    expect(wsUrlFor("https://api.hyperliquid-testnet.xyz/")).toBe("wss://api.hyperliquid-testnet.xyz/ws");
    expect(wsUrlFor("http://127.0.0.1:9/")).toBe("ws://127.0.0.1:9/ws");
    expect(wsUrlFor("http://127.0.0.1:9")).toBe("ws://127.0.0.1:9/ws");
  });
  it("feedMaxSilenceMs: the feed's silence rule is 30 s on 999 and off on 998 (quiet minutes) and anvil", () => {
    expect(FEED_MAX_SILENCE_MS).toBe(30_000);
    expect(feedMaxSilenceMs(999)).toBe(30_000);
    expect(feedMaxSilenceMs(998)).toBeNull();
    expect(feedMaxSilenceMs(31337)).toBeNull();
  });

  it("R2: all four R2_* vars or none; a partial set names the missing ones and never echoes a value", () => {
    expect(loadConfig({ ...base, ...r2env }).r2).toEqual(r2creds);
    expect(loadConfig(base).r2).toBeUndefined();
    const err = (() => { try { loadConfig({ ...base, ...r2env, R2_BUCKET: "", R2_ACCOUNT_ID: " " }); } catch (e) { return (e as Error).message; } })();
    expect(err).toBe("R2 needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET (missing: R2_ACCOUNT_ID, R2_BUCKET)");
    expect(err).not.toMatch(/AKIDVALUE|SECRETVALUE/);
  });
  it("PUBLISH=r2 publishes to R2 and needs the R2_* vars", () => {
    expect(loadConfig({ ...base, ...r2env, PUBLISH: "r2" }).publish).toEqual({ kind: "r2", creds: r2creds, prefix: "998/" });
    expect(() => loadConfig({ ...base, PUBLISH: "r2" })).toThrow("PUBLISH=r2 needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET");
  });
  it("PUBLISH must be r2 or local:<dir>", () => {
    expect(() => loadConfig({ ...base, PUBLISH: "s3" })).toThrow('PUBLISH must be "r2" or "local:<dir>"');
  });
  it("registrySource: REGISTRY_DIR wins over R2", () => {
    expect(registrySource(loadConfig({ ...base, ...r2env }), "poster")).toEqual({ kind: "r2", creds: r2creds, chainId: 998 });
    expect(registrySource(loadConfig({ ...base, ...r2env, REGISTRY_DIR: "/r" }), "poster")).toEqual({ kind: "dir", dir: "/r" });
  });
});
