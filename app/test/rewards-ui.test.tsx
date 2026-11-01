// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LatestFile } from "../src/rewards/files";
import { UPDATING, type ClaimPlan, type Yours } from "../src/rewards/model";
import { vaultRuleText } from "../src/rewards/view";
import { VaultCard } from "../src/ui/rewards/VaultCard";
import { YoursCard } from "../src/ui/rewards/YoursCard";

afterEach(cleanup);
const E18 = 10n ** 18n;
const yours: Yours = { earned: 120n * E18, claimed: 20n * E18, claimable: 100n * E18, claimNow: 100n * E18, youGet: 90n * E18, refined: 7n * E18, points: 65_727_600n, vaultShare: 3n * E18 };
const plan = (kind: ClaimPlan["kind"]): ClaimPlan => ({ kind, cp: { throughMinute: 1, refBlock: 2n, root: `0x${"11".repeat(32)}`, totalEntitled: 3n }, sig: "0x", entitlement: 120n * E18, expectClaimed: 120n * E18, proof: [] });
const claim = (o: object = {}) => ({ allowed: true, busy: false, msg: null, onClaim: () => {}, ...o });
const SETTLED = "settled through 08:20 UTC";

describe("YoursCard", () => {
  const card = (o: object = {}) => render(<YoursCard yours={yours} plan={plan("settleAndClaim")} problem={null} settled={SETTLED} claim={claim()} {...o} />);
  it("shows the four rows, the 90% sub-line, how far it is settled and the gas note", () => {
    const { container } = card();
    expect(screen.getByText("Earned so far").nextSibling?.textContent).toBe("120.00 HLO");
    expect(screen.getByText("Claimed").nextSibling?.textContent).toBe("20.00 HLO");
    expect(screen.getByText("Claimable now").nextSibling?.textContent).toBe("100.00 HLO");
    expect(screen.getByText("Refining earned").nextSibling?.textContent).toBe("7.00 HLO");
    expect(screen.getByText("You receive 90%: 90.00 HLO. The other 10% is refining, shared with holders who have not claimed yet.")).toBeTruthy();
    expect(screen.getByText(SETTLED)).toBeTruthy();
    expect(screen.getByText("Claiming happens on HyperEVM and needs a little HYPE for gas.")).toBeTruthy();
    expect(container.textContent).not.toMatch(/\bpots?\b|\bpops?\b|jackpot|lottery|prize|today|\bday\b/i);
  });
  it("claimNow below claimable adds the allowance line with the amount that can be claimed now; the Claimable row stays the full amount", () => {
    card({ yours: { ...yours, claimNow: 40n * E18, youGet: 36n * E18 } });
    expect(screen.getByText("Claimable now").nextSibling?.textContent).toBe("100.00 HLO");
    expect(screen.getByText("Claims share an hourly allowance. You can claim 40.00 HLO now; the rest stays claimable.")).toBeTruthy();
    expect(screen.getByText(/You receive 90%: 36\.00 HLO/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Settle & claim" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("no allowance line when nothing, or only dust (under 0.01 HLO), can be claimed now: the card's limit text covers it", () => {
    const { unmount } = card({ yours: { ...yours, claimNow: 0n, youGet: 0n } });
    expect(screen.queryByText(/hourly allowance/)).toBeNull();
    unmount();
    card({ yours: { ...yours, claimNow: 10n ** 16n - 1n, youGet: 0n } });
    expect(screen.queryByText(/hourly allowance/)).toBeNull();
  });
  it("limited (nothing or only dust can be claimed now): the 'You receive 90%' line is hidden", () => {
    const { unmount } = card({ yours: { ...yours, claimNow: 0n, youGet: 0n } });
    expect(screen.queryByText(/You receive 90%/)).toBeNull();
    unmount();
    card({ yours: { ...yours, claimNow: 10n ** 16n - 1n, youGet: 0n } });
    expect(screen.queryByText(/You receive 90%/)).toBeNull();
  });
  it("no allowance line when everything claimable can be claimed now", () => {
    card();
    expect(screen.queryByText(/hourly allowance/)).toBeNull();
  });
  it("the button reads Settle & claim for a settleAndClaim plan and Claim for a claim plan, and calls onClaim", () => {
    const onClaim = vi.fn();
    const { unmount } = card({ claim: claim({ onClaim }) });
    fireEvent.click(screen.getByRole("button", { name: "Settle & claim" }));
    expect(onClaim).toHaveBeenCalledTimes(1);
    unmount();
    card({ plan: plan("claim") });
    expect((screen.getByRole("button", { name: "Claim" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("is off with no plan, when busy (saying so), and when not allowed (saying why)", () => {
    const { unmount } = card({ plan: null });
    expect((screen.getByRole("button", { name: "Claim" }) as HTMLButtonElement).disabled).toBe(true);
    unmount();
    const b = card({ claim: claim({ busy: true }) });
    expect((screen.getByRole("button", { name: "Confirm in your wallet…" }) as HTMLButtonElement).disabled).toBe(true);
    b.unmount();
    card({ claim: claim({ allowed: false, blockedText: "Open HLO on the device with your wallet to do this." }) });
    expect((screen.getByRole("button", { name: "Settle & claim" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Open HLO on the device with your wallet to do this.")).toBeTruthy();
  });
  it("a problem is shown as a warning and turns the button off", () => {
    card({ problem: "Rewards are updating…" });
    expect(screen.getByText("Rewards are updating…").className).toContain("warn");
    expect((screen.getByRole("button", { name: "Settle & claim" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("a wallet file that is behind the chain still shows its numbers, says the rewards are updating, and Claim stays off because there is no plan", () => {
    card({ plan: null, problem: UPDATING });
    expect(screen.getByText("Earned so far").nextSibling?.textContent).toBe("120.00 HLO");
    expect(screen.getByText(UPDATING).className).toContain("warn");
    expect((screen.getByRole("button", { name: "Claim" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("with no usable file the numbers are dashes, never NaN or zero", () => {
    const { container } = card({ yours: null, plan: null, problem: "Rewards are updating…" });
    expect(screen.getByText("Claimable now").nextSibling?.textContent).toBe("—");
    expect(screen.getByText("Earned so far").nextSibling?.textContent).toBe("—");
    expect(screen.queryByText(/You receive 90%/)).toBeNull();
    expect(container.textContent).not.toMatch(/NaN/);
  });
  it("shows the message after a send", () => {
    card({ claim: claim({ msg: "Claimed." }) });
    expect(screen.getByText("Claimed.")).toBeTruthy();
  });
});

describe("VaultCard", () => {
  const NOW = 1_000_000;
  const LAUNCH = NOW - 86_400;
  const latest = (o: object = {}) =>
    ({ vault: { amount: (50n * E18).toString(), pointsTotal: "131455200", odds: 1250, lastPopMinute: -1 }, pops: [], ...o }) as unknown as LatestFile;
  const card = (o: Partial<Parameters<typeof VaultCard>[0]> = {}) =>
    render(<VaultCard latest={latest()} yours={yours} now={NOW} launchTime={LAUNCH} odds={1250} {...o} />);
  it("under 1 point it says how much more trading a share needs; at 1 point or with none it says nothing", () => {
    card({ yours: { ...yours, points: 79_000_000n } });
    expect(screen.getByText("You need 1 point to share in a pop: $210 more in trades.")).toBeTruthy();
    cleanup();
    card({ yours: { ...yours, points: 100_000_000n } });
    expect(screen.queryByText(/You need 1 point/)).toBeNull();
    cleanup();
    card({ yours: { ...yours, points: 0n } });
    expect(screen.queryByText(/You need 1 point/)).toBeNull();
  });
  it("states the rule and shows the vault, your points since the last pop and your share if it popped now", () => {
    const { container } = card();
    expect(screen.getByText("Vault")).toBeTruthy();
    expect(screen.getByText(vaultRuleText(1250))).toBeTruthy();
    expect(screen.getByText("In the vault").nextSibling?.textContent).toBe("50.00 HLO");
    expect(screen.getByText("Your points since the last pop").nextSibling?.textContent).toBe("0.65");
    expect(screen.getByText("Your share if it popped now").nextSibling?.textContent).toBe("3.00 HLO");
    expect(screen.queryByText(/Popped/)).toBeNull();
    expect(container.textContent).not.toMatch(/opens in|week|jackpot|lottery|prize|motherlode|\bwins?\b/i);
  });
  it("the rule's numbers are the file's odds", () => {
    card({ latest: latest({ vault: { amount: "0", pointsTotal: "0", odds: 60, lastPopMinute: -1 } }), odds: 60 });
    expect(screen.getByText(/a 1 in 60 chance to pop \(about once an hour\)/)).toBeTruthy();
  });
  it("shows the newest pop, by chain time", () => {
    // minute 1379 ends at LAUNCH + 60 × 1380 = NOW − 3600
    card({ latest: latest({ pops: [{ minute: 1379, block: "900", amount: (12n * E18).toString(), kept: E18.toString(), recipients: 41 }, { minute: 2, block: "5", amount: "1", kept: "1", recipients: 1 }] }) });
    expect(screen.getByText("Popped 1h 0m ago: 12.00 HLO to 41 traders.")).toBeTruthy();
  });
  it("with no wallet the user rows are dashes but the vault shows", () => {
    card({ yours: null });
    expect(screen.getByText("In the vault").nextSibling?.textContent).toBe("50.00 HLO");
    expect(screen.getByText("Your points since the last pop").nextSibling?.textContent).toBe("—");
    expect(screen.getByText("Your share if it popped now").nextSibling?.textContent).toBe("—");
  });
  it("a connected wallet with no entry (all zeros) shows 0.00 points and a 0.00 HLO share, never a dash", () => {
    const none: Yours = { earned: 0n, claimed: 0n, claimable: 0n, claimNow: 0n, youGet: 0n, refined: 0n, points: 0n, vaultShare: 0n };
    card({ yours: none });
    expect(screen.getByText("Your points since the last pop").nextSibling?.textContent).toBe("0.00");
    expect(screen.getByText("Your share if it popped now").nextSibling?.textContent).toBe("0.00 HLO");
    expect(screen.getByText("In the vault").nextSibling?.textContent).toBe("50.00 HLO");
  });
  describe("the vault popped after the wallet's file (above 2,000 wallets the files lag latest.json by up to 15 minutes)", () => {
    // The vault and the pop come from latest.json, the wallet's points and share from its file. A pop newer than the file means
    // the file's points are the pre-pop ones and the share could exceed the vault: dashes, the only exception to 0.00.
    const popped = (minute: number) => latest({ vault: { amount: (5n * E18).toString(), pointsTotal: "131455200", odds: 1250, lastPopMinute: minute }, pops: [] });
    it("shows a dash for points and share while the last pop is newer than the file, and the vault as latest.json says", () => {
      card({ latest: popped(12), yours, yoursAt: 10 });
      expect(screen.getByText("In the vault").nextSibling?.textContent).toBe("5.00 HLO");
      expect(screen.getByText("Your points since the last pop").nextSibling?.textContent).toBe("—");
      expect(screen.getByText("Your share if it popped now").nextSibling?.textContent).toBe("—");
    });
    it("shows the numbers when the file is at the pop's minute or later, or the vault has not popped, or there is no file minute", () => {
      for (const [lastPop, at] of [[10, 10], [10, 14], [-1, 0], [-1, 3]] as const) {
        card({ latest: popped(lastPop), yours, yoursAt: at });
        expect(screen.getByText("Your points since the last pop").nextSibling?.textContent, `${lastPop}/${at}`).toBe("0.65");
        expect(screen.getByText("Your share if it popped now").nextSibling?.textContent, `${lastPop}/${at}`).toBe("3.00 HLO");
        cleanup();
      }
    });
    it("a connected wallet with no file at all (yoursAt null, zeros) still shows 0.00, whatever the pop", () => {
      const none: Yours = { earned: 0n, claimed: 0n, claimable: 0n, claimNow: 0n, youGet: 0n, refined: 0n, points: 0n, vaultShare: 0n };
      card({ latest: popped(12), yours: none, yoursAt: null });
      expect(screen.getByText("Your points since the last pop").nextSibling?.textContent).toBe("0.00");
      expect(screen.getByText("Your share if it popped now").nextSibling?.textContent).toBe("0.00 HLO");
    });
    it("a missing yoursAt (an older caller) changes nothing", () => {
      card({ latest: popped(12), yours });
      expect(screen.getByText("Your points since the last pop").nextSibling?.textContent).toBe("0.65");
    });
  });
  it("with no usable file the card keeps its rule (the network's odds) and every number is a dash", () => {
    const { container } = card({ latest: null, yours: null, odds: 60 });
    expect(screen.getByText("Vault")).toBeTruthy();
    expect(screen.getByText(vaultRuleText(60))).toBeTruthy();
    for (const k of ["In the vault", "Your points since the last pop", "Your share if it popped now"]) expect(screen.getByText(k).nextSibling?.textContent).toBe("—");
    expect(container.textContent).not.toMatch(/NaN|undefined/);
  });
});
