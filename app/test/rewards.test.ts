import { verifyEntitlement } from "../src/rewards/proof";
import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import type { CoreChain } from "../src/rewards/chain";
import type { LatestFile, UserFile } from "../src/rewards/files";
import { parseLatest, parseUserFile } from "../src/rewards/files";
import {
  checkLatest, checkSigned, claimLimited, claimPartial, claimPlan, ENTRY_MISMATCH, MIN_CLAIM_NOW, dripRemaining, entryProblem, poolPhase, poolPrice, pointsText, settledText,
  UPDATING, yoursFrom,
} from "../src/rewards/model";
import {
  FIX_CHAIN_ID, FIX_CONTRACT, FIX_LAUNCH, FIX_OTHER_ACCOUNT, FIX_POSTER_ACCOUNT, FIX_THROUGH, FIX_USERS, makeLatest, malleate,
} from "./helpers/checkpoint-fixture";

const HLO = 10n ** 18n;
const POSTER = FIX_POSTER_ACCOUNT.address;

const chainAt = (o: Partial<CoreChain> = {}): CoreChain => ({
  now: FIX_LAUNCH + 60 * 20, launchTime: FIX_LAUNCH, anySettled: true, latestMinute: FIX_THROUGH - 1, latestValidMinute: FIX_THROUGH - 1, latestRoot: `0x${"99".repeat(32)}`,
  paused: false, poster: POSTER, claimed: 0n, claimAvailable: 5000n * HLO, ...o,
});
/** The checkpoint as the app reads it: latest.json (`latest`) and the user file holding the five fixture traders (`file`). */
const load = async (opts?: Parameters<typeof makeLatest>[0]) => {
  const made = await makeLatest(opts);
  return { ...made, latest: parseLatest(made.json) as LatestFile, file: parseUserFile(made.userFile(FIX_USERS[0])) as UserFile };
};
const WALLET = "0x00000000000000000000000000000000000000ee" as Address; // in no file
/** The file with one wallet's entry changed. */
const withEntry = (file: UserFile, u: Address, f: (e: UserFile["users"][string]) => Partial<UserFile["users"][string]>): UserFile => ({
  ...file, users: { ...file.users, [u]: { ...file.users[u], ...f(file.users[u]) } },
});
const flip = (h: Hex): Hex => `0x${h.slice(2, 4) === "00" ? "01" : "00"}${h.slice(4)}`;

describe("checkLatest", () => {
  it("fails when the file's vault odds are not this network's (1 in 60 on 998, 1 in 1,250 on 999)", async () => {
    const { latest } = await load();
    expect(latest.vault.odds).toBe(60);
    const r = await checkLatest({ ...latest, vault: { ...latest.vault, odds: 1250 } }, chainAt(), FIX_CHAIN_ID, FIX_CONTRACT);
    expect(r).toEqual({ ok: false, reason: "The reward file's vault odds are not this network's, so it was ignored." });
  });
  it("accepts a file the poster signed that is newer than the chain's latest settled minute", async () => {
    const { latest } = await load();
    expect(await checkLatest(latest, chainAt(), FIX_CHAIN_ID, FIX_CONTRACT)).toEqual({ ok: true });
  });
  it("accepts it when nothing is settled yet", async () => {
    const { latest } = await load();
    expect(await checkLatest(latest, chainAt({ anySettled: false, latestMinute: null, latestRoot: null }), FIX_CHAIN_ID, FIX_CONTRACT)).toEqual({ ok: true });
  });
  it("accepts it when it is the very checkpoint already settled", async () => {
    const { latest } = await load();
    expect(await checkLatest(latest, chainAt({ latestMinute: FIX_THROUGH, latestRoot: latest.root }), FIX_CHAIN_ID, FIX_CONTRACT)).toEqual({ ok: true });
  });
  it("fails when another key signed it", async () => {
    const { latest } = await load({ signer: FIX_OTHER_ACCOUNT });
    const r = await checkLatest(latest, chainAt(), FIX_CHAIN_ID, FIX_CONTRACT);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toMatch(/poster/i);
  });
  it("fails when the file was altered after signing (root, totalEntitled or minute)", async () => {
    const { latest } = await load();
    for (const alt of [{ root: `0x${"12".repeat(32)}` as Hex }, { totalEntitled: "1" }, { throughMinute: FIX_THROUGH + 1 }, { refBlock: "5" }]) {
      expect((await checkLatest({ ...latest, ...alt }, chainAt(), FIX_CHAIN_ID, FIX_CONTRACT)).ok, JSON.stringify(alt)).toBe(false);
    }
  });
  it("fails for another chain or another Checkpoints contract (the signature is bound to both)", async () => {
    const { latest } = await load();
    expect((await checkLatest(latest, chainAt(), 999, FIX_CONTRACT)).ok).toBe(false);
    expect((await checkLatest(latest, chainAt(), FIX_CHAIN_ID, "0x00000000000000000000000000000000000000d1")).ok).toBe(false);
  });
  it("fails when the poster on chain is someone else", async () => {
    const { latest } = await load();
    expect((await checkLatest(latest, chainAt({ poster: FIX_OTHER_ACCOUNT.address }), FIX_CHAIN_ID, FIX_CONTRACT)).ok).toBe(false);
  });
  it("a signature that cannot be recovered is a failure, not a throw", async () => {
    const { latest } = await load();
    const r = await checkLatest({ ...latest, sig: `0x${"00".repeat(65)}` }, chainAt(), FIX_CHAIN_ID, FIX_CONTRACT);
    expect(r.ok).toBe(false);
  });
  it("fails a signature the contract would reject (high s, v of 0 or 1), even though it recovers the poster", async () => {
    const { latest } = await load();
    const r = await checkLatest({ ...latest, sig: malleate(latest.sig) }, chainAt(), FIX_CHAIN_ID, FIX_CONTRACT);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/refused|contract/i);
    const v0 = `${latest.sig.slice(0, 130)}00` as Hex;
    expect((await checkLatest({ ...latest, sig: v0 }, chainAt(), FIX_CHAIN_ID, FIX_CONTRACT)).ok).toBe(false);
  });
  it("a file behind the chain says it is updating", async () => {
    const { latest } = await load();
    const r = await checkLatest(latest, chainAt({ latestMinute: FIX_THROUGH + 1 }), FIX_CHAIN_ID, FIX_CONTRACT);
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/updating/i) });
  });
  it("the same minute with a different root is a mismatch", async () => {
    const { latest } = await load();
    const r = await checkLatest(latest, chainAt({ latestMinute: FIX_THROUGH, latestRoot: `0x${"77".repeat(32)}` }), FIX_CHAIN_ID, FIX_CONTRACT);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/match/i);
  });
  it("a file ahead of the chain is fine (a refBlock at or above the head is Task 13's business, not a bad file)", async () => {
    const { latest } = await load();
    expect((await checkLatest(latest, chainAt({ latestMinute: 0, latestRoot: `0x${"55".repeat(32)}` }), FIX_CHAIN_ID, FIX_CONTRACT)).ok).toBe(true);
  });
});

