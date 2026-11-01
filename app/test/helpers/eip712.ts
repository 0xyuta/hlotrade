import { concat, keccak256, numberToHex, pad, stringToBytes, type Hex } from "viem";

// An EIP-712 encoder written here, from the spec, using only keccak256: it shares no code with viem's typed-data
// validation or with the signer under test, so it can pin the bytes that a wallet will sign.
export type Field = { name: string; type: string };
function encodeValue(type: string, v: unknown): Hex {
  if (type === "string") return keccak256(stringToBytes(v as string));
  if (type === "bytes") return keccak256(v as Hex);
  if (type === "address") return pad(v as Hex, { size: 32 });
  if (/^uint\d+$/.test(type)) return numberToHex(BigInt(v as number | bigint), { size: 32 });
  throw new Error(`unsupported ${type}`);
}
export const encodeType = (name: string, fields: readonly Field[]) => `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
function hashStruct(name: string, fields: readonly Field[], value: Record<string, unknown>): Hex {
  return keccak256(concat([keccak256(stringToBytes(encodeType(name, fields))), ...fields.map((f) => encodeValue(f.type, value[f.name]))]));
}
export function digestOf(t: { domain: Record<string, unknown>; types: Record<string, readonly Field[]>; primaryType: string; message: Record<string, unknown> }): Hex {
  const domainSep = hashStruct("EIP712Domain", t.types.EIP712Domain, t.domain);
  const msg = hashStruct(t.primaryType, t.types[t.primaryType], t.message);
  return keccak256(concat(["0x1901", domainSep, msg]));
}
