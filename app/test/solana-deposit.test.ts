import { blockhash, createKeyPairSignerFromPrivateKeyBytes, getBase58Decoder, getTransactionDecoder, getTransactionEncoder, signBytes, type KeyPairSigner } from "@solana/kit";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { IrisFee } from "../src/routes/fees";
import { PendingFullError, type Pending } from "../src/routes/pending";
import { BAD_SOLANA_ADDRESS } from "../src/routes/solana/ata";
import { WalletChangedError } from "../src/routes/solana/burn";
import { MESSAGE_TRANSMITTER_V2 } from "../src/routes/solana/constants";
import { SolanaSendUncertainError, TRANSFER_BUSY_TEXT, runSolanaDeposit, type SolanaDepositDeps } from "../src/routes/solana/deposit";
import {
  PREFLIGHT_FAILED, SolanaNoAnswerError, SolanaRpcError, blockHeight, eventAccountState, firstSignatureFor, preflightNotSent, readSolanaUsdcAt, signatureStatus, solanaRpc,
} from "../src/routes/solana/rpc";
import {
  EXPIRE_GRACE_MS, SOLANA_EXPIRED_NOTE, SOLANA_FAILED_NOTE, SOLANA_UNCONFIRMED_NOTE, SOLANA_WATCH_NOTE, readSolanaDeposit, settleSolanaDeposit, solanaTxState,
} from "../src/routes/solana/settle";
import { SolanaNotSentError, SolanaRejectedError, SolanaUnconfirmedError, type SolanaSigner } from "../src/wallet/solana";

const RPC = "https://api.devnet.solana.com";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const NOW = 1_800_000_000_000;
const IRIS: IrisFee[] = [{ finalityThreshold: 1000, minimumFee: 1, forwardFee: { low: 1, med: 243_456, high: 3 } }];
const LIFETIME = { blockhash: blockhash("4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"), lastValidBlockHeight: 300_000_100n };
const EVENT = "A37BHqE1TkVJVdFu5FGzYezD6vxgG5FNHa1dHsV6NU6M"; // any base58 address stands in for an event account in settlement tests
let owner: KeyPairSigner; // a fixed test key, never a real account
beforeAll(async () => {
  owner = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(1));
});
afterEach(() => vi.unstubAllGlobals());

/** A wallet under solana:signTransaction: signs the message it was given, changes nothing. */
const signingWallet = (): SolanaSigner & { kind: "sign" } => ({
  kind: "sign",
  address: owner.address,
  sign: vi.fn(async (wire: Uint8Array) => {
    const tx = getTransactionDecoder().decode(wire);
    const signed = { ...tx, signatures: { ...tx.signatures, [owner.address]: await signBytes(owner.keyPair.privateKey, tx.messageBytes) } };
    return Uint8Array.from(getTransactionEncoder().encode(signed));
  }),
});

/** The page-wide lock, as transferLock behaves: one holder at a time. */
const fakeLock = () => {
  const l = { held: false, tryBegin: vi.fn(() => (l.held ? false : (l.held = true))), end: vi.fn(() => void (l.held = false)) };
  return l;
};

function deps(o: Partial<SolanaDepositDeps> = {}) {
  const recorded: Pending[] = [];
  const forgotten: string[] = [];
  const io = { latestBlockhash: vi.fn(async () => LIFETIME), sendWire: vi.fn(async () => "sig"), readSol: vi.fn(async (): Promise<bigint | null> => 10_000_000n) };
  const lock = fakeLock();
  const d: SolanaDepositDeps = {
    net: "testnet", rpc: RPC, owner: owner.address, recipient: RECIPIENT, amount: 10_000_000n, quotedFee: 244_456n, signer: signingWallet(), nowMs: NOW,
    hasRoom: () => true, record: (p) => void recorded.push(p), forget: (id) => void forgotten.push(id), fetchFees: async () => IRIS, lock, io, ...o,
  };
  return { d, recorded, forgotten, io, lock };
}
const sentTx = (io: ReturnType<typeof deps>["io"]) => getTransactionDecoder().decode((io.sendWire.mock.calls[0] as unknown as [string, Uint8Array])[1]);
const eventOf = (tx: ReturnType<typeof sentTx>) => Object.keys(tx.signatures).find((k) => k !== owner.address)!;

