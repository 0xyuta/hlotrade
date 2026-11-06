import type { Hex } from "viem";
import { useMemo, useRef, useState } from "react";
import { useConfig } from "../config/context";
import type { Address } from "../config/validate";
import { settleAndClaimAbi } from "../evm/abi";
import { publicClient } from "../evm/clients";
import { plainError } from "../hl/errors";
import { fmtHlo } from "../ui/format";
import { viemChain } from "../wallet/chains";
import { useSession } from "../wallet/session";
import { claimResultFromReceipt, type ReceiptClient } from "./claim";
import type { ClaimPlan } from "./model";

/** Sends a claim plan from the wallet: Settle & claim on the Rewards screen. */
export function useClaim(o: { plan: ClaimPlan | null; master: Address | null; reload(): void; hold(claimedTo: bigint): void }) {
  const cfg = useConfig();
  const { write } = useSession();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const client = useMemo(() => publicClient(viemChain("hyperEvm", cfg)) as unknown as ReceiptClient, [cfg]);
  const sending = useRef(false); // set at once, before the next render, so a double click cannot send twice

  const claim = async () => {
    const { plan, master } = o;
    if (sending.current || !plan || !cfg.contracts) return;
    sending.current = true;
    setBusy(true);
    setMsg("Confirm in your wallet (HyperEVM)…");
    try {
      // session.write switches the wallet to HyperEVM first (and adds the chain if the wallet lacks it).
      const cp = { throughMinute: BigInt(plan.cp.throughMinute), refBlock: plan.cp.refBlock, root: plan.cp.root, totalEntitled: plan.cp.totalEntitled };
      let hash: Hex;
      if (plan.kind === "settleAndClaim") {
        hash = await write("hyperEvm", { address: cfg.contracts.mining, abi: settleAndClaimAbi, functionName: "settleAndClaim", args: [cp, plan.sig, plan.entitlement, plan.proof] });
      } else {
        hash = await write("hyperEvm", { address: cfg.contracts.mining, abi: settleAndClaimAbi, functionName: "claim", args: [cp.throughMinute, plan.entitlement, plan.proof] });
      }
      setMsg("Claimed.");
      // Hold what the chain says it now has: a partial claim pays what the allowance had when it was mined, which may be less than the plan expected.
      const res = master ? await claimResultFromReceipt(client, hash, cfg.contracts.mining, master) : null;
      o.hold(res?.claimedTotal ?? plan.expectClaimed);
      if (res) setMsg(res.claimedTotal < plan.entitlement ? `Claimed ${fmtHlo(res.paid)} HLO; the rest stays claimable.` : `Claimed ${fmtHlo(res.paid)} HLO.`);
      o.reload();
    } catch (e) {
      setMsg(plainError(e).text);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  return { busy, msg, claim };
}
