/** Every response the Worker returns carries these (they were vercel.json's). /assets/* gets them from public/_headers. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=()",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  "Strict-Transport-Security": "max-age=31536000",
};

/** A copy of `res` with the security headers set (a fetched or redirect Response's headers are immutable). */
export function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}
