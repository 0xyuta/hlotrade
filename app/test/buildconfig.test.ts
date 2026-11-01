import { describe, expect, it } from "vitest";
import { CONFIG_FILES, loadBuildConfig } from "../buildConfig";

const MAINNET = {
  network: "mainnet",
  hyperEvmRpc: "https://rpc.hyperliquid.xyz/evm",
  arbitrumRpc: "https://arb1.arbitrum.io/rpc",
  ethereumRpc: "https://eth.example",
  withdrawEnabled: false,
  solanaEnabled: false,
};
const file = (o: unknown) => () => JSON.stringify(o);
const quiet = { warn: () => {} };

describe("loadBuildConfig", () => {
  it("reads the file of its flavour", () => {
    const seen: string[] = [];
    loadBuildConfig("testnet", {}, { ...quiet, read: (f) => (seen.push(f), "{}") });
    loadBuildConfig("mainnet", {}, { ...quiet, read: (f) => (seen.push(f), "{}") });
    loadBuildConfig("dev", {}, { ...quiet, read: (f) => (seen.push(f), "{}") });
    expect(seen).toEqual([CONFIG_FILES.testnet, CONFIG_FILES.mainnet, CONFIG_FILES.dev]);
    expect(CONFIG_FILES).toEqual({ mainnet: "src/config/mainnet.json", testnet: "src/config/testnet.json", dev: "src/config/dev.json" });
  });
  it("{} builds the not-deployed page and warns", () => {
    const warned: string[] = [];
    expect(loadBuildConfig("mainnet", {}, { read: () => "{}", warn: (m) => warned.push(m) })).toEqual({ config: null });
    expect(warned.join()).toMatch(/not deployed yet/);
  });
  it("a mainnet file with withdrawals on is refused unless HLO_ALLOW_MAINNET_WITHDRAW=1 (final review M3)", () => {
    const on = file({ ...MAINNET, withdrawEnabled: true });
    expect(() => loadBuildConfig("mainnet", {}, { ...quiet, read: on, processEnv: {} })).toThrow(/withdrawEnabled.*W1/s);
    expect(() => loadBuildConfig("mainnet", {}, { ...quiet, read: on, processEnv: { HLO_ALLOW_MAINNET_WITHDRAW: "true" } })).toThrow(/W1/);
    expect(loadBuildConfig("mainnet", {}, { ...quiet, read: on, processEnv: { HLO_ALLOW_MAINNET_WITHDRAW: "1" } }).config?.withdrawEnabled).toBe(true);
    expect(loadBuildConfig("mainnet", {}, { ...quiet, read: file(MAINNET), processEnv: {} }).config?.withdrawEnabled).toBe(false);
  });
  it("a mainnet file with Solana on is refused unless HLO_ALLOW_MAINNET_SOLANA=1 (Plan 4 C)", () => {
    const on = file({ ...MAINNET, solanaEnabled: true, solanaRpc: "https://sol.example" });
    expect(() => loadBuildConfig("mainnet", {}, { ...quiet, read: on, processEnv: {} })).toThrow(/solanaEnabled.*SOL1–SOL6/s);
    expect(loadBuildConfig("mainnet", {}, { ...quiet, read: on, processEnv: { HLO_ALLOW_MAINNET_SOLANA: "1" } }).config?.solanaEnabled).toBe(true);
    // the two overrides are independent: the withdraw one does not open Solana
    expect(() => loadBuildConfig("mainnet", {}, { ...quiet, read: on, processEnv: { HLO_ALLOW_MAINNET_WITHDRAW: "1" } })).toThrow(/SOL1–SOL6/);
  });
  it("testnet with withdrawals on needs no env", () => {
    const t = { ...MAINNET, network: "testnet", hyperEvmRpc: "https://rpc.hyperliquid-testnet.xyz/evm", withdrawEnabled: true };
    expect(loadBuildConfig("testnet", {}, { ...quiet, read: file(t), processEnv: {} }).config?.network).toBe("testnet");
  });
  it("a bad file fails the build", () => {
    expect(() => loadBuildConfig("mainnet", {}, { ...quiet, read: file({ ...MAINNET, relayer: 1 }) })).toThrow(/refused: unknown key "relayer"/);
  });
  it("refuses a build with VITE_REWARDS_BASE set: the rewards URL is the config's rewardsBase", () => {
    expect(() => loadBuildConfig("testnet", { VITE_REWARDS_BASE: "https://x.example/998/" }, quiet)).toThrow(
      "[hlo] VITE_REWARDS_BASE is no longer read: the rewards URL is rewardsBase in src/config/<network>.json; unset it",
    );
  });
});
