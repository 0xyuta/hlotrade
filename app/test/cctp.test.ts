import { describe, expect, it } from "vitest";
import { HYPEREVM_DOMAIN, ROUTE_ADDRESSES } from "../src/routes/addresses";
import { burnArgs, CCTP_FORWARD_MAGIC, hyperCoreHook, toBytes32 } from "../src/routes/cctp";

const USER = "0x1234567890abcdef1234567890abcdef12345678";

describe("hyperCoreHook [R §2.5]", () => {
  it("is 56 bytes: magic, version 0, length 24, recipient, dex", () => {
    const h = hyperCoreHook(USER, 0);
    expect((h.length - 2) / 2).toBe(56);
    expect(h).toBe(`${CCTP_FORWARD_MAGIC}000000000000001812345678` + "90abcdef1234567890abcdef12345678" + "00000000");
  });
  it("encodes spot as 0xffffffff", () => {
    expect(hyperCoreHook(USER, 0xffffffff).endsWith("ffffffff")).toBe(true);
  });
});

describe("burnArgs: mintRecipient and destinationCaller are the CctpForwarder (funds are lost otherwise)", () => {
  for (const net of ["mainnet", "testnet"] as const) {
    for (const src of ["arbitrum", "ethereum"] as const) {
      it(`${net} ${src}`, () => {
        const [amount, domain, mintRecipient, burnToken, destinationCaller, maxFee, finality, hook] = burnArgs(net, src, 10_000_000n, 242_300n, USER);
        const fwd = toBytes32(ROUTE_ADDRESSES[net].cctpForwarder).toLowerCase();
        expect(amount).toBe(10_000_000n);
        expect(domain).toBe(19);
        expect(mintRecipient.toLowerCase()).toBe(fwd);
        expect(destinationCaller.toLowerCase()).toBe(fwd);
        expect(burnToken).toBe(ROUTE_ADDRESSES[net][src].usdc);
        expect(maxFee).toBe(242_300n);
        expect(finality).toBe(1000);
        expect(hook).toBe(hyperCoreHook(USER, 0));
      });
    }
  }
  it("pins the forwarder addresses from the research", () => {
    expect(toBytes32(ROUTE_ADDRESSES.mainnet.cctpForwarder).toLowerCase()).toBe("0x000000000000000000000000b21d281dedb17ae5b501f6aa8256fe38c4e45757");
    expect(toBytes32(ROUTE_ADDRESSES.testnet.cctpForwarder).toLowerCase()).toBe("0x00000000000000000000000002e39ecb8368b41bf68ff99ff351ac9864e5e2a2");
  });
});

describe("burnArgs rejects a recipient that is not a 20-byte address (review M5)", () => {
  for (const bad of ["0x1234", "0x1234567890abcdef1234567890abcdef1234567800", "1234567890abcdef1234567890abcdef12345678", "0xzz34567890abcdef1234567890abcdef12345678", ""]) {
    it(JSON.stringify(bad), () => {
      expect(() => burnArgs("mainnet", "arbitrum", 10_000_000n, 1n, bad as `0x${string}`)).toThrow();
      expect(() => hyperCoreHook(bad as `0x${string}`)).toThrow();
    });
  }
});

describe("addresses are pinned to literals from the research (review M6)", () => {
  it("mainnet [R §4.1, §5.2, §6.2]", () => {
    const m = ROUTE_ADDRESSES.mainnet;
    expect(m.hyperEvm).toEqual({ chainId: 999, usdc: "0xb88339CB7199b77E23DB6E890353E22632Ba630f", coreDepositWallet: "0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24" });
    expect(m.arbitrum).toMatchObject({ chainId: 42161, usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", tokenMessengerV2: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d" });
    expect(m.ethereum).toMatchObject({ chainId: 1, usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", tokenMessengerV2: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d" });
  });
  it("testnet [R §4.1, §5.2, §6.2, §8]", () => {
    const t = ROUTE_ADDRESSES.testnet;
    expect(t.hyperEvm).toEqual({ chainId: 998, usdc: "0x2B3370eE501B4a559b57D449569354196457D8Ab", coreDepositWallet: "0x0B80659a4076E9E93C7DbE0f10675A16a3e5C206" });
    expect(t.arbitrum).toMatchObject({ chainId: 421614, usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", tokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" });
    expect(t.ethereum).toMatchObject({ chainId: 11155111, usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", tokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" });
  });
});

describe("CCTP domain ids [R §2.5]: Ethereum 0, Arbitrum 3, HyperEVM 19 (Task 13 reads them from here)", () => {
  it("are the same on mainnet and testnet", () => {
    for (const net of ["mainnet", "testnet"] as const) {
      expect(ROUTE_ADDRESSES[net].ethereum.domain).toBe(0);
      expect(ROUTE_ADDRESSES[net].arbitrum.domain).toBe(3);
    }
    expect(HYPEREVM_DOMAIN).toBe(19);
  });
});
