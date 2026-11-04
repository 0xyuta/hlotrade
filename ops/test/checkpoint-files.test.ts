import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyCheckpoint, buildTree, newCalcState, parseTableCsv, popOdds, verifyProof, type Addr, type FeeRow } from "@hlo/calc";
import { seedsFor } from "../../calc/test/helpers/seeds.js";
import { describe, expect, it } from "vitest";
import {
  buildFiles, buildUserFiles, checkpointPath, knownWallets, LATEST_PATH, MAX_POPS, parseCheckpointFile, parseLatestFile, parseUserFile, readPublished,
  ROUND, settleRound, userFileEvery, userFilePath, type BuildArgs, type UserFile,
} from "../src/checkpoint-files.js";
import { toJson } from "../src/publish.js";

const A = "0x00000000000000000000000000000000000000aa" as const;
const B = "0x00000000000000000000000000000000000000bb" as const;
const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
const SIG = `0x${"11".repeat(65)}` as const;
const LAUNCH = 1_800_000_000;

function args(): BuildArgs {
  const s = newCalcState(LAUNCH, popOdds(998));
  const rows: FeeRow[] = [{ minute: 0, user: A, fee: 100n }, { minute: 1, user: A, fee: 100n }, { minute: 1, user: B, fee: 300n }];
  const result = applyCheckpoint(s, { minimum: { fromMinute: 0, units: 0n }, quietFrom: null, throughMinute: 1, refBlock: 10n, rows, seeds: seedsFor(0, 1, { odds: 60 }), burned: 0n, refined: 0n, claimed: new Map() });
  const tree = buildTree(result.entitlements);
  return {
    chainId: 998, contract: CONTRACT, throughMinute: 1, refBlock: 10n, sig: SIG, publishedAt: LAUNCH + 130, rows, result, tree,
    pops: [{ minute: 0, block: 9n, amount: 5n, kept: 1n, recipients: 2 }],
  };
}

describe("buildFiles", () => {
  it("round-trips through JSON and the parsers", () => {
    const { archive, latest } = buildFiles(args());
    expect(parseCheckpointFile(JSON.stringify(archive))).toEqual(archive);
    expect(parseLatestFile(JSON.stringify(latest))).toEqual(latest);
    expect(latest.root).toBe(archive.root);
    expect(archive.refBlock).toBe("10");
    expect(archive.totalEntitled).toBe(args().result.totalEntitled.toString());
  });

  it("the table round-trips through parseTableCsv", () => {
    const { archive } = buildFiles(args());
    expect(parseTableCsv(archive.table)).toEqual(args().rows);
  });

  it("carries the vault and the pops, and neither the tree nor the users: a wallet's numbers and proof are in its user file", () => {
    const a = args();
    const { latest } = buildFiles(a);
    expect(latest.vault).toEqual({ amount: a.result.vault.toString(), pointsTotal: "500", odds: 60, lastPopMinute: 0 });
    expect(latest.pops).toEqual([{ minute: 0, block: "9", amount: "5", kept: "1", recipients: 2 }]);
    expect(latest).not.toHaveProperty("tree");
    expect(latest).not.toHaveProperty("users");
    expect(latest).not.toHaveProperty("openings");
  });

  it("the users' breakdown and points since the last pop are in the user files", () => {
    const a = args();
    const file = buildUserFiles(a).get(userFilePath(A))!;
    const u = file.users[A];
    expect(u.entitlement).toBe(a.result.entitlements.get(A)!.toString());
    expect(u.fees).toBe("200");
    expect(u.points).toBe("200");
    expect(Object.keys(file.users).sort()).toEqual([A, B]);
  });

  it("before any pop lastPopMinute is -1 and pops is empty", () => {
    const { latest } = buildFiles({ ...args(), pops: [] });
    expect(latest.vault.lastPopMinute).toBe(-1);
    expect(latest.pops).toEqual([]);
  });

  it("the odds are the chain's: 1,250 on 999, 1 on anvil", () => {
    expect(buildFiles({ ...args(), chainId: 999 }).latest.vault.odds).toBe(1250);
    expect(buildFiles({ ...args(), chainId: 31337 }).latest.vault.odds).toBe(1);
  });

  it("keeps the newest 10 pops; the newest is lastPopMinute", () => {
    const a = args();
    a.pops = Array.from({ length: 12 }, (_, i) => ({ minute: 100 - i, block: BigInt(500 - i), amount: 1n, kept: 1n, recipients: 1 }));
    const { latest } = buildFiles(a);
    expect(latest.pops).toHaveLength(MAX_POPS);
    expect(latest.pops[0].minute).toBe(100);
    expect(latest.vault.lastPopMinute).toBe(100);
  });

  it("paths", () => {
    expect(checkpointPath(42)).toBe("checkpoints/42.json");
    expect(LATEST_PATH).toBe("latest.json");
  });
});