describe("checkSigned (latest.json and the user files: the signature, the minute and the root)", () => {
  it("the user file the poster signed passes, and says nothing about odds (it has none)", async () => {
    const { file } = await load();
    expect(file).not.toHaveProperty("vault.odds");
    expect(await checkSigned(file, chainAt(), FIX_CHAIN_ID, FIX_CONTRACT)).toEqual({ ok: true });
  });
  it("latest.json passes it too: checkLatest is the odds check plus checkSigned", async () => {
    const { latest } = await load();
    expect(await checkSigned(latest, chainAt(), FIX_CHAIN_ID, FIX_CONTRACT)).toEqual({ ok: true });
    expect(await checkLatest(latest, chainAt(), FIX_CHAIN_ID, FIX_CONTRACT)).toEqual({ ok: true });
    // the odds are not checkSigned's business: a file with no odds field is judged on its signature alone
    const otherOdds: LatestFile = { ...latest, vault: { ...latest.vault, odds: 1250 } };
    expect(await checkSigned(otherOdds, chainAt(), FIX_CHAIN_ID, FIX_CONTRACT)).toEqual({ ok: true });
  });
  it("another signer fails, and says it was not the poster", async () => {
    const { file } = await load({ signer: FIX_OTHER_ACCOUNT });
    const r = await checkSigned(file, chainAt(), FIX_CHAIN_ID, FIX_CONTRACT);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toBe("The reward file was not signed by the rewards poster, so it was ignored.");
    expect((await checkSigned((await load()).file, chainAt({ poster: FIX_OTHER_ACCOUNT.address }), FIX_CHAIN_ID, FIX_CONTRACT)).ok).toBe(false);
  });
  it("a file signed for another chain or another Checkpoints contract fails (the signature is bound to both), whatever its own chainId and contract fields say", async () => {
    const { file } = await load();
    expect((await checkSigned(file, chainAt(), 999, FIX_CONTRACT)).ok).toBe(false);
    expect((await checkSigned(file, chainAt(), FIX_CHAIN_ID, "0x00000000000000000000000000000000000000d1")).ok).toBe(false);
    // fields rewritten to match the network the app is on do not make the signature fit
    const otherChain: UserFile = { ...file, chainId: 999 };
    const otherContract: UserFile = { ...file, contract: "0x00000000000000000000000000000000000000d1" };
    expect((await checkSigned(otherChain, chainAt(), 999, FIX_CONTRACT)).ok).toBe(false);
    expect((await checkSigned(otherContract, chainAt(), FIX_CHAIN_ID, "0x00000000000000000000000000000000000000d1")).ok).toBe(false);
  });
  it("an altered signed field fails: root, totalEntitled, minute or refBlock", async () => {
    const { file } = await load();
    for (const alt of [{ root: `0x${"12".repeat(32)}` as Hex }, { totalEntitled: "1" }, { throughMinute: FIX_THROUGH + 1 }, { refBlock: "5" }]) {
      expect((await checkSigned({ ...file, ...alt }, chainAt(), FIX_CHAIN_ID, FIX_CONTRACT)).ok, JSON.stringify(alt)).toBe(false);
    }
  });
  it("a signature the contract would refuse, or that cannot be recovered, fails without a throw", async () => {
    const { file } = await load();
    const high = await checkSigned({ ...file, sig: malleate(file.sig) }, chainAt(), FIX_CHAIN_ID, FIX_CONTRACT);
    expect(high.ok).toBe(false);
    expect(!high.ok && high.reason).toMatch(/refused|contract/i);
    expect((await checkSigned({ ...file, sig: `${file.sig.slice(0, 130)}00` as Hex }, chainAt(), FIX_CHAIN_ID, FIX_CONTRACT)).ok).toBe(false);
    expect((await checkSigned({ ...file, sig: `0x${"00".repeat(65)}` }, chainAt(), FIX_CHAIN_ID, FIX_CONTRACT)).ok).toBe(false);
  });
  it("older than the chain's latest settled minute: ok false with exactly UPDATING", async () => {
    const { file } = await load();
    expect(UPDATING).toBe("Rewards are updating…");
    expect(await checkSigned(file, chainAt({ latestMinute: FIX_THROUGH + 1 }), FIX_CHAIN_ID, FIX_CONTRACT)).toEqual({ ok: false, reason: UPDATING });
  });
  it("a file that is both older than the chain and badly signed says what is wrong with the signature, never UPDATING (the signature comes before the minute)", async () => {
    // "Updating" lets the app show a file's numbers, so only a file the poster really signed may get it.
    const behind = chainAt({ latestMinute: FIX_THROUGH + 1 });
    const poster = "The reward file was not signed by the rewards poster, so it was ignored.";
    const other = (await load({ signer: FIX_OTHER_ACCOUNT })).file;
    expect(await checkSigned(other, behind, FIX_CHAIN_ID, FIX_CONTRACT)).toEqual({ ok: false, reason: poster });
    const { file } = await load();
    expect(await checkSigned(file, behind, FIX_CHAIN_ID, FIX_CONTRACT)).toEqual({ ok: false, reason: UPDATING }); // the same file, signed right
    expect(await checkSigned(file, behind, 999, FIX_CONTRACT)).toEqual({ ok: false, reason: poster }); // for another chain
    expect(await checkSigned(file, behind, FIX_CHAIN_ID, "0x00000000000000000000000000000000000000d1")).toEqual({ ok: false, reason: poster }); // another contract
    expect(await checkSigned({ ...file, root: `0x${"12".repeat(32)}` }, behind, FIX_CHAIN_ID, FIX_CONTRACT)).toEqual({ ok: false, reason: poster }); // altered
    expect(await checkSigned(file, { ...behind, poster: FIX_OTHER_ACCOUNT.address }, FIX_CHAIN_ID, FIX_CONTRACT)).toEqual({ ok: false, reason: poster }); // another poster on chain
    const high = await checkSigned({ ...file, sig: malleate(file.sig) }, behind, FIX_CHAIN_ID, FIX_CONTRACT);
    expect(high.ok).toBe(false);
    expect(!high.ok && high.reason).toMatch(/refused|contract/i);
    const unreadable = await checkSigned({ ...file, sig: `0x${"00".repeat(65)}` }, behind, FIX_CHAIN_ID, FIX_CONTRACT);
    expect(unreadable.ok).toBe(false);
    expect(!unreadable.ok && unreadable.reason).not.toBe(UPDATING);
  });
  it("the same minute with another root fails; with the chain's own root it passes; newer than the chain or nothing settled passes", async () => {
    const { file } = await load();
    const r = await checkSigned(file, chainAt({ latestMinute: FIX_THROUGH, latestRoot: `0x${"77".repeat(32)}` }), FIX_CHAIN_ID, FIX_CONTRACT);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/match/i);
    expect(!r.ok && r.reason).not.toBe(UPDATING);
    expect(await checkSigned(file, chainAt({ latestMinute: FIX_THROUGH, latestRoot: file.root }), FIX_CHAIN_ID, FIX_CONTRACT)).toEqual({ ok: true });
    expect((await checkSigned(file, chainAt({ latestMinute: 0, latestRoot: `0x${"55".repeat(32)}` }), FIX_CHAIN_ID, FIX_CONTRACT)).ok).toBe(true);
    expect((await checkSigned(file, chainAt({ anySettled: false, latestMinute: null, latestRoot: null }), FIX_CHAIN_ID, FIX_CONTRACT)).ok).toBe(true);
  });
  it("a user file older than latest.json but equal to the chain's settled minute passes", async () => {
    const old = await load({ throughMinute: FIX_THROUGH - 1 });
    expect(old.file.throughMinute).toBe(FIX_THROUGH - 1);
    expect(await checkSigned(old.file, chainAt({ latestMinute: FIX_THROUGH - 1, latestRoot: old.file.root }), FIX_CHAIN_ID, FIX_CONTRACT)).toEqual({ ok: true });
  });
});

