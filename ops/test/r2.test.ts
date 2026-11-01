import { describe, expect, it, vi } from "vitest";
import { R2, parseListXml } from "../src/r2.js";

const creds = { accountId: "acc123", accessKeyId: "AKID", secretAccessKey: "SECRET", bucket: "hlo-testnet" };

/** A fetch stub that records the signed requests and answers from `answer`. */
function stub(answer: (req: Request) => Response) {
  const seen: Request[] = [];
  const fetchFn = vi.fn(async (req: Request) => {
    seen.push(req.clone());
    return answer(req);
  });
  return { seen, fetchFn: fetchFn as unknown as typeof fetch };
}

describe("R2", () => {
  it("put: signed PUT to <account>.r2.cloudflarestorage.com/<bucket>/<key> with the content type and cache header", async () => {
    const { seen, fetchFn } = stub(() => new Response(null, { status: 200 }));
    await new R2(creds, fetchFn).put("998/latest.json", '{"a":1}', { "content-type": "application/json", "cache-control": "max-age=30" });
    const r = seen[0];
    expect(r.method).toBe("PUT");
    expect(r.url).toBe("https://acc123.r2.cloudflarestorage.com/hlo-testnet/998/latest.json");
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(r.headers.get("cache-control")).toBe("max-age=30");
    expect(r.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request, /);
    expect(await r.text()).toBe('{"a":1}');
  });

  it("put: a Uint8Array body is sent as those bytes, with the content-encoding header", async () => {
    const { seen, fetchFn } = stub(() => new Response(null, { status: 200 }));
    const bytes = Uint8Array.from([0x1f, 0x8b, 8, 0, 255, 0, 1, 2, 3]);
    await new R2(creds, fetchFn).put("998/users/ab.json", bytes, { "content-type": "application/json", "content-encoding": "gzip" });
    const r = seen[0];
    expect(r.method).toBe("PUT");
    expect(r.headers.get("content-encoding")).toBe("gzip");
    expect(r.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\//);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(bytes);
  });

  it("put: a non-2xx answer throws with the key and status, never the credentials", async () => {
    const { fetchFn } = stub(() => new Response("denied", { status: 403 }));
    const err = await new R2(creds, fetchFn).put("998/x.json", "{}", {}).catch((e: Error) => e);
    expect((err as Error).message).toBe("R2 PUT 998/x.json: HTTP 403");
    expect((err as Error).message).not.toMatch(/SECRET|AKID/);
  });

  it("get: the body text, or null for 404", async () => {
    const { fetchFn } = stub((req) => (req.url.endsWith("/there.json") ? new Response("hello") : new Response("", { status: 404 })));
    const r2 = new R2(creds, fetchFn);
    expect(await r2.get("registry/998/there.json")).toBe("hello");
    expect(await r2.get("registry/998/gone.json")).toBeNull();
  });

  it("get: other failures throw", async () => {
    const { fetchFn } = stub(() => new Response("", { status: 500 }));
    await expect(new R2(creds, fetchFn).get("a.json")).rejects.toThrow("R2 GET a.json: HTTP 500");
  });

  it("listKeys: ListObjectsV2 under the prefix, following continuation tokens", async () => {
    const page1 = `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>registry/998/0xa.json</Key></Contents><NextContinuationToken>tok&amp;1</NextContinuationToken></ListBucketResult>`;
    const page2 = `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>registry/998/0xb.json</Key><Size>3</Size></Contents></ListBucketResult>`;
    const { seen, fetchFn } = stub((req) => new Response(new URL(req.url).searchParams.get("continuation-token") ? page2 : page1));
    expect(await new R2(creds, fetchFn).listKeys("registry/998/")).toEqual(["registry/998/0xa.json", "registry/998/0xb.json"]);
    const u1 = new URL(seen[0].url);
    expect(u1.origin + u1.pathname).toBe("https://acc123.r2.cloudflarestorage.com/hlo-testnet");
    expect(u1.searchParams.get("list-type")).toBe("2");
    expect(u1.searchParams.get("prefix")).toBe("registry/998/");
    expect(new URL(seen[1].url).searchParams.get("continuation-token")).toBe("tok&1");
  });

  it("listKeys: start-after goes with the first page only; the continuation token holds the position after that (three pages)", async () => {
    const page = (key: string, next?: string) =>
      `<ListBucketResult><IsTruncated>${next ? "true" : "false"}</IsTruncated><Contents><Key>${key}</Key></Contents>${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}</ListBucketResult>`;
    const pages: Record<string, string> = { "": page("p/6a.json", "t1"), t1: page("p/7b.json", "t2"), t2: page("p/8c.json") };
    const { seen, fetchFn } = stub((req) => new Response(pages[new URL(req.url).searchParams.get("continuation-token") ?? ""]));
    expect(await new R2(creds, fetchFn).listKeys("p/", "p/5")).toEqual(["p/6a.json", "p/7b.json", "p/8c.json"]);
    expect(seen.length).toBe(3);
    expect(seen.map((r) => new URL(r.url).searchParams.get("continuation-token"))).toEqual([null, "t1", "t2"]);
    expect(seen.map((r) => new URL(r.url).searchParams.get("start-after"))).toEqual(["p/5", null, null]);
    expect(seen[0].url).toContain("start-after=p%2F5");
    for (const r of seen) expect(new URL(r.url).searchParams.get("prefix")).toBe("p/");
  });

  it("listKeys: no start-after parameter unless one is given", async () => {
    const { seen, fetchFn } = stub(() => new Response(`<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>`));
    await new R2(creds, fetchFn).listKeys("p/");
    expect(new URL(seen[0].url).searchParams.has("start-after")).toBe(false);
  });

  it("listKeys: truncated without a token throws (no endless loop)", async () => {
    const { fetchFn } = stub(() => new Response(`<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>`));
    await expect(new R2(creds, fetchFn).listKeys("p/")).rejects.toThrow("R2 list p/: truncated without a continuation token");
  });
});

describe("parseListXml", () => {
  it("decodes XML entities in keys", () => {
    expect(parseListXml("<ListBucketResult><Contents><Key>a&lt;b&gt;&quot;&apos;&amp;.json</Key></Contents></ListBucketResult>")).toEqual({ keys: [`a<b>"'&.json`], truncated: false, token: undefined });
  });
});