describe("parsers reject bad input", () => {
  const good = () => JSON.parse(JSON.stringify(buildFiles(args()).latest));
  const bad = (mut: (j: Record<string, unknown>) => void, parse: (t: string) => unknown = parseLatestFile) => {
    const j = good();
    mut(j);
    expect(() => parse(JSON.stringify(j))).toThrow();
  };
  it("rejects a bad root", () => {
    bad((j) => (j.root = "0x1234"));
    bad((j) => (j.root = "nothex"));
    bad((j) => (j.root = "0x" + "zz".repeat(32)));
  });
  it("rejects a non-numeric amount", () => {
    bad((j) => (j.totalEntitled = "1.5"));
    bad((j) => (j.refBlock = "abc"));
    bad((j) => (j.totalEntitled = 5));
    bad((j) => ((j.vault as Record<string, unknown>).amount = "-1"));
  });
  it("rejects a wrong v", () => {
    bad((j) => (j.v = 2));
    bad((j) => delete j.v);
  });
  it("rejects other bad fields", () => {
    bad((j) => (j.sig = "0x12"));
    bad((j) => (j.contract = "0x12"));
    bad((j) => (j.throughMinute = -1));
    bad((j) => (j.throughMinute = 1.5));
    bad((j) => (j.chainId = "998"));
    bad((j) => (j.table = "garbage"));
    bad((j) => delete j.vault);
    bad((j) => (j.pops = [{ minute: 0 }]));
    bad((j) => ((j.pops as Record<string, unknown>[])[0].block = "x"));
    bad((j) => ((j.pops as Record<string, unknown>[])[0].kept = 5));
    bad((j) => delete j.pops);
    bad((j) => ((j.vault as Record<string, unknown>).odds = 0));
    bad((j) => ((j.vault as Record<string, unknown>).odds = 1.5));
    bad((j) => ((j.vault as Record<string, unknown>).lastPopMinute = -2));
    bad((j) => ((j.vault as Record<string, unknown>).lastPopMinute = "0"));
    // the weekly shape of before the vault pops
    bad((j) => {
      j.vault = { week: 0, amount: "0", pointsTotal: "0", opensAt: 1 };
      j.openings = [];
      delete j.pops;
    });
  });
  it("parseLatestFile needs no tree and no users, and ignores both in an old file during the rollout", () => {
    const { latest } = buildFiles(args());
    const text = JSON.stringify(latest);
    expect(JSON.parse(text)).not.toHaveProperty("tree");
    expect(parseLatestFile(text)).toEqual(latest);
    const old = { ...JSON.parse(text), tree: { format: "standard-v1" }, users: { [A]: { entitlement: "not even digits" } } };
    expect(parseLatestFile(JSON.stringify(old))).toEqual(latest);
  });
  it("parseCheckpointFile rejects the same and non-JSON", () => {
    bad((j) => (j.root = "0x1234"), parseCheckpointFile);
    bad((j) => (j.v = 2), parseCheckpointFile);
    expect(() => parseCheckpointFile("{")).toThrow();
    expect(() => parseCheckpointFile("null")).toThrow();
  });
  it("parseCheckpointFile accepts the archive and ignores nothing wrong in a latest file", () => {
    const { archive, latest } = buildFiles(args());
    expect(parseCheckpointFile(JSON.stringify(archive))).toEqual(archive);
    expect(parseCheckpointFile(JSON.stringify(latest)).throughMinute).toBe(1);
  });
});

