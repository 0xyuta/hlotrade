import { afterEach, describe, expect, it, vi } from "vitest";
import { FETCH_TIMEOUT_MS, USER_FILE_TIMEOUT_MS, latestUrl, loadLatest, loadUserFile, parseLatest, parseUserFile, userFileUrl } from "../src/rewards/files";
import { FIX_USERS, makeLatest, malleate } from "./helpers/checkpoint-fixture";

const BASE = "https://store.example/998/";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const mut = async (f: (j: Record<string, any>) => void) => {
  const j = structuredClone((await makeLatest()).json) as Record<string, any>;
  f(j);
  return j;
};

describe("parseLatest (what ops' buildFiles writes)", () => {
  it("accepts the file ops builds, with every field carried over", async () => {
    const { json, cp, result } = await makeLatest();
    const l = parseLatest(json);
    expect(l).not.toBeNull();
    expect(l).toEqual(json);
    expect(l!.throughMinute).toBe(cp.throughMinute);
    expect(l!.root).toBe(cp.root);
    expect(l!.totalEntitled).toBe(cp.totalEntitled.toString());
    expect(l).not.toHaveProperty("users");
    expect(l).not.toHaveProperty("tree");
    expect(l!.vault.amount).toBe(result.vault.toString());
    expect(l!.pops).toHaveLength(1);
    expect(l!.vault.odds).toBe(60);
  });
  it("survives a JSON round trip of the text", async () => {
    const { json } = await makeLatest();
    expect(parseLatest(JSON.parse(JSON.stringify(json)))).toEqual(json);
  });
  it("rejects a bad root, sig or contract", async () => {
    for (const [k, v] of [
      ["root", "0x1234"], ["root", "nothex"], ["root", "0x" + "zz".repeat(32)], ["root", `0x${"11".repeat(33)}`], ["root", 5],
      ["sig", `0x${"11".repeat(64)}`], ["sig", `0x${"11".repeat(66)}`], ["sig", "0x"], ["sig", null],
      ["contract", "0x12"], ["contract", `0x${"1".repeat(41)}`],
    ] as const) {
      expect(parseLatest(await mut((j) => (j[k] = v))), `${k}=${String(v)}`).toBeNull();
    }
  });
  it("rejects a signature the contract rejects: v must be 27 or 28, s must be at most n/2", async () => {
    const { json } = await makeLatest();
    const sig = json.sig as string;
    expect(parseLatest(json)).not.toBeNull();
    const withV = (v: string) => sig.slice(0, 130) + v;
    for (const v of ["00", "01", "1d", "1a", "ff"]) expect(parseLatest({ ...json, sig: withV(v) }), `v=${v}`).toBeNull();
    for (const v of ["1b", "1c"]) expect(parseLatest({ ...json, sig: withV(v) }), `v=${v}`).not.toBeNull();
    expect(parseLatest({ ...json, sig: malleate(sig as `0x${string}`) }), "high s").toBeNull();
    const half = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
    const withS = (x: bigint) => `0x${"11".repeat(32)}${x.toString(16).padStart(64, "0")}1b`;
    expect(parseLatest({ ...json, sig: withS(half) }), "s = n/2").not.toBeNull();
    expect(parseLatest({ ...json, sig: withS(half + 1n) }), "s = n/2 + 1").toBeNull();
  });
  it("needs no tree and no users, and ignores both in an old file during the rollout", async () => {
    const { json } = await makeLatest();
    expect(json).not.toHaveProperty("tree");
    expect(json).not.toHaveProperty("users");
    const old = { ...json, tree: { format: "standard-v1", tree: [], values: [] }, users: { [FIX_USERS[0]]: { entitlement: "9" } } };
    expect(parseLatest(old)).toEqual(json); // not read, and not carried
    expect(parseLatest({ ...json, tree: 5, users: "garbage" })).toEqual(json);
  });
  it("rejects an amount that is not a digit string", async () => {
    for (const v of ["12x", "-1", "1.5", "", " 1", "01", 5, null, "1".repeat(79)]) {
      expect(parseLatest(await mut((j) => (j.totalEntitled = v))), String(v)).toBeNull();
      expect(parseLatest(await mut((j) => (j.refBlock = v))), String(v)).toBeNull();
      expect(parseLatest(await mut((j) => (j.vault.amount = v))), String(v)).toBeNull();
      expect(parseLatest(await mut((j) => (j.vault.pointsTotal = v))), String(v)).toBeNull();
      expect(parseLatest(await mut((j) => (j.pops[0].amount = v))), String(v)).toBeNull();
      expect(parseLatest(await mut((j) => (j.pops[0].kept = v))), String(v)).toBeNull();
      expect(parseLatest(await mut((j) => (j.pops[0].block = v))), String(v)).toBeNull();
    }
  });
  it("rejects wrong numbers, versions and shapes", async () => {
    for (const f of [
      (j: Record<string, any>) => (j.v = 2),
      (j: Record<string, any>) => delete j.v,
      (j: Record<string, any>) => (j.throughMinute = -1),
      (j: Record<string, any>) => (j.throughMinute = 1.5),
      (j: Record<string, any>) => (j.throughMinute = "4"),
      (j: Record<string, any>) => (j.chainId = "998"),
      (j: Record<string, any>) => (j.publishedAt = null),
      (j: Record<string, any>) => (j.table = 5),
      (j: Record<string, any>) => (j.vault = 5),
      (j: Record<string, any>) => (j.vault.odds = 0),
      (j: Record<string, any>) => (j.vault.odds = 1.5),
      (j: Record<string, any>) => (j.vault.odds = "60"),
      (j: Record<string, any>) => (j.vault.lastPopMinute = -2),
      (j: Record<string, any>) => delete j.vault.lastPopMinute,
      (j: Record<string, any>) => (j.pops = {}),
      (j: Record<string, any>) => delete j.pops,
      (j: Record<string, any>) => (j.pops[0].recipients = 1.5),
      (j: Record<string, any>) => (j.pops[0].minute = -1),
      // the weekly shape of before the vault pops
      (j: Record<string, any>) => ((j.vault = { week: 0, amount: "0", pointsTotal: "0", opensAt: 1 }), (j.openings = []), delete j.pops),
    ]) {
      expect(parseLatest(await mut(f)), f.toString()).toBeNull();
    }
    for (const x of [null, undefined, 5, "x", [], {}]) expect(parseLatest(x)).toBeNull();
  });
});

