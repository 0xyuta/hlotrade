/**
 * Protocol numbers the app states (the Tokenomics tab) or computes with (rewards/model.ts). They are copies: the bundle
 * never imports calc or reads the contracts, so test/tokenomics.test.ts pins each one to the source named here.
 */
const HLO = 10n ** 18n;

/** HloToken.MAX_SUPPLY (calc MAX_SUPPLY). The cap counts the HLO that exists, so burned HLO can be mined again. */
export const MAX_SUPPLY = 5_000_000n * HLO;
/** Buyback.POOL_HLO (calc POOL_RESERVE): the HLO that seeds the trading pool. */
export const POOL_SEED = 10_000n * HLO;
/** calc TRADER_PER_MINUTE: shared by each minute's traders, by builder fee. */
export const TRADER_PER_MINUTE = HLO;
/** calc VAULT_PER_MINUTE: into the vault each minute. */
export const VAULT_PER_MINUTE = HLO / 10n;
/** calc applyCheckpoint (`pay = v * 9 / 10`): a pop pays 90% by points; the rest stays in the vault. */
export const VAULT_PAY_PCT = 90;
/** calc popMinimum: the least a wallet needs to share in a pop, in fee units (1 point). */
export const POP_MIN_UNITS = 100_000_000n;
/** Mining (`paid = gross * 9 / 10`): a claim pays 90%; the other 10% is refined. */
export const CLAIM_PAID_PCT = 90;
/** Deploy.s.sol DEFAULT_CLAIM_CAP and DEFAULT_CLAIM_PER_HOUR: Mining's shared claim allowance (the deploy requires them on chain 999). */
export const CLAIM_CAP = 5_000n * HLO;
export const CLAIM_PER_HOUR = 330n * HLO;
/** Splitter (`toAdmin = amount / 10`): 90% of the fee USDC goes to the buyback, 10% to the team. */
export const BUYBACK_PCT = 90;
/** Buyback.BUY_INTERVAL in minutes, Buyback.SLICES, Buyback.BURN_BPS / 100. */
export const BUY_EVERY_MINUTES = 10;
export const BUY_SLICES = 144;
/** Not a contract rule: the mainnet keeper's MIN_BUY_USD (~/.hlo-mainnet/ops-env/keeper.env). Anyone may call buy() for less. */
export const KEEPER_MIN_BUY_USD = 10;
export const BURN_PCT = 90;
/**
 * When the trading pool opens: Buyback.OPEN_DELAY (7 days) after Buyback.launchTime, which Deploy.s.sol sets to
 * Checkpoints.launchTime() + LAUNCH_MARGIN (1 hour). Until then the buyback only collects USDC; openPool puts all of it
 * into the pool with POOL_SEED, and the pool tokens are locked forever.
 */
export const POOL_OPEN_DAYS = 7;
export const POOL_OPEN_EXTRA_HOURS = 1;