describe("yoursFrom", () => {
  it("earned, claimed, claimable, 90%, refining, points and the vault share, all from the user file (its own vault too)", async () => {
    const { file, result } = await load();
    const u = FIX_USERS[2];
    const e = result.entitlements.get(u as never) as bigint;
    const claimed = e / 4n;
    const y = yoursFrom(file, chainAt({ claimed }), u);
    const entry = file.users[u];
    expect(y.earned).toBe(e);
    expect(y.claimed).toBe(claimed);
    expect(y.claimable).toBe(e - claimed);
    expect(y.youGet).toBe(((e - claimed) * 9n) / 10n);
    expect(y.refined).toBe(BigInt(entry.refined));
    expect(y.points).toBe(BigInt(entry.points));
    expect(y.points).toBe(result.points.get(u as never));
    expect(y.points).toBeGreaterThan(0n);
    expect(y.vaultShare).toBe((((BigInt(file.vault.amount) * 9n) / 10n) * y.points) / BigInt(file.vault.pointsTotal));
    expect(y.vaultShare).toBeGreaterThan(0n);
  });
  it("the vault share uses the user file's vault, not any other: its amount and its points total", async () => {
    const { file } = await load();
    const u = FIX_USERS[2];
    const base = yoursFrom(file, chainAt(), u);
    const double = yoursFrom({ ...file, vault: { ...file.vault, amount: (BigInt(file.vault.amount) * 2n).toString() } }, chainAt(), u);
    expect(double.vaultShare).toBeGreaterThan(base.vaultShare);
    const dilute = yoursFrom({ ...file, vault: { ...file.vault, pointsTotal: (BigInt(file.vault.pointsTotal) * 2n).toString() } }, chainAt(), u);
    expect(dilute.vaultShare).toBe(base.vaultShare / 2n);
  });
  it("the allowance limits what a claim pays now: claimable 100, available 40 → claimNow 40, youGet 36 (90% of what is claimed now)", async () => {
    const { file } = await load();
    const u = FIX_USERS[0];
    const e = BigInt(file.users[u].entitlement);
    const y = yoursFrom(file, chainAt({ claimed: e - 100n, claimAvailable: 40n }), u);
    expect(y).toMatchObject({ claimable: 100n, claimNow: 40n, youGet: 36n });
    const roomy = yoursFrom(file, chainAt({ claimed: e - 100n, claimAvailable: 1000n }), u);
    expect(roomy).toMatchObject({ claimable: 100n, claimNow: 100n, youGet: 90n });
    const empty = yoursFrom(file, chainAt({ claimed: e - 100n, claimAvailable: 0n }), u);
    expect(empty).toMatchObject({ claimable: 100n, claimNow: 0n, youGet: 0n });
  });
  it("is case-insensitive in the address", async () => {
    const { file } = await load();
    const u = FIX_USERS[0];
    expect(yoursFrom(file, chainAt(), ("0x" + u.slice(2).toUpperCase()) as Address)).toEqual(yoursFrom(file, chainAt(), u));
  });
  it("claimable never goes negative (claimed above earned)", async () => {
    const { file } = await load();
    const big = yoursFrom(file, chainAt({ claimed: 10n ** 30n }), FIX_USERS[0]);
    expect(big.claimable).toBe(0n);
    expect(big.youGet).toBe(0n);
  });
  it("no file, or a file with no entry for the wallet: everything 0n, points shown as 0.00 and never a dash", async () => {
    const { file } = await load();
    const zero = { earned: 0n, claimed: 7n, claimable: 0n, claimNow: 0n, youGet: 0n, refined: 0n, points: 0n, vaultShare: 0n };
    for (const f of [null, file]) {
      const none = yoursFrom(f, chainAt({ claimed: 7n }), WALLET);
      expect(none).toEqual(zero);
      expect(pointsText(none.points)).toBe("0.00");
      expect(entryProblem(f, WALLET)).toBeNull();
      expect(claimPlan(f, chainAt(), WALLET)).toBeNull();
    }
  });
  it("no claimed read counts as 0; 90% rounds down like Mining; no points since the last pop means no share", async () => {
    const { file } = await load();
    const u = FIX_USERS[0];
    const e = BigInt(file.users[u].entitlement);
    const synthetic: UserFile = { ...withEntry(file, u, () => ({ points: "0", refined: "3" })), vault: { ...file.vault, amount: "1000", pointsTotal: "0" } };
    const y = yoursFrom(synthetic, chainAt({ claimed: null }), u);
    expect(y).toMatchObject({ earned: e, claimed: 0n, claimable: e, youGet: (e * 9n) / 10n, refined: 3n, vaultShare: 0n });
    const odd = yoursFrom(synthetic, chainAt({ claimed: e - 19n }), u);
    expect(odd).toMatchObject({ claimable: 19n, youGet: 17n });
  });
  it("under 1 point the wallet keeps its points on screen but has no share: a pop would pay it nothing", async () => {
    const { file } = await load();
    const f = (points: string): UserFile => ({ ...file, vault: { ...file.vault, amount: "1000", pointsTotal: "100000000" }, users: { ...file.users, [WALLET]: { entitlement: "0", fees: "5", mined: "0", fromVault: "0", refined: "0", points, proof: [] } } });
    expect(yoursFrom(f("99999999"), chainAt(), WALLET)).toMatchObject({ points: 99_999_999n, vaultShare: 0n });
    expect(yoursFrom(f("100000000"), chainAt(), WALLET).vaultShare).toBe(900n);
  });
  it("a wallet with points and nothing earned (entitlement 0, no proof) keeps its points and its share, and has no problem and no plan", async () => {
    const { file } = await load();
    const f: UserFile = { ...file, users: { ...file.users, [WALLET]: { entitlement: "0", fees: "5", mined: "0", fromVault: "0", refined: "0", points: "500", proof: [] } } };
    expect(entryProblem(f, WALLET)).toBeNull();
    const y = yoursFrom(f, chainAt(), WALLET);
    expect(y).toMatchObject({ earned: 0n, points: 500n });
    expect(pointsText(y.points)).toBe("0.00"); // 500 units is far below a hundredth of a point
    expect(y.vaultShare).toBe(0n); // under the 1-point minimum
    const enough = yoursFrom(withEntry(f, WALLET, () => ({ points: "500000000" })), chainAt(), WALLET);
    expect(enough.vaultShare).toBe((((BigInt(f.vault.amount) * 9n) / 10n) * 500_000_000n) / BigInt(f.vault.pointsTotal));
    expect(claimPlan(f, chainAt(), WALLET)).toBeNull();
    const more = yoursFrom(withEntry(f, WALLET, () => ({ points: "250000000" })), chainAt(), WALLET);
    expect(pointsText(more.points)).toBe("2.50");
  });
  it("a changed entitlement is never shown: zeros including points, refining and the share, the problem says so, and there is no plan", async () => {
    const { file } = await load();
    const u = FIX_USERS[0];
    const tampered = withEntry(file, u, (e) => ({ entitlement: (BigInt(e.entitlement) * 1000n).toString() }));
    expect(BigInt(file.users[u].points)).toBeGreaterThan(0n);
    expect(BigInt(file.users[u].refined) + BigInt(file.users[u].points)).toBeGreaterThan(0n);
    const y = yoursFrom(tampered, chainAt({ claimed: 7n }), u);
    expect(y).toEqual({ earned: 0n, claimed: 7n, claimable: 0n, claimNow: 0n, youGet: 0n, refined: 0n, points: 0n, vaultShare: 0n });
    expect(entryProblem(tampered, u)).toBe(ENTRY_MISMATCH);
    expect(ENTRY_MISMATCH).toBe("Your numbers in the rewards file don't match its signed tree.");
    expect(claimPlan(tampered, chainAt(), u)).toBeNull();
    // the honest file is unaffected, and another wallet's honest entry in the same file still shows
    expect(entryProblem(file, u)).toBeNull();
    expect(entryProblem(tampered, FIX_USERS[1])).toBeNull();
    expect(yoursFrom(tampered, chainAt(), FIX_USERS[1]).earned).toBe(BigInt(file.users[FIX_USERS[1]].entitlement));
    expect(claimPlan(tampered, chainAt(), FIX_USERS[1])).not.toBeNull();
  });
  it("a changed proof is never shown either: one hash flipped, one dropped, one added, or another wallet's proof", async () => {
    const { file } = await load();
    const [u, other] = [FIX_USERS[0], FIX_USERS[1]];
    const proof = file.users[u].proof;
    expect(proof.length).toBeGreaterThan(1);
    const zero = (claimed: bigint) => ({ earned: 0n, claimed, claimable: 0n, claimNow: 0n, youGet: 0n, refined: 0n, points: 0n, vaultShare: 0n });
    for (const [what, bad] of [
      ["a hash flipped", proof.map((h, i) => (i === 0 ? flip(h) : h))],
      ["the last hash flipped", proof.map((h, i) => (i === proof.length - 1 ? flip(h) : h))],
      ["one dropped", proof.slice(1)],
      ["one added", [...proof, proof[0]]],
      ["another wallet's", file.users[other].proof],
      ["reversed", [...proof].reverse()],
    ] as const) {
      const f = withEntry(file, u, () => ({ proof: [...bad] }));
      expect(entryProblem(f, u), what).toBe(ENTRY_MISMATCH);
      expect(yoursFrom(f, chainAt({ claimed: 3n }), u), what).toEqual(zero(3n));
      expect(claimPlan(f, chainAt(), u), what).toBeNull();
    }
  });
  it("a nonzero entitlement with an empty proof is a mismatch for that wallet alone: zeros, no plan, the others in the file untouched", async () => {
    const { file } = await load();
    const u = FIX_USERS[3];
    const f = withEntry(file, u, () => ({ proof: [] }));
    expect(entryProblem(f, u)).toBe(ENTRY_MISMATCH);
    expect(yoursFrom(f, chainAt(), u)).toEqual({ earned: 0n, claimed: 0n, claimable: 0n, claimNow: 0n, youGet: 0n, refined: 0n, points: 0n, vaultShare: 0n });
    expect(claimPlan(f, chainAt(), u)).toBeNull();
    for (const v of FIX_USERS.filter((x) => x !== u)) {
      expect(entryProblem(f, v)).toBeNull();
      expect(yoursFrom(f, chainAt(), v)).toEqual(yoursFrom(file, chainAt(), v));
      expect(claimPlan(f, chainAt(), v)).toEqual(claimPlan(file, chainAt(), v));
    }
  });
  it("a zero entitlement that comes with a proof cannot verify either: a mismatch", async () => {
    const { file } = await load();
    const u = FIX_USERS[0];
    const f = withEntry(file, u, () => ({ entitlement: "0" }));
    expect(entryProblem(f, u)).toBe(ENTRY_MISMATCH);
    expect(yoursFrom(f, chainAt(), u).points).toBe(0n);
  });
  it("a root that is not the proofs' (an altered file) is a mismatch for every wallet", async () => {
    const { file } = await load();
    const f: UserFile = { ...file, root: `0x${"12".repeat(32)}` };
    for (const u of FIX_USERS) {
      expect(entryProblem(f, u)).toBe(ENTRY_MISMATCH);
      expect(claimPlan(f, chainAt(), u)).toBeNull();
      expect(yoursFrom(f, chainAt(), u).earned).toBe(0n);
    }
  });
  it("an entitlement claimed for a wallet the tree does not list is a mismatch", async () => {
    const { file } = await load();
    const f: UserFile = { ...file, users: { ...file.users, [WALLET]: { ...file.users[FIX_USERS[0]] } } }; // someone else's entry, proof and all
    expect(entryProblem(f, WALLET)).toBe(ENTRY_MISMATCH);
    expect(yoursFrom(f, chainAt(), WALLET).earned).toBe(0n);
    expect(claimPlan(f, chainAt(), WALLET)).toBeNull();
  });
  it("a hostile entitlement outside 0..2^256-1 cannot throw: it is a mismatch", async () => {
    const { file } = await load();
    const u = FIX_USERS[0];
    const f = withEntry(file, u, () => ({ entitlement: (2n ** 256n).toString() }));
    expect(entryProblem(f, u)).toBe(ENTRY_MISMATCH);
    expect(yoursFrom(f, chainAt(), u).earned).toBe(0n);
  });
});

