import {
  AccountRole, blockhash, createKeyPairSignerFromPrivateKeyBytes, decompileTransactionMessage, getCompiledTransactionMessageDecoder,
  getTransactionEncoder, signBytes, verifySignature, type AccountMeta, type KeyPairSigner, type Transaction,
} from "@solana/kit";
import { bytesToHex } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { BAD_SOLANA_ADDRESS } from "../src/routes/solana/ata";
import { MAX_TX_BYTES, WalletChangedError, buildSolanaDeposit, burnInstruction, burnPdas, checkWalletSigned, computeUnitPriceInstruction, solanaBurnData, solanaTxId } from "../src/routes/solana/burn";

const OWNER = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9" as never;
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const LIFETIME = { blockhash: blockhash("4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"), lastValidBlockHeight: 300_000_100n };
// Fixed test keys (bytes 1… and 7…): never real accounts.
let owner: KeyPairSigner;
let event: KeyPairSigner;
beforeAll(async () => {
  owner = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(1));
  event = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(7));
});
/** What a wallet does under solana:signTransaction: adds the owner's signature over the same message bytes. */
async function walletSigns(tx: Transaction, key = owner): Promise<Transaction> {
  return { ...tx, signatures: { ...tx.signatures, [key.address]: await signBytes(key.keyPair.privateKey, tx.messageBytes) } };
}
const wire = (tx: Transaction) => Uint8Array.from(getTransactionEncoder().encode(tx));

describe("solanaBurnData [P4 §1]", () => {
  it("pinned bytes: discriminator, amount, domain 19, the forwarder twice, maxFee, finality 1000, the 56-byte hook", () => {
    expect(bytesToHex(solanaBurnData("testnet", 10_000_000n, 244_578n, RECIPIENT))).toBe(
      "0x6ff53e83cc6cdf9b80969800000000001300000000000000000000000000000002e39ecb8368b41bf68ff99ff351ac9864e5e2a200000000000000000000000002e39ecb8368b41bf68ff99ff351ac9864e5e2a262bb030000000000e803000038000000636374702d666f72776172640000000000000000000000000000000000000018111111111111111111111111111111111111111100000000",
    );
    expect(solanaBurnData("testnet", 10_000_000n, 244_578n, RECIPIENT)).toHaveLength(156);
  });
  it("refuses an amount at or under the fee and a bad recipient", () => {
    expect(() => solanaBurnData("testnet", 100n, 100n, RECIPIENT)).toThrow(/above the fee/);
    expect(() => solanaBurnData("testnet", 0n, 0n, RECIPIENT)).toThrow();
    expect(() => solanaBurnData("testnet", 10n, 1n, "0x1234" as never)).toThrow(/20-byte/);
  });
  it("refuses an amount or a fee above u64 instead of wrapping it", () => {
    expect(() => solanaBurnData("testnet", 2n ** 64n, 1n, RECIPIENT)).toThrow(/too large/);
    expect(() => solanaBurnData("testnet", 2n ** 64n + 10_000_000n, 2n ** 64n, RECIPIENT)).toThrow(/too large/);
    expect(solanaBurnData("testnet", 2n ** 64n - 1n, 1n, RECIPIENT).subarray(8, 16)).toEqual(new Uint8Array(8).fill(255));
  });
});

