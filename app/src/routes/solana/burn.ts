import {
  AccountRole, appendTransactionMessageInstructions, createTransactionMessage, generateKeyPairSigner, getAddressEncoder,
  getProgramDerivedAddress, getPublicKeyFromAddress, getSignatureFromTransaction, getTransactionDecoder, getTransactionEncoder,
  partiallySignTransactionMessageWithSigners, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  type AccountMeta, type AccountSignerMeta, type Address as SolAddress, type Blockhash, type Instruction, type SignatureBytes,
  type Transaction, type TransactionSigner, verifySignature,
} from "@solana/kit";
import { hexToBytes } from "viem";
import type { Address, Network } from "../../config/validate";
import { HYPEREVM_DOMAIN, ROUTE_ADDRESSES } from "../addresses";
import { FAST_FINALITY, hyperCoreHook, toBytes32 } from "../cctp";
import { solanaOwner, usdcAta } from "./ata";
import {
  COMPUTE_BUDGET_PROGRAM, DEPOSIT_FOR_BURN_WITH_HOOK, MESSAGE_TRANSMITTER_V2, SOLANA_PRIORITY_MICROLAMPORTS, SOLANA_USDC, SYSTEM_PROGRAM,
  TOKEN_MESSENGER_MINTER_V2, TOKEN_PROGRAM,
} from "./constants";

/** [P4 §1] Solana's limit on a serialized transaction. */
export const MAX_TX_BYTES = 1232;
/** [P4 §1; CIRCLE-SOL-IDL] amount and max_fee are u64: DataView.setBigUint64 would silently wrap anything larger. */
const U64_MAX = 2n ** 64n - 1n;

/**
 * [P4 §1; CIRCLE-SOL-IDL] deposit_for_burn_with_hook data (Borsh): discriminator(8) ‖ amount u64 ‖ destination_domain u32
 * ‖ mint_recipient(32) ‖ destination_caller(32) ‖ max_fee u64 ‖ min_finality_threshold u32 ‖ hook_data (u32 length ‖ bytes),
 * all little-endian. mint_recipient and destination_caller are both the CctpForwarder on HyperEVM, as on the EVM routes:
 * any other value loses the funds [P4 §1; C-H-SOL]. The hook is the EVM routes' 56-byte hyperCoreHook, byte for byte
 * [P4 §1]. Built only from constants and the user's HyperCore address.
 */
export function solanaBurnData(net: Network, amount: bigint, maxFee: bigint, recipient: Address): Uint8Array {
  if (amount > U64_MAX || maxFee > U64_MAX) throw new Error("The amount is too large.");
  if (amount <= 0n || maxFee < 0n || maxFee >= amount) throw new Error("The amount must be above the fee.");
  const forwarder = hexToBytes(toBytes32(ROUTE_ADDRESSES[net].cctpForwarder));
  const hook = hexToBytes(hyperCoreHook(recipient)); // 56 bytes; throws on a bad recipient
  const out = new Uint8Array(8 + 8 + 4 + 32 + 32 + 8 + 4 + 4 + hook.length);
  const dv = new DataView(out.buffer);
  let o = 0;
  out.set(DEPOSIT_FOR_BURN_WITH_HOOK, o); o += 8;
  dv.setBigUint64(o, amount, true); o += 8;
  dv.setUint32(o, HYPEREVM_DOMAIN, true); o += 4;
  out.set(forwarder, o); o += 32; // mint_recipient
  out.set(forwarder, o); o += 32; // destination_caller
  dv.setBigUint64(o, maxFee, true); o += 8;
  dv.setUint32(o, FAST_FINALITY, true); o += 4;
  dv.setUint32(o, hook.length, true); o += 4;
  out.set(hook, o);
  return out;
}

export interface BurnPdas {
  senderAuthority: SolAddress;
  denylist: SolAddress;
  messageTransmitter: SolAddress;
  tokenMessenger: SolAddress;
  remoteTokenMessenger: SolAddress;
  tokenMinter: SolAddress;
  localToken: SolAddress;
  eventAuthority: SolAddress;
  mtEventAuthority: SolAddress;
}

