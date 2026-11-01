import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { LocalPublisher, R2Publisher, toJson } from "../src/publish.js";

describe("LocalPublisher", () => {
  it("writes atomically: overwrite works and no .tmp is left", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pub-"));
    const pub = new LocalPublisher(dir);
    await pub.put("rewards/latest.json", "one", "application/json");
    await pub.put("rewards/latest.json", "two", "application/json");
    expect(readFileSync(join(dir, "rewards/latest.json"), "utf8")).toBe("two");
    expect(readdirSync(join(dir, "rewards"))).toEqual(["latest.json"]);
    expect(existsSync(join(dir, "rewards/latest.json.tmp"))).toBe(false);
  });

  it("writes plain text for gzip: true (the local reader and the e2e read it as is)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pub-"));
    await new LocalPublisher(dir).put("users/ab.json", '{"a":1}', "application/json", { gzip: true, maxAgeSeconds: 60 });
    expect(readFileSync(join(dir, "users/ab.json"), "utf8")).toBe('{"a":1}');
  });
});

describe("toJson", () => {
  it("writes bigints as strings", () => {
    expect(JSON.parse(toJson({ a: 10n ** 18n }))).toEqual({ a: "1000000000000000000" });
  });
});

describe("R2Publisher", () => {
  it("puts under the prefix with the content type, and a cache header only when a max age is given", async () => {
    const puts: [string, string, Record<string, string>][] = [];
    const pub = new R2Publisher({ put: async (k: string, b: string, h: Record<string, string>) => void puts.push([k, b, h]) }, "998/");
    await pub.put("latest.json", "L", "application/json", { maxAgeSeconds: 60 });
    await pub.put("checkpoints/5.json", "C", "application/json");
    expect(puts).toEqual([
      ["998/latest.json", "L", { "content-type": "application/json", "cache-control": "public, max-age=60" }],
      ["998/checkpoints/5.json", "C", { "content-type": "application/json" }],
    ]);
  });

  it("gzip: true sends the gzipped bytes with content-encoding: gzip, and the other headers as without it", async () => {
    const puts: [string, string | Uint8Array, Record<string, string>][] = [];
    const pub = new R2Publisher({ put: async (k: string, b: string | Uint8Array, h: Record<string, string>) => void puts.push([k, b, h]) }, "998/");
    const body = JSON.stringify({ users: { "0xab": "x".repeat(2000) } });
    await pub.put("users/ab.json", body, "application/json", { gzip: true, maxAgeSeconds: 60 });
    const [key, sent, headers] = puts[0];
    expect(key).toBe("998/users/ab.json");
    expect(sent).toBeInstanceOf(Uint8Array);
    expect((sent as Uint8Array).length).toBeLessThan(body.length);
    expect(gunzipSync(sent as Uint8Array).toString("utf8")).toBe(body);
    expect(headers).toEqual({ "content-type": "application/json", "cache-control": "public, max-age=60", "content-encoding": "gzip" });
  });

  it("without gzip the body goes as the string it is, with no content-encoding", async () => {
    const puts: [string, string | Uint8Array, Record<string, string>][] = [];
    const pub = new R2Publisher({ put: async (k: string, b: string | Uint8Array, h: Record<string, string>) => void puts.push([k, b, h]) }, "");
    await pub.put("latest.json", "L", "application/json", { gzip: false, maxAgeSeconds: 60 });
    expect(puts).toEqual([["latest.json", "L", { "content-type": "application/json", "cache-control": "public, max-age=60" }]]);
  });
});
