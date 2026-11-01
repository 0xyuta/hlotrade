import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import dev from "../src/config/dev.json";
import { ALLOW_MAINNET_SOLANA_ENV, ALLOW_MAINNET_WITHDRAW_ENV, mainnetSolanaProblem, mainnetWithdrawProblem, validateConfig, type AppConfig } from "../src/config/validate";

const base = {
  network: "testnet",
  hyperEvmRpc: "https://rpc.hyperliquid-testnet.xyz/evm",
  arbitrumRpc: "https://arb.example",
  ethereumRpc: "https://eth.example",
  withdrawEnabled: true,
  solanaEnabled: false,
};
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const deployment = {
  token: a(1), checkpoints: a(2), mining: a(3), staking: a(4), buyback: a(5), splitter: a(6), profiles: a(7), pair: a(8),
  chainId: 998, deployBlock: 123,
};

describe("validateConfig", () => {
  it("{} and null are empty (the not-deployed page)", () => {
    expect(validateConfig({}, "mainnet")).toEqual({ kind: "empty" });
    expect(validateConfig(null, "testnet")).toEqual({ kind: "empty" });
  });
  it("the committed dev.json is valid, trading read-only, no contracts", () => {
    const v = validateConfig(dev, "dev");
    expect(v.kind).toBe("ok");
    if (v.kind === "ok") {
      expect(v.config.builder).toBeNull();
      expect(v.config.contracts).toBeNull();
      expect(v.config.hyperEvmChainId).toBe(998);
      expect(v.config.withdrawEnabled).toBe(true);
      expect(v.config.solanaEnabled).toBe(true);
      expect(v.config.solanaRpc).toBe("https://api.devnet.solana.com");
    }
  });
  it("withdrawEnabled is required and must be a boolean; both values are kept", () => {
    const { withdrawEnabled: _w, ...without } = base;
    expect(validateConfig(without, "testnet")).toMatchObject({ kind: "invalid", reason: expect.stringContaining("withdrawEnabled") });
    for (const bad of ["true", 1, null, undefined]) expect(validateConfig({ ...base, withdrawEnabled: bad }, "testnet").kind).toBe("invalid");
    const off = validateConfig({ ...base, withdrawEnabled: false }, "testnet");
    expect(off.kind === "ok" && off.config.withdrawEnabled).toBe(false);
    const on = validateConfig(base, "testnet");
    expect(on.kind === "ok" && on.config.withdrawEnabled).toBe(true);
  });
  it("solanaEnabled is required; solanaRpc is required when it is true and must be a safe https URL (Plan 4 C)", () => {
    const { solanaEnabled: _s, ...without } = base;
    expect(validateConfig(without, "testnet")).toMatchObject({ kind: "invalid", reason: expect.stringContaining("solanaEnabled") });
    for (const bad of ["false", 0, null]) expect(validateConfig({ ...base, solanaEnabled: bad }, "testnet").kind).toBe("invalid");
    expect(validateConfig({ ...base, solanaEnabled: true }, "testnet")).toMatchObject({ kind: "invalid", reason: "solanaRpc is required when solanaEnabled is true" });
    for (const bad of ["http://api.devnet.solana.com", "https://*.solana.com", "https://rpc.example/?api-key=1", 5]) {
      expect(validateConfig({ ...base, solanaEnabled: true, solanaRpc: bad }, "testnet").kind, String(bad)).toBe("invalid");
    }
    const on = validateConfig({ ...base, solanaEnabled: true, solanaRpc: "https://api.devnet.solana.com" }, "testnet");
    expect(on.kind === "ok" && [on.config.solanaEnabled, on.config.solanaRpc]).toEqual([true, "https://api.devnet.solana.com"]);
    const off = validateConfig(base, "testnet");
    expect(off.kind === "ok" && [off.config.solanaEnabled, off.config.solanaRpc]).toEqual([false, null]);
  });
  it("referralCode is optional and must be 1–20 letters and digits; anything else fails the build (Plan 10)", () => {
    const none = validateConfig(base, "testnet");
    expect(none.kind === "ok" && none.config.referralCode).toBeNull();
    const nul = validateConfig({ ...base, referralCode: null }, "testnet");
    expect(nul.kind === "ok" && nul.config.referralCode).toBeNull();
    for (const good of ["A", "HLO", "abc123XYZ", "A".repeat(20)]) {
      const v = validateConfig({ ...base, referralCode: good }, "testnet");
      expect(v.kind === "ok" && v.config.referralCode, good).toBe(good);
    }
    for (const bad of ["", "A".repeat(21), "has space", "dash-ed", "under_score", "é", 123, true]) {
      expect(validateConfig({ ...base, referralCode: bad }, "testnet"), String(bad)).toEqual({ kind: "invalid", reason: "referralCode must be 1–20 letters and digits (A–Z, a–z, 0–9)" });
    }
  });
  it("a build flavour must match the file's network", () => {
    expect(validateConfig(base, "mainnet")).toMatchObject({ kind: "invalid" });
    expect(validateConfig(base, "testnet").kind).toBe("ok");
  });
  it("refuses unknown keys, plain http outside dev, and bad addresses", () => {
    expect(validateConfig({ ...base, relayer: "x" }, "testnet")).toMatchObject({ kind: "invalid", reason: 'unknown key "relayer"' });
    expect(validateConfig({ ...base, arbitrumRpc: "http://arb.example" }, "testnet").kind).toBe("invalid");
    expect(validateConfig({ ...base, arbitrumRpc: "http://localhost:8545" }, "dev").kind).toBe("ok");
    expect(validateConfig({ ...base, builder: a(0) }, "testnet").kind).toBe("invalid");
  });
  it("refuses hosts that could widen or break the CSP: wildcard, ';', quote, space, userinfo, query, fragment", () => {
    const hosts = [
      "https://*.example.com",
      "https://a.example;script-src",
      'https://a.example"x',
      "https://a.example'x",
      "https://a b.example",
      "https://user:pw@a.example",
      "https://a.example/?key=1",
      "https://a.example/#x",
      "https://a_b.example",
    ];
    for (const h of hosts) {
      for (const field of ["hyperEvmRpc", "arbitrumRpc", "ethereumRpc"]) {
        expect(validateConfig({ ...base, [field]: h }, "testnet").kind, `${field} ${h}`).toBe("invalid");
      }
    }
  });
  it("http is for dev on localhost / 127.0.0.1 only", () => {
    expect(validateConfig({ ...base, arbitrumRpc: "http://127.0.0.1:8545" }, "dev").kind).toBe("ok");
    expect(validateConfig({ ...base, arbitrumRpc: "http://arb.example" }, "dev").kind).toBe("invalid");
    expect(validateConfig({ ...base, arbitrumRpc: "http://localhost:8545" }, "testnet").kind).toBe("invalid");
  });
  it("accepts ordinary hosts with a port and a path", () => {
    expect(validateConfig({ ...base, arbitrumRpc: "https://rpc-1.arb.example:8443/v2/abc" }, "testnet").kind).toBe("ok");
  });
  it("lowercases the builder", () => {
    const v = validateConfig({ ...base, builder: "0x00000000000000000000000000000000000000AA" }, "testnet");
    expect(v.kind === "ok" && v.config.builder).toBe("0x00000000000000000000000000000000000000aa");
  });
  it("takes contracts/deployments/<chainId>.json as deployment, on the right chain only", () => {
    const v = validateConfig({ ...base, deployment, rewardsBase: "https://files.example/998/" }, "testnet");
    expect(v.kind === "ok" && v.config.contracts?.mining).toBe(a(3));
    expect(v.kind === "ok" && v.config.deployBlock).toBe(123);
    expect(validateConfig({ ...base, deployment: { ...deployment, chainId: 999 } }, "testnet").kind).toBe("invalid");
    expect(validateConfig({ ...base, deployment: { ...deployment, pair: "0x1" } }, "testnet").kind).toBe("invalid");
  });
  it("needs checkpoints and rejects the old feed key", () => {
    const { checkpoints, ...noCheckpoints } = deployment;
    void checkpoints;
    const missing = validateConfig({ ...base, deployment: noCheckpoints }, "testnet");
    expect(missing.kind === "invalid" && missing.reason).toMatch(/deployment\.checkpoints/);
    const old = validateConfig({ ...base, deployment: { ...noCheckpoints, feed: a(2) } }, "testnet");
    expect(old.kind === "invalid" && old.reason).toMatch(/feed/);
    const both = validateConfig({ ...base, deployment: { ...deployment, feed: a(2) } }, "testnet");
    expect(both.kind === "invalid" && both.reason).toMatch(/feed/);
    const ok = validateConfig({ ...base, deployment, rewardsBase: "https://files.example/998/" }, "testnet");
    expect(ok.kind === "ok" && ok.config.contracts?.checkpoints).toBe(a(2));
  });
});