describe("claimLimited / claimPartial (the allowance rules)", () => {
  const y = (claimable: bigint, claimNow: bigint) => ({ claimable, claimNow });
  it("dust threshold is 0.01 HLO", () => expect(MIN_CLAIM_NOW).toBe(10n ** 16n));
  it("limited: something is claimable but the allowance lets through nothing, or less than 0.01 HLO", () => {
    expect(claimLimited(y(100n * HLO, 0n))).toBe(true);
    expect(claimLimited(y(100n * HLO, MIN_CLAIM_NOW - 1n))).toBe(true);
    expect(claimLimited(y(100n * HLO, MIN_CLAIM_NOW))).toBe(false);
  });
  it("not limited when nothing is claimable, or when the allowance is not what holds the claim back (a tiny claimable is not 'the limit')", () => {
    expect(claimLimited(y(0n, 0n))).toBe(false);
    expect(claimLimited(y(5n, 5n))).toBe(false);
    expect(claimLimited(y(MIN_CLAIM_NOW - 1n, MIN_CLAIM_NOW - 1n))).toBe(false);
  });
  it("partial: at least 0.01 HLO can be claimed now but not all of it", () => {
    expect(claimPartial(y(100n * HLO, 40n * HLO))).toBe(true);
    expect(claimPartial(y(100n * HLO, 100n * HLO))).toBe(false);
    expect(claimPartial(y(100n * HLO, 0n))).toBe(false);
    expect(claimPartial(y(100n * HLO, MIN_CLAIM_NOW - 1n))).toBe(false);
    expect(claimPartial(y(100n * HLO, MIN_CLAIM_NOW))).toBe(true);
  });
});

