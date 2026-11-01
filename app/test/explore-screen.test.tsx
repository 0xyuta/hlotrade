// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Fill } from "../src/hl/account";
import type { RewardsState } from "../src/rewards/useRewards";

const LAUNCH = 1_000_000;
const ME = "0x517b22f40b1b9bebf1776fa9d732e2c27fdeb590";
let state: RewardsState;
let master: string | null;
let fills: Fill[];
let tables: Map<number, Map<string, bigint>>;
let failed: Set<number>;
const wantedSeen: number[][] = [];

vi.mock("../src/hl/TradingProvider", () => ({ useTrading: () => ({ master }) }));
vi.mock("../src/hl/AccountProvider", () => ({ useAccount: () => ({ fills }) }));
vi.mock("../src/rewards/useRewards", () => ({ useRewards: () => ({ state, reload: vi.fn(), hold: vi.fn() }) }));
vi.mock("../src/rewards/useMinuteTables", () => ({
  useMinuteTables: (wanted: number[]) => {
    wantedSeen.push(wanted);
    return { tables, failed };
  },
}));

import { ExploreScreen } from "../src/ui/explore/ExploreScreen";

const ready = (o: { now?: number; through?: number | null; settled?: number | null; paused?: boolean; problem?: string | null; pops?: object[] } = {}): RewardsState => {
  const through = o.through === undefined ? 10 : o.through;
  return {
    kind: "ready",
    data: {
      chain: { now: o.now ?? LAUNCH + 60 * 12 + 5, launchTime: LAUNCH, latestValidMinute: o.settled === undefined ? 8 : o.settled, paused: o.paused ?? false },
      latest: through === null ? null : { throughMinute: through, pops: o.pops ?? [], vault: { amount: "0" }, table: "minute,user,fee" },
      latestProblem: o.problem ?? null,
    },
  } as unknown as RewardsState;
};
const fill = (minute: number, builderFee: number, tid: number, over: Partial<Fill> = {}): Fill => ({
  coin: "BTC", px: 100_000, sz: builderFee / 100, side: "B", time: (LAUNCH + minute * 60 + 5) * 1000, dir: "Open Long", closedPnl: 0, fee: builderFee, builderFee, oid: 1, tid, ...over,
});
const card = (title: string) => screen.getByRole("heading", { name: title }).closest("section") as HTMLElement;

beforeEach(() => {
  state = ready();
  master = ME;
  fills = [];
  tables = new Map();
  failed = new Set();
  wantedSeen.length = 0;
});
afterEach(cleanup);

