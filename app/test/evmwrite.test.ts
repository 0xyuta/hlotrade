import { beforeEach, describe, expect, it, vi } from "vitest";

const hash = `0x${"ab".repeat(32)}` as const;
let receipt: () => Promise<{ status: string }>;

vi.mock("viem", async (orig) => {
  const real = await orig<typeof import("viem")>();
  return {
    ...real,
    createWalletClient: () => ({ writeContract: async () => hash }),
    createPublicClient: () => ({ waitForTransactionReceipt: () => receipt() }),
  };
});

const { EvmTxError, evmWrite } = await import("../src/evm/clients");
const { viemChain } = await import("../src/wallet/chains");

const chain = viemChain("hyperEvm", {
  network: "testnet", hyperEvmChainId: 998, hyperEvmRpc: "https://rpc.example/evm", arbitrumRpc: "https://a.example", ethereumRpc: "https://e.example",
  withdrawEnabled: true, solanaEnabled: false, solanaRpc: null, rewardsBase: null, builder: null, contracts: null, deployBlock: null, referralCode: null,
});
const eth = { request: async () => "0x3e6" };
const call = { address: "0x1111111111111111111111111111111111111111", abi: [], functionName: "stake" } as const;

describe("evmWrite keeps the hash (review M7)", () => {
  beforeEach(() => void (receipt = async () => ({ status: "success" })));
  it("returns the hash on success", async () => {
    expect(await evmWrite(eth, call.address, chain, call)).toBe(hash);
  });
  it("a receipt timeout rethrows with the hash and says the tx may still land", async () => {
    receipt = async () => Promise.reject(Object.assign(new Error("Timed out while waiting for transaction"), { name: "WaitForTransactionReceiptTimeoutError" }));
    const e = await evmWrite(eth, call.address, chain, call).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(EvmTxError);
    expect((e as InstanceType<typeof EvmTxError>).hash).toBe(hash);
    expect((e as Error).message).toContain(hash);
    expect((e as Error).message).toContain("not confirmed");
    expect(((e as Error).cause as Error).message).toContain("Timed out");
  });
  it("a reverted receipt is an EvmTxError with the hash too", async () => {
    receipt = async () => ({ status: "reverted" });
    const e = await evmWrite(eth, call.address, chain, call).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(EvmTxError);
    expect((e as InstanceType<typeof EvmTxError>).hash).toBe(hash);
    expect((e as Error).message).toContain("failed on chain");
  });
});
