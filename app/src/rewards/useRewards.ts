import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Hex } from "viem";
import { useConfig } from "../config/context";
import { rewardsBase } from "../config/load";
import type { Address } from "../config/validate";
import { publicClient } from "../evm/clients";
import { plainError } from "../hl/errors";
import { viemChain } from "../wallet/chains";
import { joinChain, readCoreChain, readExtraChain, readRootOf, type ChainReader, type CoreChain, type ExtraChain, type RewardsChain } from "./chain";
import { loadLatest, loadUserFile, type LatestFile, type UserFile } from "./files";
import { checkLatest, checkSigned, claimPlan, entryProblem, UPDATING, yoursFrom, type ClaimPlan, type Yours } from "./model";

export interface RewardsData {
  chain: CoreChain; // Checkpoints and Mining reads: enough for the rewards and claim screen. `claimed` includes a claim just made, until the chain catches up (see `hold`)
  full: RewardsChain | null; // chain plus the Staking and Buyback reads, once they have answered
  extraError: string | null; // the Staking or Buyback reads failed: the rewards cards are unaffected
  /** latest.json (the vault, the pops), only when the poster's signature, the chain and the file agree (checkLatest). Null while there is none or it is not usable. */
  latest: LatestFile | null;
  /**
   * Why `latest` or the account's numbers are not usable although the files exist or should: the files are unreachable, a signature is wrong,
   * a file lags the chain ("Rewards are updating…"), or the account's entry does not match the signed tree. Null when all is well or nothing is published yet.
   */
  latestProblem: string | null;
  /** The account's numbers from its own user file (users/<xx>.json): zeros for a wallet without an entry, null without an account, without a usable latest.json or when its file could not be read or trusted. */
  yours: Yours | null;
  /** The minute of the user file `yours` comes from; null without one (zeros). The Vault card compares it with the last pop in latest.json. */
  yoursAt: number | null;
  plan: ClaimPlan | null; // null when there is nothing to claim or no proof that verifies
}
export type RewardsState = { kind: "off" } | { kind: "loading" } | { kind: "down"; error: string } | { kind: "ready"; data: RewardsData };

/** Every 30 s while the tab is visible: a checkpoint lands every minute. */
export const EVERY_MS = 30_000;
/** Safety cap on a claim hold (see `hold`): normally it ends as soon as a read shows `claimed` caught up. */
export const CLAIM_HOLD_MS = 10 * 60_000;

/**
 * What one read produced, before the account's hold is applied. `mine` is the account's user file (null: the store has none, which
 * with a readable latest.json means zero for the account) and `mineUsable` says whether the account's numbers may be shown at all
 * (its file was read, or is missing, and passed the signature and chain checks). `mineRoot` is `rootOf(mine.throughMinute)`, read only
 * when the file is older than the chain's latest settled minute: the root it was settled at, or null (zero, or not asked).
 */
type Read = Pick<RewardsData, "chain" | "full" | "extraError" | "latest" | "latestProblem"> & { mine: UserFile | null; mineUsable: boolean; mineRoot: Hex | null };

const firstLine = (e: unknown) => plainError(e).text.split("\n")[0]; // viem's message goes on to quote the whole request: the first line says what happened
const unreadable = (e: unknown) => ({ error: `The reward files could not be read (${firstLine(e)}).` });

