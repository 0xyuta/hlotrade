import { useCallback, useEffect, useRef, useState } from "react";
import { useConfig } from "../config/context";
import type { Address } from "../config/validate";
import { profilesAbi } from "../evm/abi";
import { publicClient } from "../evm/clients";
import { viemChain } from "../wallet/chains";

/** Reads Profiles.nameOf / avatarOf on HyperEVM. Unavailable without contracts or when HyperEVM does not answer. */
export function useProfile(address: Address | null): { available: boolean; name: string; avatar: number; reload(): void } {
  const cfg = useConfig();
  const [state, setState] = useState({ available: false, name: "", avatar: 0 });
  const latest = useRef(0); // an answer for a previous address must not overwrite the current one
  const reload = useCallback(() => {
    const mine = ++latest.current;
    const profiles = cfg.contracts?.profiles;
    if (!profiles || !address) return setState({ available: false, name: "", avatar: 0 });
    const c = publicClient(viemChain("hyperEvm", cfg));
    Promise.all([
      c.readContract({ address: profiles, abi: profilesAbi, functionName: "nameOf", args: [address] }),
      c.readContract({ address: profiles, abi: profilesAbi, functionName: "avatarOf", args: [address] }),
    ])
      .then(([name, avatar]) => mine === latest.current && setState({ available: true, name, avatar: Number(avatar) }))
      .catch(() => mine === latest.current && setState({ available: false, name: "", avatar: 0 }));
  }, [cfg, address]);
  useEffect(reload, [reload]);
  return { ...state, reload };
}
