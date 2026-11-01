import { isBlocked } from "../src/geo/blocked.js";
import type { Cf, Env } from "./env.js";
import { withSecurityHeaders } from "./headers.js";
import { bindingStore, register } from "./register.js";

/**
 * The app's only server code (Cloudflare Worker with static assets, app/wrangler.jsonc). It runs before every request
 * except the hashed /assets/* files: country block, then /api/register, then the www redirect, then the built app.
 */

const BLOCKED_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HLO</title></head>' +
  '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f1e7;color:#2a2118;font-family:system-ui,sans-serif">' +
  "<p>HLO is not available in your region.</p></body></html>";

const api = (status: number, error: string, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

export async function handle(request: Request, env: Env, cf: Cf | undefined): Promise<Response> {
  if (isBlocked(cf?.country, cf?.regionCode)) {
    return withSecurityHeaders(new Response(BLOCKED_PAGE, { status: 451, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }));
  }
  const url = new URL(request.url);
  if (url.pathname === "/api/register") {
    if (request.method !== "POST") return withSecurityHeaders(api(405, "Method not allowed.", { allow: "POST" }));
    return withSecurityHeaders(await register(request, env.HLO_NETWORK, bindingStore(env.REGISTRY)));
  }
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return withSecurityHeaders(api(404, "Not found."));
  if (url.hostname.startsWith("www.")) {
    return withSecurityHeaders(Response.redirect(`https://${url.hostname.slice("www.".length)}${url.pathname}${url.search}`, 301));
  }
  const res = await env.ASSETS.fetch(request);
  // The app's own SPA fallback (wrangler.jsonc has not_found_handling "none"): the platform's fallback would also serve
  // index.html for a missing /assets/* file without running this Worker, past the country block. Here every page runs
  // the block above, and a missing /assets/* file stays a plain 404. Fetch "/" (not /index.html: html_handling redirects it).
  if (res.status === 404 && (request.method === "GET" || request.method === "HEAD")) {
    void res.body?.cancel().catch(() => undefined);
    return withSecurityHeaders(await env.ASSETS.fetch(new Request(new URL("/", url), request)));
  }
  return withSecurityHeaders(res);
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env, (request as Request & { cf?: Cf }).cf);
  },
};
