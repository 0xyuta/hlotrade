// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HaloLogo } from "../src/ui/Logo";

afterEach(cleanup);

describe("HaloLogo", () => {
  it("is decorative, and two on one page use their own gradient and mask ids", () => {
    const { container } = render(<div><HaloLogo size={28} /><HaloLogo size={28} /></div>);
    const svgs = container.querySelectorAll("svg");
    expect(svgs).toHaveLength(2);
    for (const s of svgs) expect(s.getAttribute("aria-hidden")).toBe("true");
    const ids = [...container.querySelectorAll("[id]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z][\w-]*$/); // safe inside url(#…)
    for (const el of container.querySelectorAll("[stroke^='url('], [fill^='url('], [mask^='url(']")) {
      const ref = /url\(#([^)]+)\)/.exec(el.getAttribute("stroke") ?? el.getAttribute("fill") ?? el.getAttribute("mask") ?? "")?.[1];
      expect(ids).toContain(ref);
    }
  });
});
