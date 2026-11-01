import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Addr } from "@hlo/calc";
import { forEachLimit } from "./limit.js";
import type { R2 } from "./r2.js";
import type { Store } from "./store.js";

/** A wallet that signed up for rewards; `registeredAt` (unix seconds) is the Vercel server's clock when it did. */
export interface Registration {
  user: Addr;
  registeredAt: number;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** A record's JSON as a Registration (address lowercased), or null when it is not one. */
export function parseRegistration(j: unknown): Registration | null {
  if (typeof j !== "object" || j === null || Array.isArray(j)) return null;
  const { user, registeredAt } = j as Record<string, unknown>;
  if (typeof user !== "string" || !ADDR.test(user)) return null;
  // >= 1e10 is milliseconds passed as seconds (year 2286 as seconds).
  if (typeof registeredAt !== "number" || !Number.isSafeInteger(registeredAt) || registeredAt <= 0 || registeredAt >= 10_000_000_000) return null;
  return { user: user.toLowerCase() as Addr, registeredAt };
}

/** Where a record lives in the store. The app's register/rules.ts writes the same literal. */
export const registryKey = (chainId: number, user: Addr): string => `registry/${chainId}/${user.toLowerCase()}.json`;

/** Where a record's index entry lives: time-sorted, so a reader lists only what is new. The app's register/rules.ts writes the same literal. */
export const registryLogKey = (chainId: number, registeredAt: number, user: Addr): string =>
  `registry-log/${chainId}/${String(registeredAt).padStart(10, "0")}-${user.toLowerCase()}.json`;

export interface Registry {
  /**
   * Every registration. `full` asks for a read of the whole store now (R2Registry: the whole `registry/` prefix, whatever
   * its hourly timer says); a registry that always reads everything (DirRegistry) ignores it.
   */
  list(full?: boolean): Promise<Registration[]>;
}

/** Records as `*.json` files in a directory (anvil and tests). Invalid files are skipped with a warning. */
export class DirRegistry implements Registry {
  constructor(private readonly dir: string) {}

  async list(): Promise<Registration[]> {
    const out: Registration[] = [];
    for (const name of readdirSync(this.dir).filter((n) => n.endsWith(".json")).sort()) {
      let reg: Registration | null = null;
      try {
        reg = parseRegistration(JSON.parse(readFileSync(join(this.dir, name), "utf8")));
      } catch {
        // falls through to the warning
      }
      if (reg) out.push(reg);
      else console.warn(`registry: skipping invalid record ${name}`);
    }
    return out;
  }
}

const CACHE_FILE = "registry-cache";
const FULL_EVERY_MS = 3_600_000;
const LOOK_BACK_SECONDS = 600;
const READ_LIMIT = 16;
/** A record read that fails is tried this many times more, RETRY_WAIT_MS apart, before it fails the pass. */
const READ_RETRIES = 2;
const RETRY_WAIT_MS = 1_000;

/**
 * Records in Cloudflare R2 under `registry/<chainId>/`, read with the S3 API (no public URL needed). A record never changes,
 * so each is read once and kept (in memory and in `registry-cache.json`). The first list(), one each hour and list(true)
 * read the whole prefix; the others list the time-sorted index `registry-log/<chainId>/` from 10 minutes before the newest
 * registration seen (Workers' clocks, R2 write delays; never later than 10 minutes before the clock, so one record dated in
 * the future cannot move the window past every real key) and read only unknown wallets. The record is the truth: an index
 * entry with no record yet is ignored this pass. A pass that fails part-way keeps and saves the records it read (each is
 * valid), but the hourly timer and the index window move only when a pass completes, so the retry covers everything the
 * failed one did. A full read after the first one warns about a wallet it finds outside the index window: it was found late.
 */
export class R2Registry implements Registry {
  /** record key → the registration, or null for an invalid record */
  private readonly records = new Map<string, Registration | null>();
  /** The valid records by address, rebuilt when `records` changed; null until then. */
  private sorted: Registration[] | null = null;
  /** The newest registeredAt of the last completed pass: where the index window starts. */
  private newest = 0;
  /** Records were kept since `newest` was last worked out. */
  private newestStale = false;
  private lastFullAt = -Infinity;
  /** Records not yet in the cache file. */
  private unsaved = false;

  constructor(
    private readonly r2: Pick<R2, "listKeys" | "get">,
    private readonly chainId: number,
    private readonly store?: Pick<Store, "readJson" | "writeJson">,
    private readonly clock: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.load();
  }

