import { readFileSync } from "node:fs";
import { HLO, MAX_SUPPLY as CALC_MAX_SUPPLY, POOL_RESERVE, TRADER_PER_MINUTE as CALC_TRADER, VAULT_PER_MINUTE as CALC_VAULT } from "@hlo/calc";
import { describe, expect, it } from "vitest";
import {
  BURN_PCT, BUYBACK_PCT, BUY_EVERY_MINUTES, BUY_SLICES, CLAIM_CAP, CLAIM_PAID_PCT, CLAIM_PER_HOUR, MAX_SUPPLY, POOL_OPEN_DAYS,
  POOL_OPEN_EXTRA_HOURS, POOL_SEED, TRADER_PER_MINUTE, VAULT_PAY_PCT, VAULT_PER_MINUTE,
} from "../src/rewards/constants";
import { builderFeeText, contractList, liveFigures, liveNotes, tokenContract, tokenomicsFlows, tokenomicsSections, VERIFIED_TEXT } from "../src/rewards/tokenomics";

describe("contractList", () => {
  const contracts = {
    token: "0x01", checkpoints: "0x02", mining: "0x03", staking: "0x04", buyback: "0x05", splitter: "0x06", profiles: "0x07", pair: "0x08",
  } as never;
  it("mainnet: the seven HLO contracts, each linking to its verified source, and the verified note", () => {
    const l = contractList({ network: "mainnet", contracts })!;
    expect(l.rows.map((r) => [r.name, r.address])).toEqual([
      ["HLO token", "0x01"], ["Mining", "0x03"], ["Checkpoints", "0x02"], ["Staking", "0x04"], ["Buyback", "0x05"], ["Splitter", "0x06"], ["Profiles", "0x07"],
    ]);
    expect(l.rows[0].url).toBe("https://hyperevmscan.io/address/0x01#code");
    expect(l.rows.find((r) => r.name === "Splitter")!.job).toBe("Sends 90% of fees to the buyback");
    expect(l.note).toBe(VERIFIED_TEXT);
  });
  it("testnet: addresses only, no links and no verified note; nothing before a deployment", () => {
    const l = contractList({ network: "testnet", contracts })!;
    expect(l.rows.every((r) => r.url === null)).toBe(true);
    expect(l.note).toBeNull();
    expect(contractList({ network: "mainnet", contracts: null })).toBeNull();
  });
});

describe("tokenContract", () => {
  const token = "0xa4Bb42d6D7F36b6EA0C4A0890691826C9C077005" as const;
  it("mainnet: the address and its HyperEVMScan page", () => {
    expect(tokenContract({ network: "mainnet", contracts: { token } as never })).toEqual({ address: token, explorerUrl: `https://hyperevmscan.io/token/${token}` });
  });
  it("testnet: the address, no explorer link; nothing before a deployment", () => {
    expect(tokenContract({ network: "testnet", contracts: { token } as never })).toEqual({ address: token, explorerUrl: null });
    expect(tokenContract({ network: "mainnet", contracts: null })).toBeNull();
  });
});

const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const E18 = 10n ** 18n;

describe("the Tokenomics numbers are the protocol's (the bundle never imports calc or reads the contracts)", () => {
  it("supply and emission are calc's", () => {
    expect(MAX_SUPPLY).toBe(CALC_MAX_SUPPLY);
    expect(POOL_SEED).toBe(POOL_RESERVE);
    expect(TRADER_PER_MINUTE).toBe(CALC_TRADER);
    expect(VAULT_PER_MINUTE).toBe(CALC_VAULT);
  });
  it("the contracts' constants", () => {
    expect(src("contracts/src/HloToken.sol")).toContain("uint256 public constant MAX_SUPPLY = 5_000_000e18;");
    expect(MAX_SUPPLY).toBe(5_000_000n * HLO);
    const bb = src("contracts/src/Buyback.sol");
    expect(bb).toContain("uint256 public constant POOL_HLO = 10_000e18;");
    expect(POOL_SEED).toBe(10_000n * HLO);
    expect(bb).toContain(`uint256 public constant BUY_INTERVAL = ${BUY_EVERY_MINUTES} minutes;`);
    expect(bb).toContain(`uint256 public constant SLICES = ${BUY_SLICES};`);
    expect(bb).toContain("uint256 public constant BURN_BPS = 9_000;");
    expect(BURN_PCT).toBe(90);
    expect(src("contracts/src/Mining.sol")).toContain("paid = gross * 9 / 10;");
    expect(CLAIM_PAID_PCT).toBe(90);
    expect(src("contracts/src/Splitter.sol")).toContain("uint256 toAdmin = amount / 10;");
    expect(BUYBACK_PCT).toBe(90);
    const deploy = src("contracts/script/Deploy.s.sol");
    expect(deploy).toContain("uint256 public constant DEFAULT_CLAIM_CAP = 5000 ether;");
    expect(deploy).toContain("uint256 public constant DEFAULT_CLAIM_PER_HOUR = 330 ether;");
    expect(CLAIM_CAP).toBe(5000n * E18);
    expect(CLAIM_PER_HOUR).toBe(330n * E18);
  });
  it("the pool opens 7 days and 1 hour after launch, seeded with all the buyback's USDC (final review I2)", () => {
    const bb = src("contracts/src/Buyback.sol");
    expect(bb).toContain(`uint256 public constant OPEN_DELAY = ${POOL_OPEN_DAYS} days;`);
    expect(bb).toContain("if (block.timestamp < launchTime + OPEN_DELAY) revert TooEarly();");
    expect(bb).toContain("uint256 u = IBalanceOf(usdc).balanceOf(address(this));");
    expect(bb).toContain("SafeTransfer.transfer(usdc, address(pair), u);");
    expect(bb).toContain("if (!poolOpen) revert PoolNotOpen();"); // no buy before it opens
    const deploy = src("contracts/script/Deploy.s.sol");
    expect(deploy).toContain(`uint256 public constant LAUNCH_MARGIN = ${POOL_OPEN_EXTRA_HOURS} hours;`);
    expect(deploy).toContain("Checkpoints(d.checkpoints).launchTime() + LAUNCH_MARGIN");
  });
  it("refining is shared with everyone whose earned HLO is above what they claimed, by that unclaimed balance (calc)", () => {
    const cp = src("calc/src/checkpoint.ts");
    expect(cp).toContain("if (e > cl) {");
    expect(cp).toContain("base.push([u, e - cl]);");
    expect(cp).toContain("const a = (pool * b) / total;");
  });
  it("a pop pays calc's 90% by points", () => {
    expect(src("calc/src/checkpoint.ts")).toContain("const pay = (v * 9n) / 10n;");
    expect(VAULT_PAY_PCT).toBe(90);
  });
  it("the builder fee is the one orders carry (f = 100 → 0.1%)", () => {
    expect(builderFeeText()).toBe("0.1%");
  });
});