describe("claimPlan", () => {
  it("settleAndClaim when the file is newer than the chain's latest settled minute, with the file's own checkpoint and signature", async () => {
    const { file, cp, tree } = await load();
    for (const u of FIX_USERS) {
      const plan = claimPlan(file, chainAt(), u)!;
      expect(plan.kind).toBe("settleAndClaim");
      expect(plan.cp).toEqual(cp);
      expect(plan.sig).toBe(file.sig);
      expect(plan.entitlement).toBe(BigInt(file.users[u].entitlement));
      expect(plan.proof).toEqual(file.users[u].proof);
      expect(verifyEntitlement(tree.root, u, plan.entitlement, plan.proof)).toBe(true);
    }
  });
  it("settleAndClaim when nothing is settled yet", async () => {
    const { file } = await load();
    expect(claimPlan(file, chainAt({ anySettled: false, latestMinute: null, latestRoot: null }), FIX_USERS[0])!.kind).toBe("settleAndClaim");
  });
  it("claim when the chain has settled this very checkpoint", async () => {
    const { file } = await load();
    const plan = claimPlan(file, chainAt({ latestMinute: FIX_THROUGH, latestRoot: file.root }), FIX_USERS[0])!;
    expect(plan.kind).toBe("claim");
    expect(plan.cp.throughMinute).toBe(FIX_THROUGH);
  });
  it("a user file older than latest.json but equal to the chain's settled minute still claims (the poster writes files only on a round)", async () => {
    const old = await load({ throughMinute: FIX_THROUGH - 1 });
    const newer = await load();
    expect(old.file.throughMinute).toBeLessThan(newer.latest.throughMinute);
    const chain = chainAt({ latestMinute: FIX_THROUGH - 1, latestValidMinute: FIX_THROUGH - 1, latestRoot: old.file.root });
    expect(await checkSigned(old.file, chain, FIX_CHAIN_ID, FIX_CONTRACT)).toEqual({ ok: true });
    const plan = claimPlan(old.file, chain, FIX_USERS[0])!;
    expect(plan.kind).toBe("claim");
    expect(plan.cp).toEqual(old.cp);
    expect(plan.entitlement).toBe(BigInt(old.file.users[FIX_USERS[0]].entitlement));
  });
  it("null when the chain's latest minute is newer than the file and the file is not known to be settled, or has another root at the same minute", async () => {
    const { file } = await load();
    expect(claimPlan(file, chainAt({ latestMinute: FIX_THROUGH + 1 }), FIX_USERS[0])).toBeNull();
    expect(claimPlan(file, chainAt({ latestMinute: FIX_THROUGH, latestRoot: `0x${"77".repeat(32)}` }), FIX_USERS[0])).toBeNull();
    // the settled root of the file's own minute only counts for a file OLDER than the chain
    expect(claimPlan(file, chainAt({ latestMinute: FIX_THROUGH, latestRoot: `0x${"77".repeat(32)}` }), FIX_USERS[0], file.root)).toBeNull();
  });
  describe("a file older than the chain (Mining pays against any settled minute that is not cancelled)", () => {
    // The chain has moved on to FIX_THROUGH + 1; the file is the checkpoint of FIX_THROUGH. `settledRoot` is rootOf(FIX_THROUGH),
    // which the hook reads only in this state: null when it reads zero (never settled, or cancelled).
    const newer = chainAt({ latestMinute: FIX_THROUGH + 1, latestValidMinute: FIX_THROUGH + 1, latestRoot: `0x${"88".repeat(32)}` });
    it("settled at the file's own root: a claim at the file's minute, with the file's entitlement and proof", async () => {
      const { file, tree } = await load();
      for (const u of FIX_USERS) {
        const plan = claimPlan(file, newer, u, file.root)!;
        expect(plan.kind).toBe("claim");
        expect(plan.cp.throughMinute).toBe(FIX_THROUGH);
        expect(plan.entitlement).toBe(BigInt(file.users[u].entitlement));
        expect(plan.proof).toEqual(file.users[u].proof);
        expect(verifyEntitlement(tree.root, u, plan.entitlement, plan.proof)).toBe(true);
      }
    });
    it("the answer is compared without regard to case", async () => {
      const { file } = await load();
      expect(claimPlan(file, newer, FIX_USERS[0], file.root.toUpperCase().replace("0X", "0x") as Hex)?.kind).toBe("claim");
    });
    it("never settled, or cancelled (rootOf reads zero): no plan", async () => {
      const { file } = await load();
      expect(claimPlan(file, newer, FIX_USERS[0], null)).toBeNull();
      expect(claimPlan(file, newer, FIX_USERS[0])).toBeNull(); // not asked
    });
    it("settled at another root: no plan", async () => {
      const { file } = await load();
      expect(claimPlan(file, newer, FIX_USERS[0], `0x${"77".repeat(32)}`)).toBeNull();
    });
    it("the amount rules stay: a wallet that has already claimed past the file's entitlement gets no plan, a partial claim is as before", async () => {
      const { file } = await load();
      const u = FIX_USERS[1];
      const e = BigInt(file.users[u].entitlement);
      expect(claimPlan(file, { ...newer, claimed: e }, u, file.root)).toBeNull();
      expect(claimPlan(file, { ...newer, claimed: e + 1n }, u, file.root)).toBeNull();
      expect(claimPlan(file, { ...newer, claimed: e - 100n, claimAvailable: 40n }, u, file.root)).toMatchObject({ kind: "claim", entitlement: e, expectClaimed: e - 60n });
    });
    it("a wallet whose proof does not verify still gets nothing: the settled root does not vouch for the entry", async () => {
      const { file } = await load();
      const u = FIX_USERS[0];
      expect(claimPlan(withEntry(file, u, (e) => ({ entitlement: (BigInt(e.entitlement) + 1n).toString() })), newer, u, file.root)).toBeNull();
      expect(claimPlan(withEntry(file, u, () => ({ proof: [] })), newer, u, file.root)).toBeNull();
      expect(claimPlan({ ...file, root: `0x${"12".repeat(32)}` }, newer, u, `0x${"12".repeat(32)}`)).toBeNull(); // a root the proofs do not reach
    });
    it("a file at the chain's own minute and root is still a claim without the extra read", async () => {
      const { file } = await load();
      expect(claimPlan(file, chainAt({ latestMinute: FIX_THROUGH, latestRoot: file.root }), FIX_USERS[0])?.kind).toBe("claim");
    });
  });
  it("null when there is nothing to claim: no file, already claimed everything, or a wallet that is absent", async () => {
    const { file } = await load();
    const u = FIX_USERS[1];
    expect(claimPlan(null, chainAt(), u)).toBeNull();
    expect(claimPlan(file, chainAt({ claimed: BigInt(file.users[u].entitlement) }), u)).toBeNull();
    expect(claimPlan(file, chainAt({ claimed: 10n ** 30n }), u)).toBeNull();
    expect(claimPlan(file, chainAt(), WALLET)).toBeNull();
  });
  it("null for an entry with points and nothing earned (nothing to claim)", async () => {
    const { file } = await load();
    const f: UserFile = { ...file, users: { ...file.users, [WALLET]: { entitlement: "0", fees: "5", mined: "0", fromVault: "0", refined: "0", points: "500", proof: [] } } };
    expect(claimPlan(f, chainAt(), WALLET)).toBeNull();
  });
  it("claims the rest when part is claimed (the cumulative entitlement is what is proven)", async () => {
    const { file } = await load();
    const u = FIX_USERS[1];
    const e = BigInt(file.users[u].entitlement);
    expect(claimPlan(file, chainAt({ claimed: e - 1n }), u)!.entitlement).toBe(e);
  });
  it("expectClaimed is claimed plus what the allowance lets through, never past the entitlement", async () => {
    const { file } = await load();
    const u = FIX_USERS[1];
    const e = BigInt(file.users[u].entitlement);
    expect(claimPlan(file, chainAt({ claimed: e - 100n, claimAvailable: 40n }), u)).toMatchObject({ entitlement: e, expectClaimed: e - 60n });
    expect(claimPlan(file, chainAt({ claimed: e - 100n, claimAvailable: 1000n }), u)!.expectClaimed).toBe(e);
    expect(claimPlan(file, chainAt({ claimed: e - 100n, claimAvailable: 100n }), u)!.expectClaimed).toBe(e);
    expect(claimPlan(file, chainAt({ claimed: e - 100n, claimAvailable: 0n }), u)!.expectClaimed).toBe(e - 100n);
    expect(claimPlan(file, chainAt({ claimed: null }), u)!.expectClaimed).toBe(e); // available 5000 HLO covers it
  });
  it("null when the proof does not verify against the file's root: a lying entitlement, proof or root, or a nonzero entitlement with no proof", async () => {
    const { file } = await load();
    const u = FIX_USERS[0];
    const e = BigInt(file.users[u].entitlement);
    expect(claimPlan(withEntry(file, u, () => ({ entitlement: (e + 1n).toString() })), chainAt(), u)).toBeNull();
    expect(claimPlan(withEntry(file, u, () => ({ entitlement: (e - 1n).toString() })), chainAt(), u)).toBeNull();
    expect(claimPlan(withEntry(file, u, (x) => ({ proof: x.proof.map(flip) })), chainAt(), u)).toBeNull();
    expect(claimPlan(withEntry(file, u, () => ({ proof: [] })), chainAt(), u)).toBeNull();
    expect(claimPlan({ ...file, root: `0x${"12".repeat(32)}` }, chainAt(), u)).toBeNull();
    // and it never reaches a plan with a proof it did not check: every plan's proof verifies
    for (const v of FIX_USERS) {
      const plan = claimPlan(file, chainAt(), v)!;
      expect(verifyEntitlement(file.root, v, plan.entitlement, plan.proof)).toBe(true);
    }
  });
});

