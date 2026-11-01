import { useEffect, useState } from "react";
import { useConfig } from "../config/context";
import { rewardsBase } from "../config/load";
import type { CoreChain } from "./chain";
import { feeTable, type FeeTable, type MinuteTables } from "./explore";
import { loadCheckpoint, type LatestFile } from "./files";
import { checkSigned, UPDATING } from "./model";

/** Published minutes never change, so a table read once is kept. Bounded: a tab left open a long time reads one a minute. */
const KEPT = 500;
const AT_ONCE = 6;
const kept = new Map<string, FeeTable>();

function keep(key: string, table: FeeTable) {
  kept.set(key, table);
  if (kept.size > KEPT) kept.delete(kept.keys().next().value as string);
}

/** Forgets the kept tables, for tests. */
export const clearMinuteTables = () => kept.clear();

/**
 * The fee tables of `wanted` (published minutes). latest.json holds the newest; the others come from `checkpoints/<m>.json`, at
 * most six at a time. A file that is missing, unreadable or not signed by the rewards poster is in `failed` and is asked for
 * again on the next poll. `chain` and `latest` come from useRewards, so this polls with it.
 */
export function useMinuteTables(wanted: readonly number[], chain: CoreChain | null, latest: LatestFile | null): { tables: MinuteTables; failed: ReadonlySet<number> } {
  const cfg = useConfig();
  const [result, setResult] = useState<{ tables: MinuteTables; failed: ReadonlySet<number> }>({ tables: new Map(), failed: new Set() });
  const contract = cfg.contracts?.checkpoints;
  const list = wanted.join(",");
  const poll = chain?.now ?? null;
  const newest = latest?.throughMinute ?? null;

  useEffect(() => {
    if (!chain || !contract || !rewardsBase || list === "") return;
    const base = rewardsBase;
    let live = true;
    const keyOf = (m: number) => `${cfg.hyperEvmChainId}:${contract}:${m}`;
    if (latest) {
      const table = feeTable(latest.table, latest.throughMinute);
      if (table) keep(keyOf(latest.throughMinute), table);
    }
    const minutes = list.split(",").map(Number);
    const failed = new Set<number>();
    const publish = () => {
      if (!live) return;
      const tables: MinuteTables = new Map();
      for (const m of minutes) {
        const t = kept.get(keyOf(m));
        if (t) tables.set(m, t);
      }
      setResult({ tables, failed: new Set(failed) });
    };
    const read = async (m: number) => {
      try {
        const file = await loadCheckpoint(base, m);
        if (!file || file.throughMinute !== m) throw new Error("no file");
        const ok = await checkSigned(file, chain, cfg.hyperEvmChainId, contract);
        // A minute older than the chain's newest reads as UPDATING: that says only that it is old, after the signature passed.
        if (!ok.ok && ok.reason !== UPDATING) throw new Error(ok.reason);
        const table = feeTable(file.table, m);
        if (!table) throw new Error("bad table");
        keep(keyOf(m), table);
      } catch {
        failed.add(m);
      }
    };
    void (async () => {
      const todo = minutes.filter((m) => !kept.has(keyOf(m)));
      publish();
      for (let i = 0; i < todo.length && live; i += AT_ONCE) {
        await Promise.all(todo.slice(i, i + AT_ONCE).map(read));
        publish();
      }
    })();
    return () => {
      live = false;
    };
    // `chain` and `latest` are new objects on every poll: `poll` and `newest` say when they changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, poll, newest, contract, cfg.hyperEvmChainId]);

  return result;
}
