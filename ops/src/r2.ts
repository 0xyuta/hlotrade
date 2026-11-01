import { AwsClient } from "aws4fetch";

/** Cloudflare R2 through its S3 API. The keys come only from env vars and never appear in an error. */
export interface R2Creds {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

const TIMEOUT_MS = 30_000;

const decodeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** The parts of a ListObjectsV2 answer we use. */
export function parseListXml(xml: string): { keys: string[]; truncated: boolean; token?: string } {
  const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => decodeXml(m[1]));
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const t = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml);
  return { keys, truncated, token: t ? decodeXml(t[1]) : undefined };
}

export class R2 {
  private readonly aws: AwsClient;
  private readonly base: string;

  constructor(creds: R2Creds, private readonly fetchFn: typeof fetch = fetch) {
    this.aws = new AwsClient({ accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, service: "s3", region: "auto" });
    this.base = `https://${creds.accountId}.r2.cloudflarestorage.com/${creds.bucket}`;
  }

  private url(key: string): string {
    return `${this.base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const req = await this.aws.sign(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return this.fetchFn(req);
  }

  async put(key: string, body: string | Uint8Array<ArrayBuffer>, headers: Record<string, string>): Promise<void> {
    const res = await this.send(this.url(key), { method: "PUT", body, headers });
    if (!res.ok) throw new Error(`R2 PUT ${key}: HTTP ${res.status}`);
  }

  /** The object's text, or null when it does not exist. */
  async get(key: string): Promise<string | null> {
    const res = await this.send(this.url(key), { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 GET ${key}: HTTP ${res.status}`);
    return res.text();
  }

  /** Every key under `prefix` that sorts after `startAfter` (when given; sent with the first page only: the continuation token holds the position after that). */
  async listKeys(prefix: string, startAfter?: string): Promise<string[]> {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const q = new URLSearchParams({ "list-type": "2", prefix });
      if (startAfter && !token) q.set("start-after", startAfter);
      if (token) q.set("continuation-token", token);
      const res = await this.send(`${this.base}?${q}`, { method: "GET" });
      if (!res.ok) throw new Error(`R2 list ${prefix}: HTTP ${res.status}`);
      const page = parseListXml(await res.text());
      out.push(...page.keys);
      if (page.truncated && !page.token) throw new Error(`R2 list ${prefix}: truncated without a continuation token`);
      token = page.truncated ? page.token : undefined;
    } while (token);
    return out;
  }
}
