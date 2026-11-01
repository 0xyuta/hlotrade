import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { afterAll, describe, expect, it } from "vitest";
// The poster's own writer and reader (test only: the app bundle never imports ops or calc).
import { checkpointPath, LATEST_PATH, parseLatestFile, parseUserFile as opsParseUserFile, readPublished, userFilePath } from "../../ops/src/checkpoint-files";
import { LocalPublisher, toJson } from "../../ops/src/publish";
import type { CoreChain } from "../src/rewards/chain";
import { checkpointUrl, parseCheckpointFile, parseLatest, parseUserFile, userFileUrl } from "../src/rewards/files";
import { feeTable } from "../src/rewards/explore";
import { checkLatest, checkSigned, claimPlan, entryProblem, ENTRY_MISMATCH, pointsText, yoursFrom } from "../src/rewards/model";
import { verifyEntitlement } from "../src/rewards/proof";
import { FIX_CHAIN_ID, FIX_CONTRACT, FIX_LAUNCH, FIX_OTHER_ACCOUNT, FIX_POP_MINUTE, FIX_POSTER_ACCOUNT, FIX_THROUGH, FIX_USERS, makeLatest } from "./helpers/checkpoint-fixture";

/**
 * Final review M6: ops writes the reward files and the app reads them, and each side used to test against its own
 * hand-written fixture, so a renamed field would pass both suites. This builds a real, signed checkpoint with ops, publishes it
 * with the poster's own writer into a temp dir (latest.json, the archive and every users/<xx>.json), reads it back the way ops
 * reads it, and feeds the text through the app's parsers, proof check and poster-signature check.
 */
