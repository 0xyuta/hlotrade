/**
 * Pins hl.ts signing to hyperliquid-python-sdk's own test vectors (tests/signing_test.py),
 * ported from the legacy relayer test: a wrong msgpack byte or EIP-712 field would make the
 * API recover a different address, i.e. act as someone else.
 */
import { concat, encodeAbiParameters, hashDomain, hashTypedData, keccak256, parseSignature, recoverAddress, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actionHash, claimRewards, decimalTo1e6, format1e6, MAINNET, usdClassTransfer, signL1Action, signUserAction, TESTNET,
  USD_CLASS_TRANSFER_FIELDS, USDC_SYSTEM_ADDRESS, builderRewardsUnits, maxBuilderFee, perpCoins, userFillsByTime,
} from "../src/hl.js";

const wallet = privateKeyToAccount("0x0123456789012345678901234567890123456789012345678901234567890123");

function parts(sig: Hex) {
  const p = parseSignature(sig);
  return { r: BigInt(p.r), s: BigInt(p.s), v: Number(p.v ?? 27n + BigInt(p.yParity ?? 0)) };
}

describe("signing vectors (hyperliquid-python-sdk tests/signing_test.py)", () => {
  it("L1 action, testnet (test_l1_action_signing_matches)", async () => {
    // num = float_to_int_for_hashing(1000)
    const sig = await signL1Action(wallet, { type: "dummy", num: 100_000_000_000 }, 0, TESTNET);
    expect(parts(sig)).toEqual({
      r: BigInt("0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510"),
      s: BigInt("0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613"),
      v: 28,
    });
  });

  it("L1 action, mainnet (phantom source a)", async () => {
    const sig = await signL1Action(wallet, { type: "dummy", num: 100_000_000_000 }, 0, MAINNET);
    expect(parts(sig)).toEqual({
      r: BigInt("0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298"),
      s: BigInt("0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8"),
      v: 27,
    });
  });

  it("user-signed UsdSend, testnet (test_sign_usd_transfer_action)", async () => {
    const sig = await signUserAction(
      wallet,
      "HyperliquidTransaction:UsdSend",
      [
        { name: "hyperliquidChain", type: "string" },
        { name: "destination", type: "string" },
        { name: "amount", type: "string" },
        { name: "time", type: "uint64" },
      ],
      { hyperliquidChain: "Testnet", destination: "0x5e9ee1089755c3435139848e47e6635505d5a13a", amount: "1", time: 1687816341423n },
    );
    expect(parts(sig)).toEqual({
      r: BigInt("0x637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073"),
      s: BigInt("0x11a6a24900e6e314136d2592e2f8d502cd89b7c15b198e1bee043c9589f9fad7"),
      v: 27,
    });
  });
});

describe("amount helpers", () => {
  it("decimal → 1e6", () => expect(decimalTo1e6("12.5")).toBe(12_500_000n));
  it("decimal → 1e6 truncates past 6 dp", () => expect(decimalTo1e6("0.12345678")).toBe(123_456n));
  it("1e6 → decimal", () => expect(format1e6(12_500_000n)).toBe("12.5"));
  it("1e6 → decimal (integer)", () => expect(format1e6(10_000_000n)).toBe("10"));
});

