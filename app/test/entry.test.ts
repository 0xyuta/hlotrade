import { describe, expect, it, vi } from "vitest";
import { takeEntry } from "../src/entry";

const at = (pathname: string, hash = "") => ({ location: { pathname, hash }, history: { replaceState: vi.fn() } });

describe("takeEntry", () => {
  it("any path but /pair is the app, and the address is not touched", () => {
    const w = at("/", "#x");
    expect(takeEntry(w)).toEqual({ page: "app" });
    expect(w.history.replaceState).not.toHaveBeenCalled();
  });
  it("/pair is the pair page", () => {
    const w = at("/pair");
    expect(takeEntry(w)).toEqual({ page: "pair", legacyLink: false });
    expect(w.history.replaceState).not.toHaveBeenCalled();
  });
  it("an old /pair#<key> link: the fragment is dropped from the address bar, unread, and the page says the link is no longer used", () => {
    const w = at("/pair", "#eyJ2IjoxLCJuZXQiOiJ0ZXN0bmV0In0");
    const e = takeEntry(w);
    expect(e).toEqual({ page: "pair", legacyLink: true });
    expect(JSON.stringify(e)).not.toContain("eyJ");
    expect(w.history.replaceState).toHaveBeenCalledWith(null, "", "/pair");
  });
  it("a bare '#' is not a link, but is still dropped", () => {
    const w = at("/pair", "#");
    expect(takeEntry(w)).toEqual({ page: "pair", legacyLink: false });
    expect(w.history.replaceState).toHaveBeenCalledWith(null, "", "/pair");
  });
});