describe("rewardsBase (config key)", () => {
  const testnetFile = () => JSON.parse(readFileSync(new URL("../src/config/testnet.json", import.meta.url), "utf8"));
  it("rewardsBase: required with a deployment, an https URL ending in /", () => {
    const withDeployment = testnetFile();
    const { rewardsBase: _rb, ...without } = withDeployment;
    expect(validateConfig(without, "testnet")).toEqual({ kind: "invalid", reason: "rewardsBase is required when the config has a deployment" });
    for (const bad of ["http://files.example/998/", "https://files.example/998", "https://files.example/998/?x=1", "/rewards-blob/998/", 7]) {
      expect(validateConfig({ ...withDeployment, rewardsBase: bad }, "testnet")).toMatchObject({ kind: "invalid", reason: expect.stringMatching(/^rewardsBase must be/) });
    }
    const ok = validateConfig(withDeployment, "testnet");
    expect(ok.kind === "ok" && ok.config.rewardsBase).toBe("https://files-testnet.hlotrade.xyz/998/");
  });
  it("is optional without a deployment (null)", () => {
    const v = validateConfig(base, "testnet");
    expect(v.kind === "ok" && v.config.rewardsBase).toBeNull();
  });
  it("refuses a rewards base whose host is a wildcard, has a ';' or a quote, or carries userinfo, query or fragment", () => {
    for (const b of [
      "https://*.example.com/998/",
      "https://a.example;script-src/998/",
      'https://a.example"x/998/',
      "https://user@a.example/998/",
      "https://a.example/998/?x=1/",
      "https://a.example/998/#x/",
    ]) {
      expect(validateConfig({ ...base, rewardsBase: b }, "testnet").kind, b).toBe("invalid");
    }
  });
});