describe("pointsText", () => {
  it("fee units / 1e8 (1 point per $1 of builder fee, $1,000 traded) with 2 decimals, rounded down", () => {
    expect(pointsText(65_727_600n)).toBe("0.65");
    expect(pointsText(0n)).toBe("0.00");
    expect(pointsText(100_000_000n)).toBe("1.00");
    expect(pointsText(99_999_999n)).toBe("0.99");
    expect(pointsText(1_234_567_890_000n)).toBe("12345.67");
  });
});

describe("settledText", () => {
  const T0 = Date.UTC(2026, 9, 29, 14, 0, 0) / 1000;
  it("names the end of the latest settled minute, in UTC", () => {
    expect(settledText({ latestValidMinute: 4, launchTime: T0 })).toBe("settled through 14:05 UTC");
    expect(settledText({ latestValidMinute: 0, launchTime: T0 })).toBe("settled through 14:01 UTC");
    expect(settledText({ latestValidMinute: 1439, launchTime: T0 })).toBe("settled through 14:00 UTC");
  });
  it("after a cancel it shows the newest checkpoint that is not cancelled", () => {
    expect(settledText({ latestValidMinute: 2, launchTime: T0 })).toBe("settled through 14:03 UTC");
  });
  it("says so when nothing is settled", () => {
    expect(settledText({ latestValidMinute: null, launchTime: T0 })).toBe("not settled yet");
  });
});