export function useRewards(user: Address | null): { state: RewardsState; reload(): void; hold(claimedTo: bigint): void } {
  const cfg = useConfig();
  const deployed = Boolean(cfg.contracts && rewardsBase);
  const key = `${cfg.network}:${user?.toLowerCase() ?? ""}`;
  // The result is tagged with the account it was read for, so another account never sees it, not even for one render.
  const [res, setRes] = useState<{ key: string; state: { kind: "off" } | { kind: "down"; error: string } | { kind: "ready"; read: Read } } | null>(null);
  const seq = useRef(0); // a slow answer for an older account or an older refresh must not overwrite a newer one
  // After a claim goes through, the caller holds the entitlement just claimed until a chain read shows `claimed` at or above it (or CLAIM_HOLD_MS pass),
  // so a node that lags behind the receipt cannot show the same amount as claimable again.
  const [held, setHeld] = useState<{ key: string; value: bigint } | null>(null);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    const set = (state: NonNullable<typeof res>["state"]) => {
      if (mine === seq.current) setRes({ key, state });
    };
    const k = cfg.contracts;
    if (!k || !rewardsBase) return set({ kind: "off" });
    const client = publicClient(viemChain("hyperEvm", cfg)) as unknown as ChainReader;
    // Staking, token and Buyback reads run apart from the Checkpoints and Mining ones: a failure there pauses only their cards.
    const extraP: Promise<{ extra: ExtraChain } | { error: string }> = readExtraChain(client, k, user).then((extra) => ({ extra }), (e) => ({ error: firstLine(e) }));
    // The files are fetched while the chain is read; all are needed before anything is shown.
    const fileP: Promise<{ file: LatestFile | null } | { error: string }> = loadLatest(rewardsBase).then((file) => ({ file }), unreadable);
    // The account's own numbers and proof are in its user file, not in latest.json. No account, no file to read.
    const userP: Promise<{ file: UserFile | null } | { error: string } | null> = user ? loadUserFile(rewardsBase, user).then((file) => ({ file }), unreadable) : Promise.resolve(null);
    let chain: CoreChain;
    try {
      chain = await readCoreChain(client, k, user);
    } catch (e) {
      return set({ kind: "down", error: firstLine(e) });
    }
    const fileR = await fileP;
    if (mine !== seq.current) return; // superseded while reading
    let latest: LatestFile | null = null;
    let latestProblem: string | null = null;
    if ("error" in fileR) latestProblem = fileR.error;
    else if (fileR.file) {
      const ok = await checkLatest(fileR.file, chain, cfg.hyperEvmChainId, k.checkpoints);
      if (ok.ok) latest = fileR.file;
      else latestProblem = ok.reason;
    }
    // The account's file gets the same checks as latest.json (signature, chain minute, root). It counts only while latest.json was read:
    // a missing file means zero for the account only then, and a failed latest.json keeps its own problem text.
    let mineFile: UserFile | null = null;
    let mineUsable = false;
    let mineRoot: Hex | null = null;
    const userR = await userP;
    if (mine !== seq.current) return; // superseded while reading
    if (userR && latest) {
      if ("error" in userR) latestProblem = userR.error;
      else if (!userR.file) mineUsable = true; // none written yet for this part of the address space: zero
      else {
        const ok = await checkSigned(userR.file, chain, cfg.hyperEvmChainId, k.checkpoints);
        if (ok.ok || ok.reason === UPDATING) {
          // A file the poster signed that is behind the chain still shows its numbers. Mining pays against any settled minute that is
          // not cancelled, so if the file's own minute is settled at its root it can still claim (claimPlan); only otherwise the card
          // says the rewards are updating. UPDATING comes only after the signature, so the extra read is never made for an unsigned file.
          if (!ok.ok) {
            mineRoot = await readRootOf(client, k, userR.file.throughMinute).catch(() => null);
            if (mineRoot === null || mineRoot.toLowerCase() !== userR.file.root.toLowerCase()) latestProblem = ok.reason;
          }
          mineFile = userR.file;
          mineUsable = true;
        } else latestProblem = ok.reason;
      }
    }
    // The Staking and Buyback numbers do not wait for each other or for the file: patched in the moment they are read.
    const patch = (r: Awaited<typeof extraP>, base: Read): Read => ({ ...base, full: "extra" in r ? joinChain(chain, r.extra) : null, extraError: "error" in r ? r.error : null });
    set({ kind: "ready", read: { chain, full: null, extraError: null, latest, latestProblem, mine: mineFile, mineUsable, mineRoot } });
    void extraP.then((r) => {
      if (mine !== seq.current) return;
      setRes((prev) => (prev && prev.key === key && prev.state.kind === "ready" ? { key, state: { kind: "ready", read: patch(r, prev.state.read) } } : prev));
    });
  }, [cfg, user, key]);

  useEffect(() => {
    void reload();
    const t = setInterval(() => document.visibilityState === "visible" && void reload(), EVERY_MS);
    // Back on the tab after a while: do not show old numbers (or claim with an old entitlement) until the next tick.
    const onVisible = () => document.visibilityState === "visible" && void reload();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      seq.current++; // nothing from this account or config lands after it is gone
    };
  }, [reload]);

  useEffect(() => {
    if (held === null) return;
    const t = setTimeout(() => setHeld(null), CLAIM_HOLD_MS);
    return () => clearTimeout(t);
  }, [held]);

  // The chain has caught up with the held claim: release it, so later reads are shown as they are.
  useEffect(() => {
    if (held && res && res.key === held.key && res.state.kind === "ready" && (res.state.read.chain.claimed ?? 0n) >= held.value) setHeld(null);
  }, [res, held]);

  const state: RewardsState = useMemo(() => {
    if (!res || res.key !== key) return deployed ? { kind: "loading" } : { kind: "off" };
    if (res.state.kind !== "ready") return res.state;
    const r = res.state.read;
    // The hold applies while the chain's `claimed` is below it (and then it also lowers `claimAvailable` by the held difference); once the chain catches up, the chain's own number is used.
    const heldValue = held && held.key === key ? held.value : null;
    const chainClaimed = r.chain.claimed ?? 0n;
    const claimed = heldValue !== null && heldValue > chainClaimed ? heldValue : r.chain.claimed;
    // Under a hold the chain still lags, so its allowance does not yet count the held claim either: take it off, or Claim would offer it a second time.
    const heldNow = heldValue !== null && heldValue > chainClaimed ? heldValue - chainClaimed : 0n;
    const claimAvailable = r.chain.claimAvailable > heldNow ? r.chain.claimAvailable - heldNow : 0n;
    const chain = claimed === r.chain.claimed ? r.chain : { ...r.chain, claimed, claimAvailable };
    const full = r.full && claimed !== r.chain.claimed && r.full.user ? { ...r.full, user: { ...r.full.user, claimed: claimed ?? 0n } } : r.full;
    const { mine, mineUsable, mineRoot, ...read } = r; // the user file stays here: the screen gets the account's numbers and plan, never the raw entry
    const usable = Boolean(user && r.latest && mineUsable);
    const yours = user && usable ? yoursFrom(mine, chain, user) : null;
    const yoursAt = usable && mine ? mine.throughMinute : null;
    const plan = user && usable ? claimPlan(mine, chain, user, mineRoot) : null;
    // An entry is not signed, only its proof is: one that contradicts the signed root is not shown (yoursFrom gives zeros), and the card says why.
    const latestProblem = r.latestProblem ?? (user && usable ? entryProblem(mine, user) : null);
    return { kind: "ready", data: { ...read, chain, full, yours, yoursAt, plan, latestProblem } };
  }, [res, held, key, deployed, user]);

  return { state, reload: () => void reload(), hold: (claimedTo) => setHeld({ key, value: claimedTo }) };
}
