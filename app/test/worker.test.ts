import { describe, expect, it, vi } from "vitest";
import worker, { handle } from "../worker/index";
import { SECURITY_HEADERS } from "../worker/headers";
import type { Env } from "../worker/env";

const env = (over: Partial<Env> = {}): Env & { ASSETS: { fetch: ReturnType<typeof vi.fn> } } => ({
  ASSETS: { fetch: vi.fn(async () => new Response("<!doctype html>app", { status: 200, headers: { "content-type": "text/html" } })) },
  REGISTRY: { head: vi.fn(async () => null), put: vi.fn(async () => ({})) },
  HLO_NETWORK: "testnet",
  ...over,
}) as never;
/** Like the built assets with not_found_handling "none": only / exists, everything else is 404. */
const spaAssets = () => ({
  fetch: vi.fn(async (req: Request) =>
    new URL(req.url).pathname === "/"
      ? new Response(req.method === "HEAD" ? null : "<!doctype html>index", { status: 200, headers: { "content-type": "text/html" } })
      : new Response("not found", { status: 404 }),
  ),
});
const get = (path: string, host = "testnet.hlotrade.xyz", method = "GET") => new Request(`https://${host}${path}`, { method });
const hasSecurityHeaders = (r: Response) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(r.headers.get(k)).toBe(v);
};

describe("Worker", () => {
  it("451 for a blocked country or region, with the security headers and no-store; the API is blocked too", async () => {
    for (const cf of [{ country: "US" }, { country: "CA", regionCode: "ON" }, { country: "UA", regionCode: "43" }, { country: "CA" }]) {
      const r = await handle(get("/"), env(), cf);
      expect(r.status).toBe(451);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(await r.text()).toContain("HLO is not available in your region.");
      hasSecurityHeaders(r);
    }
    const e = env();
    expect((await handle(new Request("https://testnet.hlotrade.xyz/api/register", { method: "POST", body: "{}" }), e, { country: "US" })).status).toBe(451);
    expect(e.REGISTRY.head).not.toHaveBeenCalled();
  });
  it("lets others through: another country, CA with another region, Tor (T1), unknown (XX), no cf at all", async () => {
    for (const cf of [{ country: "DE" }, { country: "CA", regionCode: "BC" }, { country: "T1" }, { country: "XX" }, undefined]) {
      expect((await handle(get("/"), env(), cf)).status).toBe(200);
    }
  });
  it("serves pages from ASSETS with the security headers", async () => {
    const e = env();
    const r = await handle(get("/"), e, { country: "DE" });
    expect(r.status).toBe(200);
    expect(e.ASSETS.fetch).toHaveBeenCalledTimes(1);
    expect(new URL(e.ASSETS.fetch.mock.calls[0][0].url).pathname).toBe("/");
    hasSecurityHeaders(r);
  });
  it("an unknown page (/pair, /some/route) gets the app's index from the Worker: ASSETS 404, then asked for / (GET and HEAD)", async () => {
    for (const method of ["GET", "HEAD"]) {
      for (const p of ["/pair", "/some/route", "/pair?x=1"]) {
        const e = env({ ASSETS: spaAssets() });
        const r = await handle(get(p, "testnet.hlotrade.xyz", method), e, { country: "DE" });
        expect(r.status).toBe(200);
        if (method === "GET") expect(await r.text()).toBe("<!doctype html>index");
        const paths = e.ASSETS.fetch.mock.calls.map((c) => new URL(c[0].url).pathname);
        expect(paths).toEqual([new URL(`https://x${p}`).pathname, "/"]);
        expect(e.ASSETS.fetch.mock.calls[1][0].method).toBe(method);
        hasSecurityHeaders(r);
      }
    }
  });
  it("a blocked country at /pair is 451 without touching ASSETS", async () => {
    const e = env({ ASSETS: spaAssets() });
    expect((await handle(get("/pair"), e, { country: "US" })).status).toBe(451);
    expect(e.ASSETS.fetch).not.toHaveBeenCalled();
  });
  it("a 404 for a non-GET/HEAD request stays 404 (no fallback)", async () => {
    const e = env({ ASSETS: spaAssets() });
    const r = await handle(get("/some/route", "testnet.hlotrade.xyz", "POST"), e, { country: "DE" });
    expect(r.status).toBe(404);
    expect(e.ASSETS.fetch).toHaveBeenCalledTimes(1);
    hasSecurityHeaders(r);
  });
  it("keeps the upstream status and headers (a 304 with its etag and cache-control) and adds the security headers", async () => {
    const e = env({
      ASSETS: { fetch: vi.fn(async () => new Response(null, { status: 304, headers: { etag: '"abc"', "cache-control": "no-cache" } })) },
    });
    const r = await handle(get("/"), e, { country: "DE" });
    expect(r.status).toBe(304);
    expect(r.headers.get("etag")).toBe('"abc"');
    expect(r.headers.get("cache-control")).toBe("no-cache");
    hasSecurityHeaders(r);
  });
  it("redirects www. to the bare host, keeping path and query (301)", async () => {
    const r = await handle(get("/pair?x=1", "www.hlotrade.xyz"), env(), { country: "DE" });
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("https://hlotrade.xyz/pair?x=1");
    hasSecurityHeaders(r);
  });
  it("/api/register: 405 for other methods (Allow: POST); other /api paths 404; never ASSETS", async () => {
    const e = env();
    const r = await handle(get("/api/register"), e, { country: "DE" });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("POST");
    hasSecurityHeaders(r);
    expect((await handle(get("/api/other"), e, { country: "DE" })).status).toBe(404);
    expect((await handle(get("/api"), e, { country: "DE" })).status).toBe(404);
    expect(e.ASSETS.fetch).not.toHaveBeenCalled();
  });
  it("POST /api/register goes to register with the env's network and bucket (a bad body is a 400 with headers)", async () => {
    const e = env();
    const r = await handle(new Request("https://testnet.hlotrade.xyz/api/register", { method: "POST", body: "nope" }), e, { country: "DE" });
    expect(r.status).toBe(400);
    hasSecurityHeaders(r);
    expect((await handle(new Request("https://testnet.hlotrade.xyz/api/register", { method: "POST", body: "{}" }), env({ HLO_NETWORK: undefined }), { country: "DE" })).status).toBe(503);
  });
  it("the default export reads request.cf", async () => {
    const r = Object.assign(get("/"), { cf: { country: "US" } });
    expect((await worker.fetch(r, env())).status).toBe(451);
  });
});
