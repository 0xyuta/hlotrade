import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindingStore, register, type RegistryStore } from "../worker/register";
import { registryKey, registryLogKey } from "../src/register/rules";
import type { RegistryBucket } from "../worker/env";
import testnet from "../src/config/testnet.json";

const A = "0x00000000000000000000000000000000000000aa";
const KEY = `registry/998/${A}.json`;
const LOG_KEY = (at: number, user = A) => `registry-log/998/${at}-${user}.json`;
const NOW_MS = Date.UTC(2026, 9, 30, 12, 0, 0, 500);
const NOW_S = Math.floor(NOW_MS / 1000);
const BUILDER = (testnet as { builder: string }).builder;

const req = (body: unknown, raw?: string) =>
  new Request("https://testnet.hlotrade.xyz/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) });
const feeReply = (fee: unknown, status = 200) => new Response(JSON.stringify(fee), { status });

/** An in-memory bucket that honours onlyIf If-None-Match: * like R2 (put returns null when the key exists). A put whose key starts with an entry of `failPuts` throws. */
function fakeBucket() {
  const objects = new Map<string, string>();
  const failPuts: string[] = [];
  const bucket = {
    objects,
    failPuts,
    head: vi.fn(async (k: string) => (objects.has(k) ? { key: k } : null)),
    put: vi.fn(async (k: string, v: string, o: { onlyIf?: Headers; httpMetadata: { contentType: string } }) => {
      if (failPuts.some((p) => k.startsWith(p))) throw new Error("R2 down");
      if (o.onlyIf?.get("if-none-match") === "*" && objects.has(k)) return null;
      objects.set(k, v);
      return { key: k };
    }),
  };
  return bucket satisfies RegistryBucket & { objects: Map<string, string> };
}

let bucket: ReturnType<typeof fakeBucket>;
let store: RegistryStore;
let fetchMock: ReturnType<typeof vi.fn>;
// An explicit `undefined` network must reach register() (a default parameter would turn it into "testnet"), so the default is by argument count.
const post = (r: Request, ...rest: [network?: string | undefined, configs?: Parameters<typeof register>[4]]) =>
  register(r, rest.length > 0 ? rest[0] : "testnet", store, fetchMock as unknown as typeof fetch, rest[1]);

/** The two R2 calls ops' registry reads with, answered from the fake bucket the way S3 lists (sorted, after `startAfter`). */
const bucketAsR2 = (b: { objects: Map<string, string> }) => ({
  listKeys: async (prefix: string, startAfter?: string) => [...b.objects.keys()].filter((k) => k.startsWith(prefix) && (startAfter === undefined || k > startAfter)).sort(),
  get: async (k: string) => b.objects.get(k) ?? null,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_MS);
  bucket = fakeBucket();
  store = bindingStore(bucket);
  fetchMock = vi.fn().mockResolvedValue(feeReply(100));
});
afterEach(() => vi.useRealTimers());

