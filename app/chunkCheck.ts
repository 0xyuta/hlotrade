/**
 * Keeps the code split honest (Plan 4 D): after Rollup has chunked the bundle, every rule's start chunk and all chunks it
 * imports statically (what the browser loads before that code runs) must not contain the listed modules. Dynamic
 * imports are where the split happens, so they are not followed. Runs in every `vite build`; a problem fails the build.
 */
import type { Plugin } from "vite";

export interface ChunkInfo {
  file: string;
  isEntry: boolean;
  /** Static imports: other chunks' file names. Rules find their start chunk by `modules` (a shared chunk, the App one among them, has no facade module). */
  imports: string[];
  /** Module ids, relative ("src/…" or "node_modules/<pkg>/…"). */
  modules: string[];
  /** The chunk's code size in bytes (UTF-8), not characters. */
  bytes: number;
}

export interface ChunkRule {
  /** "entry" = the index.html entry; otherwise a module that must sit in a lazy chunk (not the entry), whose chunk is the start. */
  from: "entry" | string;
  mustNotContain: RegExp[];
}

const TRADING = [/^src\/App\.tsx$/, /^src\/ui\/trade\//, /^node_modules\/@nktkas\//];
const LAZY_SCREENS = [/^src\/ui\/rewards\//, /^src\/ui\/referrals\//, /^src\/ui\/tokenomics\//, /^src\/ui\/explore\//, /^src\/ui\/bots\//, /^src\/ui\/swap\//, /^src\/ui\/intro\//, /^src\/ui\/transfer\//, /^src\/ui\/PairModal\.tsx$/, /^src\/ui\/trade\/Chart\.tsx$/, /^node_modules\/lightweight-charts\//, /^node_modules\/qrcode\//];

const JSQR = /^node_modules\/jsqr\//;
const PAIR_PAGE = [/^src\/ui\/pair\//, /^src\/hl\/pairing\.ts$/, JSQR];
/**
 * What the phone's /pair may load up front, as an allow-list (Task 7 review m2): the entry's shell (main, entry, the
 * config, the styles), the formatter, the key and pairing modules, and its own ui/pair. Every other module under src/,
 * including a directory added later, is the App's and fails the build. The App chunk holds src/App.tsx (in TRADING),
 * so /pair importing it fails too.
 */
export const NOT_FOR_PAIR =
  /^src\/(?!config\/|entry\.ts$|main\.tsx$|styles\.css$|hl\/(agent|pairCode|pairing|role)\.ts$|ui\/(pair\/|format\.ts$|Loading\.tsx$|ErrorBoundary\.tsx$|NotDeployed\.tsx$))/;

/** Plan 4 C: Solana code (Kit, Wallet Standard, the route) loads only with the Solana form or a Solana record's poll. */
const SOLANA = [/^node_modules\/@solana\//, /^node_modules\/@wallet-standard\//, /^src\/routes\/solana\//, /^src\/wallet\/solana\.ts$/, /^src\/ui\/transfer\/SolanaFlow\.tsx$/];
/** What the poll chunk (loaded while a Solana record is pending) must leave to the form: the wallet, the builders, the form. */
const SOLANA_FORM_ONLY = [/^node_modules\/@wallet-standard\//, /^src\/wallet\/solana\.ts$/, /^src\/ui\/transfer\/SolanaFlow\.tsx$/, /^src\/routes\/solana\/(burn|deposit|withdraw|hook)\.ts$/];

export const CHUNK_RULES: ChunkRule[] = [
  { from: "entry", mustNotContain: [...TRADING, ...LAZY_SCREENS, ...PAIR_PAGE, ...SOLANA] },
  { from: "src/App.tsx", mustNotContain: [...LAZY_SCREENS, ...PAIR_PAGE, ...SOLANA] },
  // the phone's /pair: no trading code, no screens, and jsQR only when the browser has no QR detector (a lazy import from the scanner)
  { from: "src/ui/pair/PairPage.tsx", mustNotContain: [...TRADING, ...LAZY_SCREENS, NOT_FOR_PAIR, JSQR, ...SOLANA] },
  // the transfer modal: the Solana form and the Solana poll are dynamic imports
  { from: "src/ui/transfer/TransferModal.tsx", mustNotContain: SOLANA },
  { from: "src/routes/solana/poll.ts", mustNotContain: SOLANA_FORM_ONLY },
];

export function shortId(id: string, appDir: string): string {
  const clean = id.replace(/^\0/, "").replace(/\?.*$/, "");
  const nm = clean.lastIndexOf("/node_modules/");
  if (nm >= 0) return clean.slice(nm + 1);
  return clean.startsWith(appDir) ? clean.slice(appDir.length).replace(/^\//, "") : clean;
}

/** The start chunk and every chunk reachable from it by static imports. */
export function staticClosure(chunks: ChunkInfo[], start: ChunkInfo): ChunkInfo[] {
  const byFile = new Map(chunks.map((c) => [c.file, c]));
  const seen = new Map<string, ChunkInfo>([[start.file, start]]);
  const todo = [start];
  while (todo.length) {
    for (const f of todo.pop()!.imports) {
      const next = byFile.get(f);
      if (next && !seen.has(f)) {
        seen.set(f, next);
        todo.push(next);
      }
    }
  }
  return [...seen.values()];
}

export function checkChunks(chunks: ChunkInfo[], rules: ChunkRule[] = CHUNK_RULES): string[] {
  const problems: string[] = [];
  for (const r of rules) {
    const start = r.from === "entry" ? chunks.find((c) => c.isEntry) : chunks.find((c) => !c.isEntry && c.modules.includes(r.from));
    if (!start) {
      problems.push(`no chunk is built for ${r.from} (is it still imported lazily?)`);
      continue;
    }
    for (const chunk of staticClosure(chunks, start)) {
      for (const m of chunk.modules) {
        const hit = r.mustNotContain.find((re) => re.test(m));
        if (hit) problems.push(`${r.from} loads ${m} up front (rule ${hit})`);
      }
    }
  }
  return problems;
}

/** One Rollup output chunk as the rules see it. */
export function toChunkInfo(o: { fileName: string; isEntry: boolean; imports: string[]; modules: Record<string, unknown>; code: string }, appDir: string): ChunkInfo {
  return { file: o.fileName, isEntry: o.isEntry, imports: [...o.imports], modules: Object.keys(o.modules).map((id) => shortId(id, appDir)), bytes: Buffer.byteLength(o.code, "utf8") };
}

export function chunkCheck(appDir: string, rules: ChunkRule[] = CHUNK_RULES): Plugin {
  return {
    name: "hlo-chunk-check",
    apply: "build",
    generateBundle(_options, bundle) {
      const chunks: ChunkInfo[] = Object.values(bundle).flatMap((o) =>
        o.type === "chunk" ? [toChunkInfo(o, appDir)] : [],
      );
      const problems = checkChunks(chunks, rules);
      if (problems.length) this.error(`[hlo] the code split is broken:\n  ${problems.join("\n  ")}`);
      const entry = chunks.find((c) => c.isEntry);
      if (entry) {
        const kb = staticClosure(chunks, entry).reduce((n, c) => n + c.bytes, 0) / 1000;
        console.log(`\n[hlo] the entry loads ${kb.toFixed(1)} kB of JS before anything else (minified, before gzip).`);
      }
    },
  };
}