describe("mainnetWithdrawProblem (final review M3: build-time go/no-go)", () => {
  const cfg = (network: "mainnet" | "testnet", withdrawEnabled: boolean) => {
    const v = validateConfig({ ...base, network, hyperEvmRpc: "https://rpc.example/evm", withdrawEnabled }, network);
    if (v.kind !== "ok") throw new Error("fixture");
    return v.config as AppConfig;
  };
  it("refuses a mainnet build with withdrawals on, naming the env override", () => {
    expect(ALLOW_MAINNET_WITHDRAW_ENV).toBe("HLO_ALLOW_MAINNET_WITHDRAW");
    expect(mainnetWithdrawProblem(cfg("mainnet", true), "mainnet", undefined)).toMatch(/withdrawEnabled.*W1.*HLO_ALLOW_MAINNET_WITHDRAW=1/);
    expect(mainnetWithdrawProblem(cfg("mainnet", true), "mainnet", "")).not.toBeNull();
    expect(mainnetWithdrawProblem(cfg("mainnet", true), "mainnet", "true")).not.toBeNull(); // only the exact "1"
  });
  it("lets it through with HLO_ALLOW_MAINNET_WITHDRAW=1", () => {
    expect(mainnetWithdrawProblem(cfg("mainnet", true), "mainnet", "1")).toBeNull();
  });
  it("never refuses mainnet with withdrawals off, the empty config, or testnet and dev builds", () => {
    expect(mainnetWithdrawProblem(cfg("mainnet", false), "mainnet", undefined)).toBeNull();
    expect(mainnetWithdrawProblem(null, "mainnet", undefined)).toBeNull();
    expect(mainnetWithdrawProblem(cfg("testnet", true), "testnet", undefined)).toBeNull();
    expect(mainnetWithdrawProblem(cfg("testnet", true), "dev", undefined)).toBeNull();
  });
});

describe("mainnetSolanaProblem (Plan 4 C: build-time go/no-go)", () => {
  const cfg = (network: "mainnet" | "testnet", solanaEnabled: boolean) => {
    const v = validateConfig({ ...base, network, hyperEvmRpc: "https://rpc.example/evm", withdrawEnabled: false, solanaEnabled, solanaRpc: "https://sol.example" }, network);
    if (v.kind !== "ok") throw new Error("fixture");
    return v.config as AppConfig;
  };
  it("refuses a mainnet build with Solana on unless HLO_ALLOW_MAINNET_SOLANA=1, and nothing else", () => {
    expect(ALLOW_MAINNET_SOLANA_ENV).toBe("HLO_ALLOW_MAINNET_SOLANA");
    expect(mainnetSolanaProblem(cfg("mainnet", true), "mainnet", undefined)).toMatch(/solanaEnabled.*SOL1–SOL6.*HLO_ALLOW_MAINNET_SOLANA=1/);
    expect(mainnetSolanaProblem(cfg("mainnet", true), "mainnet", "true")).not.toBeNull();
    expect(mainnetSolanaProblem(cfg("mainnet", true), "mainnet", "1")).toBeNull();
    expect(mainnetSolanaProblem(cfg("mainnet", false), "mainnet", undefined)).toBeNull();
    expect(mainnetSolanaProblem(null, "mainnet", undefined)).toBeNull();
    expect(mainnetSolanaProblem(cfg("testnet", true), "testnet", undefined)).toBeNull();
    expect(mainnetSolanaProblem(cfg("testnet", true), "dev", undefined)).toBeNull();
  });
});