const pda = async (program: SolAddress, ...seeds: (string | Uint8Array)[]) => (await getProgramDerivedAddress({ programAddress: program, seeds })).at(0) as SolAddress;

/** [P4 §1] The program-derived accounts of a burn (seeds per the research table); the pinned devnet table is the test vector. */
export async function burnPdas(net: Network, owner: SolAddress): Promise<BurnPdas> {
  const enc = getAddressEncoder();
  return {
    senderAuthority: await pda(TOKEN_MESSENGER_MINTER_V2, "sender_authority"),
    denylist: await pda(TOKEN_MESSENGER_MINTER_V2, "denylist_account", enc.encode(owner) as Uint8Array),
    messageTransmitter: await pda(MESSAGE_TRANSMITTER_V2, "message_transmitter"),
    tokenMessenger: await pda(TOKEN_MESSENGER_MINTER_V2, "token_messenger"),
    remoteTokenMessenger: await pda(TOKEN_MESSENGER_MINTER_V2, "remote_token_messenger", String(HYPEREVM_DOMAIN)),
    tokenMinter: await pda(TOKEN_MESSENGER_MINTER_V2, "token_minter"),
    localToken: await pda(TOKEN_MESSENGER_MINTER_V2, "local_token", enc.encode(SOLANA_USDC[net]) as Uint8Array),
    eventAuthority: await pda(TOKEN_MESSENGER_MINTER_V2, "__event_authority"),
    mtEventAuthority: await pda(MESSAGE_TRANSMITTER_V2, "__event_authority"),
  };
}

/**
 * [P4 §1; C-SOLQS] The 20 accounts in Circle's order: the IDL's 18, then MessageTransmitter's event authority and program.
 * The owner pays the event account's rent and signs; the fresh event account signs for its own creation.
 */
export function burnInstruction(o: { net: Network; owner: SolAddress; ownerAta: SolAddress; event: TransactionSigner; pdas: BurnPdas; data: Uint8Array }): Instruction & { accounts: readonly (AccountMeta | AccountSignerMeta)[] } {
  const p = o.pdas;
  const ro = (address: SolAddress): AccountMeta => ({ address, role: AccountRole.READONLY });
  const w = (address: SolAddress): AccountMeta => ({ address, role: AccountRole.WRITABLE });
  const accounts: (AccountMeta | AccountSignerMeta)[] = [
    { address: o.owner, role: AccountRole.WRITABLE_SIGNER }, // owner
    { address: o.owner, role: AccountRole.WRITABLE_SIGNER }, // event_rent_payer
    ro(p.senderAuthority),
    w(o.ownerAta), // burn_token_account
    ro(p.denylist),
    w(p.messageTransmitter),
    ro(p.tokenMessenger),
    ro(p.remoteTokenMessenger),
    ro(p.tokenMinter),
    w(p.localToken),
    w(SOLANA_USDC[o.net]), // burn_token_mint
    { address: o.event.address, role: AccountRole.WRITABLE_SIGNER, signer: o.event }, // message_sent_event_data
    ro(MESSAGE_TRANSMITTER_V2),
    ro(TOKEN_MESSENGER_MINTER_V2),
    ro(TOKEN_PROGRAM),
    ro(SYSTEM_PROGRAM),
    ro(p.eventAuthority),
    ro(TOKEN_MESSENGER_MINTER_V2), // program (Anchor events)
    ro(p.mtEventAuthority),
    ro(MESSAGE_TRANSMITTER_V2),
  ];
  return { programAddress: TOKEN_MESSENGER_MINTER_V2, accounts, data: o.data };
}

/** [P4 §1] ComputeBudget SetComputeUnitPrice (instruction 3, u64 micro-lamports per compute unit). */
export function computeUnitPriceInstruction(microLamports: bigint): Instruction {
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, microLamports, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data };
}

