import { describe, expect, it } from "vitest";
import { SECURITY_HEADERS } from "../worker/headers";

describe("the Worker's security headers (were vercel.json's)", () => {
  it("allows the camera for this origin only (the pairing scanner) and keeps the rest off", () => {
    const p = SECURITY_HEADERS["Permissions-Policy"];
    expect(p).toContain("camera=(self)");
    expect(p).not.toContain("camera=()");
    for (const off of ["microphone=()", "geolocation=()", "payment=()", "usb=()"]) expect(p).toContain(off);
  });
  it("still forbids framing", () => {
    expect(SECURITY_HEADERS["X-Frame-Options"]).toBe("DENY");
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toBe("frame-ancestors 'none'");
  });
});
