import { describe, expect, it, vi } from "vitest";
import { CONNECT, SIGN_AND_SEND, SIGN_TX, SolanaNotSentError, SolanaRejectedError, SolanaUnconfirmedError, connectSolana, isUserRejection, solanaCapable, solanaSigner, watchSolanaWallets, type SolanaAccountLike, type SolanaWalletLike, type WalletsApi } from "../src/wallet/solana";

const DEV = "solana:devnet";
const acct = (o: Partial<SolanaAccountLike> = {}): SolanaAccountLike => ({ address: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9", chains: [DEV], features: [SIGN_TX, SIGN_AND_SEND], ...o });
function wallet(o: { name?: string; chains?: string[]; sign?: boolean; send?: boolean; versions?: (string | number)[]; accounts?: SolanaAccountLike[] } = {}) {
  const signTransaction = vi.fn(async (i: { transaction: Uint8Array }) => [{ signedTransaction: Uint8Array.from([...i.transaction, 9]) }]);
  const signAndSendTransaction = vi.fn(async () => [{ signature: new Uint8Array(64).fill(7) }]);
  const accounts = o.accounts ?? [acct()];
  const connect = vi.fn(async () => ({ accounts }));
  const v = { supportedTransactionVersions: o.versions ?? ["legacy", 0] };
  const w: SolanaWalletLike = {
    name: o.name ?? "Phantom", icon: "data:image/svg+xml;base64,", chains: o.chains ?? [DEV, "solana:mainnet"], accounts: [],
    features: {
      [CONNECT]: { version: "1.0.0", connect },
      ...(o.sign === false ? {} : { [SIGN_TX]: { version: "1.0.0", ...v, signTransaction } }),
      ...(o.send === false ? {} : { [SIGN_AND_SEND]: { version: "1.0.0", ...v, signAndSendTransaction } }),
    },
  };
  return { w, connect, signTransaction, signAndSendTransaction };
}

describe("which wallets are offered [P4 §3]", () => {
  it("needs connect, the chain, and a signing feature for version-0 transactions", () => {
    expect(solanaCapable(wallet().w, DEV)).toBe(true);
    expect(solanaCapable(wallet({ sign: false }).w, DEV)).toBe(true);
    expect(solanaCapable(wallet({ send: false }).w, DEV)).toBe(true);
    expect(solanaCapable(wallet({ sign: false, send: false }).w, DEV)).toBe(false);
    expect(solanaCapable(wallet({ chains: ["solana:mainnet"] }).w, DEV)).toBe(false);
    expect(solanaCapable(wallet({ versions: ["legacy"] }).w, DEV)).toBe(false);
    const noMethod = wallet({ send: false }).w;
    expect(solanaCapable({ ...noMethod, features: { ...noMethod.features, [SIGN_TX]: { version: "1.0.0", supportedTransactionVersions: [0] } } }, DEV)).toBe(false);
  });
  it("watch lists capable wallets now and on every register and unregister, and stops", () => {
    const good = wallet().w;
    const evmOnly = { ...wallet().w, name: "EVM", chains: ["eip155:1"] };
    let listeners: (() => void)[] = [];
    let all: SolanaWalletLike[] = [evmOnly];
    const api: WalletsApi = { get: () => all, on: (_e, l) => (listeners.push(l), () => (listeners = listeners.filter((x) => x !== l))) };
    const seen: string[][] = [];
    const stop = watchSolanaWallets(DEV, (ws) => seen.push(ws.map((w) => w.name)), api);
    all = [evmOnly, good];
    listeners.forEach((l) => l());
    stop();
    expect(seen).toEqual([[], ["Phantom"], ["Phantom"]]);
    expect(listeners).toEqual([]);
  });
});

describe("connectSolana", () => {
  it("returns the first account that lists the chain and can sign", async () => {
    const other = acct({ address: "other", chains: ["solana:mainnet"] });
    const { w } = wallet({ accounts: [other, acct()] });
    expect((await connectSolana(w, DEV)).address).toBe("5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9");
  });
  it("never falls back to an account authorized earlier: only one this connect returned", async () => {
    const { w } = wallet({ accounts: [acct({ chains: ["solana:mainnet"] })] });
    await expect(connectSolana({ ...w, accounts: [acct()] }, DEV)).rejects.toThrow(/no account on Solana devnet/);
  });
  it("no such account: says so", async () => {
    await expect(connectSolana(wallet({ accounts: [acct({ features: [] })] }).w, DEV)).rejects.toThrow("Phantom has no account on Solana devnet that can sign transactions.");
  });
});

describe("solanaSigner [P4 §3 ruling]", () => {
  it("prefers solana:signTransaction and returns the wallet's signed bytes, one call per transaction", async () => {
    const { w, signTransaction, signAndSendTransaction } = wallet();
    const s = solanaSigner(w, acct(), DEV, "sign");
    expect(s.kind).toBe("sign");
    if (s.kind !== "sign") return;
    expect(await s.sign(Uint8Array.from([1, 2]))).toEqual(Uint8Array.from([1, 2, 9]));
    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(signTransaction).toHaveBeenCalledWith({ account: acct(), transaction: Uint8Array.from([1, 2]), chain: DEV });
    expect(signAndSendTransaction).not.toHaveBeenCalled();
  });
  it("falls back to signAndSend when the account lacks signTransaction (or the switch says so)", async () => {
    const { w, signAndSendTransaction } = wallet();
    const s = solanaSigner(w, acct({ features: [SIGN_AND_SEND] }), DEV, "sign");
    expect(s.kind).toBe("signAndSend");
    if (s.kind !== "signAndSend") return;
    expect(await s.signAndSend(Uint8Array.from([1]))).toEqual(new Uint8Array(64).fill(7));
    expect(signAndSendTransaction).toHaveBeenCalledWith({ account: acct({ features: [SIGN_AND_SEND] }), transaction: Uint8Array.from([1]), chain: DEV });
    expect(solanaSigner(wallet().w, acct(), DEV, "signAndSend").kind).toBe("signAndSend");
    expect(solanaSigner(wallet({ send: false }).w, acct(), DEV, "signAndSend").kind).toBe("sign");
  });
  it("neither, or an account without the chain: refused", () => {
    expect(() => solanaSigner(wallet().w, acct({ features: [] }), DEV)).toThrow(/cannot sign Solana transactions/);
    expect(() => solanaSigner(wallet().w, acct({ chains: ["solana:mainnet"] }), DEV)).toThrow(/cannot sign Solana transactions/);
  });
  it("isUserRejection: typed codes only, never the wording", () => {
    expect(isUserRejection({ code: 4001, message: "x" })).toBe(true);
    expect(isUserRejection({ context: { __code: 4001000 } })).toBe(true);
    expect(isUserRejection({ code: 4001000 })).toBe(true);
    for (const m of ["User rejected the request.", "access denied", "Request cancelled", "declined", "Transaction simulation failed"]) expect(isUserRejection(new Error(m))).toBe(false);
    expect(isUserRejection(null)).toBe(false);
    expect(isUserRejection("4001")).toBe(false);
  });
});

describe("what a failed wallet call means [P4 §3 ruling 2, 3]", () => {
  const sendSigner = () => {
    const { w, signAndSendTransaction } = wallet({ sign: false });
    const s = solanaSigner(w, acct(), DEV);
    if (s.kind !== "signAndSend") throw new Error("expected signAndSend");
    return { s, signAndSendTransaction };
  };
  const signSigner = () => {
    const { w, signTransaction } = wallet();
    const s = solanaSigner(w, acct(), DEV, "sign");
    if (s.kind !== "sign") throw new Error("expected sign");
    return { s, signTransaction };
  };
  it("signAndSend: 'access denied' (or any untyped error) may have been broadcast: unconfirmed", async () => {
    for (const e of [new Error("access denied"), new Error("Request cancelled"), new Error("User rejected the request.")]) {
      const { s, signAndSendTransaction } = sendSigner();
      signAndSendTransaction.mockRejectedValueOnce(e);
      const err = await s.signAndSend(new Uint8Array(1)).catch((x: unknown) => x);
      expect(err).toBeInstanceOf(SolanaUnconfirmedError);
      expect(err).not.toBeInstanceOf(SolanaNotSentError);
      expect((err as Error).cause).toBe(e);
    }
  });
  it("signAndSend: a typed rejection (4001, or Wallet Standard 4001000): rejected, nothing sent", async () => {
    for (const e of [{ code: 4001, message: "no" }, Object.assign(new Error("x"), { context: { __code: 4001000 } })]) {
      const { s, signAndSendTransaction } = sendSigner();
      signAndSendTransaction.mockRejectedValueOnce(e);
      const err = await s.signAndSend(new Uint8Array(1)).catch((x: unknown) => x);
      expect(err).toBeInstanceOf(SolanaRejectedError);
      expect(err).toBeInstanceOf(SolanaNotSentError);
    }
  });
  it("signAndSend: a missing or malformed signature is unconfirmed, never a guess", async () => {
    for (const answer of [[{ signature: new Uint8Array(3) }], [], [{ signature: new Uint8Array(64) }, { signature: new Uint8Array(64) }], undefined]) {
      const { s, signAndSendTransaction } = sendSigner();
      signAndSendTransaction.mockResolvedValueOnce(answer as never);
      await expect(s.signAndSend(new Uint8Array(1))).rejects.toBeInstanceOf(SolanaUnconfirmedError);
    }
  });
  it("sign: never broadcasts, so any failure is nothing sent (a typed rejection is also 'rejected')", async () => {
    const a = signSigner();
    a.signTransaction.mockRejectedValueOnce(new Error("access denied"));
    const err = await a.s.sign(new Uint8Array(1)).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(SolanaNotSentError);
    expect(err).not.toBeInstanceOf(SolanaRejectedError);
    expect(err).not.toBeInstanceOf(SolanaUnconfirmedError);
    const b = signSigner();
    b.signTransaction.mockRejectedValueOnce({ code: 4001 });
    await expect(b.s.sign(new Uint8Array(1))).rejects.toBeInstanceOf(SolanaRejectedError);
    const c = signSigner();
    c.signTransaction.mockResolvedValueOnce([]);
    const err2 = await c.s.sign(new Uint8Array(1)).catch((x: unknown) => x);
    expect(err2).toBeInstanceOf(SolanaNotSentError);
    expect((err2 as Error).message).toMatch(/no signed transaction/);
  });
});
