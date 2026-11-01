import { tpslPriceFromPct } from "../../hl/math";
import { fmtPx } from "../format";

export const TP_PRESETS = [25, 50, 100];
export const SL_PRESETS = [10, 25, 50];

/** One TP or SL leg, chosen as a % of margin. `px` keeps an existing trigger exactly until the % is changed. */
export interface TpslLeg {
  pct: string;
  px: number | null;
}
export const EMPTY_LEG: TpslLeg = { pct: "", px: null };

export interface TpslCtx {
  entry: number;
  leverage: number;
  isLong: boolean;
}

/** The trigger price for the order plan: undefined when empty, NaN when the % is unusable (the plan refuses it). */
export const legPrice = (leg: TpslLeg, kind: "tp" | "sl", ctx: TpslCtx): number | undefined =>
  leg.px ?? (leg.pct.trim() === "" ? undefined : tpslPriceFromPct({ ...ctx, pct: Number(leg.pct), kind }));

export function TpslPctField({ id, kind, leg, ctx, onChange }: { id: string; kind: "tp" | "sl"; leg: TpslLeg; ctx: TpslCtx; onChange(l: TpslLeg): void }) {
  const tp = kind === "tp";
  const px = legPrice(leg, kind, ctx);
  return (
    <div className="field">
      <label htmlFor={id}>{tp ? "Take profit %" : "Stop loss %"}</label>
      <div className="row tpsl-presets">
        {(tp ? TP_PRESETS : SL_PRESETS).map((p) => (
          <button key={p} type="button" className={`btn small ${leg.px === null && leg.pct === String(p) ? "on" : ""}`} onClick={() => onChange({ pct: String(p), px: null })}>
            {tp ? "+" : "−"}{p}%
          </button>
        ))}
      </div>
      <input id={id} className="input" inputMode="decimal" placeholder={tp ? "gain on margin" : "loss on margin"} value={leg.pct} onChange={(e) => onChange({ pct: e.target.value, px: null })} />
      <span className="muted small">{px === undefined ? "Not set" : Number.isNaN(px) ? "Not a usable %" : `Triggers at ${fmtPx(px)}`}</span>
    </div>
  );
}