export interface SolanaDepositTx {
  /** Signed by the event account only; the owner's (fee payer's) signature slot is empty. */
  tx: Transaction;
  /** Wire bytes handed to the wallet. */
  wire: Uint8Array;
  lastValidBlockHeight: bigint;
  /**
   * The fresh message_sent_event_data account (its address only; the key never leaves buildSolanaDeposit). It exists on
   * chain only if this burn landed, so an unconfirmed deposit is settled by reading it [P4 §1 "Event account rent"].
   */
  eventAddress: SolAddress;
}

/**
 * Builds the deposit: a version-0 transaction, fee payer = owner, the burn (and, if SOLANA_PRIORITY_MICROLAMPORTS > 0,
 * a compute-unit price first), partially signed by a fresh event keypair that is never stored, logged or returned: only
 * its signature leaves this function [P4 §1, §3 ruling 1]. The owner passes the same check as a withdrawal's [P4 §2.1].
 */
export async function buildSolanaDeposit(o: {
  net: Network; owner: SolAddress; amount: bigint; maxFee: bigint; recipient: Address;
  lifetime: { blockhash: Blockhash; lastValidBlockHeight: bigint }; event?: TransactionSigner; priority?: bigint;
}): Promise<SolanaDepositTx> {
  const owner = solanaOwner(o.owner);
  const data = solanaBurnData(o.net, o.amount, o.maxFee, o.recipient);
  const event = o.event ?? (await generateKeyPairSigner());
  const [ownerAta, pdas] = await Promise.all([usdcAta(o.net, owner), burnPdas(o.net, owner)]);
  const priority = o.priority ?? SOLANA_PRIORITY_MICROLAMPORTS;
  const ixs: Instruction[] = [...(priority > 0n ? [computeUnitPriceInstruction(priority)] : []), burnInstruction({ net: o.net, owner, ownerAta, event, pdas, data })];
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(o.lifetime, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const tx = await partiallySignTransactionMessageWithSigners(msg);
  const wire = Uint8Array.from(getTransactionEncoder().encode(tx));
  if (wire.length > MAX_TX_BYTES) throw new Error("The Solana transaction is too large.");
  return { tx, wire, lastValidBlockHeight: o.lifetime.lastValidBlockHeight, eventAddress: event.address };
}

export class WalletChangedError extends Error {
  constructor(what: string) {
    super(`The wallet changed the transaction (${what}), so it was not sent. Nothing moved.`);
    this.name = "WalletChangedError";
  }
}

const same = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/**
 * [P4 §3 ruling 2, 5] What came back from solana:signTransaction must be the transaction the app built, with every
 * signature present, the event account's signature untouched, and every signature valid for its signer over the
 * message. Otherwise nothing is sent (WalletChangedError): a transaction that could never land is never recorded.
 */
export async function checkWalletSigned(sent: Transaction, bytes: Uint8Array): Promise<Transaction> {
  let back: Transaction;
  try {
    back = getTransactionDecoder().decode(bytes);
  } catch {
    throw new WalletChangedError("unreadable");
  }
  if (!same(back.messageBytes, sent.messageBytes)) throw new WalletChangedError("its content differs");
  const want = Object.keys(sent.signatures).sort();
  if (Object.keys(back.signatures).sort().join() !== want.join()) throw new WalletChangedError("its signers differ");
  for (const k of want as SolAddress[]) {
    const got = back.signatures[k];
    const mine = sent.signatures[k] as SignatureBytes | null;
    if (!got) throw new WalletChangedError("a signature is missing");
    if (mine && !same(got, mine)) throw new WalletChangedError("a signature differs");
    if (!mine && !(await verifySignature(await getPublicKeyFromAddress(k), got, back.messageBytes))) throw new WalletChangedError("a signature is not valid");
  }
  return back;
}

/** [P4 §3 ruling 2] The transaction id: the fee payer's signature, base58. Known before the transaction is broadcast. */
export const solanaTxId = (tx: Transaction): string => getSignatureFromTransaction(tx);