describe("Explore", () => {
  it("says it is off on a network with no contracts, and offers a retry when the chain is down", () => {
    state = { kind: "off" };
    render(<ExploreScreen />);
    expect(screen.getByText(/not deployed on this network/)).toBeTruthy();
    cleanup();
    state = { kind: "down", error: "no answer" };
    render(<ExploreScreen />);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
  it("the status: on time, the last counted minute and what is on chain", () => {
    state = ready({ now: LAUNCH + 60 * 12 + 5, through: 10, settled: 8 });
    render(<ExploreScreen />);
    const c = within(card("Live status"));
    expect(c.getByText("On time")).toBeTruthy();
    expect(c.getByText("10")).toBeTruthy();
    expect(c.getByText("8")).toBeTruthy();
  });
  it("the status says how late, and warns when claims are paused or the file has a problem", () => {
    state = ready({ now: LAUNCH + 60 * 30, through: 10, paused: true, problem: "Rewards are updating…" });
    render(<ExploreScreen />);
    const c = within(card("Live status"));
    expect(c.getByText("Running 19 minutes late")).toBeTruthy();
    expect(c.getByText(/Claims are paused/)).toBeTruthy();
    expect(c.getByText("Rewards are updating…")).toBeTruthy();
  });
  it("the minutes show their status, totals and a pop", () => {
    state = ready({ now: LAUNCH + 60 * 13, through: 10, settled: 8, pops: [{ minute: 9, block: "1", amount: "1000000000000000000", kept: "0", recipients: 2 }] });
    tables = new Map([[10, new Map([[ME, 79_943_800n]])], [9, new Map()]]);
    render(<ExploreScreen />);
    const rows = within(card("Minutes")).getAllByRole("row").slice(1);
    const row = (i: number) => within(rows[i]);
    expect(row(0).getByText("12")).toBeTruthy();
    expect(row(0).getByText("Pending")).toBeTruthy();
    expect(row(2).getByText("Counted")).toBeTruthy();
    expect(row(2).getByText("$0.80")).toBeTruthy();
    expect(row(3).getByText("Popped")).toBeTruthy();
    expect(row(4).getByText("On chain")).toBeTruthy();
  });
  it("asks for the shown minutes and the trades' minutes, only those published", () => {
    fills = [fill(11, 1, 1), fill(2, 1, 2)];
    render(<ExploreScreen />);
    const wanted = wantedSeen[wantedSeen.length - 1];
    expect(wanted).toContain(10);
    expect(wanted).toContain(2);
    expect(wanted).not.toContain(11);
  });
  it("without a wallet it asks to connect and still shows the minutes", () => {
    master = null;
    render(<ExploreScreen />);
    expect(screen.getByText(/Connect a wallet/)).toBeTruthy();
    expect(within(card("Minutes")).getAllByRole("row").length).toBeGreaterThan(1);
  });
  it("each trade shows its status, and a miss says why", () => {
    fills = [fill(11, 1, 1), fill(10, 1, 2), fill(9, 1, 3), fill(7, 1, 4), fill(6, 0, 5)];
    tables = new Map([[10, new Map([[ME, 100_000_000n]])], [9, new Map()]]);
    failed = new Set([7]);
    render(<ExploreScreen />);
    const rows = within(card("Your trades")).getAllByRole("row").slice(1);
    expect(rows.length).toBe(4); // the trade with no builder fee was not placed through HLO
    expect(within(rows[0]).getByText("Pending")).toBeTruthy();
    expect(within(rows[0]).getByText("1.00")).toBeTruthy();
    expect(within(rows[1]).getByText("Counted")).toBeTruthy();
    expect(within(rows[1]).getByText("1.00")).toBeTruthy();
    expect(within(rows[2]).queryByText("1.00")).toBeNull(); // not counted: no points
    expect(within(rows[2]).getByText("Not counted")).toBeTruthy();
    expect(within(rows[2]).getByText(/Enable trading/)).toBeTruthy();
    expect(within(rows[3]).getByText("Could not check")).toBeTruthy();
  });
  it("no file: no minutes list, and the problem is on the status card", () => {
    state = ready({ through: null, problem: "The reward files could not be read (x)." });
    render(<ExploreScreen />);
    expect(screen.getByText("No published minutes to show right now.")).toBeTruthy();
    expect(screen.getByText("The reward files could not be read (x).")).toBeTruthy();
  });
  it("the pops: what went out, what stayed and how many wallets; one with no points says so", () => {
    state = ready({ pops: [{ minute: 9, block: "1", amount: "717858000000000000000", kept: "79762000000000000000", recipients: 1 }, { minute: 5, block: "1", amount: "0", kept: "5000000000000000000", recipients: 0 }] });
    render(<ExploreScreen />);
    const c = within(card("Recent vault pops"));
    expect(c.getByText("717.86 HLO")).toBeTruthy();
    expect(c.getByText(/nobody had 1 point/)).toBeTruthy();
  });
  it("never uses the words the project does not use", () => {
    fills = [fill(10, 1, 1)];
    state = ready({ pops: [{ minute: 9, block: "1", amount: "1", kept: "1", recipients: 0 }] });
    const { container } = render(<ExploreScreen />);
    expect(container.textContent).not.toMatch(/jackpot|lottery|prize|motherlode|\bwin\b/i);
  });
});
