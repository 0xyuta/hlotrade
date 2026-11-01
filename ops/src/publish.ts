import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Config } from "./config.js";
import { R2 } from "./r2.js";

export interface PutOpts {
  /** Edge/browser cache lifetime. Unset keeps the store's default. */
  maxAgeSeconds?: number;
  /** Store the body gzipped with `content-encoding: gzip`. Only R2 does: the local directory keeps plain text, which its readers take as is. */
  gzip?: boolean;
}

export interface Publisher {
  put(path: string, body: string, contentType: string, opts?: PutOpts): Promise<void>;
}

export class LocalPublisher implements Publisher {
  constructor(private readonly dir: string) {}
  async put(path: string, body: string, _contentType?: string, _opts?: PutOpts) {
    const p = join(this.dir, path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(`${p}.tmp`, body);
    renameSync(`${p}.tmp`, p);
  }
}

/** Cloudflare R2, read by the app through the bucket's public URL. Untrusted: the app checks every proof against the on-chain root. */
export class R2Publisher implements Publisher {
  constructor(private readonly r2: Pick<R2, "put">, private readonly prefix: string) {}
  async put(path: string, body: string, contentType: string, opts: PutOpts = {}) {
    const headers: Record<string, string> = { "content-type": contentType };
    if (opts.maxAgeSeconds !== undefined) headers["cache-control"] = `public, max-age=${opts.maxAgeSeconds}`;
    if (opts.gzip) headers["content-encoding"] = "gzip";
    await this.r2.put(`${this.prefix}${path}`, opts.gzip ? gzipSync(body) : body, headers);
  }
}

export function makePublisher(cfg: Config): Publisher {
  const p = cfg.publish;
  if (p.kind === "r2") return new R2Publisher(new R2(p.creds), p.prefix);
  return new LocalPublisher(p.dir);
}

export const toJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 1);