  private load() {
    let saved: { v?: unknown; records?: unknown } | null | undefined;
    try {
      saved = this.store?.readJson<{ v?: unknown; records?: unknown } | null | undefined>(CACHE_FILE, undefined);
    } catch {
      return void console.warn(`registry: ignoring ${CACHE_FILE}.json`); // not JSON
    }
    if (saved === undefined) return; // no store, or no file yet
    if (typeof saved !== "object" || saved === null || saved.v !== 1 || !Array.isArray(saved.records)) {
      return void console.warn(`registry: ignoring ${CACHE_FILE}.json`);
    }
    const loaded = new Map<string, Registration>();
    for (const r of saved.records) {
      const reg = Array.isArray(r) ? parseRegistration({ user: r[0], registeredAt: r[1] }) : null;
      if (!reg) return void console.warn(`registry: ignoring ${CACHE_FILE}.json`); // all or nothing
      loaded.set(registryKey(this.chainId, reg.user), reg);
    }
    for (const [key, reg] of loaded) {
      this.records.set(key, reg);
      if (reg.registeredAt > this.newest) this.newest = reg.registeredAt;
    }
  }

  private keep(key: string, reg: Registration | null) {
    this.records.set(key, reg);
    if (reg) {
      this.sorted = null;
      this.unsaved = true;
      this.newestStale = true;
    }
  }

  private ordered(): Registration[] {
    this.sorted ??= [...this.records.values()].filter((r): r is Registration => r !== null).sort((x, y) => (x.user < y.user ? -1 : x.user > y.user ? 1 : 0));
    return this.sorted;
  }

  /** The unix second the index is listed from: 10 minutes before the newest registration, but not before 10 minutes ago by the clock. */
  private windowStart(nowMs: number): number {
    return Math.min(this.newest, Math.floor(nowMs / 1000)) - LOOK_BACK_SECONDS;
  }

  async list(full = false): Promise<Registration[]> {
    const startedAt = this.clock();
    const since = startedAt - this.lastFullAt;
    const whole = full || since >= FULL_EVERY_MS || since < 0; // a clock that went back cannot hold a full read off
    const windowStart = this.windowStart(startedAt);
    // After the first complete full read, a wallet that a full read finds from before the window is one the index could not have shown.
    const foundLateBefore = whole && this.lastFullAt !== -Infinity ? windowStart : -Infinity;
    const keys = whole ? await this.r2.listKeys(`registry/${this.chainId}/`) : await this.indexKeys(windowStart);
    // A full read tries a record held as invalid again (it may have been corrected); an index pass does not.
    const unknown = keys.filter((k) => (whole ? !this.records.get(k) : !this.records.has(k)));
    try {
      await forEachLimit(unknown, READ_LIMIT, async (key) => {
        const text = await this.read(key); // a read failure propagates and is not kept
        if (text === null) {
          if (!whole) return; // the index is written first: its record is still on the way
          throw new Error(`registry ${key}: listed but not found`);
        }
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          // an invalid record
        }
        const reg = parseRegistration(json);
        if (!reg) {
          if (this.records.get(key) !== null) console.warn(`registry: skipping invalid record ${key}`);
        } else if (reg.registeredAt < foundLateBefore) {
          console.warn(`registry: found late by a full read: ${reg.user} registeredAt ${reg.registeredAt}; its fees from before this read may be lost`);
        }
        this.keep(key, reg);
      });
    } catch (e) {
      this.save(); // every record kept is valid and was read in full: a retry or a restart need not read it again
      throw e;
    }
    // The pass is complete: only now does a full read count as done and the window move.
    if (whole) this.lastFullAt = startedAt;
    if (this.newestStale) {
      for (const r of this.ordered()) if (r.registeredAt > this.newest) this.newest = r.registeredAt;
      this.newestStale = false;
    }
    this.save();
    return [...this.ordered()];
  }

  private async read(key: string): Promise<string | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.r2.get(key);
      } catch (e) {
        if (attempt >= READ_RETRIES) throw e;
        await this.sleep(RETRY_WAIT_MS);
      }
    }
  }

  private save() {
    if (!this.unsaved || !this.store) return;
    try {
      this.store.writeJson(CACHE_FILE, { v: 1, records: this.ordered().map((r) => [r.user, r.registeredAt]) });
      this.unsaved = false;
    } catch {
      console.warn(`registry: could not save ${CACHE_FILE}.json`); // only a restart pays for it
    }
  }

  /** The record keys of index entries from `windowStart` on (once each). */
  private async indexKeys(windowStart: number): Promise<string[]> {
    const prefix = `registry-log/${this.chainId}/`;
    const after = windowStart > 0 ? `${prefix}${String(windowStart).padStart(10, "0")}` : undefined;
    const out = new Set<string>();
    for (const k of await this.r2.listKeys(prefix, after)) {
      const m = k.startsWith(prefix) ? /^\d{10}-(0x[0-9a-f]{40})\.json$/.exec(k.slice(prefix.length)) : null;
      if (m) out.add(registryKey(this.chainId, m[1] as Addr));
    }
    return [...out];
  }
}
