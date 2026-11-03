// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { introCards } from "../src/rewards/intro";

vi.mock("../src/config/context", () => ({ useConfig: () => ({ network: "mainnet", hyperEvmChainId: 999 }) }));
import { IntroModal } from "../src/ui/intro/IntroModal";

afterEach(cleanup);
const alts = introCards(1250).map((c) => c.alt);

describe("IntroModal", () => {
  it("Next walks through the cards; the last one has Start and no Skip", () => {
    const onClose = vi.fn();
    render(<IntroModal onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "How HLO works" })).toBeTruthy();
    for (let i = 0; i < alts.length; i++) {
      expect(screen.getByRole("img", { name: alts[i] })).toBeTruthy();
      expect(screen.getByRole("img", { name: `Card ${i + 1} of ${alts.length}` })).toBeTruthy();
      if (i < alts.length - 1) {
        expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
      }
    }
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("Skip and ✕ close it", () => {
    const onClose = vi.fn();
    render(<IntroModal onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
