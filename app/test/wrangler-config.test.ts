import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SECURITY_HEADERS } from "../worker/headers";

const w = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));

describe("wrangler.jsonc", () => {
  it("serves dist through the Worker except the hashed assets; a missing asset is a plain 404 (the Worker does the SPA fallback)", () => {
    expect(w.main).toBe("./worker/index.ts");
    // a bare `wrangler deploy` (no --env) must not reuse a network's name or open a workers.dev URL
    expect(w.name).toBe("hlo-pick-an-env");
    expect(w.workers_dev).toBe(false);
    expect(w.r2_buckets).toBeUndefined();
    expect(w.assets).toEqual({ directory: "./dist", binding: "ASSETS", not_found_handling: "none", run_worker_first: ["/*", "!/assets/*"] });
  });
  it("testnet: hlo-testnet on testnet.hlotrade.xyz, bucket hlo-testnet, HLO_NETWORK testnet, no workers.dev or preview URLs", () => {
    const t = w.env.testnet;
    expect(t.name).toBe("hlo-testnet");
    expect(t.vars).toEqual({ HLO_NETWORK: "testnet" });
    expect(t.r2_buckets).toEqual([{ binding: "REGISTRY", bucket_name: "hlo-testnet" }]);
    expect(t.routes).toEqual([{ pattern: "testnet.hlotrade.xyz", custom_domain: true }]);
    expect(t.workers_dev).toBe(false);
    expect(t.preview_urls).toBe(false);
  });
  it("mainnet: hlo on hlotrade.xyz and www, bucket hlo-mainnet, HLO_NETWORK mainnet", () => {
    const m = w.env.mainnet;
    expect(m.name).toBe("hlo");
    expect(m.vars).toEqual({ HLO_NETWORK: "mainnet" });
    expect(m.r2_buckets).toEqual([{ binding: "REGISTRY", bucket_name: "hlo-mainnet" }]);
    expect(m.routes).toEqual([{ pattern: "hlotrade.xyz", custom_domain: true }, { pattern: "www.hlotrade.xyz", custom_domain: true }]);
    expect(m.workers_dev).toBe(false);
    expect(m.preview_urls).toBe(false);
  });
  it("public/_headers gives /assets/* the immutable cache and the same security headers", () => {
    const h = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
    expect(h.split("\n")[0]).toBe("/assets/*");
    expect(h).toContain("  Cache-Control: public, max-age=31536000, immutable");
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(h).toContain(`  ${k}: ${v}`);
  });
});