const WALLET = "0xAB12000000000000000000000000000000000001" as const; // users/ab.json

/** A copy of the user file (all five fixture traders are in users/00.json) to change. */
const fileOf = async (f: (j: Record<string, any>) => void = () => {}) => {
  const made = await makeLatest();
  const j = structuredClone(made.userFile(FIX_USERS[0])) as Record<string, any>;
  f(j);
  return j;
};
const entryOf = (j: Record<string, any>) => j.users[FIX_USERS[0]] as Record<string, any>;

describe("parseUserFile (what ops' buildUserFiles writes)", () => {
  it("accepts the file ops builds, with every field and every wallet's proof carried over", async () => {
    const made = await makeLatest();
    const json = made.userFile(FIX_USERS[0])!;
    const f = parseUserFile(json);
    expect(f).not.toBeNull();
    expect(f).toEqual(json);
    expect(Object.keys(f!.users).sort()).toEqual([...FIX_USERS].sort());
    expect(f!.throughMinute).toBe(made.cp.throughMinute);
    expect(f!.root).toBe(made.cp.root);
    expect(f!.vault).toEqual({ amount: made.result.vault.toString(), pointsTotal: made.result.pointsTotal.toString() });
    for (const u of FIX_USERS) expect(f!.users[u].proof).toEqual(made.tree.proofs.get(u as never)!.proof);
    expect(f!.users[FIX_USERS[0]].proof.length).toBeGreaterThan(0);
  });
  it("survives a JSON round trip of the text", async () => {
    const json = await fileOf();
    expect(parseUserFile(JSON.parse(JSON.stringify(json)))).toEqual(json);
  });
  it("needs no table, and does not carry fields it does not know (a latest.json's odds, pops, tree)", async () => {
    const json = await fileOf();
    expect(json).not.toHaveProperty("table");
    expect(parseUserFile({ ...json, table: "x", tree: {}, pops: [], extra: 1 })).toEqual(json);
  });
  it("rejects a wrong v", async () => {
    expect(parseUserFile(await fileOf((j) => (j.v = 2)))).toBeNull();
    expect(parseUserFile(await fileOf((j) => delete j.v))).toBeNull();
  });
  it("rejects a missing or bad signed field", async () => {
    for (const k of ["chainId", "contract", "throughMinute", "refBlock", "root", "totalEntitled", "sig", "publishedAt"]) {
      expect(parseUserFile(await fileOf((j) => delete j[k])), `missing ${k}`).toBeNull();
    }
    for (const [k, v] of [
      ["root", "0x1234"], ["root", "nothex"], ["root", `0x${"11".repeat(33)}`], ["root", 5],
      ["sig", `0x${"11".repeat(64)}`], ["sig", "0x"], ["sig", null],
      ["contract", "0x12"], ["contract", `0x${"1".repeat(41)}`],
      ["chainId", "998"], ["throughMinute", -1], ["throughMinute", 1.5], ["throughMinute", "4"], ["publishedAt", null],
    ] as const) {
      expect(parseUserFile(await fileOf((j) => (j[k] = v))), `${k}=${String(v)}`).toBeNull();
    }
  });
  it("rejects a signature the contract rejects: v must be 27 or 28, s must be at most n/2", async () => {
    const json = await fileOf();
    const sig = json.sig as string;
    expect(parseUserFile(json)).not.toBeNull();
    for (const v of ["00", "01", "1d", "ff"]) expect(parseUserFile({ ...json, sig: sig.slice(0, 130) + v }), `v=${v}`).toBeNull();
    for (const v of ["1b", "1c"]) expect(parseUserFile({ ...json, sig: sig.slice(0, 130) + v }), `v=${v}`).not.toBeNull();
    expect(parseUserFile({ ...json, sig: malleate(sig as `0x${string}`) }), "high s").toBeNull();
  });
  it("rejects a missing or bad vault", async () => {
    expect(parseUserFile(await fileOf((j) => delete j.vault))).toBeNull();
    expect(parseUserFile(await fileOf((j) => (j.vault = 5)))).toBeNull();
    expect(parseUserFile(await fileOf((j) => (j.vault = null)))).toBeNull();
    expect(parseUserFile(await fileOf((j) => delete j.vault.pointsTotal))).toBeNull();
    expect(parseUserFile(await fileOf((j) => delete j.vault.amount))).toBeNull();
  });
  it("rejects users that are not an object", async () => {
    for (const v of [[], null, "x", 5]) expect(parseUserFile(await fileOf((j) => (j.users = v))), String(v)).toBeNull();
    expect(parseUserFile(await fileOf((j) => delete j.users))).toBeNull();
    for (const x of [null, undefined, 5, "x", [], {}]) expect(parseUserFile(x)).toBeNull();
  });
  it("rejects an address key that is not lowercase hex, and an entry that is not an object", async () => {
    for (const bad of ["0xABC", FIX_USERS[0].toUpperCase().replace("0X", "0x"), "0xnothex", `${FIX_USERS[0]}00`, FIX_USERS[0].slice(0, -2), "", FIX_USERS[0].slice(2)]) {
      expect(parseUserFile(await fileOf((j) => (j.users[bad] = entryOf(j)))), bad).toBeNull();
    }
    expect(parseUserFile(await fileOf((j) => (j.users[FIX_USERS[0]] = null)))).toBeNull();
    expect(parseUserFile(await fileOf((j) => (j.users[FIX_USERS[0]] = [])))).toBeNull();
  });
  it("rejects an amount that is not a digit string, or has more than 78 digits", async () => {
    for (const v of ["12x", "-1", "1.5", "", " 1", "01", 5, null, "1".repeat(79)]) {
      for (const k of ["totalEntitled", "refBlock"]) expect(parseUserFile(await fileOf((j) => (j[k] = v))), `${k}=${String(v)}`).toBeNull();
      for (const k of ["amount", "pointsTotal"]) expect(parseUserFile(await fileOf((j) => (j.vault[k] = v))), `vault.${k}=${String(v)}`).toBeNull();
      for (const k of ["entitlement", "fees", "mined", "fromVault", "refined", "points"]) {
        expect(parseUserFile(await fileOf((j) => (entryOf(j)[k] = v))), `${k}=${String(v)}`).toBeNull();
      }
    }
    expect(parseUserFile(await fileOf((j) => delete entryOf(j).refined))).toBeNull();
    expect(parseUserFile(await fileOf((j) => (entryOf(j).entitlement = "9".repeat(78))))).not.toBeNull(); // 78 digits is the longest
  });
  it("rejects a proof that is missing, not an array, has an entry that is not 32-byte hex, or has more than 64 entries", async () => {
    const h = `0x${"11".repeat(32)}`;
    expect(parseUserFile(await fileOf((j) => delete entryOf(j).proof))).toBeNull();
    for (const v of ["0x", h, null, 5, { 0: h, length: 1 }]) expect(parseUserFile(await fileOf((j) => (entryOf(j).proof = v))), String(v)).toBeNull();
    for (const bad of ["0x12", `0x${"11".repeat(31)}`, `0x${"11".repeat(33)}`, `0x${"zz".repeat(32)}`, "", 5, null, h.slice(2)]) {
      expect(parseUserFile(await fileOf((j) => (entryOf(j).proof = [h, bad]))), String(bad)).toBeNull();
      expect(parseUserFile(await fileOf((j) => (entryOf(j).proof = [bad, h]))), String(bad)).toBeNull();
    }
    expect(parseUserFile(await fileOf((j) => (entryOf(j).proof = Array(64).fill(h))))).not.toBeNull();
    expect(parseUserFile(await fileOf((j) => (entryOf(j).proof = Array(65).fill(h))))).toBeNull();
  });
  it("accepts a wallet with points and nothing earned: entitlement 0 and an empty proof", async () => {
    const w = "0x00000000000000000000000000000000000000ee";
    const f = parseUserFile(await fileOf((j) => (j.users[w] = { entitlement: "0", fees: "5", mined: "0", fromVault: "0", refined: "0", points: "500", proof: [] })));
    expect(f?.users[w]).toEqual({ entitlement: "0", fees: "5", mined: "0", fromVault: "0", refined: "0", points: "500", proof: [] });
  });
  it("accepts a nonzero entitlement with an empty proof: the file parses, and model.ts makes it a mismatch for that wallet alone (ops' parser refuses it as malformed; the poster never writes it)", async () => {
    const f = parseUserFile(await fileOf((j) => (entryOf(j).proof = [])));
    expect(f).not.toBeNull();
    expect(f!.users[FIX_USERS[0]].proof).toEqual([]);
    expect(Object.keys(f!.users)).toHaveLength(FIX_USERS.length); // the other wallets are still there
  });
});

