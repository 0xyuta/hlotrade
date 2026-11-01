import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/validate";
import { ROUTE_ADDRESSES } from "../src/routes/addresses";

const readContract = vi.fn();
const chainsAsked: string[] = [];
const cfgsAsked: AppConfig[] = [];
vi.mock("../src/evm/clients", async (orig) => ({
  ...(await orig<typeof import("../src/evm/clients")>()),
  publicClient: (chain: { kind: string; cfg: AppConfig }) => {
    chainsAsked.push(chain.kind);
    cfgsAsked.push(chain.cfg);
    return { readContract };
  },
}));
// the chain is built from the caller's config (its RPC and network), not some other one (Task 1-2 review minor)
vi.mock("../src/wallet/chains", async (orig) => ({ ...(await orig<typeof import("../src/wallet/chains")>()), viemChain: (kind: string, cfg: AppConfig) => ({ kind, cfg }) }));

import { readAllowance } from "../src/routes/exec";

const OWNER = "0x00000000000000000000000000000000000000aa";
const cfg = (network: "mainnet" | "testnet") => ({ network }) as AppConfig;

beforeEach(() => {
  readContract.mockReset().mockResolvedValue(7n);
  chainsAsked.length = 0;
  cfgsAsked.length = 0;
});

describe("readAllowance maps each route to its token and spender (E2)", () => {
  for (const net of ["mainnet", "testnet"] as const) {
    const a = ROUTE_ADDRESSES[net];
    it(`${net} HyperEVM: USDC allowance from the owner to the CoreDepositWallet`, async () => {
      const c = cfg(net);
      expect(await readAllowance(c, "hyperEvm", OWNER)).toBe(7n);
      expect(chainsAsked).toEqual(["hyperEvm"]);
      expect(cfgsAsked).toHaveLength(1);
      expect(cfgsAsked[0]).toBe(c);
      expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ address: a.hyperEvm.usdc, functionName: "allowance", args: [OWNER, a.hyperEvm.coreDepositWallet] }));
    });
    for (const src of ["arbitrum", "ethereum"] as const) {
      it(`${net} ${src}: USDC allowance from the owner to TokenMessengerV2`, async () => {
        const c = cfg(net);
        await readAllowance(c, src, OWNER);
        expect(chainsAsked).toEqual([src]);
        expect(cfgsAsked).toHaveLength(1);
        expect(cfgsAsked[0]).toBe(c);
        expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ address: a[src].usdc, functionName: "allowance", args: [OWNER, a[src].tokenMessengerV2] }));
      });
    }
  }
  it("the owner is the first argument and the spender is never the owner or the token", async () => {
    await readAllowance(cfg("mainnet"), "arbitrum", OWNER);
    const { args, address } = readContract.mock.calls[0][0] as { args: string[]; address: string };
    expect(args[0]).toBe(OWNER);
    expect(args[1]).not.toBe(OWNER);
    expect(args[1]).not.toBe(address);
  });
  it("a chain that does not answer gives null, not a throw", async () => {
    readContract.mockRejectedValueOnce(new Error("rpc down"));
    expect(await readAllowance(cfg("testnet"), "ethereum", OWNER)).toBeNull();
  });
});
