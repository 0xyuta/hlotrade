/**
 * The one config this bundle talks to, chosen at BUILD time so no other network's file is bundled:
 *   --mode testnet (dev:testnet, build:testnet) → testnet.json
 *   dev server                                  → dev.json
 *   production build                            → mainnet.json
 * (decided in vite.config.ts and passed in as __HLO_FLAVOUR__)
 * Never throws: main.tsx shows the "not deployed" page when `config` is null.
 */
import { validateConfig, type AppConfig, type Flavour } from "./validate";

/** Defined once in vite.config.ts (the same value that validates the file and builds the CSP). */
export const flavour: Flavour = __HLO_FLAVOUR__;

const files: Record<string, unknown> =
  __HLO_FLAVOUR__ === "testnet"
    ? import.meta.glob("./testnet.json", { eager: true, import: "default" })
    : __HLO_FLAVOUR__ === "dev"
      ? import.meta.glob("./dev.json", { eager: true, import: "default" })
      : import.meta.glob("./mainnet.json", { eager: true, import: "default" });

function load(): { config: AppConfig | null; problem: string | null } {
  const raw = Object.values(files)[0];
  const v = validateConfig(raw, flavour);
  if (v.kind !== "ok") return { config: null, problem: v.kind === "invalid" ? v.reason : null };
  return { config: v.config, problem: null };
}

const loaded = load();
export const config: AppConfig | null = loaded.config;
export const configProblem: string | null = loaded.problem;
/** The poster's files base (config rewardsBase); null when the network has no deployment. */
export const rewardsBase: string | null = config?.rewardsBase ?? null;
