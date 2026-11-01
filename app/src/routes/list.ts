import type { AppConfig } from "../config/validate";
import type { RouteId } from "./fees";

/** Config gate (`withdrawEnabled`): nothing under a withdraw can start while it is false. Deposits never see it. */
export const WITHDRAW_CLOSED_TEXT = "Withdrawals open after testing.";

export interface RouteRow {
  id: RouteId | "robinhood";
  label: string;
  enabled: boolean;
  note?: string;
}

/**
 * Spec §6 routes for this build. Solana (Plan 4 C) only when the config turns it on; Robinhood Chain comes later.
 * Bridge2 is deprecated and absent [R §1.3]. Withdrawals as a whole are gated by withdrawEnabled in TransferModal.
 */
export function routesFor(cfg: Pick<AppConfig, "solanaEnabled">): RouteRow[] {
  return [
    { id: "hypercore", label: "HyperCore (your trading balance)", enabled: true },
    { id: "hyperevm", label: "HyperEVM", enabled: true },
    { id: "arbitrum", label: "Arbitrum", enabled: true },
    { id: "ethereum", label: "Ethereum", enabled: true },
    cfg.solanaEnabled ? { id: "solana", label: "Solana", enabled: true } : { id: "solana", label: "Solana", enabled: false, note: "coming soon" },
    { id: "robinhood", label: "Robinhood Chain", enabled: false, note: "coming soon" },
  ];
}