const dir = mkdtempSync(join(tmpdir(), "hlo-publish-contract-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function publish() {
  const made = await makeLatest();
  const pub = new LocalPublisher(dir);
  await pub.put(LATEST_PATH, toJson(made.latest), "application/json");
  await pub.put(checkpointPath(made.latest.throughMinute), toJson(made.archive), "application/json");
  // The poster's own writer for the user files (the local directory keeps them as plain text; R2 would store them gzipped).
  for (const [path, file] of made.userFiles) await pub.put(path, toJson(file), "application/json", { maxAgeSeconds: 60, gzip: true });
  const text = await readPublished({ dir }, LATEST_PATH);
  if (text === null) throw new Error("latest.json was not written");
  const userTexts = new Map<string, string>();
  for (const path of made.userFiles.keys()) {
    const t = await readPublished({ dir }, path);
    if (t === null) throw new Error(`${path} was not written`);
    userTexts.set(path, t);
  }
  const fileText = userTexts.get(userFilePath(FIX_USERS[0]));
  if (fileText === undefined) throw new Error("the fixture's user file was not written");
  return { ...made, text, userTexts, fileText };
}

const chainAt = (o: Partial<CoreChain> = {}): CoreChain => ({
  now: FIX_LAUNCH + 60 * 20, launchTime: FIX_LAUNCH, anySettled: true, latestMinute: FIX_THROUGH - 1, latestValidMinute: FIX_THROUGH - 1, latestRoot: `0x${"99".repeat(32)}`,
  paused: false, poster: FIX_POSTER_ACCOUNT.address, claimed: 0n, claimAvailable: 5000n * 10n ** 18n, ...o,
});

describe("ops latest.json → app parsers (final review M6)", () => {
  it("the app parses exactly what ops accepts, and sees the same values", async () => {
    const { text, latest } = await publish();
    const opsView = parseLatestFile(text);
    const appView = parseLatest(JSON.parse(text));
    expect(appView).not.toBeNull();
    expect(appView).toEqual(opsView);
    expect(appView).toEqual(JSON.parse(JSON.stringify(latest)));
  });
  it("the archive file is not a latest.json (no tree, users or vault): the app refuses it", async () => {
    const { archive } = await publish();
    expect(parseLatest(JSON.parse(JSON.stringify(archive)))).toBeNull();
  });
  it("the app reads an archive file ops wrote, its signature and its fee table (the Explore tab)", async () => {
    const { archive } = await publish();
    const file = parseCheckpointFile(JSON.parse(JSON.stringify(archive)));
    expect(file?.throughMinute).toBe(archive.throughMinute);
    expect(feeTable(file!.table, file!.throughMinute)).not.toBeNull();
    expect(checkpointUrl("https://files.example/998/", 7)).toBe("https://files.example/998/checkpoints/7.json");
    expect(checkpointPath(7)).toBe("checkpoints/7.json");
  });
  it("latest.json has neither a tree nor users: a wallet's numbers and proof are in its user file", async () => {
    const { text } = await publish();
    const j = JSON.parse(text) as Record<string, unknown>;
    expect(j).not.toHaveProperty("tree");
    expect(j).not.toHaveProperty("users");
    expect(Object.keys(j).sort()).toEqual(["chainId", "contract", "pops", "publishedAt", "refBlock", "root", "sig", "table", "throughMinute", "totalEntitled", "v", "vault"]);
  });
  it("the app parses every user file exactly as ops reads it, and sees the same values", async () => {
    const { userTexts, userFiles } = await publish();
    expect(userTexts.size).toBeGreaterThan(0);
    for (const [path, text] of userTexts) {
      const appView = parseUserFile(JSON.parse(text));
      expect(appView, path).not.toBeNull();
      expect(appView, path).toEqual(opsParseUserFile(text));
      expect(appView, path).toEqual(userFiles.get(path));
    }
  });
  it("the parsers differ on one thing, on purpose: a nonzero entitlement with no proof (the poster never writes it). Ops refuses the whole file as malformed; the app parses it and makes it a mismatch for that wallet alone", async () => {
    const { fileText } = await publish();
    const j = JSON.parse(fileText) as { users: Record<string, { proof: string[] }> };
    j.users[FIX_USERS[0]].proof = [];
    const text = JSON.stringify(j);
    expect(() => opsParseUserFile(text)).toThrow(/bad checkpoint file/);
    const file = parseUserFile(JSON.parse(text));
    expect(file).not.toBeNull();
    expect(entryProblem(file, FIX_USERS[0])).toBe(ENTRY_MISMATCH);
    expect(yoursFrom(file, chainAt(), FIX_USERS[0]).earned).toBe(0n);
    expect(claimPlan(file, chainAt(), FIX_USERS[0])).toBeNull();
    expect(entryProblem(file, FIX_USERS[1])).toBeNull(); // the other wallets in the file are fine
    expect(yoursFrom(file, chainAt(), FIX_USERS[1]).earned).toBeGreaterThan(0n);
  });
  it("every wallet's proof comes from its user file and verifies against the file's root, which is latest.json's and the tree's", async () => {
    const { text, fileText, result, tree } = await publish();
    const l = parseLatest(JSON.parse(text))!;
    const f = parseUserFile(JSON.parse(fileText))!;
    expect(f.root).toBe(tree.root);
    expect(f.root).toBe(l.root);
    for (const user of FIX_USERS) {
      const e = f.users[user];
      expect(e, user).toBeDefined();
      expect(BigInt(e.entitlement)).toBe(result.entitlements.get(user as never));
      expect(e.proof).toEqual(tree.proofs.get(user as never)!.proof);
      expect(e.proof.length).toBeGreaterThan(0);
      expect(verifyEntitlement(f.root as Hex, user, BigInt(e.entitlement), e.proof)).toBe(true);
    }
  });
  it("the user file carries latest.json's signed fields, so it stands alone: the poster's signature checks out on it too", async () => {
    const { text, fileText } = await publish();
    const l = parseLatest(JSON.parse(text))!;
    const f = parseUserFile(JSON.parse(fileText))!;
    expect(f).toMatchObject({ chainId: l.chainId, contract: l.contract, throughMinute: l.throughMinute, refBlock: l.refBlock, root: l.root, totalEntitled: l.totalEntitled, sig: l.sig, publishedAt: l.publishedAt });
    expect(f.vault).toEqual({ amount: l.vault.amount, pointsTotal: l.vault.pointsTotal });
    expect(await checkSigned(f, chainAt(), FIX_CHAIN_ID, FIX_CONTRACT)).toEqual({ ok: true });
    expect((await checkSigned(f, chainAt({ poster: FIX_OTHER_ACCOUNT.address }), FIX_CHAIN_ID, FIX_CONTRACT)).ok).toBe(false);
  });
  it("the poster's signature recovers the poster, and not another key", async () => {
    const { text } = await publish();
    const l = parseLatest(JSON.parse(text))!;
    expect(await checkLatest(l, chainAt(), FIX_CHAIN_ID, FIX_CONTRACT)).toEqual({ ok: true });
    expect((await checkLatest(l, chainAt({ poster: FIX_OTHER_ACCOUNT.address }), FIX_CHAIN_ID, FIX_CONTRACT)).ok).toBe(false);
  });
  it("yours and the claim plan read the breakdown, points and vault from the user file the way ops wrote them", async () => {
    const { fileText, result } = await publish();
    const f = parseUserFile(JSON.parse(fileText))!;
    for (const user of FIX_USERS as Address[]) {
      const y = yoursFrom(f, chainAt(), user);
      expect(y.earned).toBe(result.entitlements.get(user as never));
      expect(y.points).toBe(result.points.get(user as never));
      expect(y.refined).toBe(result.totals.get(user as never)!.refined);
      const plan = claimPlan(f, chainAt(), user)!;
      expect(plan).toMatchObject({ kind: "settleAndClaim", entitlement: y.earned, sig: f.sig, proof: f.users[user].proof });
      expect(plan.cp).toEqual({ throughMinute: FIX_THROUGH, refBlock: BigInt(f.refBlock), root: f.root, totalEntitled: result.totalEntitled });
    }
    const all = FIX_USERS.reduce((s, u) => s + yoursFrom(f, chainAt(), u as Address).vaultShare, 0n);
    const pay = (result.vault * 9n) / 10n; // what a pop now would share
    expect(all).toBeLessThanOrEqual(pay);
    expect(all).toBeGreaterThan(pay - BigInt(FIX_USERS.length));
    expect(pointsText(yoursFrom(f, chainAt(), FIX_USERS[0]).points)).toMatch(/^\d+\.\d\d$/);
  });
  it("the app asks for the file ops writes: userFileUrl is the base plus ops' userFilePath, for any case and any first byte, letters included", () => {
    const base = "https://files.example/998/";
    for (const user of [
      "0xAB12000000000000000000000000000000000001", "0xab12000000000000000000000000000000000001", "0xfF00000000000000000000000000000000000002",
      "0x0A00000000000000000000000000000000000003", "0xe5C0000000000000000000000000000000000004", FIX_USERS[0], "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
    ] as Address[]) {
      expect(userFileUrl(base, user), user).toBe(`${base}${userFilePath(user)}`);
    }
    expect(userFilePath("0xAB12000000000000000000000000000000000001")).toBe("users/ab.json");
  });
  it("a wallet in no file reads as zero, with 0.00 points and no problem and no plan", async () => {
    const { fileText } = await publish();
    const f = parseUserFile(JSON.parse(fileText))!;
    const stranger = "0x00000000000000000000000000000000000000ee" as Address;
    expect(yoursFrom(f, chainAt(), stranger)).toMatchObject({ earned: 0n, points: 0n, vaultShare: 0n });
    expect(pointsText(yoursFrom(null, chainAt(), stranger).points)).toBe("0.00");
    expect(entryProblem(f, stranger)).toBeNull();
    expect(claimPlan(f, chainAt(), stranger)).toBeNull();
  });
  it("the vault's odds and the pops the way ops wrote them", async () => {
    const { text, result } = await publish();
    const l = parseLatest(JSON.parse(text))!;
    expect(l.vault).toEqual({ amount: result.vault.toString(), pointsTotal: result.pointsTotal.toString(), odds: 60, lastPopMinute: FIX_POP_MINUTE });
    expect(l.pops).toEqual([...result.pops].reverse().map((p) => ({ minute: p.minute, block: p.block.toString(), amount: p.amount.toString(), kept: p.kept.toString(), recipients: p.recipients })));
    expect(await checkLatest(l, chainAt(), FIX_CHAIN_ID, FIX_CONTRACT)).toEqual({ ok: true });
  });
});