describe("forwarder additions", () => {
  it("USDC system address is the HyperCore → HyperEVM bridge for token 0", () => {
    expect(USDC_SYSTEM_ADDRESS).toBe("0x2000000000000000000000000000000000000000");
  });

  it("usdClassTransfer fields are the SDK's USD_CLASS_TRANSFER_SIGN_TYPES, in order", () => {
    expect(USD_CLASS_TRANSFER_FIELDS).toEqual([
      { name: "hyperliquidChain", type: "string" },
      { name: "amount", type: "string" },
      { name: "toPerp", type: "bool" },
      { name: "nonce", type: "uint64" },
    ]);
  });

  it("claimRewards action hash: msgpack of the one-key map {type:claimRewards}", () => {
    // 0x81 fixmap(1) | 0xa4 "type" | 0xac "claimRewards" (12 bytes) ‖ nonce u64be ‖ 0x00 (no vault)
    const bytes = new Uint8Array([
      0x81, 0xa4, 0x74, 0x79, 0x70, 0x65, 0xac, 0x63, 0x6c, 0x61, 0x69, 0x6d, 0x52, 0x65, 0x77, 0x61, 0x72, 0x64, 0x73,
      0, 0, 0, 0, 0, 0, 0, 0, 0x00,
    ]);
    expect(actionHash({ type: "claimRewards" }, 0)).toBe(keccak256(bytes));
    expect(actionHash({ type: "claimRewards" }, 0)).toBe(PINNED_CLAIM_HASH);
  });

  // No SDK-published vector exists for usd_class_transfer (the SDK has no test for it), so this
  // is a regression pin of our own output for a fixed message, not an SDK vector.
  it("usdClassTransfer signature is stable (self-computed pin, not an SDK vector)", async () => {
    const sig = await signUserAction(wallet, "HyperliquidTransaction:UsdClassTransfer", USD_CLASS_TRANSFER_FIELDS, {
      hyperliquidChain: "Testnet", amount: "1.5", toPerp: false, nonce: 1687816341423n,
    });
    expect(sig).toBe(PINNED_USD_CLASS_SIG);
  });
});

describe("decimalTo1e6 input checks", () => {
  it("throws on a negative amount", () => {
    expect(() => decimalTo1e6("-1")).toThrow("negative amount");
    expect(() => decimalTo1e6("-0.5")).toThrow("negative amount");
  });
});

/** Mocks fetch, runs `fn`, returns the single POST it made (url, init, parsed body). */
async function capturePost(fn: () => Promise<unknown>) {
  const real = globalThis.fetch;
  const seen: { url: string; init: RequestInit; body: any }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ status: "ok", response: { type: "default" } }), { status: 200 });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
  expect(seen).toHaveLength(1);
  return seen[0];
}

describe("exchange wrappers post what they signed", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("every HL request carries a timeout signal", async () => {
    const r = await capturePost(() => claimRewards(wallet, TESTNET));
    expect(r.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("usdClassTransfer: posted action, nonce and signer", async () => {
    const r = await capturePost(() => usdClassTransfer(wallet, 12_500_000n, false, TESTNET));
    expect(r.url).toBe("https://api.hyperliquid-testnet.xyz/exchange");
    const a = r.body.action;
    expect(a).toMatchObject({ type: "usdClassTransfer", amount: "12.5", toPerp: false, hyperliquidChain: "Testnet", signatureChainId: "0x66eee" });
    expect(r.body.nonce).toBe(a.nonce);
    // Independent EIP-712 encoding of the POSTED fields (abi-encode, not the hl.ts helper).
    const typeHash = keccak256(toHex("HyperliquidTransaction:UsdClassTransfer(string hyperliquidChain,string amount,bool toPerp,uint64 nonce)"));
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bool" }, { type: "uint64" }],
        [typeHash, keccak256(toHex(a.hyperliquidChain)), keccak256(toHex(a.amount)), a.toPerp, BigInt(a.nonce)],
      ),
    );
    const domainSeparator = hashDomain({
      domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 0x66eee, verifyingContract: "0x0000000000000000000000000000000000000000" },
      types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] },
    } as never);
    const digest = keccak256(concat(["0x1901", domainSeparator, structHash]));
    const signer = await recoverAddress({ hash: digest, signature: { r: r.body.signature.r, s: r.body.signature.s, v: BigInt(r.body.signature.v) } });
    expect(signer).toBe(wallet.address);
  });

  it("claimRewards: posted action, nonce and signer", async () => {
    const r = await capturePost(() => claimRewards(wallet, TESTNET));
    expect(r.body.action).toEqual({ type: "claimRewards" });
    const digest = hashTypedData({
      domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" },
      types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
      primaryType: "Agent",
      message: { source: "b", connectionId: actionHash(r.body.action, r.body.nonce) },
    });
    const signer = await recoverAddress({ hash: digest, signature: { r: r.body.signature.r, s: r.body.signature.s, v: BigInt(r.body.signature.v) } });
    expect(signer).toBe(wallet.address);
  });
});

