import type { Network } from "../config/validate";
import { fmtHlo } from "../ui/format";
import { CLAIM_PAID_PCT, TRADER_PER_MINUTE, VAULT_PAY_PCT, VAULT_PER_MINUTE } from "./constants";
import { popOftenText } from "./view";

/** The first-visit intro (ui/intro/): a few cards on how HLO works, shown once per browser. */
export const INTRO_KEY = "hlo:intro";
export const INTRO_SEEN = "seen";
export const INTRO_TITLE = "How HLO works";

/** The images are drawn with mainnet's numbers (the vault's 1 in 1,250), so the intro shows on mainnet only. */
export const showIntro = (network: Network, stored: string | null): boolean => network === "mainnet" && stored !== INTRO_SEEN;

export type IntroImage = "mining" | "vault" | "claim" | "start";
export interface IntroCard {
  image: IntroImage;
  /** Says everything the image says, for screen readers. */
  alt: string;
}

const hlo = (x: bigint, d = 0) => `${fmtHlo(x, d)} HLO`;

/** The cards in order. The words and numbers are the images' (drawn by the X article's make-diagrams.py); a changed protocol number means a new image. */
export function introCards(odds: number): IntroCard[] {
  return [
    {
      image: "mining",
      alt: `${hlo(TRADER_PER_MINUTE)} a minute, shared by fees paid. Wallet A pays $3.00 and gets 0.60 HLO, wallet B pays $1.50 and gets 0.30 HLO, wallet C pays $0.50 and gets 0.10 HLO. Trade alone in a minute and you get the whole ${hlo(TRADER_PER_MINUTE)}.`,
    },
    {
      image: "vault",
      alt: `The vault fills up, then pops. Every minute ${hlo(VAULT_PER_MINUTE, 1)} goes in, and ${fmtHlo(TRADER_PER_MINUTE, 0)} more if nobody traded. It has a 1 in ${odds.toLocaleString("en-US")} chance to pop each minute, ${popOftenText(odds)}. When it pops, ${VAULT_PAY_PCT}% is shared by points and ${100 - VAULT_PAY_PCT}% stays in the vault. To share in a pop: 1 point since the last pop. $1,000 traded = 1 point.`,
    },
    {
      image: "claim",
      alt: `A claim pays ${CLAIM_PAID_PCT}%. You claim 100 HLO: ${CLAIM_PAID_PCT} HLO goes to your wallet, and ${100 - CLAIM_PAID_PCT} HLO is shared by everyone still holding unclaimed HLO. Wait to claim, and you collect a share of other people's claims.`,
    },
    {
      image: "start",
      alt: "Start mining in 3 steps: 1, connect your wallet. 2, Enable trading once, in your wallet. 3, trade any market here. Every minute you trade, you mine HLO. Claim it any time on Rewards.",
    },
  ];
}
