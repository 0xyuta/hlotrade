/**
 * Each minute the vault pops with a 1-in-odds chance (spec 2026-10-30 §2 rule 1). The app's own copy of calc's popOdds
 * for its two networks (the bundle never imports calc; test/odds.test.ts pins it to calc). checkLatest refuses a
 * latest.json whose vault.odds differs.
 */
export const POP_ODDS: Readonly<Record<number, number>> = { 999: 1250, 998: 60 };
