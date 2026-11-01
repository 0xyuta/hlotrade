/**
 * Where HLO's front end is not offered. [T §7.1] Hyperliquid's Terms (1.6) name the US and Ontario;
 * sanctioned territories are covered without a list, so the countries below come from Hyperliquid's
 * delegation-program list, the only primary list found. The US territories are blocked as the US (Cloudflare reports
 * each under its own code). Checked against the Terms of 2026-06-15 on 2026-10-30 (docs/APP.md V4).
 * ISO 3166-1 alpha-2; regions are `${country}-${ISO 3166-2 subdivision}`, built from Cloudflare's `request.cf.country` and `request.cf.regionCode` [T §7.2].
 */
export const BLOCKED_COUNTRIES: readonly string[] = [
  "US", "PR", "GU", "VI", "AS", "MP", "UM", // the US and its territories
  "CU", "IR", "MM", "KP", "SY",
];
export const BLOCKED_REGIONS: readonly string[] = ["CA-ON", "UA-43", "UA-40", "UA-14", "UA-09"]; // Ontario; Crimea, Sevastopol, Donetsk, Luhansk

/** Countries with a blocked region: with the country known but the region missing, we cannot tell, so they are blocked. */
const REGIONAL_COUNTRIES: readonly string[] = [...new Set(BLOCKED_REGIONS.map((r) => r.split("-")[0]))];

/**
 * No country at all (local dev, unknown IP) is let through: fail-open, documented in docs/APP.md.
 * A country that has blocked regions (CA, UA) but arrives without a region is blocked: fail-closed (review ruling M5).
 */
export function isBlocked(country?: string | null, region?: string | null): boolean {
  const c = (country ?? "").toUpperCase();
  if (!c) return false;
  if (BLOCKED_COUNTRIES.includes(c)) return true;
  const r = (region ?? "").toUpperCase();
  if (r === "") return REGIONAL_COUNTRIES.includes(c);
  return BLOCKED_REGIONS.includes(`${c}-${r}`);
}