describe("runSolanaDeposit with solana:signTransaction (ruling 13, 14)", () => {
  it("records under the signature before the broadcast, broadcasts once, then clears the watch note", async () => {
    const { d, recorded, io, lock } = deps();
    let atSend: Pending[] = [];
    io.sendWire.mockImplementationOnce(async () => ((atSend = [...recorded]), "x"));
    const rec = await runSolanaDeposit(d);
    expect(atSend).toEqual([expect.objectContaining({ id: rec.id, note: SOLANA_WATCH_NOTE })]);
    const sent = sentTx(io);
    expect(rec).toEqual({
      dir: "deposit", route: "solana", amount: "10000000", startedAt: NOW, status: "pending", srcDomain: 5, lastValid: "300000100", id: rec.id, txHash: rec.id,
      eventAccount: eventOf(sent),
    });
    expect(recorded.at(-1)).toEqual(rec);
    expect(io.sendWire).toHaveBeenCalledTimes(1);
    expect(getBase58Decoder().decode(sent.signatures[owner.address]!)).toBe(rec.id); // the id is the fee payer's signature
    expect(lock.tryBegin).toHaveBeenCalledTimes(1);
    expect(lock.held).toBe(false); // released once the send answered
  });
  it("the record holds the event account's address and the signature, and no key (ruling 5)", async () => {
    const { d, recorded } = deps();
    await runSolanaDeposit(d);
    for (const r of recorded) {
      expect(Object.keys(r).sort()).toEqual(
        ["amount", "dir", "eventAccount", "id", "lastValid", "route", "srcDomain", "startedAt", "status", "txHash", ...("note" in r ? ["note"] : [])].sort(),
      );
      expect(r.eventAccount).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    }
  });
  it("a broadcast with no answer: the record keeps the watch note, nothing is re-sent or re-signed", async () => {
    const { d, recorded, io, lock } = deps();
    io.sendWire.mockRejectedValueOnce(new SolanaNoAnswerError(new TypeError("Failed to fetch")));
    const e = await runSolanaDeposit(d).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SolanaSendUncertainError);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ note: SOLANA_WATCH_NOTE, txHash: (e as SolanaSendUncertainError).id, eventAccount: eventOf(sentTx(io)) });
    expect(io.sendWire).toHaveBeenCalledTimes(1);
    expect((d.signer as ReturnType<typeof signingWallet>).sign).toHaveBeenCalledTimes(1);
    expect(lock.held).toBe(false);
  });
  const preflight = (err: unknown, message = "Transaction simulation failed") => new SolanaRpcError(PREFLIGHT_FAILED, message, { err, logs: [], accounts: null, unitsConsumed: 0 });
  it("-32002 with BlockhashNotFound (or the fee payer cannot pay the fee) is a real 'not sent'", async () => {
    for (const err of ["BlockhashNotFound", "InsufficientFundsForFee", "AccountNotFound"]) {
      const a = deps();
      a.io.sendWire.mockRejectedValueOnce(preflight(err, "Transaction simulation failed: Blockhash not found"));
      await expect(runSolanaDeposit(a.d)).rejects.toThrow(/refused the transaction before sending it, so nothing moved/);
      expect(a.recorded).toHaveLength(2);
      expect(a.recorded.at(-1)?.note).toMatch(/^not sent: Solana refused it/);
      expect(a.io.sendWire).toHaveBeenCalledTimes(1);
    }
  });
  it("-32002 with AlreadyProcessed: the cluster already has it, so the record stays unconfirmed and is never re-sent", async () => {
    const a = deps();
    a.io.sendWire.mockRejectedValueOnce(preflight("AlreadyProcessed", "Transaction simulation failed: This transaction has already been processed"));
    const e = await runSolanaDeposit(a.d).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SolanaSendUncertainError);
    expect((e as SolanaSendUncertainError).id).toBe(a.recorded[0].id);
    expect(a.recorded).toHaveLength(1);
    expect(a.recorded.at(-1)?.note).toBe(SOLANA_WATCH_NOTE);
    expect(a.io.sendWire).toHaveBeenCalledTimes(1);
  });
  it("-32002 that cannot be classified, and any other RPC error, stay unconfirmed", async () => {
    const cases = [
      preflight({ InstructionError: [1, { Custom: 1 }] }), preflight({ InsufficientFundsForRent: { account_index: 2 } }), preflight(undefined),
      new SolanaRpcError(PREFLIGHT_FAILED, "Transaction simulation failed: Blockhash not found"), // wording alone never says "not sent"
      new SolanaRpcError(-32005, "Node is unhealthy"),
    ];
    for (const err of cases) {
      const b = deps();
      b.io.sendWire.mockRejectedValueOnce(err);
      await expect(runSolanaDeposit(b.d)).rejects.toBeInstanceOf(SolanaSendUncertainError);
      expect(b.recorded).toHaveLength(1);
      expect(b.recorded.at(-1)?.note).toBe(SOLANA_WATCH_NOTE);
    }
  });
  it("a failure to store the record after a successful send is reported as unconfirmed, not as a plain error", async () => {
    let n = 0;
    const { d, io } = deps({ record: () => { if (++n === 2) throw new Error("storage full"); } });
    const e = await runSolanaDeposit(d).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SolanaSendUncertainError);
    expect(io.sendWire).toHaveBeenCalledTimes(1);
  });
  it("only one run at a time: a second call while the first is still reading is refused before any read", async () => {
    const first = deps();
    let release!: () => void;
    first.io.readSol.mockImplementationOnce(() => new Promise((r) => (release = () => r(10_000_000n))));
    const a = runSolanaDeposit(first.d);
    const second = deps();
    await expect(runSolanaDeposit(second.d)).rejects.toThrow(TRANSFER_BUSY_TEXT);
    expect(second.io.readSol).not.toHaveBeenCalled();
    release();
    await a;
    const third = deps(); // free again once the first settles
    await expect(runSolanaDeposit(third.d)).resolves.toMatchObject({ route: "solana" });
  });
  it("a wallet that changes the transaction: nothing recorded, nothing sent", async () => {
    const { d, recorded, io, lock } = deps({ signer: { kind: "sign", address: owner.address, sign: async (w) => Uint8Array.from([...w.slice(0, -1), w[w.length - 1] ^ 1]) } });
    await expect(runSolanaDeposit(d)).rejects.toBeInstanceOf(WalletChangedError);
    expect(recorded).toEqual([]);
    expect(io.sendWire).not.toHaveBeenCalled();
    expect(lock.held).toBe(false);
  });
  it("a wallet that returns the message with a bad owner signature: nothing recorded, nothing sent (ruling 2)", async () => {
    const forged = async (wire: Uint8Array) => {
      const tx = getTransactionDecoder().decode(wire);
      return Uint8Array.from(getTransactionEncoder().encode({ ...tx, signatures: { ...tx.signatures, [owner.address]: new Uint8Array(64).fill(9) as never } }));
    };
    const { d, recorded, io } = deps({ signer: { kind: "sign", address: owner.address, sign: forged } });
    await expect(runSolanaDeposit(d)).rejects.toThrow(/a signature is not valid/);
    expect(recorded).toEqual([]);
    expect(io.sendWire).not.toHaveBeenCalled();
  });
  it("a declined or failed signature: nothing recorded, nothing sent, the lock is released", async () => {
    for (const err of [new SolanaRejectedError(), new SolanaNotSentError("Your Solana wallet did not sign. Nothing was sent.")]) {
      const { d, recorded, io, lock } = deps({ signer: { kind: "sign", address: owner.address, sign: async () => { throw err; } } });
      await expect(runSolanaDeposit(d)).rejects.toBe(err);
      expect(recorded).toEqual([]);
      expect(io.sendWire).not.toHaveBeenCalled();
      expect(lock.held).toBe(false);
    }
  });
  it("refused before the wallet is asked: no room, no Iris, a higher fee than quoted, too little SOL", async () => {
    const sign = vi.fn();
    const s: SolanaSigner = { kind: "sign", address: owner.address, sign };
    await expect(runSolanaDeposit(deps({ signer: s, hasRoom: () => false }).d)).rejects.toBeInstanceOf(PendingFullError);
    await expect(runSolanaDeposit(deps({ signer: s, fetchFees: async () => null }).d)).rejects.toThrow(/did not answer/);
    await expect(runSolanaDeposit(deps({ signer: s, quotedFee: 200_000n }).d)).rejects.toThrow("Circle's fee changed from 0.20 to 0.24 USDC");
    const poor = deps({ signer: s });
    poor.io.readSol.mockResolvedValueOnce(3_999_999n);
    await expect(runSolanaDeposit(poor.d)).rejects.toThrow(/about 0\.004 SOL/);
    expect(sign).not.toHaveBeenCalled();
  });
  it("validation (buildSolanaDeposit) runs before the lock is taken and before the wallet is asked (ruling 1)", async () => {
    const sign = vi.fn();
    const s: SolanaSigner = { kind: "sign", address: owner.address, sign };
    for (const o of [{ recipient: "0x12" as never }, { amount: 2n ** 64n }]) {
      const { d, lock, recorded } = deps({ signer: s, quotedFee: null, ...o });
      await expect(runSolanaDeposit(d)).rejects.toThrow();
      expect(lock.tryBegin).not.toHaveBeenCalled();
      expect(recorded).toEqual([]);
    }
    expect(sign).not.toHaveBeenCalled();
  });
  it("the owner is the connected account, checked by solanaOwner; the signer must be that account (ruling 4)", async () => {
    const sign = vi.fn();
    const bad = deps({ owner: "11111111111111111111111111111111", signer: { kind: "sign", address: "11111111111111111111111111111111", sign } });
    await expect(runSolanaDeposit(bad.d)).rejects.toThrow(BAD_SOLANA_ADDRESS);
    expect(bad.io.readSol).not.toHaveBeenCalled();
    const other = deps({ signer: { kind: "sign", address: EVENT, sign } });
    await expect(runSolanaDeposit(other.d)).rejects.toThrow(/not the connected account/);
    expect(other.lock.tryBegin).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });
  it("the lock: busy means the wallet is never asked; room is checked again under the lock, right before the prompt", async () => {
    const sign = vi.fn();
    const busy = deps({ signer: { kind: "sign", address: owner.address, sign } });
    busy.lock.held = true;
    await expect(runSolanaDeposit(busy.d)).rejects.toThrow(TRANSFER_BUSY_TEXT);
    expect(busy.lock.end).not.toHaveBeenCalled(); // someone else's lock is never released
    let calls = 0;
    const full = deps({ signer: { kind: "sign", address: owner.address, sign }, hasRoom: () => ++calls === 1 });
    await expect(runSolanaDeposit(full.d)).rejects.toBeInstanceOf(PendingFullError);
    expect(full.lock.held).toBe(false);
    expect(sign).not.toHaveBeenCalled();
  });
  it("the wallet is asked while the lock is held", async () => {
    const { d, lock } = deps();
    const inner = (d.signer as ReturnType<typeof signingWallet>).sign;
    let heldAtPrompt = false;
    d.signer = { kind: "sign", address: owner.address, sign: async (w) => ((heldAtPrompt = lock.held), inner(w)) };
    await runSolanaDeposit(d);
    expect(heldAtPrompt).toBe(true);
  });
});

