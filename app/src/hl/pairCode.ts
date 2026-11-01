import { concat, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Network } from "../config/validate";

/**
 * The text of the computer's second QR (Plan 4 ruling 3). Words and spaces, no scheme: no phone opens it as a link,
 * so the key never lands in a browser history. The phone reads it in-page (ui/pair) or the user types the hex part.
 */
export const PAIR_CODE_PREFIX = "hlo pairing code";
/** 64 hex of key + 4 hex of checksum. */
export const PAIR_CODE_HEX_LENGTH = 68;
export const NOT_A_CODE = "That is not an HLO pairing code. Scan the second code your computer shows after you approve the phone.";

/** 2 bytes of keccak256("hlo pair" ‖ key): a random typo slips through 1 time in 65,536. */
export const pairChecksum = (key: Hex): string => keccak256(concat([toHex("hlo pair"), key])).slice(2, 6);
export const pairCodeHex = (key: Hex): string => key.slice(2).toLowerCase() + pairChecksum(key);
export const pairQrText = (net: Network, key: Hex): string => `${PAIR_CODE_PREFIX} ${net} ${pairCodeHex(key)}`;
/** For typing on the phone: 17 groups of 4. */
export const groupPairCode = (hex: string): string[] => hex.match(/.{1,4}/g) ?? [];

/**
 * `discard`: the text is a whole code that can never pair here (another network's, or not a valid key), so the typed
 * field drops it rather than keep a usable key on screen. A typo or a short code is kept for correcting.
 */
export type ParsedPairCode = { ok: true; key: Hex; agent: Address } | { ok: false; reason: string; discard?: true };

/** The QR text, or the typed 68 characters (spaces, dashes and capitals are ignored). */
export function parsePairCode(text: string, net: Network): ParsedPairCode {
  let body = text.trim().toLowerCase();
  if (body.startsWith(PAIR_CODE_PREFIX)) {
    const rest = body.slice(PAIR_CODE_PREFIX.length).trim().split(/\s+/);
    if (rest.length !== 2 || (rest[0] !== "mainnet" && rest[0] !== "testnet")) return { ok: false, reason: NOT_A_CODE };
    if (rest[0] !== net) return { ok: false, reason: `This code is for ${rest[0]}, but this is the ${net} app.`, discard: true };
    body = rest[1];
  } else {
    body = body.replace(/[\s-]/g, "");
  }
  if (!/^[0-9a-f]+$/.test(body)) return { ok: false, reason: NOT_A_CODE };
  if (body.length !== PAIR_CODE_HEX_LENGTH) {
    return { ok: false, reason: `The code has ${PAIR_CODE_HEX_LENGTH} characters; this has ${body.length}. Check it and try again.` };
  }
  const key = `0x${body.slice(0, 64)}` as Hex;
  if (body.slice(64) !== pairChecksum(key)) {
    return { ok: false, reason: "That code has a typo: its last 4 characters do not match. Check it against your computer and try again." };
  }
  try {
    return { ok: true, key, agent: privateKeyToAccount(key).address }; // viem refuses 0 and keys at or above the curve order
  } catch {
    return { ok: false, reason: "That code is not a valid key. Show a new code on your computer.", discard: true };
  }
}