describe("staking drip tail (plan2-inputs)", () => {
  it("about 63% of a buy is out after a day of 10-minute updates", () => {
    expect(1 - dripRemaining(86_400)).toBeCloseTo(0.633, 2);
    expect(dripRemaining(0)).toBe(1);
  });
  it("is never above 1 for a negative elapsed time, and falls with time", () => {
    expect(dripRemaining(-500)).toBe(1);
    expect(dripRemaining(600)).toBeCloseTo(1 - 600 / 86_400, 12);
    expect(dripRemaining(7 * 86_400)).toBeLessThan(dripRemaining(86_400));
  });
});

describe("pool", () => {
  it("price in USDC per HLO from the pair reserves", () => {
    expect(poolPrice([10_000n * HLO, 45_000_000n], true)).toBeCloseTo(0.0045, 10);
    expect(poolPrice([45_000_000n, 10_000n * HLO], false)).toBeCloseTo(0.0045, 10);
    expect(poolPrice([0n, 0n], true)).toBeNull();
  });
  it("phases", () => {
    const base = { now: 100, openAt: 200, poolOpen: false, usdcHeld: 1n, slice: 0n, lastBuy: 0, buyInterval: 600 };
    expect(poolPhase(base)).toEqual({ kind: "countdown", secondsLeft: 100 });
    expect(poolPhase({ ...base, now: 200 })).toEqual({ kind: "canOpen" });
    expect(poolPhase({ ...base, now: 200, usdcHeld: 0n })).toEqual({ kind: "waitingForFees" });
    expect(poolPhase({ ...base, poolOpen: true })).toEqual({ kind: "waitingForDeposit" });
    expect(poolPhase({ ...base, poolOpen: true, slice: 5n, now: 1000, lastBuy: 700 })).toEqual({ kind: "nextBuy", secondsLeft: 300 });
    expect(poolPhase({ ...base, poolOpen: true, slice: 5n, now: 1300, lastBuy: 700 })).toEqual({ kind: "buyDue" });
  });
  it("boundaries: opens at openAt exactly, buys at lastBuy + interval exactly", () => {
    const base = { now: 0, openAt: 200, poolOpen: false, usdcHeld: 1n, slice: 0n, lastBuy: 0, buyInterval: 600 };
    expect(poolPhase({ ...base, now: 199 })).toEqual({ kind: "countdown", secondsLeft: 1 });
    expect(poolPhase({ ...base, now: 200 })).toEqual({ kind: "canOpen" });
    const open = { ...base, poolOpen: true, slice: 5n, lastBuy: 700 };
    expect(poolPhase({ ...open, now: 1299 })).toEqual({ kind: "nextBuy", secondsLeft: 1 });
    expect(poolPhase({ ...open, now: 1300 })).toEqual({ kind: "buyDue" });
  });
  it("open with slice 0 waits for a fee deposit, whatever the clock says", () => {
    const open = { now: 10_000, openAt: 200, poolOpen: true, usdcHeld: 1n, slice: 0n, lastBuy: 0, buyInterval: 600 };
    expect(poolPhase(open)).toEqual({ kind: "waitingForDeposit" });
    expect(poolPhase({ ...open, slice: 5n })).toEqual({ kind: "buyDue" });
    expect(poolPhase({ ...open, slice: 5n, poolOpen: false, now: 100 })).toEqual({ kind: "countdown", secondsLeft: 100 });
  });
});