describe("burn accounts [P4 §1]", () => {
  it("the PDAs are the ones checked on devnet", async () => {
    expect(await burnPdas("testnet", OWNER)).toEqual({
      senderAuthority: "45hzrGLQ2EGo1Ln7QpXjDwb589GDQ9H2aEXXw6ds6BFE",
      denylist: "8kfrkuzrLQgaFQYyRnK5oKtNr5vZy9vQ3Q21SAsHzjAp",
      messageTransmitter: "W1k5ijkaSTo5iA5zChNpfzcy796fLhkBxfmJuR8W8HU",
      tokenMessenger: "AawthJCGRmggpfv9MMWV6Jmo9cue4gL9wUZgRBShg58W",
      remoteTokenMessenger: "3WG7G3vPxz4a6bdBb9Xic2YL4QM84ru1YcVYskcweVHY",
      tokenMinter: "E1bQJ8eMMn3zmeSewW3HQ8zmJr7KR75JonbwAtWx2bux",
      localToken: "7MwmWTK2R9Na6rnoSAEt5gytFmSZj9WLVdazvxvru9AU",
      eventAuthority: "6TCCnJ9R1m1RXFzyoH7GYH2J6NJDtZaUvfipPuLWxHNd",
      mtEventAuthority: "2PcXTomVAbX5Es1NUZUkxwuCm8tvV4NmRk3fmQWFCWoV",
    });
    expect((await burnPdas("mainnet", OWNER)).localToken).toBe("CRBBbuLCyrkQy4dCTHxqstSmDQv4ajBeUVb9qUdMVaP1");
  });
  it("20 accounts in Circle's order and roles", async () => {
    const pdas = await burnPdas("testnet", OWNER);
    const ix = burnInstruction({ net: "testnet", owner: OWNER, ownerAta: "A37BHqE1TkVJVdFu5FGzYezD6vxgG5FNHa1dHsV6NU6M" as never, event, pdas, data: new Uint8Array(1) });
    const W = AccountRole.WRITABLE, R = AccountRole.READONLY, WS = AccountRole.WRITABLE_SIGNER;
    expect(ix.programAddress).toBe("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe");
    expect(ix.accounts.map((a) => [a.address, a.role])).toEqual([
      [OWNER, WS], [OWNER, WS], [pdas.senderAuthority, R], ["A37BHqE1TkVJVdFu5FGzYezD6vxgG5FNHa1dHsV6NU6M", W], [pdas.denylist, R],
      [pdas.messageTransmitter, W], [pdas.tokenMessenger, R], [pdas.remoteTokenMessenger, R], [pdas.tokenMinter, R], [pdas.localToken, W],
      ["4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", W], [event.address, WS],
      ["CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC", R], ["CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe", R],
      ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", R], ["11111111111111111111111111111111", R], [pdas.eventAuthority, R],
      ["CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe", R], [pdas.mtEventAuthority, R], ["CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC", R],
    ]);
  });
  it("compute-unit price: instruction 3 with a u64 LE price", () => {
    expect([...computeUnitPriceInstruction(5n).data!]).toEqual([3, 5, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("buildSolanaDeposit", () => {
  const build = (o: { priority?: bigint } = {}) =>
    buildSolanaDeposit({ net: "testnet", owner: owner.address, amount: 10_000_000n, maxFee: 244_578n, recipient: RECIPIENT, lifetime: LIFETIME, event, ...o });
  it("v0, the owner pays, one burn instruction; the event account has signed and the owner's slot is empty; it fits", async () => {
    const { tx, wire: bytes, lastValidBlockHeight, eventAddress } = await build();
    const m = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes));
    expect(m.version).toBe(0);
    expect(m.feePayer.address).toBe(owner.address);
    expect(m.instructions).toHaveLength(1);
    expect(m.instructions[0].data).toEqual(solanaBurnData("testnet", 10_000_000n, 244_578n, RECIPIENT));
    expect(((m.instructions[0].accounts ?? []) as readonly AccountMeta[]).length).toBe(20);
    expect(tx.signatures[owner.address]).toBeNull();
    expect(await verifySignature(event.keyPair.publicKey, tx.signatures[event.address]!, tx.messageBytes)).toBe(true);
    expect(bytes.length).toBeLessThanOrEqual(MAX_TX_BYTES);
    expect(lastValidBlockHeight).toBe(300_000_100n);
    expect(eventAddress).toBe(event.address);
  });
  it("a priority fee adds the compute-unit price first (SOLANA_PRIORITY_MICROLAMPORTS, SOL6)", async () => {
    const { tx } = await build({ priority: 1_000n });
    const m = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes));
    expect((m.instructions as readonly { programAddress: string }[]).map((i) => i.programAddress)).toEqual(["ComputeBudget111111111111111111111111111111", "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe"]);
  });
  it("without a given event keypair, a fresh one each time", async () => {
    const a = await buildSolanaDeposit({ net: "testnet", owner: owner.address, amount: 2_000_000n, maxFee: 1n, recipient: RECIPIENT, lifetime: LIFETIME });
    const b = await buildSolanaDeposit({ net: "testnet", owner: owner.address, amount: 2_000_000n, maxFee: 1n, recipient: RECIPIENT, lifetime: LIFETIME });
    expect(Object.keys(a.tx.signatures).sort()).not.toEqual(Object.keys(b.tx.signatures).sort());
    // eventAddress is the fresh signer's address (the second signer after the fee payer), and only an address
    for (const d of [a, b]) {
      expect(Object.keys(d.tx.signatures)).toEqual([owner.address, d.eventAddress]);
      expect(typeof d.eventAddress).toBe("string");
    }
    expect(a.eventAddress).not.toBe(b.eventAddress);
    expect(Object.keys(a).sort()).toEqual(["eventAddress", "lastValidBlockHeight", "tx", "wire"]);
  });
  it("refuses a depositor no wallet can sign for: the zero address, an off-curve address (a PDA), or not an address", async () => {
    // [P4 §2.1] the same owner check as the withdrawal: the denylist PDA and the devnet USDC token account are off-curve.
    for (const bad of ["11111111111111111111111111111111", "8kfrkuzrLQgaFQYyRnK5oKtNr5vZy9vQ3Q21SAsHzjAp", "A37BHqE1TkVJVdFu5FGzYezD6vxgG5FNHa1dHsV6NU6M", "nope"]) {
      await expect(buildSolanaDeposit({ net: "testnet", owner: bad as never, amount: 2_000_000n, maxFee: 1n, recipient: RECIPIENT, lifetime: LIFETIME, event })).rejects.toThrow(BAD_SOLANA_ADDRESS);
    }
  });
});

describe("checkWalletSigned [P4 §3 ruling 2, 5]", () => {
  it("the same message with every signature: accepted; the id is the owner's signature", async () => {
    const { tx } = await buildSolanaDeposit({ net: "testnet", owner: owner.address, amount: 10_000_000n, maxFee: 1n, recipient: RECIPIENT, lifetime: LIFETIME, event });
    const signed = await walletSigns(tx);
    const back = await checkWalletSigned(tx, wire(signed));
    expect(solanaTxId(back)).toBe(solanaTxId(signed));
    expect(await verifySignature(owner.keyPair.publicKey, back.signatures[owner.address]!, back.messageBytes)).toBe(true);
  });
  it("a wallet that changes the message (Lighthouse, another blockhash, …): refused, nothing to send", async () => {
    const { tx } = await buildSolanaDeposit({ net: "testnet", owner: owner.address, amount: 10_000_000n, maxFee: 1n, recipient: RECIPIENT, lifetime: LIFETIME, event });
    const other = await buildSolanaDeposit({ net: "testnet", owner: owner.address, amount: 10_000_000n, maxFee: 1n, recipient: RECIPIENT, lifetime: { ...LIFETIME, blockhash: blockhash("11111111111111111111111111111111") }, event });
    await expect(checkWalletSigned(tx, wire(other.tx))).rejects.toThrow(WalletChangedError);
  });
  it("a wallet that adds an instruction (as Lighthouse does): refused", async () => {
    const { tx } = await buildSolanaDeposit({ net: "testnet", owner: owner.address, amount: 10_000_000n, maxFee: 1n, recipient: RECIPIENT, lifetime: LIFETIME, event });
    const added = await buildSolanaDeposit({ net: "testnet", owner: owner.address, amount: 10_000_000n, maxFee: 1n, recipient: RECIPIENT, lifetime: LIFETIME, event, priority: 1n });
    await expect(checkWalletSigned(tx, wire(await walletSigns(added.tx)))).rejects.toThrow(/content differs/);
  });
  it("a missing owner signature, a changed event signature, or garbage: refused", async () => {
    const { tx } = await buildSolanaDeposit({ net: "testnet", owner: owner.address, amount: 10_000_000n, maxFee: 1n, recipient: RECIPIENT, lifetime: LIFETIME, event });
    await expect(checkWalletSigned(tx, wire(tx))).rejects.toThrow(/signature is missing/);
    const signed = await walletSigns(tx);
    const tampered = { ...signed, signatures: { ...signed.signatures, [event.address]: signed.signatures[owner.address] } } as Transaction;
    await expect(checkWalletSigned(tx, wire(tampered))).rejects.toThrow(/signature differs/);
    await expect(checkWalletSigned(tx, new Uint8Array([1, 2, 3]))).rejects.toThrow(WalletChangedError);
  });
  it("an owner signature that does not verify (another key, or garbage): refused before anything is recorded", async () => {
    const { tx } = await buildSolanaDeposit({ net: "testnet", owner: owner.address, amount: 10_000_000n, maxFee: 1n, recipient: RECIPIENT, lifetime: LIFETIME, event });
    const byEvent = { ...tx, signatures: { ...tx.signatures, [owner.address]: await signBytes(event.keyPair.privateKey, tx.messageBytes) } } as Transaction;
    await expect(checkWalletSigned(tx, wire(byEvent))).rejects.toThrow(/signature is not valid/);
    const garbage = { ...tx, signatures: { ...tx.signatures, [owner.address]: new Uint8Array(64).fill(5) } } as Transaction;
    await expect(checkWalletSigned(tx, wire(garbage))).rejects.toThrow(WalletChangedError);
  });
});
