import { SendToEvmWithDataRequest } from "@nktkas/hyperliquid/api/exchange";
import { concat, keccak256, recoverAddress, stringToBytes, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HlUserWallet } from "../src/hl/injected";
import { UNCONFIRMED_NOTE, UnconfirmedPostError, sendToEvmTypedData, type SendToEvmAction, type SignedBody } from "../src/hl/userSigned";
import { PendingFullError, type Pending } from "../src/routes/pending";
import { BAD_SOLANA_ADDRESS, runSolanaWithdraw, signSendToSolana, solanaWithdrawAction, type SolanaWithdrawDeps } from "../src/routes/solana/withdraw";
import { digestOf, encodeType, type Field } from "./helpers/eip712";

const OWNER = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
const ATA_DEVNET = "A37BHqE1TkVJVdFu5FGzYezD6vxgG5FNHa1dHsV6NU6M";
const ATA_MAINNET = "FzbcyEZ9m8xjtergWgWDq7mfPoHEbboBF791B6cTpzbq";
const HOOK57 = "0x636374702d666f72776172640000000000000000000000000148c01b5059005455d9dcb0c6bcecdcb4fb5b2eabc1a9a82b57392baaa40f04e6";
const NOW = 1_800_000_000_000;
// A throwaway key derived from a label: never a real account.
const acct = privateKeyToAccount(keccak256(stringToBytes("hlo solana withdraw test vector")));
const signTypedData = vi.fn(async (p: unknown) => acct.sign({ hash: digestOf(p as never) }));
const wallet: HlUserWallet = { signTypedData, getAddresses: async () => [acct.address], getChainId: async () => 421614 };