describe("runSolanaDeposit with solana:signAndSendTransaction (fallback)", () => {
  it("the wallet sends; the returned signature is added to the record written before the prompt", async () => {
    const sig = new Uint8Array(64).fill(7);
    let wire: Uint8Array = new Uint8Array();
    const { d, recorded, forgotten, io, lock } = deps({ signer: { kind: "signAndSend", address: owner.address, signAndSend: async (w) => ((wire = w), sig) } });
    const rec = await runSolanaDeposit(d);
    expect(rec.id).toBe(`s-${NOW}`);
    expect(rec.txHash).toBe(getBase58Decoder().decode(sig));
    expect(rec.note).toBeUndefined();
    expect(rec.eventAccount).toBe(Object.keys(getTransactionDecoder().decode(wire).signatures).find((k) => k !== owner.address));
    expect(recorded).toEqual([{ ...rec, txHash: undefined, note: SOLANA_UNCONFIRMED_NOTE }, rec].map((r) => JSON.parse(JSON.stringify(r))));
    expect(forgotten).toEqual([]);
    expect(io.sendWire).not.toHaveBeenCalled();
    expect(lock.held).toBe(false);
  });
  it("signAndSend: the record stands before the wallet is asked, so a page that dies while the wallet broadcasts still has it (Task 15 review m5)", async () => {
    let atPrompt: Pending[] = [];
    const { d, recorded } = deps({ signer: { kind: "signAndSend", address: owner.address, signAndSend: async () => ((atPrompt = [...recorded]), new Uint8Array(64).fill(7)) } });
    await runSolanaDeposit(d);
    expect(atPrompt).toEqual([expect.objectContaining({ id: `s-${NOW}`, note: SOLANA_UNCONFIRMED_NOTE, eventAccount: expect.any(String) })]);
    expect(atPrompt[0].txHash).toBeUndefined();
  });
  it("a typed 'not sent' (rejection or failure before broadcast) removes the record again", async () => {
    for (const err of [new SolanaRejectedError(), new SolanaNotSentError("nothing")]) {
      const no = deps({ signer: { kind: "signAndSend", address: owner.address, signAndSend: async () => { throw err; } } });
      await expect(runSolanaDeposit(no.d)).rejects.toBe(err);
      expect(no.recorded.map((r) => r.id)).toEqual([`s-${NOW}`]);
      expect(no.forgotten).toEqual([`s-${NOW}`]);
      expect(no.lock.held).toBe(false);
    }
  });
  it("an unconfirmed failure (typed or not) is recorded with the event account to watch, and no signature", async () => {
    for (const err of [new SolanaUnconfirmedError(), new Error("Request timed out")]) {
      let wire: Uint8Array = new Uint8Array();
      const lost = deps({ signer: { kind: "signAndSend", address: owner.address, signAndSend: async (w) => { wire = w; throw err; } } });
      const e = await runSolanaDeposit(lost.d).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(SolanaSendUncertainError);
      expect((e as SolanaSendUncertainError).id).toBeNull();
      const event = Object.keys(getTransactionDecoder().decode(wire).signatures).find((k) => k !== owner.address);
      expect(lost.recorded).toEqual([expect.objectContaining({ id: `s-${NOW}`, note: SOLANA_UNCONFIRMED_NOTE, eventAccount: event })]);
      expect(lost.recorded[0].txHash).toBeUndefined();
      expect(lost.forgotten).toEqual([]);
      expect(lost.lock.held).toBe(false);
    }
  });
  it("a failed save never turns a broadcast deposit into 'nothing sent'; a save that fails before the prompt asks nothing", async () => {
    // before the prompt: the wallet is never asked, so this is a plain "nothing sent" error
    const asked = vi.fn(async () => new Uint8Array(64).fill(7));
    const full = deps({ record: () => { throw new Error("storage full"); }, signer: { kind: "signAndSend", address: owner.address, signAndSend: asked } });
    const e0 = await runSolanaDeposit(full.d).catch((x: unknown) => x);
    expect(e0).not.toBeInstanceOf(SolanaSendUncertainError);
    expect(asked).not.toHaveBeenCalled();
    expect(full.lock.held).toBe(false);
    // after the wallet sent it: only the second save fails, and that is unconfirmed under the signature
    let n = 0;
    const second = (p: Pending) => { if (n++ > 0) throw new Error("storage full"); void p; };
    const sent = deps({ record: second, signer: { kind: "signAndSend", address: owner.address, signAndSend: async () => new Uint8Array(64).fill(7) } });
    const e2 = await runSolanaDeposit(sent.d).catch((x: unknown) => x);
    expect(e2).toBeInstanceOf(SolanaSendUncertainError);
    expect((e2 as SolanaSendUncertainError).id).toBe(getBase58Decoder().decode(new Uint8Array(64).fill(7)));
    expect(sent.lock.held).toBe(false);
  });
  it("a forget that fails after a typed 'not sent' still reports the wallet's own error (the record only expires later)", async () => {
    const err = new SolanaRejectedError();
    const no = deps({ forget: () => { throw new Error("blocked"); }, signer: { kind: "signAndSend", address: owner.address, signAndSend: async () => { throw err; } } });
    await expect(runSolanaDeposit(no.d)).rejects.toBe(err);
    expect(no.lock.held).toBe(false);
  });
});

