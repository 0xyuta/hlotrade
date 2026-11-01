import type { AppConfig, Network } from "./validate.js";

/** [T §1.5, §6.1] REST and WebSocket hosts; CORS is open on both [T §1.1]. */
export const HL_HOSTS: Record<Network, { api: string; ws: string }> = {
  mainnet: { api: "https://api.hyperliquid.xyz", ws: "wss://api.hyperliquid.xyz" },
  testnet: { api: "https://api.hyperliquid-testnet.xyz", ws: "wss://api.hyperliquid-testnet.xyz" },
};

/** [R §2.5, §6.2] Circle's fee and attestation API (open CORS, no key). */
export const IRIS_HOSTS: Record<Network, string> = {
  mainnet: "https://iris-api.circle.com",
  testnet: "https://iris-api-sandbox.circle.com",
};

const FONTS_CSS = "https://fonts.googleapis.com";
const FONTS_FILES = "https://fonts.gstatic.com";

/** Exactly the origins the app talks to. 'self' is our own /api/register. */
export function connectSources(c: AppConfig | null): string[] {
  if (!c) return ["'none'"];
  const s = new Set<string>(["'self'", HL_HOSTS[c.network].api, HL_HOSTS[c.network].ws]); // 'self': POST /api/register
  for (const u of [c.hyperEvmRpc, c.arbitrumRpc, c.ethereumRpc]) s.add(new URL(u).origin);
  if (c.solanaEnabled && c.solanaRpc) s.add(new URL(c.solanaRpc).origin); // only when the route is on: no unused origin in the policy
  s.add(IRIS_HOSTS[c.network]);
  if (c.rewardsBase) s.add(new URL(c.rewardsBase).origin);
  return [...s];
}

/** Hyperliquid's own coin icons (`/coins/<coin>.svg`). An <img> SVG runs no scripts; the app already talks to Hyperliquid. */
export const COIN_ICONS_ORIGIN = "https://app.hyperliquid.xyz";

/** The <meta> policy. frame-ancestors cannot go in a <meta>; the Worker sends it as a header (app/worker/headers.ts). */
export function cspFor(c: AppConfig | null): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    `style-src 'self' ${FONTS_CSS}`,
    `font-src ${FONTS_FILES}`,
    `img-src 'self' data: ${COIN_ICONS_ORIGIN}`,
    `connect-src ${connectSources(c).join(" ")}`,
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}
