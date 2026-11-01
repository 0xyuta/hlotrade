import { decodeLz4, yyyymmdd, type Addr } from "@hlo/calc";
import type { Config } from "./config.js";

const FETCH_TIMEOUT_MS = 30_000;

export type FileResult = { kind: "file"; text: string } | { kind: "missing" };

/** Hyperliquid's builder-fill file for UTC `day` (the verifier's daily check). */
export async function fetchDayFile(src: Config["fills"], builder: Addr, day: number, fetchFn: typeof fetch = fetch): Promise<FileResult> {
  const name = yyyymmdd(day);
  const url = src.template.replaceAll("{builder}", builder.toLowerCase()).replaceAll("{yyyymmdd}", name);
  const res = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status === 403 || res.status === 404) {
    await res.body?.cancel();
    return { kind: "missing" };
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`builder file ${name}: HTTP ${res.status}`);
  }
  return { kind: "file", text: decodeLz4(new Uint8Array(await res.arrayBuffer())) };
}