describe("settling a Solana deposit (ruling 14, carried ruling 3)", () => {
  const p = (o: Partial<Pending> = {}): Pending => ({ id: "S", dir: "deposit", route: "solana", amount: "1", startedAt: NOW, status: "pending", srcDomain: 5, txHash: "S", lastValid: "100", ...o });
  const iris = (o: Partial<{ status: string; delayReason: string | null; forwardTxHash: string | null }> = {}) => ({ status: "pending_confirmations", delayReason: null, forwardTxHash: null, ...o });
  it("solanaTxState", () => {
    expect(solanaTxState({ state: "landed" }, null, 100n)).toBe("landed");
    expect(solanaTxState({ state: "failed" }, null, 100n)).toBe("failed");
    expect(solanaTxState({ state: "missing" }, 101n, 100n)).toBe("expired");
    expect(solanaTxState({ state: "missing" }, 100n, 100n)).toBe("unknown");
    expect(solanaTxState({ state: "missing" }, null, 100n)).toBe("unknown");
    expect(solanaTxState(null, 999n, 100n)).toBe("unknown");
  });
  it("solanaTxState: an event account owned by MessageTransmitter means the burn landed, whatever the status says", () => {
    expect(solanaTxState({ state: "missing" }, 101n, 100n, "present")).toBe("landed");
    expect(solanaTxState(null, null, null, "present")).toBe("landed");
    expect(solanaTxState({ state: "missing" }, 101n, 100n, "absent")).toBe("expired");
    expect(solanaTxState({ state: "failed" }, null, 100n, "absent")).toBe("failed");
  });
  it("Iris's forwardTxHash finishes it, even over a 'not sent' note", () => {
    expect(settleSolanaDeposit(p({ note: SOLANA_EXPIRED_NOTE }), iris({ forwardTxHash: "0xf" }), "expired", NOW)).toMatchObject({ status: "done", note: undefined });
    expect(settleSolanaDeposit(p({ note: SOLANA_WATCH_NOTE }), iris(), "unknown", NOW).note).toBeUndefined();
  });
  it("failed says not sent; expired only after 15 minutes; not-sent notes stay until Iris", () => {
    expect(settleSolanaDeposit(p({ note: SOLANA_WATCH_NOTE }), null, "failed", NOW).note).toBe(SOLANA_FAILED_NOTE);
    expect(settleSolanaDeposit(p({ note: SOLANA_WATCH_NOTE }), null, "expired", NOW + EXPIRE_GRACE_MS).note).toBe(SOLANA_WATCH_NOTE);
    expect(settleSolanaDeposit(p({ note: SOLANA_WATCH_NOTE }), null, "expired", NOW + EXPIRE_GRACE_MS + 1).note).toBe(SOLANA_EXPIRED_NOTE);
    expect(settleSolanaDeposit(p({ note: SOLANA_FAILED_NOTE }), null, "landed", NOW).note).toBe(SOLANA_FAILED_NOTE);
  });
  it("a 'not sent' record whose transaction turns up landed on chain: the note clears (except a failed status)", () => {
    for (const note of [SOLANA_EXPIRED_NOTE, "not sent: Solana refused it (Transaction simulation failed: Blockhash not found)"]) {
      const r = settleSolanaDeposit(p({ note }), null, "landed", NOW);
      expect(r.note).toBeUndefined();
      expect(r.status).toBe("pending"); // landed is not arrived: only Iris's forward finishes it
      expect(settleSolanaDeposit(p({ note }), null, "unknown", NOW).note).toBe(note);
      expect(settleSolanaDeposit(p({ note }), null, "expired", NOW + EXPIRE_GRACE_MS + 1).note).toBe(note);
    }
    expect(settleSolanaDeposit(p({ note: SOLANA_FAILED_NOTE }), null, "landed", NOW).note).toBe(SOLANA_FAILED_NOTE);
  });
  it("landed drops the watch note; unknown keeps it", () => {
    expect(settleSolanaDeposit(p({ note: SOLANA_WATCH_NOTE }), null, "landed", NOW).note).toBeUndefined();
    expect(settleSolanaDeposit(p({ note: SOLANA_WATCH_NOTE }), null, "unknown", NOW).note).toBe(SOLANA_WATCH_NOTE);
  });
  it("a record with no signature: expired after the grace, never a 'landed' it cannot prove", () => {
    const u = p({ id: `s-${NOW}`, txHash: undefined, note: SOLANA_UNCONFIRMED_NOTE, eventAccount: EVENT });
    expect(settleSolanaDeposit(u, null, "unknown", NOW + EXPIRE_GRACE_MS + 1).note).toBe(SOLANA_UNCONFIRMED_NOTE);
    expect(settleSolanaDeposit(u, null, "expired", NOW + EXPIRE_GRACE_MS + 1).note).toBe(SOLANA_EXPIRED_NOTE);
  });
});