describe("userFileUrl", () => {
  it("is <base>users/<first byte of the address, lowercase>.json", () => {
    expect(userFileUrl("https://f/998/", WALLET)).toBe("https://f/998/users/ab.json");
    expect(userFileUrl("https://f/998", WALLET)).toBe("https://f/998/users/ab.json");
    expect(userFileUrl("https://f/998///", WALLET)).toBe("https://f/998/users/ab.json");
    expect(userFileUrl("https://f/998/", FIX_USERS[0])).toBe("https://f/998/users/00.json");
    expect(userFileUrl("https://f/998/", "0x0Fedcba000000000000000000000000000000001")).toBe("https://f/998/users/0f.json");
  });
  it("does not depend on the case of the address (the publish-contract test compares it with ops' userFilePath)", () => {
    expect(userFileUrl("https://f/", WALLET.toLowerCase() as typeof WALLET)).toBe(userFileUrl("https://f/", WALLET));
  });
});

describe("loadLatest", () => {
  const serve = (status: number, body: unknown) => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", f);
    return f;
  };
  it("fetches <base>latest.json with cache no-store and parses it", async () => {
    const { json } = await makeLatest();
    const f = serve(200, json);
    expect(await loadLatest(BASE)).toEqual(json);
    expect(f).toHaveBeenCalledWith(`${BASE}latest.json`, expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
  });
  it("adds the slash a base lacks", async () => {
    const f = serve(404, "nope");
    await loadLatest("https://store.example/998");
    await loadLatest("https://store.example/998/");
    expect(f.mock.calls.map((c) => c[0])).toEqual(["https://store.example/998/latest.json", "https://store.example/998/latest.json"]);
    expect(latestUrl("https://x.example///")).toBe("https://x.example/latest.json");
  });
  it("404 is null (nothing published yet)", async () => {
    serve(404, "not found");
    expect(await loadLatest(BASE)).toBeNull();
  });
  it("other errors throw: 503, a network failure, text that is not JSON", async () => {
    serve(503, "boom");
    await expect(loadLatest(BASE)).rejects.toThrow(/HTTP 503/);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(loadLatest(BASE)).rejects.toThrow(/Failed to fetch/);
    serve(200, "<html>");
    await expect(loadLatest(BASE)).rejects.toThrow();
  });
  it("a file that parses as JSON but is not a latest.json throws (a store problem, not 'nothing yet')", async () => {
    serve(200, { hello: 1 });
    await expect(loadLatest(BASE)).rejects.toThrow(/latest\.json/);
  });
  it("a store that never answers gives up after 10 s, in plain words", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_u: string, o: { signal: AbortSignal }) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))));
    const seen = loadLatest(BASE).then(() => "resolved", (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS + 1);
    expect(await seen).toBe("reward file latest.json: no answer after 10 s");
  });
  it("a fast answer clears the timer", async () => {
    vi.useFakeTimers();
    serve(404, "");
    await loadLatest(BASE);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("a fetchFn can be passed", async () => {
    const f = vi.fn(async () => new Response("", { status: 404 }));
    expect(await loadLatest(BASE, f as unknown as typeof fetch)).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("loadUserFile", () => {
  const serve = (status: number, body: unknown) => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", f);
    return f;
  };
  it("fetches <base>users/<xx>.json and parses it", async () => {
    const json = (await makeLatest()).userFile(FIX_USERS[0])!;
    const f = serve(200, json);
    expect(await loadUserFile(BASE, FIX_USERS[0])).toEqual(json);
    expect(f).toHaveBeenCalledWith(`${BASE}users/00.json`, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
  it("revalidates every time (cache no-cache: an unchanged file costs a 304 with no body, a changed one is never served stale), where latest.json is never stored (no-store)", async () => {
    const made = await makeLatest();
    const f = serve(200, made.userFile(FIX_USERS[0])!);
    await loadUserFile(BASE, FIX_USERS[0]);
    expect(f.mock.calls[0][1]).toMatchObject({ cache: "no-cache" });
    f.mockImplementation(async () => new Response(JSON.stringify(made.json)));
    await loadLatest(BASE);
    expect(f.mock.calls[1][1]).toMatchObject({ cache: "no-store" });
  });
  it("adds the slash a base lacks", async () => {
    const f = serve(404, "nope");
    await loadUserFile("https://store.example/998", WALLET);
    await loadUserFile("https://store.example/998/", WALLET);
    expect(f.mock.calls.map((c) => c[0])).toEqual(["https://store.example/998/users/ab.json", "https://store.example/998/users/ab.json"]);
  });
  it("404 is null (no file for this part of the address space yet: zero for the wallet, not an error)", async () => {
    serve(404, "not found");
    expect(await loadUserFile(BASE, WALLET)).toBeNull();
  });
  it("other errors throw and name the file: 500, 503, a network failure, text that is not JSON", async () => {
    serve(500, "boom");
    await expect(loadUserFile(BASE, WALLET)).rejects.toThrow(/users\/ab\.json: HTTP 500/);
    serve(503, "boom");
    await expect(loadUserFile(BASE, WALLET)).rejects.toThrow(/HTTP 503/);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(loadUserFile(BASE, WALLET)).rejects.toThrow(/Failed to fetch/);
    serve(200, "<html>");
    await expect(loadUserFile(BASE, WALLET)).rejects.toThrow();
  });
  it("a body that is JSON but not a user file throws (a store problem, not 'nothing yet'); a latest.json is not one", async () => {
    serve(200, { hello: 1 });
    await expect(loadUserFile(BASE, WALLET)).rejects.toThrow(/users\/ab\.json: not a valid/);
    serve(200, (await makeLatest()).json);
    await expect(loadUserFile(BASE, WALLET)).rejects.toThrow(/not a valid/);
  });
  it("a store that never answers gives up after 20 s, in plain words (the body is in the time: latest.json keeps 10 s)", async () => {
    expect(USER_FILE_TIMEOUT_MS).toBe(20_000);
    expect(FETCH_TIMEOUT_MS).toBe(10_000);
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_u: string, o: { signal: AbortSignal }) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))));
    let state = "pending";
    const seen = loadUserFile(BASE, WALLET).then(() => (state = "resolved"), (e: Error) => (state = e.message));
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS + 1);
    expect(state).toBe("pending"); // past latest.json's limit, still waiting
    await vi.advanceTimersByTimeAsync(USER_FILE_TIMEOUT_MS - FETCH_TIMEOUT_MS - 2);
    expect(state).toBe("pending"); // 1 ms short of 20 s
    await vi.advanceTimersByTimeAsync(2);
    expect(await seen).toBe("reward file users/ab.json: no answer after 20 s");
  });
  it("a body that arrives slowly, after 10 s and before 20 s, is read", async () => {
    vi.useFakeTimers();
    const made = await makeLatest();
    const file = made.userFile(FIX_USERS[0])!;
    // the headers are here at once; the body takes 15 s, and the read is cut off by the abort signal if the limit is reached first
    vi.stubGlobal("fetch", vi.fn(async (_u: string, o: { signal: AbortSignal }) => {
      const r = new Response("", { status: 200 });
      r.json = () =>
        new Promise((res, rej) => {
          const t = setTimeout(() => res(file), 15_000);
          o.signal.addEventListener("abort", () => {
            clearTimeout(t);
            rej(new DOMException("aborted", "AbortError"));
          });
        });
      return r;
    }));
    const got = loadUserFile(BASE, FIX_USERS[0]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await got).toEqual(file);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("latest.json still gives up with the same slow body after 10 s", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_u: string, o: { signal: AbortSignal }) => {
      const r = new Response("", { status: 200 });
      r.json = () => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
      return r;
    }));
    const seen = loadLatest(BASE).then(() => "resolved", (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS + 1);
    expect(await seen).toBe("reward file latest.json: no answer after 10 s");
  });
  it("a fast answer clears the timer", async () => {
    vi.useFakeTimers();
    serve(404, "");
    await loadUserFile(BASE, WALLET);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("a fetchFn can be passed", async () => {
    const f = vi.fn(async () => new Response("", { status: 404 }));
    expect(await loadUserFile(BASE, WALLET, f as unknown as typeof fetch)).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
  });
});
