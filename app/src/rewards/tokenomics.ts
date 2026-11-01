import { BUILDER_FEE_RATE } from "../hl/math";
import { fmtHlo } from "../ui/format";
import {
  BURN_PCT, BUYBACK_PCT, BUY_EVERY_MINUTES, BUY_SLICES, CLAIM_CAP, CLAIM_PAID_PCT, CLAIM_PER_HOUR, MAX_SUPPLY, POOL_OPEN_DAYS,
  POOL_OPEN_EXTRA_HOURS, POOL_SEED, TRADER_PER_MINUTE, VAULT_PAY_PCT, VAULT_PER_MINUTE,
} from "./constants";
import { notAvailableText, popOftenText } from "./view";

/** The Tokenomics tab's texts (spec 2026-10-30 referrals §5). Every number comes from constants.ts, the odds from POP_ODDS. */
export interface TokenomicsSection {
  title: string;
  lines: string[];
}
export interface Flow {
  label: string;
  steps: string[];
}
export interface LiveFigure {
  label: string;
  value: string;
}

const hlo = (x: bigint, d = 0) => `${fmtHlo(x, d)} HLO`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** "7 days and 1 hour after launch" (Buyback.OPEN_DELAY after a launch time 1 hour past mining's). */
const poolOpensText = () => `${plural(POOL_OPEN_DAYS, "day")} and ${plural(POOL_OPEN_EXTRA_HOURS, "hour")} after launch`;

/** The builder fee every order carries, as a percent: BUILDER_FEE_RATE 0.001 → "0.1%". */
export const builderFeeText = () => `${Number((BUILDER_FEE_RATE * 100).toFixed(4))}%`;

export function tokenomicsSections(odds: number): TokenomicsSection[] {
  return [
    {
      title: "Supply",
      lines: [
        `A cap of ${hlo(MAX_SUPPLY)}.`,
        `The trading pool opens ${poolOpensText()}, seeded with ${hlo(POOL_SEED)} and all the USDC the buyback collected until then. Its pool tokens are locked forever.`,
        "HLO that is burned can be mined again: the cap counts what exists.",
      ],
    },
    {
      title: "Mining, every minute",
      lines: [
        `${hlo(TRADER_PER_MINUTE)} goes to that minute's traders, shared by the builder fees they paid.`,
        `A minute nobody trades sends its ${hlo(TRADER_PER_MINUTE)} to the vault.`,
      ],
    },
    {
      title: "The vault",
      lines: [
        `${hlo(VAULT_PER_MINUTE, 1)} goes in every minute.`,
        `Each minute it has a 1 in ${odds.toLocaleString("en-US")} chance to pop (${popOftenText(odds)}).`,
        `When it pops, ${VAULT_PAY_PCT}% is shared by points among wallets with at least 1 point (1 point per $1,000 traded since the last pop) and ${100 - VAULT_PAY_PCT}% stays.`,
      ],
    },
    {
      title: "Claiming",
      lines: [
        `A claim pays ${CLAIM_PAID_PCT}%. The other ${100 - CLAIM_PAID_PCT}% is refined: shared with everyone who holds unclaimed HLO, by their unclaimed balance.`,
        `Claims draw from a shared allowance of ${hlo(CLAIM_CAP)}, refilling ${hlo(CLAIM_PER_HOUR)} an hour.`,
      ],
    },
    {
      title: "Fees",
      lines: [
        `A ${builderFeeText()} builder fee on every trade: ${BUYBACK_PCT}% goes to the buyback and ${100 - BUYBACK_PCT}% to the team.`,
        `Until the trading pool opens (${poolOpensText()}), the buyback only collects USDC. All of it goes into the pool with the ${hlo(POOL_SEED)}, locked forever.`,
        `After that, every ${BUY_EVERY_MINUTES} minutes the buyback spends a 1/${BUY_SLICES} slice of its USDC on HLO. ${BURN_PCT}% of the HLO it buys is burned and ${100 - BURN_PCT}% goes to stakers.`,
      ],
    },
  ];
}

/** The diagram: fees → buyback → (the pool's seed until it opens, then) buys HLO → burn / stakers; the minute's HLO → traders / the vault → pop. */
export function tokenomicsFlows(): Flow[] {
  return [
    {
      label: "Fees",
      steps: [
        `${builderFeeText()} builder fee on every trade`,
        `${BUYBACK_PCT}% to the buyback`,
        `until the pool opens: into the pool with ${hlo(POOL_SEED)}, locked forever`,
        "after it opens: buys back HLO",
        `${BURN_PCT}% burned · ${100 - BURN_PCT}% to stakers`,
      ],
    },
    {
      label: "Mining",
      steps: [`${hlo(TRADER_PER_MINUTE + VAULT_PER_MINUTE, 1)} a minute`, `${hlo(TRADER_PER_MINUTE)} to traders · ${hlo(VAULT_PER_MINUTE, 1)} to the vault`, `the vault pops: ${VAULT_PAY_PCT}% by points`],
    },
  ];
}

/** Live figures from the Rewards reads; a dash for what is not read (not deployed, or not answered yet). */
export function liveFigures(o: { totalBurned: bigint; totalBought: bigint; totalStaked: bigint } | null, vault: bigint | null): LiveFigure[] {
  const v = (x: bigint | null | undefined) => (x === null || x === undefined ? "—" : hlo(x, 2));
  return [
    { label: "Total burned", value: v(o?.totalBurned) },
    { label: "HLO bought back", value: v(o?.totalBought) },
    { label: "Total staked", value: v(o?.totalStaked) },
    { label: "In the vault", value: v(vault) },
  ];
}

/**
 * Why a Live figure is a dash although the reads are up: the Staking and Buyback reads failed on their own, or the
 * rewards file was refused (the Rewards screen's own texts). Nothing while they are still being read.
 */
export function liveNotes(d: { full: unknown; extraError: string | null; latest: unknown; latestProblem: string | null }): string[] {
  const out: string[] = [];
  if (!d.full && d.extraError) out.push(notAvailableText(d.extraError));
  if (!d.latest && d.latestProblem) out.push(d.latestProblem);
  return out;
}