describe("readSolanaDeposit: the chain reads that settle a record (carried ruling 3)", () => {
  const SIG = "5".repeat(87);
  const p = (o: Partial<Pending> = {}): Pending => ({ id: "S", dir: "deposit", route: "solana", amount: "1", startedAt: NOW, status: "pending", srcDomain: 5, txHash: SIG, lastValid: "100", eventAccount: EVENT, note: SOLANA_WATCH_NOTE, ...o });
  const reads = (o: Partial<Parameters<typeof readSolanaDeposit>[2]> = {}) => {
    const order: string[] = [];
    const io = {
      blockHeight: vi.fn(async (): Promise<bigint | null> => (order.push("height"), 50n)),
      signatureStatus: vi.fn(async (): Promise<Awaited<ReturnType<typeof signatureStatus>>> => (order.push("status"), { state: "missing" })),
      eventAccountState: vi.fn(async (): Promise<Awaited<ReturnType<typeof eventAccountState>>> => (order.push("event"), "absent")),
      firstSignatureFor: vi.fn(async (): Promise<Awaited<ReturnType<typeof firstSignatureFor>>> => (order.push("first"), { state: "none" })),
      ...o,
    };
    return { io, order };
  };
  it("the height is read before the status, so 'expired' can never miss a transaction that landed in between", async () => {
    const { io, order } = reads({ blockHeight: vi.fn(async () => 101n) });
    expect(await readSolanaDeposit(RPC, p(), io)).toEqual({ p: p(), tx: "expired" });
    expect(order).toEqual(["status", "event"]);
    expect(vi.mocked(io.blockHeight).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(io.signatureStatus).mock.invocationCallOrder[0]);
    expect(vi.mocked(io.blockHeight).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(io.eventAccountState).mock.invocationCallOrder[0]);
  });
  it("with a signature: the status decides; the event account is read only when the status does not", async () => {
    const landed = reads({ signatureStatus: vi.fn(async () => ({ state: "landed" as const })) });
    expect((await readSolanaDeposit(RPC, p(), landed.io)).tx).toBe("landed");
    expect(landed.io.eventAccountState).not.toHaveBeenCalled();
    const present = reads({ eventAccountState: vi.fn(async () => "present" as const) });
    expect((await readSolanaDeposit(RPC, p(), present.io)).tx).toBe("landed");
    expect(present.io.firstSignatureFor).not.toHaveBeenCalled();
  });
  it("with no signature: once the event account is present, its first signature is adopted and watched from then on", async () => {
    const u = p({ id: `s-${NOW}`, txHash: undefined, note: SOLANA_UNCONFIRMED_NOTE });
    const found = reads({ eventAccountState: vi.fn(async () => "present" as const), firstSignatureFor: vi.fn(async () => ({ state: "found" as const, signature: SIG })) });
    const r = await readSolanaDeposit(RPC, u, found.io);
    expect(r).toEqual({ p: { ...u, txHash: SIG, note: SOLANA_WATCH_NOTE }, tx: "landed" });
    expect(found.io.firstSignatureFor).toHaveBeenCalledWith(RPC, EVENT);
    expect(settleSolanaDeposit(r.p, null, r.tx, NOW)).toMatchObject({ id: `s-${NOW}`, txHash: SIG, note: undefined });
  });
  it("with no signature: a signature on an absent event account is never adopted (lamports a stranger sent to a dropped burn's address)", async () => {
    const u = p({ id: `s-${NOW}`, txHash: undefined, note: SOLANA_UNCONFIRMED_NOTE });
    const stranger = reads({ firstSignatureFor: vi.fn(async () => ({ state: "found" as const, signature: SIG })), signatureStatus: vi.fn(async () => ({ state: "landed" as const })) });
    expect(await readSolanaDeposit(RPC, u, stranger.io)).toEqual({ p: u, tx: "unknown" });
    expect(stranger.io.firstSignatureFor).not.toHaveBeenCalled();
    expect(stranger.io.signatureStatus).not.toHaveBeenCalled();
  });
  it("with no signature: absent past the last valid height is expired; no answer is unknown; a lagging signature index only delays the adoption", async () => {
    const u = p({ id: `s-${NOW}`, txHash: undefined, note: SOLANA_UNCONFIRMED_NOTE });
    expect(await readSolanaDeposit(RPC, u, reads({ blockHeight: vi.fn(async () => 101n) }).io)).toEqual({ p: u, tx: "expired" });
    expect(await readSolanaDeposit(RPC, u, reads().io)).toEqual({ p: u, tx: "unknown" });
    expect(await readSolanaDeposit(RPC, u, reads({ blockHeight: vi.fn(async () => 101n), eventAccountState: vi.fn(async () => null) }).io)).toEqual({ p: u, tx: "unknown" });
    for (const first of [null, { state: "none" as const }]) {
      const lag = await readSolanaDeposit(RPC, u, reads({ blockHeight: vi.fn(async () => 101n), eventAccountState: vi.fn(async () => "present" as const), firstSignatureFor: vi.fn(async () => first) }).io);
      expect(lag).toEqual({ p: u, tx: "landed" });
      expect(settleSolanaDeposit(lag.p, null, lag.tx, NOW + EXPIRE_GRACE_MS + 1).note).toBe(SOLANA_UNCONFIRMED_NOTE); // kept until a signature shows
    }
    const bare = p({ txHash: undefined, eventAccount: undefined });
    const none = reads();
    expect(await readSolanaDeposit(RPC, bare, none.io)).toEqual({ p: bare, tx: "unknown" });
  });
  it("with a signature and an event account: an unanswered event read is no proof, so it is never 'expired' (final review M1)", async () => {
    const r = reads({ blockHeight: vi.fn(async () => 101n), eventAccountState: vi.fn(async () => null) });
    expect(await readSolanaDeposit(RPC, p(), r.io)).toEqual({ p: p(), tx: "unknown" });
    expect(r.io.eventAccountState).toHaveBeenCalledWith(RPC, EVENT);
    // absent is still read as expired, and a record without an event account keeps the status-only rule
    expect((await readSolanaDeposit(RPC, p(), reads({ blockHeight: vi.fn(async () => 101n) }).io)).tx).toBe("expired");
    expect((await readSolanaDeposit(RPC, p({ eventAccount: undefined }), reads({ blockHeight: vi.fn(async () => 101n) }).io)).tx).toBe("expired");
  });
  it("a finished record is not read", async () => {
    const { io } = reads();
    const done = p({ status: "done", note: undefined });
    expect(await readSolanaDeposit(RPC, done, io)).toEqual({ p: done, tx: "unknown" });
    expect(io.blockHeight).not.toHaveBeenCalled();
  });
});

