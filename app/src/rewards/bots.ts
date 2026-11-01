import type { Network } from "../config/validate";
import { BUILDER_F, BUILDER_FEE_RATE } from "../hl/math";

/** The Bots tab's texts. The sample is public/bots/hlo-bot.mjs, pinned to the config and to these rules by test/bots.test.ts. */
export const BOT_FILE = "/bots/hlo-bot.mjs";
const API_PAGES: Record<Network, string> = { testnet: "https://app.hyperliquid-testnet.xyz/API", mainnet: "https://app.hyperliquid.xyz/API" };
export const TERMS_URL = "https://app.hyperliquid.xyz/terms";
export const apiPageUrl = (net: Network) => API_PAGES[net];

export const builderField = (builder: string) => `builder: { b: "${builder.toLowerCase()}", f: ${BUILDER_F} }`;
export const builderFeeText = `${BUILDER_FEE_RATE * 100}%`;

export const BOT_INTRO = "An order mines the same whether you click it or a bot sends it. Run your own bot from your own computer: HLO never holds your keys and never trades for you.";

export interface BotStep {
  title: string;
  text: string;
}

export const botSteps = (o: { origin: string }): BotStep[] => [
  {
    title: "Register your wallet",
    text: `Connect it here and press Enable trading once. That approves the ${builderFeeText} builder fee and registers the wallet. With no browser: sign approveBuilderFee with maxFeeRate "${builderFeeText}", then POST {"user":"0x…"} to ${o.origin}/api/register. Trades count only from the moment the wallet is registered.`,
  },
  {
    title: "Make an API wallet",
    text: "Create one on Hyperliquid's API page and give your bot its key. It can trade but cannot withdraw. Never give a bot your main wallet's key.",
  },
  {
    title: "Send orders with the builder field",
    text: "Every order must carry the builder field below. An order without it pays no HLO fee and does not mine.",
  },
  {
    title: "Check it counted",
    text: "Explore shows each of your trades as Pending, then Counted, with its points.",
  },
];

export const BOT_RULES: string[] = [
  "Never trade between your own wallets, and never send orders only to create volume. Hyperliquid's Terms ban wash trading (§3.1.4).",
  "Stay inside Hyperliquid's rate limits and reasonable use (§3.1.8).",
  "Trading can lose money. The HLO you mine is not guaranteed to cover your fees or losses.",
  "Each minute's HLO is split by the fees paid in that minute, so more wallets earn no more than one.",
  "A vault pop pays only wallets with at least 1 point since the last pop.",
  "When many wallets trade every minute, rewards can run some minutes late. They are not lost, and Explore shows how late.",
];

export const BOT_SAMPLE_TEXT = "A small example to start from: it buys a fixed amount of one market on a schedule and stops once your position reaches your limit. It never sells. It sends nothing until you set LIVE=1. Change it into your own strategy.";

/** The commands, for the page's own host. */
export const botCommands = (origin: string): string =>
  [
    "mkdir hlo-bot && cd hlo-bot",
    `curl -O ${origin}${BOT_FILE}`,
    "npm init -y && npm i @nktkas/hyperliquid@0.33.3 viem@2.57.12",
    "",
    "# practice: reads the market and sends nothing",
    "ACCOUNT=0xYourWallet node hlo-bot.mjs --once",
    "",
    "# for real: type the API wallet's key when asked, so it stays out of your shell history",
    "read -rs API_WALLET_KEY && export API_WALLET_KEY",
    "ACCOUNT=0xYourWallet LIVE=1 COIN=BTC USD_EACH=12 EVERY_MINUTES=60 MAX_USD=100 node hlo-bot.mjs",
  ].join("\n");