beforeEach(() => {
  signTypedData.mockClear();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => vi.restoreAllMocks());

describe("the Solana withdraw action [P4 §2.1; C-W-SOL Step 2]", () => {
  it("testnet: domain 5, base58, the devnet USDC token account (not the wallet), gasLimit 200000, the 57-byte data", async () => {
    const body = await signSendToSolana(wallet, "testnet", { amount: "2.50", sourceDex: "", owner: OWNER });
    expect(body.action).toEqual({
      type: "sendToEvmWithData", hyperliquidChain: "Testnet", signatureChainId: "0x66eee", token: "USDC", amount: "2.5", sourceDex: "",
      destinationRecipient: ATA_DEVNET, addressEncoding: "base58", destinationChainId: 5, gasLimit: 200_000, data: HOOK57, nonce: NOW,
    });
    expect(body.nonce).toBe(NOW);
    expect(body.action.destinationRecipient).not.toBe(OWNER);
  });
  it("mainnet uses the mainnet token account; sourceDex spot passes through", async () => {
    const body = await signSendToSolana(wallet, "mainnet", { amount: "3", sourceDex: "spot", owner: OWNER });
    expect(body.action).toMatchObject({ hyperliquidChain: "Mainnet", destinationRecipient: ATA_MAINNET, sourceDex: "spot", amount: "3" });
  });
  it("the wallet signs the same SendToEvmWithData type as the EVM withdrawals, and the signature recovers to it", async () => {
    const body = await signSendToSolana(wallet, "testnet", { amount: "2.5", sourceDex: "", owner: OWNER });
    const typed = sendToEvmTypedData(body.action as unknown as SendToEvmAction) as ReturnType<typeof sendToEvmTypedData> & { types: Record<string, readonly Field[]> };
    expect(encodeType(typed.primaryType, typed.types[typed.primaryType])).toBe(
      "HyperliquidTransaction:SendToEvmWithData(string hyperliquidChain,string token,string amount,string sourceDex,string destinationRecipient,string addressEncoding,uint32 destinationChainId,uint64 gasLimit,bytes data,uint64 nonce)",
    );
    expect(typed.message).toMatchObject({ addressEncoding: "base58", destinationChainId: 5, destinationRecipient: ATA_DEVNET });
    const sig = concat([body.signature.r, body.signature.s, toHex(body.signature.v, { size: 1 })]);
    expect(await recoverAddress({ hash: digestOf(typed as never), signature: sig })).toBe(acct.address);
    expect(signTypedData).toHaveBeenCalledTimes(1);
  });
  it("nktkas 0.33.3 accepts base58 for this action (second oracle)", () => {
    expect(SendToEvmWithDataRequest.entries.action.entries.addressEncoding.options).toContain("base58");
  });
  it("refuses a bad owner or amount before the wallet is asked", async () => {
    // (dropping the last character of a base58 address can still leave a valid address: one reason withdrawals go only
    // to the connected wallet, never to a typed address, ruling 12)
    // "1" x 32 decodes to 32 zero bytes: the default (all-zero) address, which no wallet owns
    for (const owner of ["", "0x00000000000000000000000000000000000000aa", "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwu", "0OIl".repeat(11), "1".repeat(32)]) {
      await expect(signSendToSolana(wallet, "testnet", { amount: "2", sourceDex: "", owner })).rejects.toThrow(BAD_SOLANA_ADDRESS);
    }
    // each refused for its own reason, not for some unrelated throw (Task 11-12 review minor)
    for (const [amount, why] of [["0", "Enter an amount above zero."], ["-1", "Enter the amount as a plain number"], ["1e3", "Enter the amount as a plain number"], ["1.0000001", "USDC has 6 decimals"]]) {
      await expect(signSendToSolana(wallet, "testnet", { amount, sourceDex: "", owner: OWNER }), amount).rejects.toThrow(why);
    }
    expect(signTypedData).not.toHaveBeenCalled();
  });
  it("refuses an off-curve owner (a PDA no wallet can sign for), before the wallet is asked", async () => {
    // [P4 §2.1] the denylist PDA and the devnet USDC token account of OWNER: both program-derived, both off-curve.
    // An ATA derived for such an owner would hold USDC that nobody can move (Circle's how-to refuses it too:
    // getAssociatedTokenAddressSync with allowOwnerOffCurve = false).
    for (const owner of ["8kfrkuzrLQgaFQYyRnK5oKtNr5vZy9vQ3Q21SAsHzjAp", ATA_DEVNET]) {
      await expect(signSendToSolana(wallet, "testnet", { amount: "2", sourceDex: "", owner })).rejects.toThrow(BAD_SOLANA_ADDRESS);
    }
    expect(signTypedData).not.toHaveBeenCalled();
  });
  it("solanaWithdrawAction is a pure builder", () => {
    const a = solanaWithdrawAction({ net: "mainnet", signatureChainId: 42161, amount: "1.5", sourceDex: "", ata: ATA_MAINNET as never, data: HOOK57, nonce: 1 });
    expect(a).toMatchObject({ signatureChainId: "0xa4b1", destinationChainId: 5, addressEncoding: "base58" });
  });
});

describe("runSolanaWithdraw (Plan 3 money rules)", () => {
  function deps(o: Partial<SolanaWithdrawDeps> = {}) {
    const recorded: Pending[] = [];
    const kept: [string, SignedBody][] = [];
    const post = vi.fn(async (_net: string, _body: SignedBody) => {});
    const d: SolanaWithdrawDeps = {
      net: "testnet", wallet, amount: 2_000_000n, sourceDex: "", owner: OWNER, nowMs: NOW,
      hasRoom: () => true, readAtaUsdc: vi.fn(async () => 7_000_000n), watching: () => 0n,
      record: (p) => void recorded.push(p), keepSigned: (id, b) => void kept.push([id, b]), post, ...o,
    };
    return { d, recorded, kept, post };
  }
  it("signs once, posts, and records a withdrawal watched by the token account's balance", async () => {
    const { d, recorded, post } = deps();
    const rec = await runSolanaWithdraw(d);
    expect(rec).toEqual({
      id: `w-${NOW}`, dir: "withdraw", route: "solana", amount: "2000000", startedAt: NOW, status: "pending",
      balanceKind: "solana", watch: ATA_DEVNET, baseline: "7000000", minArrive: "1500000",
    });
    expect(recorded).toEqual([rec]);
    expect(d.readAtaUsdc).toHaveBeenCalledWith(ATA_DEVNET);
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect((post.mock.calls[0] as unknown as [string, SignedBody])[1].action).toMatchObject({ amount: "2", destinationRecipient: ATA_DEVNET });
  });
  it("starts from an earlier pending withdrawal's mark when that is higher", async () => {
    const { d } = deps({ watching: () => 9_000_000n });
    expect((await runSolanaWithdraw(d)).baseline).toBe("9000000");
  });
  it("below the minimum, without room, or without a balance reading: refused before the wallet is asked", async () => {
    await expect(runSolanaWithdraw(deps({ amount: 1_499_999n }).d)).rejects.toThrow("Withdraw at least 1.50 USDC");
    const full = deps({ hasRoom: () => false });
    await expect(runSolanaWithdraw(full.d)).rejects.toThrow(PendingFullError);
    expect(full.d.readAtaUsdc).not.toHaveBeenCalled(); // room before any network read (Task 11-12 review minor)
    await expect(runSolanaWithdraw(deps({ readAtaUsdc: async () => null }).d)).rejects.toThrow(/Nothing was sent/);
    await expect(runSolanaWithdraw(deps({ owner: "nope" }).d)).rejects.toThrow(BAD_SOLANA_ADDRESS);
    const pda = deps({ owner: "8kfrkuzrLQgaFQYyRnK5oKtNr5vZy9vQ3Q21SAsHzjAp" });
    await expect(runSolanaWithdraw(pda.d)).rejects.toThrow(BAD_SOLANA_ADDRESS);
    expect(pda.d.readAtaUsdc).not.toHaveBeenCalled();
    expect(pda.recorded).toEqual([]);
    expect(signTypedData).not.toHaveBeenCalled();
  });
  it("an unconfirmed post keeps the signed body for the same-request retry and records the transfer as unconfirmed", async () => {
    const { d, recorded, kept, post } = deps();
    post.mockImplementationOnce(async (_n: unknown, body: SignedBody) => { throw new UnconfirmedPostError(body); });
    await expect(runSolanaWithdraw(d)).rejects.toBeInstanceOf(UnconfirmedPostError);
    expect(kept).toHaveLength(1);
    expect(kept[0][0]).toBe(`w-${NOW}`);
    expect(kept[0][1].action).toMatchObject({ destinationRecipient: ATA_DEVNET });
    expect(recorded).toEqual([expect.objectContaining({ id: `w-${NOW}`, note: UNCONFIRMED_NOTE, watch: ATA_DEVNET })]);
    expect(signTypedData).toHaveBeenCalledTimes(1);
  });
  it("a refusal from Hyperliquid records nothing and keeps nothing", async () => {
    const { d, recorded, kept, post } = deps();
    post.mockRejectedValueOnce(new Error("Insufficient balance"));
    await expect(runSolanaWithdraw(d)).rejects.toThrow("Insufficient balance");
    expect(recorded).toEqual([]);
    expect(kept).toEqual([]);
  });
});