describe("register (Worker, R2 binding)", () => {
  it("503 without a network or with a bad one, touching nothing", async () => {
    expect((await post(req({ user: A }), undefined)).status).toBe(503);
    expect((await post(req({ user: A }), "devnet")).status).toBe(503);
    expect(bucket.head).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("503 when the network's config has no builder; mainnet uses chain 999 and the mainnet API once it has one", async () => {
    expect((await post(req({ user: A }), "mainnet", { mainnet: {}, testnet: { builder: BUILDER } })).status).toBe(503);
    const MB = "0x3333333333333333333333333333333333333333";
    expect((await post(req({ user: A }), "mainnet", { mainnet: { builder: MB }, testnet: { builder: BUILDER } })).status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.hyperliquid.xyz/info");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).builder).toBe(MB);
    expect([...bucket.objects.keys()].sort()).toEqual([`registry-log/999/${NOW_S}-${A}.json`, `registry/999/${A}.json`]);
  });
  it("400 for an invalid body or non-JSON, over 1 KiB counted in bytes", async () => {
    expect((await post(req({ user: "nope" }))).status).toBe(400);
    expect((await post(req({ user: A, extra: 1 }))).status).toBe(400);
    expect((await post(req(null, "not json"))).status).toBe(400);
    expect((await post(req(null, JSON.stringify({ user: A, pad: "x".repeat(1100) })))).status).toBe(400);
    expect((await post(req(null, JSON.stringify({ user: A, pad: "é".repeat(600) })))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
  });
  it("400 at once for a content-length over 1 KiB, without reading the body or calling anything", async () => {
    const r = new Request("https://testnet.hlotrade.xyz/api/register", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "2000000" },
      body: JSON.stringify({ user: A }),
    });
    const res = await post(r);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Bad request." });
    expect(r.bodyUsed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bucket.head).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
  });
  it("403 below the builder fee floor (99), nothing written", async () => {
    fetchMock.mockResolvedValue(feeReply(99));
    const r = await post(req({ user: A }));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "Enable trading first." });
    expect(bucket.put).not.toHaveBeenCalled();
  });
  it("asks Hyperliquid's info endpoint for maxBuilderFee of the user and our builder", async () => {
    await post(req({ user: A }));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.hyperliquid-testnet.xyz/info");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ type: "maxBuilderFee", user: A, builder: BUILDER });
  });
  it("200 creating the record: key, lowercase user, the Worker's clock, create-only put with a JSON type", async () => {
    const r = await post(req({ user: "0x00000000000000000000000000000000000000AA" }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ registered: true });
    expect(JSON.parse(bucket.objects.get(KEY)!)).toEqual({ user: A, registeredAt: NOW_S });
    const opts = bucket.put.mock.calls[1][2]; // the index entry went first
    expect(bucket.put.mock.calls[1][0]).toBe(KEY);
    expect(opts.onlyIf?.get("if-none-match")).toBe("*");
    expect(opts.httpMetadata).toEqual({ contentType: "application/json" });
  });
  it("the record parses with ops' parseRegistration", async () => {
    const { parseRegistration } = await import("../../ops/src/registry");
    await post(req({ user: A }));
    expect(parseRegistration(JSON.parse(bucket.objects.get(KEY)!))).toEqual({ user: A, registeredAt: NOW_S });
  });
  it("a repeat is 200 from one head: no Hyperliquid call, no put, the first record kept", async () => {
    await post(req({ user: A }));
    const first = bucket.objects.get(KEY);
    vi.setSystemTime(NOW_MS + 60_000);
    fetchMock.mockClear();
    bucket.put.mockClear();
    expect((await post(req({ user: A }))).status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
    expect(bucket.objects.get(KEY)).toBe(first);
  });
  it("a lost race (put returns null, the other writer's record is there) is 200 and keeps theirs", async () => {
    bucket.head.mockResolvedValueOnce(null); // the first exists() saw nothing
    bucket.objects.set(KEY, "theirs");
    expect((await post(req({ user: A }))).status).toBe(200);
    expect(bucket.objects.get(KEY)).toBe("theirs");
  });
  it("a race of two first registrations leaves one record (the first writer's); the loser's index entry is stale and harmless to ops' reader", async () => {
    const { R2Registry } = await import("../../ops/src/registry");
    expect((await post(req({ user: A }))).status).toBe(200); // the winner, at NOW_S
    vi.setSystemTime(NOW_MS + 5_000);
    bucket.head.mockResolvedValueOnce(null); // the loser's first look saw nothing
    fetchMock.mockResolvedValue(feeReply(100)); // a Response body reads once
    expect((await post(req({ user: A }))).status).toBe(200);
    expect([...bucket.objects.keys()].sort()).toEqual([KEY, LOG_KEY(NOW_S), LOG_KEY(NOW_S + 5)].sort());
    expect(JSON.parse(bucket.objects.get(KEY)!)).toEqual({ user: A, registeredAt: NOW_S });
    // ops' reader: a first (full) read, then a pass through the index, which lists the winner's entry and the loser's stale one
    const lists: string[] = [];
    const reads: string[] = [];
    const r2 = bucketAsR2(bucket);
    let ms = NOW_MS + 5_000;
    const reg = new R2Registry(
      { listKeys: async (p, s) => (lists.push(p), r2.listKeys(p, s)), get: async (k) => (reads.push(k), r2.get(k)) },
      998, undefined, () => ms,
    );
    expect(await reg.list()).toEqual([{ user: A, registeredAt: NOW_S }]);
    lists.length = 0;
    reads.length = 0;
    ms += 60_000;
    expect(await reg.list()).toEqual([{ user: A, registeredAt: NOW_S }]);
    expect(lists).toEqual(["registry-log/998/"]);
    expect(reads).toEqual([]); // both entries name the record it already has: stale, harmless, not read again
  });
  it("a race: the first reader to see it after the fact reads the one record through the stale entry and gets the winner's time", async () => {
    const { R2Registry } = await import("../../ops/src/registry");
    let ms = NOW_MS;
    const reads: string[] = [];
    const r2 = bucketAsR2(bucket);
    const reg = new R2Registry({ listKeys: r2.listKeys, get: async (k) => (reads.push(k), r2.get(k)) }, 998, undefined, () => ms);
    expect(await reg.list()).toEqual([]);
    await post(req({ user: A }));
    vi.setSystemTime(NOW_MS + 5_000);
    bucket.head.mockResolvedValueOnce(null);
    fetchMock.mockResolvedValue(feeReply(100));
    await post(req({ user: A }));
    ms += 60_000;
    expect(await reg.list()).toEqual([{ user: A, registeredAt: NOW_S }]); // found through the index, which has two entries for the wallet
    expect(reads).toEqual([KEY]);
  });
  it("502 when the record's put throws and head then finds nothing, or head throws", async () => {
    bucket.failPuts.push("registry/"); // the index entry goes through, the record's put throws
    const first = await post(req({ user: A }));
    expect(first.status).toBe(502);
    expect(await first.json()).toEqual({ error: "Could not register." });
    expect(bucket.objects.has(KEY)).toBe(false);
    expect(bucket.objects.has(LOG_KEY(NOW_S))).toBe(true); // the index went in first; the stale entry is harmless
    // the same again, with head failing on the look after the failed put (a fresh Response: a body reads once)
    bucket.head.mockClear();
    fetchMock.mockResolvedValue(feeReply(100));
    bucket.head.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("R2 down"));
    const second = await post(req({ user: A }));
    expect(second.status).toBe(502);
    expect(await second.json()).toEqual({ error: "Could not register." }); // not "Could not check trading status."
    expect(bucket.head).toHaveBeenCalledTimes(2); // the first look, then the one after the failed put
    await expect(bucket.head("probe")).resolves.toBeNull(); // the queued rejection was used up
    expect(bucket.objects.has(KEY)).toBe(false);
  });
  it("502 when Hyperliquid fails, answers non-JSON, or sends an unusable fee", async () => {
    fetchMock.mockResolvedValueOnce(feeReply("x", 500));
    expect((await post(req({ user: A }))).status).toBe(502);
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await post(req({ user: A }))).status).toBe(502);
    fetchMock.mockResolvedValueOnce(new Response("not json"));
    expect((await post(req({ user: A }))).status).toBe(502);
    fetchMock.mockResolvedValueOnce(feeReply("100"));
    expect((await post(req({ user: A }))).status).toBe(502);
    expect(bucket.put).not.toHaveBeenCalled();
  });
});

