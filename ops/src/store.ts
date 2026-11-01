import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The process's local state: small JSON files (calculator state, cursors, write-ahead files). */
export class Store {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private write(rel: string, text: string) {
    const p = join(this.dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(`${p}.tmp`, text);
    renameSync(`${p}.tmp`, p);
  }

  readJson<T>(name: string, fallback: T): T {
    const p = join(this.dir, `${name}.json`);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : fallback;
  }

  /** Deletes `<name>.json`; nothing happens when it is absent. */
  remove(name: string) {
    rmSync(join(this.dir, `${name}.json`), { force: true });
  }

  writeJson(name: string, v: unknown) {
    this.write(`${name}.json`, JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 1));
  }
}
