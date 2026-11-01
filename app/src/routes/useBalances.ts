import { useCallback, useEffect, useRef, useState } from "react";
import { useConfig } from "../config/context";
import type { Address, AppConfig } from "../config/validate";
import { erc20Abi } from "../evm/abi";
import { publicClient } from "../evm/clients";
import { viemChain, type EvmKind } from "../wallet/chains";
import { ROUTE_ADDRESSES } from "./addresses";

export interface EvmBalances {
  hyperEvm: bigint | null; // USDC 1e6; null = the chain did not answer
  arbitrum: bigint | null;
  ethereum: bigint | null;
  hype: bigint | null; // HYPE on HyperEVM, for gas
}

export async function readUsdc(cfg: AppConfig, kind: EvmKind, user: Address): Promise<bigint | null> {
  try {
    return await publicClient(viemChain(kind, cfg)).readContract({ address: ROUTE_ADDRESSES[cfg.network][kind].usdc, abi: erc20Abi, functionName: "balanceOf", args: [user] });
  } catch {
    return null;
  }
}

export function useBalances(user: Address | null): { balances: EvmBalances | null; reload(): void } {
  const cfg = useConfig();
  const [balances, setBalances] = useState<EvmBalances | null>(null);
  const latest = useRef(0); // a slow answer for an older account must not replace a newer one
  const reload = useCallback(() => {
    const mine = ++latest.current;
    if (!user) return setBalances(null);
    void Promise.all([
      readUsdc(cfg, "hyperEvm", user),
      readUsdc(cfg, "arbitrum", user),
      readUsdc(cfg, "ethereum", user),
      publicClient(viemChain("hyperEvm", cfg)).getBalance({ address: user }).catch(() => null),
    ]).then(([hyperEvm, arbitrum, ethereum, hype]) => {
      if (mine === latest.current) setBalances({ hyperEvm, arbitrum, ethereum, hype });
    });
  }, [cfg, user]);
  useEffect(() => {
    setBalances(null); // another account: never show the last one's numbers
    reload();
  }, [reload]);
  return { balances, reload };
}