describe("tokenomicsSections", () => {
  it("mainnet (odds 1,250)", () => {
    expect(tokenomicsSections(1250)).toEqual([
      {
        title: "Supply",
        lines: [
          "A cap of 5,000,000 HLO.",
          "The trading pool opens 7 days and 1 hour after launch, seeded with 10,000 HLO and all the USDC the buyback collected until then. Its pool tokens are locked forever.",
          "HLO that is burned can be mined again: the cap counts what exists.",
        ],
      },
      { title: "Mining, every minute", lines: ["1 HLO goes to that minute's traders, shared by the builder fees they paid.", "A minute nobody trades sends its 1 HLO to the vault."] },
      {
        title: "The vault",
        lines: [
          "0.1 HLO goes in every minute.",
          "Each minute it has a 1 in 1,250 chance to pop (about once every 21 hours).",
          "When it pops, 90% is shared by points among wallets with at least 1 point (1 point per $1,000 traded since the last pop) and 10% stays.",
        ],
      },
      {
        title: "Claiming",
        lines: [
          "A claim pays 90%. The other 10% is refined: shared with everyone who holds unclaimed HLO, by their unclaimed balance.",
          "Claims draw from a shared allowance of 5,000 HLO, refilling 330 HLO an hour.",
        ],
      },
      {
        title: "Fees",
        lines: [
          "A 0.1% builder fee on every trade: 90% goes to the buyback and 10% to the team.",
          "Until the trading pool opens (7 days and 1 hour after launch), the buyback only collects USDC. All of it goes into the pool with the 10,000 HLO, locked forever.",
          "After that, the buyback can spend a 1/144 slice of its USDC on HLO every 10 minutes. Anyone can start a buy, and HLO's keeper does once a buy would spend at least $10. 90% of the HLO it buys is burned and 10% goes to stakers.",
        ],
      },
    ]);
  });
  it("testnet (odds 60)", () => {
    expect(tokenomicsSections(60)[2].lines[1]).toBe("Each minute it has a 1 in 60 chance to pop (about once an hour).");
  });
  it("the wording rule holds in every text", () => {
    const all = [...tokenomicsSections(1250), ...tokenomicsSections(60)].flatMap((s) => [s.title, ...s.lines]).concat(tokenomicsFlows().flatMap((f) => [f.label, ...f.steps]));
    for (const t of all) expect(t, t).not.toMatch(/jackpot|lottery|prize|motherlode|\bwin|\bORE\b/i);
  });
});

describe("tokenomicsFlows", () => {
  it("fees to the buyback to burn and stakers; the minute's HLO to traders and the vault", () => {
    expect(tokenomicsFlows()).toEqual([
      {
        label: "Fees",
        steps: [
          "0.1% builder fee on every trade",
          "90% to the buyback",
          "until the pool opens: into the pool with 10,000 HLO, locked forever",
          "after it opens: buys back HLO",
          "90% burned · 10% to stakers",
        ],
      },
      { label: "Mining", steps: ["1.1 HLO a minute", "1 HLO to traders · 0.1 HLO to the vault", "the vault pops: 90% by points"] },
    ]);
  });
});

describe("liveFigures", () => {
  it("the protocol, staking and vault reads", () => {
    expect(liveFigures({ totalBurned: 1234n * E18 + E18 / 2n, totalBought: 2000n * E18, totalStaked: 300n * E18 }, 50n * E18)).toEqual([
      { label: "Total burned", value: "1,234.50 HLO" },
      { label: "HLO bought back", value: "2,000.00 HLO" },
      { label: "Total staked", value: "300.00 HLO" },
      { label: "In the vault", value: "50.00 HLO" },
    ]);
  });
  it("dashes for what is not read (not deployed, or not answered yet)", () => {
    expect(liveFigures(null, null).map((f) => f.value)).toEqual(["—", "—", "—", "—"]);
  });
});

describe("liveNotes (why a Live figure is a dash)", () => {
  it("the Staking and Buyback reads failed, or the rewards file was refused: the Rewards screen's texts", () => {
    expect(liveNotes({ full: null, extraError: "HTTP 500", latest: null, latestProblem: "The reward files could not be read (timeout)." })).toEqual([
      "Not available right now: HTTP 500",
      "The reward files could not be read (timeout).",
    ]);
  });
  it("nothing while the reads are pending or when all is well", () => {
    expect(liveNotes({ full: null, extraError: null, latest: null, latestProblem: null })).toEqual([]);
    expect(liveNotes({ full: {}, extraError: null, latest: {}, latestProblem: null })).toEqual([]);
  });
});