describe("register: the index entry (spec 2026-10-31 §7)", () => {
  /** A store that logs the order of its calls. */
  const spied = (o: { exists?: boolean; writeIndex?: boolean; createOnce?: boolean } = {}) => {
    const calls: string[] = [];
    const s: RegistryStore = {
      exists: vi.fn(async (k: string) => (calls.push(`exists ${k}`), o.exists ?? false)),
      writeIndex: vi.fn(async (k: string) => {
        calls.push(`writeIndex ${k}`);
        vi.setSystemTime(NOW_MS + 7_000); // time passes while the index is written: the record must still carry the index's registeredAt
        return o.writeIndex ?? true;
      }),
      createOnce: vi.fn(async (k: string, body: string) => (calls.push(`createOnce ${k} ${body}`), o.createOnce ?? true)),
    };
    return { s, calls };
  };
  const postTo = (s: RegistryStore, r: Request) => register(r, "testnet", s, fetchMock as unknown as typeof fetch);

  it("a new wallet: the index entry is written before the record, with the record's registeredAt", async () => {
    const { s, calls } = spied();
    expect((await postTo(s, req({ user: A }))).status).toBe(200);
    expect(calls).toEqual([
      `exists ${KEY}`,
      `writeIndex ${LOG_KEY(NOW_S)}`,
      `createOnce ${KEY} ${JSON.stringify({ user: A, registeredAt: NOW_S })}`,
    ]);
  });

  it("through the R2 binding: the empty index put (no onlyIf) comes first, then the create-only record put", async () => {
    await post(req({ user: A }));
    const [index, record] = bucket.put.mock.calls;
    expect(index[0]).toBe(LOG_KEY(NOW_S));
    expect(index[1]).toBe("");
    expect(index[2].onlyIf).toBeUndefined();
    expect(index[2].httpMetadata).toEqual({ contentType: "application/json" });
    expect(record[0]).toBe(KEY);
    expect(bucket.put.mock.invocationCallOrder[0]).toBeLessThan(bucket.put.mock.invocationCallOrder[1]);
    expect(bucket.put).toHaveBeenCalledTimes(2);
    expect(bucket.objects.get(LOG_KEY(NOW_S))).toBe("");
  });

  it("the index key's time is the record's registeredAt, in the key as 10 digits", async () => {
    vi.setSystemTime(Date.UTC(1970, 0, 1, 0, 0, 7)); // registeredAt 7
    await post(req({ user: A }));
    expect([...bucket.objects.keys()].sort()).toEqual([`registry-log/998/0000000007-${A}.json`, KEY]);
    expect(JSON.parse(bucket.objects.get(KEY)!).registeredAt).toBe(7);
  });

  it("a failed index write is a 502 and no record is written (createOnce never called)", async () => {
    const { s, calls } = spied({ writeIndex: false });
    const r = await postTo(s, req({ user: A }));
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "Could not register." });
    expect(s.createOnce).not.toHaveBeenCalled();
    expect(calls.some((c) => c.startsWith("createOnce"))).toBe(false);
  });

  it("through the binding: an index put that throws is a 502 with no record put", async () => {
    bucket.failPuts.push("registry-log/");
    expect((await post(req({ user: A }))).status).toBe(502);
    expect(bucket.put).toHaveBeenCalledTimes(1);
    expect(bucket.objects.size).toBe(0);
  });

  it("a repeat (the record exists) is 200 and writes no index entry and no record, and calls no Hyperliquid", async () => {
    const { s } = spied({ exists: true });
    expect((await postTo(s, req({ user: A }))).status).toBe(200);
    expect(s.writeIndex).not.toHaveBeenCalled();
    expect(s.createOnce).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    // and through the binding, a second app open writes nothing at all
    await post(req({ user: A }));
    bucket.put.mockClear();
    vi.setSystemTime(NOW_MS + 90_000);
    expect((await post(req({ user: A }))).status).toBe(200);
    expect(bucket.put).not.toHaveBeenCalled();
    expect(bucket.objects.size).toBe(2);
  });

  it("bindingStore(bucket).writeIndex: an empty body without onlyIf; true when the bucket answers, false when put throws or returns null", async () => {
    const s = bindingStore(bucket);
    expect(await s.writeIndex(LOG_KEY(5))).toBe(true);
    expect(bucket.put).toHaveBeenCalledWith(LOG_KEY(5), "", { httpMetadata: { contentType: "application/json" } });
    bucket.put.mockRejectedValueOnce(new Error("R2 down"));
    expect(await s.writeIndex(LOG_KEY(6))).toBe(false);
    bucket.put.mockResolvedValueOnce(null);
    expect(await s.writeIndex(LOG_KEY(7))).toBe(false);
  });

  it("what the Worker writes is found through the index by ops' R2Registry, not only by its full read", async () => {
    const { R2Registry } = await import("../../ops/src/registry");
    let ms = NOW_MS;
    const reg = new R2Registry(bucketAsR2(bucket), 998, undefined, () => ms);
    expect(await reg.list()).toEqual([]); // the first read is a full one
    await post(req({ user: A }));
    ms += 60_000; // an ordinary pass: only the index is listed
    expect(await reg.list()).toEqual([{ user: A, registeredAt: NOW_S }]);
  });

  it("the key literals of the app and of ops are the same function of their inputs", async () => {
    const ops = await import("../../ops/src/registry");
    const inputs: [number, number, `0x${string}`][] = [
      [998, 1800000000, A],
      [999, 7, "0x00000000000000000000000000000000000000Aa"],
      [998, 999, "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD"],
      [999, 9_999_999_999, "0x1111111111111111111111111111111111111111"],
    ];
    for (const [chainId, at, user] of inputs) {
      expect(registryLogKey(chainId, at, user)).toBe(ops.registryLogKey(chainId, at, user));
      expect(registryKey(chainId, user)).toBe(ops.registryKey(chainId, user));
    }
  });
});