describe("Solana RPC reads", () => {
  const answer = (result: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }))));
  it("a token account's USDC; a missing account is 0; another mint or no answer is null", async () => {
    answer({ value: { data: { parsed: { info: { mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", tokenAmount: { amount: "1500000" } } } } } });
    expect(await readSolanaUsdcAt(RPC, "testnet", "A37BHqE1TkVJVdFu5FGzYezD6vxgG5FNHa1dHsV6NU6M")).toBe(1_500_000n);
    answer({ value: null });
    expect(await readSolanaUsdcAt(RPC, "testnet", "A37BHqE1TkVJVdFu5FGzYezD6vxgG5FNHa1dHsV6NU6M")).toBe(0n);
    answer({ value: { data: { parsed: { info: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tokenAmount: { amount: "1" } } } } } });
    expect(await readSolanaUsdcAt(RPC, "testnet", "x")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 429 })));
    expect(await readSolanaUsdcAt(RPC, "testnet", "x")).toBeNull();
  });
  it("signature status and block height", async () => {
    answer({ value: [null] });
    expect(await signatureStatus(RPC, "S")).toEqual({ state: "missing" });
    answer({ value: [{ err: null, confirmationStatus: "finalized" }] });
    expect(await signatureStatus(RPC, "S")).toEqual({ state: "landed" });
    answer({ value: [{ err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" }] });
    expect(await signatureStatus(RPC, "S")).toEqual({ state: "failed" });
    answer(312);
    expect(await blockHeight(RPC)).toBe(312n);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    expect(await signatureStatus(RPC, "S")).toBeNull();
  });
  it("a malformed signature status is no answer, never 'missing' (which can feed 'expired')", async () => {
    for (const value of ["x", [], [7], ["s"], [null, null], null]) {
      answer({ value });
      expect(await signatureStatus(RPC, "S")).toBeNull();
    }
  });
  it("a JSON-RPC error keeps its code, message and data; only a structured BlockhashNotFound/fee err is 'not sent'", async () => {
    const data = { err: "AlreadyProcessed", logs: [] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32002, message: "Transaction simulation failed: This transaction has already been processed", data } }))));
    const e = (await solanaRpc(RPC, "sendTransaction", []).catch((x: unknown) => x)) as SolanaRpcError;
    expect(e).toBeInstanceOf(SolanaRpcError);
    expect([e.code, e.message, e.data]).toEqual([-32002, "Transaction simulation failed: This transaction has already been processed", data]);
    expect(preflightNotSent(e)).toBe(false);
    expect(preflightNotSent(new SolanaRpcError(-32002, "m", { err: "BlockhashNotFound" }))).toBe(true);
    expect(preflightNotSent(new SolanaRpcError(-32003, "m", { err: "BlockhashNotFound" }))).toBe(false);
    expect(preflightNotSent(new SolanaRpcError(-32002, "m", "BlockhashNotFound"))).toBe(false);
    expect(preflightNotSent(new SolanaNoAnswerError(null))).toBe(false);
  });
  it("the event account: present only when MessageTransmitter owns it", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: { owner: MESSAGE_TRANSMITTER_V2, lamports: 3_108_960 } } })));
    vi.stubGlobal("fetch", f);
    expect(await eventAccountState(RPC, EVENT)).toBe("present");
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ method: "getAccountInfo", params: [EVENT, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 0 } }] });
    answer({ value: null });
    expect(await eventAccountState(RPC, EVENT)).toBe("absent");
    answer({ value: { owner: "11111111111111111111111111111111", lamports: 1 } }); // lamports sent to the address prove nothing
    expect(await eventAccountState(RPC, EVENT)).toBe("absent");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 503 })));
    expect(await eventAccountState(RPC, EVENT)).toBeNull();
  });
  it("the event account's first signature: the oldest one listed; none; no answer", async () => {
    const SIG = "5".repeat(87);
    const f = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [{ signature: "4".repeat(87), err: null }, { signature: SIG, err: null }] })));
    vi.stubGlobal("fetch", f);
    expect(await firstSignatureFor(RPC, EVENT)).toEqual({ state: "found", signature: SIG });
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ method: "getSignaturesForAddress", params: [EVENT, { commitment: "confirmed" }] });
    answer([]);
    expect(await firstSignatureFor(RPC, EVENT)).toEqual({ state: "none" });
    answer([{ signature: 7 }]);
    expect(await firstSignatureFor(RPC, EVENT)).toBeNull();
    answer({ not: "a list" });
    expect(await firstSignatureFor(RPC, EVENT)).toBeNull();
  });
});