describe("readPublished", () => {
  it("reads from a dir and gives null for a missing file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pub-"));
    mkdirSync(dirname(join(dir, "checkpoints/3.json")), { recursive: true });
    writeFileSync(join(dir, "checkpoints/3.json"), "hello");
    expect(await readPublished({ dir }, "checkpoints/3.json")).toBe("hello");
    expect(await readPublished({ dir }, "checkpoints/4.json")).toBeNull();
  });
  it("refuses a path that escapes the dir", async () => {
    await expect(readPublished({ dir: tmpdir() }, "../etc/passwd")).rejects.toThrow();
  });
  it("GETs over http: body, null on 404, throws on other errors", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/base/latest.json") res.end("{}");
      else if (req.url === "/base/boom.json") (res.writeHead(500), res.end("x"));
      else (res.writeHead(404), res.end("no"));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/base/`;
    try {
      expect(await readPublished(base, "latest.json")).toBe("{}");
      expect(await readPublished(base.replace(/\/$/, ""), "latest.json")).toBe("{}");
      expect(await readPublished(base, "checkpoints/9.json")).toBeNull();
      await expect(readPublished(base, "boom.json")).rejects.toThrow(/500/);
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------- user files

const W1 = "0xab00000000000000000000000000000000000001" as Addr;
const W2 = "0xab00000000000000000000000000000000000002" as Addr; // the same file as W1
const W3 = "0xcd00000000000000000000000000000000000003" as Addr;
const W4 = "0x00000000000000000000000000000000000000aa" as Addr;
const PTS = "0x7f00000000000000000000000000000000000005" as Addr; // points, nothing earned
const TOT = "0x8000000000000000000000000000000000000006" as Addr; // totals only

/** Four wallets with an entitlement in three files, one with points and no entitlement, one only in totals. */
function userArgs(): BuildArgs {
  const s = newCalcState(LAUNCH, popOdds(998));
  const rows: FeeRow[] = [W1, W2, W3, W4].map((user, i) => ({ minute: 1, user, fee: BigInt(100 * (i + 1)) }));
  const a = args();
  const result = applyCheckpoint(s, { minimum: { fromMinute: 0, units: 0n }, quietFrom: null, throughMinute: 1, refBlock: 10n, rows, seeds: seedsFor(0, 1, { odds: 60 }), burned: 0n, refined: 0n, claimed: new Map() });
  result.points.set(PTS, 5n);
  result.totals.set(PTS, { fees: 5n, mined: 0n, fromVault: 0n, refined: 0n });
  result.totals.set(TOT, { fees: 9n, mined: 0n, fromVault: 0n, refined: 0n });
  return { ...a, rows, result, tree: buildTree(result.entitlements) };
}

describe("userFilePath and userFileEvery", () => {
  it("the file is the address's first byte in lowercase hex", () => {
    expect(userFilePath("0xAB12000000000000000000000000000000000000")).toBe("users/ab.json");
    expect(userFilePath(W4)).toBe("users/00.json");
  });
  it("every checkpoint under 2,000 wallets, every 5th under 20,000, every 15th above", () => {
    expect([0, 1, 1_999].map(userFileEvery)).toEqual([1, 1, 1]);
    expect([2_000, 19_999].map(userFileEvery)).toEqual([5, 5]);
    expect([20_000, 100_000].map(userFileEvery)).toEqual([15, 15]);
  });
  it("every multiple of ROUND (15) is a round at every wallet count, which is what lets the keeper settle only those minutes", () => {
    expect(ROUND).toBe(15);
    for (const wallets of [0, 1, 1_999, 2_000, 19_999, 20_000, 100_000, 1_000_000]) {
      expect(ROUND % userFileEvery(wallets), `${wallets} wallets`).toBe(0);
      for (const m of [0, 15, 30, 45, 60, 1_005]) expect(m % userFileEvery(wallets), `minute ${m}, ${wallets} wallets`).toBe(0);
    }
  });
  it("the keeper settles multiples of 15, and every minute on anvil", () => {
    expect([999, 998].map(settleRound)).toEqual([15, 15]);
    expect(settleRound(31337)).toBe(1);
  });
});

describe("buildUserFiles", () => {
  it("puts every wallet with an entitlement, points or totals in exactly one file, the one its address names, and no empty file", () => {
    const a = userArgs();
    const files = buildUserFiles(a);
    expect([...files.keys()].sort()).toEqual(["users/00.json", "users/7f.json", "users/80.json", "users/ab.json", "users/cd.json"]);
    const seen = new Map<string, string>();
    for (const [path, f] of files) {
      expect(Object.keys(f.users).length).toBeGreaterThan(0);
      for (const u of Object.keys(f.users)) {
        expect(userFilePath(u)).toBe(path);
        expect(seen.has(u)).toBe(false);
        seen.set(u, path);
      }
    }
    expect([...seen.keys()].sort()).toEqual([W1, W2, W3, W4, PTS, TOT].sort());
    expect(Object.keys(files.get("users/ab.json")!.users)).toEqual([W1, W2]);
  });

  it("each file carries its checkpoint's signed fields and the vault's two amounts, not the table", () => {
    const a = userArgs();
    const { archive } = buildFiles(a);
    for (const f of buildUserFiles(a).values()) {
      expect(f).not.toHaveProperty("table");
      expect(f).toMatchObject({
        v: 1, chainId: archive.chainId, contract: archive.contract, throughMinute: archive.throughMinute, refBlock: archive.refBlock,
        root: archive.root, totalEntitled: archive.totalEntitled, sig: archive.sig, publishedAt: archive.publishedAt,
      });
      expect(f.vault).toEqual({ amount: a.result.vault.toString(), pointsTotal: a.result.pointsTotal.toString() });
    }
  });

  it("an entry has the calculator's numbers, and its proof is the tree's and verifies against the file's root", () => {
    const a = userArgs();
    for (const f of buildUserFiles(a).values()) {
      for (const [u, e] of Object.entries(f.users)) {
        const { proof, ...numbers } = e;
        const t = a.result.totals.get(u as Addr);
        expect(numbers).toEqual({
          entitlement: (a.result.entitlements.get(u as Addr) ?? 0n).toString(),
          fees: (t?.fees ?? 0n).toString(),
          mined: (t?.mined ?? 0n).toString(),
          fromVault: (t?.fromVault ?? 0n).toString(),
          refined: (t?.refined ?? 0n).toString(),
          points: (a.result.points.get(u as Addr) ?? 0n).toString(),
        });
        if (e.entitlement === "0") continue;
        expect(proof).toEqual(a.tree.proofs.get(u as Addr)!.proof);
        expect(proof.length).toBeGreaterThan(0);
        expect(verifyProof(f.root, u as Addr, BigInt(e.entitlement), proof)).toBe(true);
      }
    }
  });

  it("a wallet with points or totals and nothing earned has entitlement 0 and no proof", () => {
    const files = buildUserFiles(userArgs());
    expect(files.get("users/7f.json")!.users[PTS]).toMatchObject({ entitlement: "0", points: "5", fees: "5", proof: [] });
    expect(files.get("users/80.json")!.users[TOT]).toMatchObject({ entitlement: "0", points: "0", fees: "9", proof: [] });
  });

  it("a wallet with an entitlement and no proof in the tree fails the build, it is never written without one", () => {
    const a = userArgs();
    const without = new Map(a.result.entitlements);
    without.delete(W2); // a tree that does not hold W2
    expect(() => buildUserFiles({ ...a, tree: buildTree(without) })).toThrow(/no proof for 0xab0*2 /);
  });

  it("a proof for another entitlement fails the build too", () => {
    const a = userArgs();
    const wrong = new Map(a.result.entitlements);
    wrong.set(W1, a.result.entitlements.get(W1)! + 1n);
    expect(() => buildUserFiles({ ...a, tree: buildTree(wrong) })).toThrow(/no proof for 0xab0*1 /);
  });

  it("an empty checkpoint has no files", () => {
    const s = newCalcState(LAUNCH, popOdds(998));
    const result = applyCheckpoint(s, { minimum: { fromMinute: 0, units: 0n }, quietFrom: null, throughMinute: 0, refBlock: 10n, rows: [], seeds: seedsFor(0, 0, { odds: 60 }), burned: 0n, refined: 0n, claimed: new Map() });
    expect(buildUserFiles({ ...args(), throughMinute: 0, rows: [], result, tree: buildTree(result.entitlements) }).size).toBe(0);
  });

  it("the files list every wallet the checkpoint knows (a wallet only in totals is in no bucket's gap)", () => {
    const a = userArgs();
    const fromFiles = [...buildUserFiles(a).values()].flatMap((f) => Object.keys(f.users)).sort();
    expect(fromFiles).toEqual([...knownWallets(a.result)].sort());
  });
});

describe("parseUserFile", () => {
  const built = () => buildUserFiles(userArgs()).get("users/ab.json")!;
  const good = () => JSON.parse(toJson(built()));
  const bad = (mut: (j: Record<string, unknown>) => void) => {
    const j = good();
    mut(j);
    expect(() => parseUserFile(JSON.stringify(j))).toThrow(/bad checkpoint file/);
  };
  const entry = (j: Record<string, unknown>) => (j.users as Record<string, Record<string, unknown>>)[W1];

  it("round-trips a built file, and every file of a checkpoint", () => {
    for (const f of buildUserFiles(userArgs()).values()) expect(parseUserFile(toJson(f))).toEqual(f);
  });
  it("needs no table", () => {
    expect(good()).not.toHaveProperty("table");
    expect(parseUserFile(JSON.stringify(good()))).toEqual(built());
  });
  it("refuses a wrong v", () => {
    bad((j) => (j.v = 2));
    bad((j) => delete j.v);
  });
  it("refuses a bad signed field, as parseLatestFile does", () => {
    bad((j) => (j.root = "0x1234"));
    bad((j) => (j.sig = "0x12"));
    bad((j) => (j.contract = "0x12"));
    bad((j) => (j.throughMinute = -1));
    bad((j) => (j.chainId = "998"));
    bad((j) => (j.refBlock = "abc"));
    bad((j) => (j.totalEntitled = "-5"));
    bad((j) => (j.publishedAt = 1.5));
  });
  it("refuses a missing or bad vault", () => {
    bad((j) => delete j.vault);
    bad((j) => (j.vault = null));
    bad((j) => ((j.vault as Record<string, unknown>).amount = "-1"));
    bad((j) => ((j.vault as Record<string, unknown>).pointsTotal = "1.5"));
    bad((j) => delete (j.vault as Record<string, unknown>).pointsTotal);
  });
  it("refuses users that are not an object, a bad address key and an uppercase one", () => {
    bad((j) => delete j.users);
    bad((j) => (j.users = []));
    bad((j) => (j.users = { "0xnothex": entry(j) }));
    bad((j) => (j.users = { "0xab0000": entry(j) }));
    bad((j) => (j.users = { [W1.toUpperCase().replace("0X", "0x")]: entry(j) }));
    bad((j) => (j.users = { [W1]: null }));
  });
  it("refuses an amount that is negative, not digits, not a string or has a leading zero", () => {
    for (const k of ["entitlement", "fees", "mined", "fromVault", "refined", "points"]) {
      for (const v of ["-1", "x", "1.5", "", "01", 5, null]) bad((j) => (entry(j)[k] = v));
      bad((j) => delete entry(j)[k]);
    }
  });
  it("refuses a proof that is missing, not an array, or has an entry that is not 32-byte hex", () => {
    bad((j) => delete entry(j).proof);
    bad((j) => (entry(j).proof = "0x"));
    bad((j) => (entry(j).proof = [`0x${"11".repeat(31)}`]));
    bad((j) => (entry(j).proof = [`0x${"11".repeat(33)}`]));
    bad((j) => (entry(j).proof = [`0x${"zz".repeat(32)}`]));
    bad((j) => (entry(j).proof = [5]));
    bad((j) => ((entry(j).proof as unknown[])[0] = "0x1234"));
  });
  it("refuses an entry that can never verify: a proof with entitlement 0, or an entitlement with no proof", () => {
    bad((j) => (entry(j).entitlement = "0"));
    bad((j) => (entry(j).proof = []));
    const f = buildUserFiles(userArgs()).get("users/7f.json")!;
    expect(f.users[PTS].proof).toEqual([]);
    expect(parseUserFile(toJson(f))).toEqual(f); // the right way round is fine
  });
  it("refuses non-JSON and a non-object", () => {
    expect(() => parseUserFile("{")).toThrow(/bad checkpoint file/);
    expect(() => parseUserFile("[]")).toThrow(/bad checkpoint file/);
    expect(() => parseUserFile("null")).toThrow(/bad checkpoint file/);
  });
  it("ignores fields it does not know (a table in a copy of latest.json is dropped)", () => {
    const j = good();
    j.table = "minute,user,fee\n";
    j.extra = 1;
    const f: UserFile = parseUserFile(JSON.stringify(j));
    expect(f).toEqual(built());
  });
});
