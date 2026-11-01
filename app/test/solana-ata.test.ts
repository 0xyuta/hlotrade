import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { bytesToHex } from "viem";
import { describe, expect, it } from "vitest";
import { usdcAta } from "../src/routes/solana/ata";
import { MESSAGE_TRANSMITTER_V2, SOLANA_SIGN_PREFERENCE, SOLANA_USDC, SOLANA_WITHDRAW_HOOK_LAYOUT, SOLANA_PRIORITY_MICROLAMPORTS, TOKEN_MESSENGER_MINTER_V2 } from "../src/routes/solana/constants";
import { solanaAtaHook } from "../src/routes/solana/hook";

// [P4 §2.1] a real mainnet owner whose USDC account was checked on chain on 2026-10-28
const OWNER = address("5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9");
const OWNER_HEX = "48c01b5059005455d9dcb0c6bcecdcb4fb5b2eabc1a9a82b57392baaa40f04e6";

describe("Solana constants [P4 §1, §5]", () => {
  it("program ids and mints", () => {
    expect(TOKEN_MESSENGER_MINTER_V2).toBe("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe");
    expect(MESSAGE_TRANSMITTER_V2).toBe("CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC");
    expect(SOLANA_USDC).toEqual({ mainnet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", testnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" });
  });
  it("the UNCONFIRMED switches start where the research rules (SOL1, SOL2, SOL6)", () => {
    expect(SOLANA_WITHDRAW_HOOK_LAYOUT).toBe("withdraw-howto-57");
    expect(SOLANA_SIGN_PREFERENCE).toBe("sign");
    expect(SOLANA_PRIORITY_MICROLAMPORTS).toBe(0n);
  });
});

describe("usdcAta [P4 §2.1]", () => {
  it("mainnet: the account checked on chain", async () => {
    expect(await usdcAta("mainnet", OWNER)).toBe("FzbcyEZ9m8xjtergWgWDq7mfPoHEbboBF791B6cTpzbq");
  });
  it("testnet builds use the devnet mint", async () => {
    expect(await usdcAta("testnet", OWNER)).toBe("A37BHqE1TkVJVdFu5FGzYezD6vxgG5FNHa1dHsV6NU6M");
  });
  it("the owner's bytes are the pinned ones", () => {
    expect(bytesToHex(Uint8Array.from(getAddressEncoder().encode(OWNER)))).toBe(`0x${OWNER_HEX}`);
  });
  it("the denylist PDA for the same owner matches the research (checks the seed encoding used by burn.ts)", async () => {
    const [pda] = await getProgramDerivedAddress({ programAddress: TOKEN_MESSENGER_MINTER_V2, seeds: ["denylist_account", getAddressEncoder().encode(OWNER)] });
    expect(pda).toBe("8kfrkuzrLQgaFQYyRnK5oKtNr5vZy9vQ3Q21SAsHzjAp");
  });
});

describe("solanaAtaHook [P4 §2.1]", () => {
  it("withdraw-howto-57 (the default): magic ‖ 01 ‖ owner", () => {
    expect(solanaAtaHook(OWNER)).toBe(`0x636374702d666f72776172640000000000000000000000000148c01b5059005455d9dcb0c6bcecdcb4fb5b2eabc1a9a82b57392baaa40f04e6`);
    expect(solanaAtaHook(OWNER, "withdraw-howto-57")).toBe(solanaAtaHook(OWNER));
  });
  it("forwarding-v0-65 (the alternative): magic ‖ u32 0 ‖ u32 33 ‖ 01 ‖ owner", () => {
    expect(solanaAtaHook(OWNER, "forwarding-v0-65")).toBe(
      `0x636374702d666f727761726400000000000000000000000000000000000000210148c01b5059005455d9dcb0c6bcecdcb4fb5b2eabc1a9a82b57392baaa40f04e6`,
    );
  });
  it("a layout it does not know is refused, never built as one of the others (Task 11-12 review minor)", () => {
    expect(() => solanaAtaHook(OWNER, "forwarding-v1" as never)).toThrow(/Unknown Solana withdraw data layout/);
  });
});
