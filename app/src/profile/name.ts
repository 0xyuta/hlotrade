/** Profiles.setName: 3–16 bytes, each a-z, 0-9 or _ (contracts/src/Profiles.sol). */
export function validateName(s: string): string | null {
  // Charset first: any non-ASCII character is refused by the contract, and "use only a–z…" is the useful message for it.
  // After this check every character is one byte, so s.length is the contract's byte length.
  if (!/^[a-z0-9_]*$/.test(s)) return "Use only a–z, 0–9 and _.";
  if (s.length < 3 || s.length > 16) return "Use 3 to 16 characters.";
  return null;
}