const PINNED_CLAIM_HASH: Hex = "0x9de9c67559ad58bcefe9c86c2639a73854d227157895fd9a33c59d38240d04a7";
const PINNED_USD_CLASS_SIG: Hex = "0xcdd8bb1c23606d65106f6ce0363b7c06b4a236edef8ab07bb7e1dbb440ebe23c54d1e46bb9fada4d32747bcc35bda504c0ae8d7623354f7fd1a2df5517d927601c";

describe("userFillsByTime / maxBuilderFee / perpCoins / builderRewardsUnits", () => {
  const user = "0x00000000000000000000000000000000000000aa" as const;
  const fill = (tid: number, time: number) => ({ tid, time, coin: "BTC", px: "100", sz: "1", builderFee: "0.1" });
  const fake = (replies: unknown[]) => {
    const bodies: any[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const r = replies.shift();
      return r && typeof r === "object" && "httpStatus" in r ? new Response("boom", { status: (r as { httpStatus: number }).httpStatus }) : new Response(JSON.stringify(r));
    }) as unknown as typeof fetch;
    return { bodies, fetchFn };
  };

  it("sends the userFillsByTime request with aggregateByTime false", async () => {
    const { bodies, fetchFn } = fake([[fill(1, 5)]]);
    const out = await userFillsByTime(user, 10, 20, TESTNET, fetchFn);
    expect(bodies).toEqual([{ type: "userFillsByTime", user, startTime: 10, endTime: 20, aggregateByTime: false }]);
    expect(out).toHaveLength(1);
  });
  // A fake server that honors startTime/endTime like Hyperliquid: oldest first, capped at 2000.
  const server = (all: ReturnType<typeof fill>[]) => {
    const bodies: any[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      bodies.push(b);
      const page = all.filter((f) => f.time >= b.startTime && f.time <= b.endTime).sort((x, y) => x.time - y.time || x.tid - y.tid).slice(0, 2000);
      return new Response(JSON.stringify(page));
    }) as unknown as typeof fetch;
    return { bodies, fetchFn };
  };
  it("pages from the newest fill's time, losing none of the fills that share the boundary millisecond and duplicating none", async () => {
    // 1990 fills at distinct ms, then 20 at ms 3000: only 10 of those fit in page one.
    const all = [...Array.from({ length: 1990 }, (_, i) => fill(i, 1000 + i)), ...Array.from({ length: 20 }, (_, i) => fill(5000 + i, 3000)), fill(9000, 3500)];
    const { bodies, fetchFn } = server(all);
    const out = await userFillsByTime(user, 1000, 9000, TESTNET, fetchFn);
    expect(bodies.map((b) => b.startTime)).toEqual([1000, 3000]);
    expect(out.map((f) => f.tid).sort((a, b) => a - b)).toEqual(all.map((f) => f.tid).sort((a, b) => a - b));
  });
  it("throws when a full page cannot advance (2000 fills in one millisecond)", async () => {
    const all = Array.from({ length: 2001 }, (_, i) => fill(i, 1000));
    await expect(userFillsByTime(user, 1000, 9000, TESTNET, server(all).fetchFn)).rejects.toThrow(/cannot page/);
  });
  it("throws on HTTP 500", async () => {
    const { fetchFn } = fake([{ httpStatus: 500 }]);
    await expect(userFillsByTime(user, 0, 1, TESTNET, fetchFn)).rejects.toThrow(/500/);
  });
  it("retries an HTTP 429 with backoff (2 s, 4 s, 8 s) and then succeeds", async () => {
    const { bodies, fetchFn } = fake([{ httpStatus: 429 }, { httpStatus: 429 }, [fill(1, 5)]]);
    const waits: number[] = [];
    const out = await userFillsByTime(user, 10, 20, TESTNET, fetchFn, async (ms) => void waits.push(ms));
    expect(out).toHaveLength(1);
    expect(bodies).toHaveLength(3);
    expect(waits).toEqual([2000, 4000]);
  });
  it("throws after the third retry of a 429 (four requests in all)", async () => {
    const { bodies, fetchFn } = fake([{ httpStatus: 429 }, { httpStatus: 429 }, { httpStatus: 429 }, { httpStatus: 429 }, [fill(1, 5)]]);
    const waits: number[] = [];
    await expect(userFillsByTime(user, 10, 20, TESTNET, fetchFn, async (ms) => void waits.push(ms))).rejects.toThrow(/429/);
    expect(bodies).toHaveLength(4);
    expect(waits).toEqual([2000, 4000, 8000]);
  });
  it("does not retry other errors", async () => {
    const { bodies, fetchFn } = fake([{ httpStatus: 500 }, [fill(1, 5)]]);
    await expect(userFillsByTime(user, 10, 20, TESTNET, fetchFn, async () => {})).rejects.toThrow(/500/);
    expect(bodies).toHaveLength(1);
  });
  it("maxBuilderFee returns the number", async () => {
    const { bodies, fetchFn } = fake([100]);
    const builder = "0x00000000000000000000000000000000000000bb" as const;
    expect(await maxBuilderFee(user, builder, TESTNET, fetchFn)).toBe(100);
    expect(bodies).toEqual([{ type: "maxBuilderFee", user, builder }]);
  });
  it("perpCoins lists the core perps that are not delisted", async () => {
    const { bodies, fetchFn } = fake([{ universe: [{ name: "BTC" }, { name: "OLD", isDelisted: true }, { name: "ETH" }, { name: "xyz:GOLD" }, { name: "@107" }, { name: "kPEPE", isDelisted: false }] }]);
    expect(await perpCoins(TESTNET, fetchFn)).toEqual(["BTC", "ETH", "kPEPE"]);
    expect(bodies).toEqual([{ type: "meta" }]);
  });
  it("perpCoins throws when the answer has no universe or the request fails", async () => {
    await expect(perpCoins(TESTNET, fake([{}]).fetchFn)).rejects.toThrow("meta: unexpected response");
    await expect(perpCoins(TESTNET, fake([null]).fetchFn)).rejects.toThrow();
    await expect(perpCoins(TESTNET, fake([{ httpStatus: 500 }]).fetchFn)).rejects.toThrow(/500/);
  });
  it("perpCoins and builderRewardsUnits wait out an HTTP 429 like the fill reads (2 s, then try again)", async () => {
    vi.useFakeTimers();
    try {
      const builder = "0x00000000000000000000000000000000000000bb" as const;
      const coins = perpCoins(TESTNET, fake([{ httpStatus: 429 }, { universe: [{ name: "BTC" }] }]).fetchFn);
      await vi.advanceTimersByTimeAsync(1_999);
      let settled = false;
      void coins.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await coins).toEqual(["BTC"]);
      const total = builderRewardsUnits(builder, TESTNET, fake([{ httpStatus: 429 }, { builderRewards: "1" }]).fetchFn);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await total).toBe(100_000_000n);
    } finally {
      vi.useRealTimers();
    }
  });
  it("builderRewardsUnits reads the cumulative builder total in 1e-8 USDC", async () => {
    const builder = "0x00000000000000000000000000000000000000bb" as const;
    const { bodies, fetchFn } = fake([{ builderRewards: "86.26939", unclaimedRewards: "1" }]);
    expect(await builderRewardsUnits(builder, TESTNET, fetchFn)).toBe(8626939000n);
    expect(bodies).toEqual([{ type: "referral", user: builder }]);
  });
  it("builderRewardsUnits is null when the total is missing or unreadable", async () => {
    const builder = "0x00000000000000000000000000000000000000bb" as const;
    for (const answer of [{}, null, { builderRewards: null }, { builderRewards: 86.2 }, { builderRewards: "" }, { builderRewards: "abc" }, { builderRewards: "-1" }, { builderRewards: "1e3" }, { builderRewards: "1.123456789" }]) {
      expect(await builderRewardsUnits(builder, TESTNET, fake([answer]).fetchFn)).toBeNull();
    }
    expect(await builderRewardsUnits(builder, TESTNET, fake([{ builderRewards: "0" }]).fetchFn)).toBe(0n);
    expect(await builderRewardsUnits(builder, TESTNET, fake([{ builderRewards: "1.12345678" }]).fetchFn)).toBe(112345678n);
    await expect(builderRewardsUnits(builder, TESTNET, fake([{ httpStatus: 500 }]).fetchFn)).rejects.toThrow(/500/);
  });
});
