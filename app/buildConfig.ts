/**
 * The build-time config gate, shared by vite.config.ts (the CSP plugin and the dev server) and its tests (E1).
 * Node only: never imported by the browser bundle.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ALLOW_MAINNET_SOLANA_ENV, ALLOW_MAINNET_WITHDRAW_ENV, mainnetSolanaProblem, mainnetWithdrawProblem, validateConfig, type AppConfig, type Flavour } from "./src/config/validate";

export const CONFIG_FILES: Record<Flavour, string> = {
  mainnet: "src/config/mainnet.json",
  testnet: "src/config/testnet.json",
  dev: "src/config/dev.json",
};

export interface BuildConfig {
  config: AppConfig | null;
}

export interface BuildDeps {
  read(file: string): string;
  processEnv: Record<string, string | undefined>;
  warn(message: string): void;
}

const DEFAULTS: BuildDeps = {
  read: (file) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8"),
  processEnv: process.env,
  warn: (m) => console.warn(m),
};

/**
 * Fails the build on a bad file, a set VITE_REWARDS_BASE (no longer read: the rewards URL is the config's rewardsBase), or a mainnet file with withdrawals or Solana on without its
 * HLO_ALLOW_MAINNET_* override (HLO_ALLOW_MAINNET_WITHDRAW=1, HLO_ALLOW_MAINNET_SOLANA=1); `{}` builds the not-deployed page.
 */
export function loadBuildConfig(flavour: Flavour, env: Record<string, string>, deps: Partial<BuildDeps> = {}): BuildConfig {
  const d = { ...DEFAULTS, ...deps };
  if (env.VITE_REWARDS_BASE?.trim()) throw new Error("[hlo] VITE_REWARDS_BASE is no longer read: the rewards URL is rewardsBase in src/config/<network>.json; unset it");
  const file = CONFIG_FILES[flavour];
  const raw: unknown = JSON.parse(d.read(file));
  const v = validateConfig(raw, flavour);
  if (v.kind === "invalid") throw new Error(`[hlo] ${file} refused: ${v.reason}`);
  if (v.kind === "empty") {
    d.warn(`\n[hlo] ${file} is {}: building the "not deployed yet" page.\n`);
    return { config: null };
  }
  const w = mainnetWithdrawProblem(v.config, flavour, d.processEnv[ALLOW_MAINNET_WITHDRAW_ENV]);
  if (w) throw new Error(`[hlo] ${file} refused: ${w}`);
  const s = mainnetSolanaProblem(v.config, flavour, d.processEnv[ALLOW_MAINNET_SOLANA_ENV]);
  if (s) throw new Error(`[hlo] ${file} refused: ${s}`);
  return { config: v.config };
}
