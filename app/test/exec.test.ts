import { afterEach, describe, expect, it, vi } from "vitest";
import { ROUTE_ADDRESSES, USDC_SYSTEM_ADDRESS } from "../src/routes/addresses";
import { burnArgs } from "../src/routes/cctp";
import {
  ApprovedNotSentError, BurnUncertainError, depositCctp, depositFromHyperEvm, irisFeesUrl, irisMessageUrl, moveCoreUsdc, parseIrisFees, parsePreTransfer, sourceDexFor, usdcString, withdrawCctp, withdrawToHyperEvm,
} from "../src/routes/exec";
import { EvmTxError } from "../src/evm/clients";
import { plainError } from "../src/hl/errors";
import { injectedHlWallet } from "../src/hl/injected";
import { postSigned, UnconfirmedPostError } from "../src/hl/userSigned";

const USER = "0x1111111111111111111111111111111111111111";
const SIG = `0x${"11".repeat(32)}${"22".repeat(32)}1b`;

function recorder() {
  const calls: { kind: string; address: string; functionName: string; args: readonly unknown[] }[] = [];
  const write = async (kind: string, c: { address: string; functionName: string; args?: readonly unknown[] }) => {
    calls.push({ kind, address: c.address, functionName: c.functionName, args: c.args ?? [] });
    return `0x${"ab".repeat(32)}` as const;
  };
  return { calls, write };
}
afterEach(() => vi.unstubAllGlobals());

describe("units and helpers", () => {
  it("usdcString: 6-decimal integer → decimal string for Core actions [R §2.2]", () => {
    expect(usdcString(10_000_000n)).toBe("10");
    expect(usdcString(10_500_000n)).toBe("10.5");
    expect(usdcString(1n)).toBe("0.000001");
  });
  it("sourceDexFor: spot for unified and portfolio accounts, perps otherwise [R §2.4]", () => {
    expect(sourceDexFor("unifiedAccount")).toBe("spot");
    expect(sourceDexFor("portfolioMargin")).toBe("spot");
    expect(sourceDexFor("disabled")).toBe("");
    expect(sourceDexFor("default")).toBe("");
  });
  it("Iris URLs [R §2.5]", () => {
    expect(irisFeesUrl("mainnet", 3)).toBe("https://iris-api.circle.com/v2/burn/USDC/fees/3/19?forward=true&hyperCoreDeposit=true");
    expect(irisMessageUrl("testnet", 0, "0xabc")).toBe("https://iris-api-sandbox.circle.com/v2/messages/0?transactionHash=0xabc");
    // [P4 §1] Solana is domain 5; its transaction id is the base58 signature
    expect(irisFeesUrl("testnet", 5)).toBe("https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/5/19?forward=true&hyperCoreDeposit=true");
    expect(irisMessageUrl("mainnet", 5, "5sig")).toBe("https://iris-api.circle.com/v2/messages/5?transactionHash=5sig");
  });
  it("parseIrisFees keeps the documented shape", () => {
    expect(parseIrisFees([{ finalityThreshold: 1000, minimumFee: 1, forwardFee: { low: 1, med: 2, high: 3 } }, { bad: 1 }]))
      .toEqual([{ finalityThreshold: 1000, minimumFee: 1, forwardFee: { low: 1, med: 2, high: 3 } }]);
    expect(parseIrisFees({})).toBeNull();
  });
  it("parsePreTransfer [R §2.3]", () => {
    expect(parsePreTransfer({ isSanctioned: false, userExists: true, fee: "0.0", userHasSentTx: true })).toEqual({ fee: 0, userExists: true });
    expect(parsePreTransfer({ fee: "1.0", userExists: false })).toEqual({ fee: 1, userExists: false });
    expect(parsePreTransfer("x")).toBeNull();
  });
});

describe("EVM deposits", () => {
  it("HyperEVM: approve the CoreDepositWallet, then deposit(amount, 0) [R §4.2]", async () => {
    const r = recorder();
    await depositFromHyperEvm(r.write as never, "mainnet", 5_000_000n);
    const a = ROUTE_ADDRESSES.mainnet.hyperEvm;
    expect(r.calls).toEqual([
      { kind: "hyperEvm", address: a.usdc, functionName: "approve", args: [a.coreDepositWallet, 5_000_000n] },
      { kind: "hyperEvm", address: a.coreDepositWallet, functionName: "deposit", args: [5_000_000n, 0] },
    ]);
  });
  it("HyperEVM: an allowance that covers the amount skips the approve; a smaller one approves again (final review M7)", async () => {
    const a = ROUTE_ADDRESSES.testnet.hyperEvm;
    const covered = recorder();
    await depositFromHyperEvm(covered.write as never, "testnet", 5_000_000n, 5_000_000n);
    expect(covered.calls).toEqual([{ kind: "hyperEvm", address: a.coreDepositWallet, functionName: "deposit", args: [5_000_000n, 0] }]);
    const short = recorder();
    await depositFromHyperEvm(short.write as never, "testnet", 5_000_000n, 4_999_999n);
    expect(short.calls.map((c) => c.functionName)).toEqual(["approve", "deposit"]);
  });
  it("CCTP: approve TokenMessengerV2, then depositForBurnWithHook with the burn args [R §5.3, §6.3]", async () => {
    const r = recorder();
    await depositCctp(r.write as never, "testnet", "arbitrum", 20_000_000n, 200_000n, USER);
    const a = ROUTE_ADDRESSES.testnet.arbitrum;
    expect(r.calls[0]).toEqual({ kind: "arbitrum", address: a.usdc, functionName: "approve", args: [a.tokenMessengerV2, 20_000_000n] });
    expect(r.calls[1]).toEqual({ kind: "arbitrum", address: a.tokenMessengerV2, functionName: "depositForBurnWithHook", args: burnArgs("testnet", "arbitrum", 20_000_000n, 200_000n, USER) });
  });
  it("CCTP: a burn that was sent but not confirmed keeps its hash (the burn may still land); a reverted burn is a plain failure", async () => {
    const HASH = `0x${"cd".repeat(32)}` as const;
    const sentUnconfirmed = async (_k: string, c: { functionName: string }) => {
      if (c.functionName === "approve") return `0x${"ab".repeat(32)}` as const;
      throw new EvmTxError("depositForBurnWithHook was sent but its result is not confirmed yet.", HASH, { cause: new Error("timeout") });
    };
    const e = await depositCctp(sentUnconfirmed as never, "testnet", "ethereum", 20_000_000n, 200_000n, USER).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BurnUncertainError);
    expect((e as BurnUncertainError).hash).toBe(HASH);
    const reverted = async (_k: string, c: { functionName: string }) => {
      if (c.functionName === "approve") return `0x${"ab".repeat(32)}` as const;
      throw new EvmTxError("depositForBurnWithHook failed on chain", HASH);
    };
    const f = await depositCctp(reverted as never, "testnet", "ethereum", 20_000_000n, 200_000n, USER).catch((x: unknown) => x);
    expect(f).toBeInstanceOf(EvmTxError);
    expect(f).not.toBeInstanceOf(BurnUncertainError);
    // a failed approve never reaches the burn
    const calls: string[] = [];
    await expect(depositCctp((async (_k: string, c: { functionName: string }) => { calls.push(c.functionName); throw new Error("rejected"); }) as never, "testnet", "arbitrum", 1n, 0n, USER)).rejects.toThrow("rejected");
    expect(calls).toEqual(["approve"]);
  });
  it("CCTP: an allowance that already covers the amount skips the approve", async () => {
    const r = recorder();
    await depositCctp(r.write as never, "testnet", "arbitrum", 20_000_000n, 200_000n, USER, 20_000_000n);
    expect(r.calls.map((c) => c.functionName)).toEqual(["depositForBurnWithHook"]);
    const r2 = recorder();
    await depositCctp(r2.write as never, "testnet", "arbitrum", 20_000_000n, 200_000n, USER, 19_999_999n);
    expect(r2.calls.map((c) => c.functionName)).toEqual(["approve", "depositForBurnWithHook"]);
  });
  it("CCTP: approve done, burn refused before it was sent = 'Approved, not sent. Nothing left your wallet.'; with the approve skipped the refusal passes through", async () => {
    const refuse = (calls: string[]) => async (_k: string, c: { functionName: string }) => {
      calls.push(c.functionName);
      if (c.functionName === "approve") return `0x${"ab".repeat(32)}` as const;
      throw Object.assign(new Error("User rejected the request."), { code: 4001 });
    };
    const calls: string[] = [];
    const e = await depositCctp(refuse(calls) as never, "testnet", "arbitrum", 20_000_000n, 200_000n, USER).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApprovedNotSentError);
    expect(plainError(e).text).toMatch(/^Approved, not sent\. Nothing left your wallet\./);
    expect(calls).toEqual(["approve", "depositForBurnWithHook"]);
    const f = await depositCctp(refuse([]) as never, "testnet", "arbitrum", 20_000_000n, 200_000n, USER, 20_000_000n).catch((x: unknown) => x);
    expect(f).not.toBeInstanceOf(ApprovedNotSentError);
    expect(plainError(f).text).toBe("You cancelled the request in your wallet.");
  });
});

/** An injected wallet that signs once per call and counts the signatures. */
function wallet(chain = "0x3e6") {
  const signs: string[] = [];
  const eth = {
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      if (method === "eth_chainId") return chain;
      signs.push(String((params as string[])[1]));
      return SIG;
    },
  };
  return { signs, w: injectedHlWallet(eth, USER) };
}
type Posted = { action: Record<string, unknown>; nonce: number; signature: unknown };
const okResponse = () => new Response(JSON.stringify({ status: "ok", response: { type: "default" } }), { headers: { "content-type": "application/json" } });
function stubPosts(reply: () => Response | Promise<Response> = okResponse) {
  const bodies: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: { body?: unknown }) => {
    bodies.push(init?.body ? String(init.body) : await (input as Request).clone().text());
    return reply();
  }));
  return bodies;
}

describe("Core → HyperEVM [R §4.3]", () => {
  it("sendAsset to the USDC system address, destinationDex spot", async () => {
    const actions: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      actions.push(JSON.parse(init?.body ? String(init.body) : await (input as Request).clone().text()).action);
      return new Response(JSON.stringify({ status: "ok", response: { type: "default" } }), { headers: { "content-type": "application/json" } });
    }));
    const eth = { request: async ({ method }: { method: string }) => (method === "eth_chainId" ? "0x3e6" : `0x${"11".repeat(32)}${"22".repeat(32)}1b`) };
    await withdrawToHyperEvm(injectedHlWallet(eth, USER), "testnet", 12_340_000n, "");
    expect(actions[0]).toMatchObject({
      type: "sendAsset", hyperliquidChain: "Testnet", destination: USDC_SYSTEM_ADDRESS, sourceDex: "", destinationDex: "spot", token: "USDC", amount: "12.34", fromSubAccount: "",
    });
  });
  it("a zero or negative amount is refused before the wallet is asked to sign", async () => {
    const { w, signs } = wallet();
    const bodies = stubPosts();
    await expect(withdrawToHyperEvm(w, "testnet", 0n, "")).rejects.toThrow(/above zero/);
    await expect(moveCoreUsdc(w, "testnet", -1n, true)).rejects.toThrow(/above zero/);
    expect(signs).toEqual([]);
    expect(bodies).toEqual([]);
  });
  it("the network failing after signing keeps the signed body; a retry posts the SAME body (same nonce) and signs nothing again", async () => {
    const { w, signs } = wallet();
    let n = 0;
    const bodies = stubPosts(() => { if (n++ === 0) throw new TypeError("Failed to fetch"); return okResponse(); });
    const e = await withdrawToHyperEvm(w, "testnet", 12_340_000n, "spot").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UnconfirmedPostError);
    const body = (e as UnconfirmedPostError).body;
    expect(body.action).toMatchObject({ type: "sendAsset", amount: "12.34", sourceDex: "spot" });
    expect(JSON.parse(bodies[0])).toEqual(JSON.parse(JSON.stringify(body)));
    await postSigned("testnet", body);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(JSON.stringify(body));
    expect((JSON.parse(bodies[1]) as Posted).nonce).toBe((JSON.parse(bodies[0]) as Posted).nonce);
    expect(signs).toHaveLength(1);
  });
  it("Hyperliquid answering with an error is a plain failure, not 'unconfirmed'", async () => {
    const { w } = wallet();
    stubPosts(() => new Response(JSON.stringify({ status: "err", response: "Insufficient balance" }), { headers: { "content-type": "application/json" } }));
    const e = await withdrawToHyperEvm(w, "testnet", 1_000_000n, "").catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(UnconfirmedPostError);
    expect(String((e as Error).message ?? (e as { response?: string }).response)).toMatch(/Insufficient balance/);
  });
  it("a wallet that changed chain between reading and signing is retried once, then posts once [T §1.4]", async () => {
    let chain = "0x3e6";
    let signs = 0;
    const eth = {
      request: async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return chain;
        if (++signs === 1) {
          chain = "0xa4b1";
          throw new Error('Provided chainId "998" must match the active chainId "42161"');
        }
        return SIG;
      },
    };
    const bodies = stubPosts();
    await withdrawToHyperEvm(injectedHlWallet(eth, USER), "testnet", 5_000_000n, "");
    expect(signs).toBe(2);
    expect(bodies).toHaveLength(1);
    expect((JSON.parse(bodies[0]) as Posted).action.signatureChainId).toBe("0xa4b1");
  });
  it("spot ↔ perps: usdClassTransfer with a decimal string and the direction", async () => {
    const { w } = wallet();
    const bodies = stubPosts();
    await moveCoreUsdc(w, "testnet", 2_500_000n, true);
    expect((JSON.parse(bodies[0]) as Posted).action).toMatchObject({ type: "usdClassTransfer", amount: "2.5", toPerp: true });
    await moveCoreUsdc(w, "testnet", 2_500_000n, false);
    expect((JSON.parse(bodies[1]) as Posted).action).toMatchObject({ toPerp: false });
  });
  it("usdClassTransfer losing the network keeps the body too", async () => {
    const { w } = wallet();
    stubPosts(() => { throw new TypeError("Failed to fetch"); });
    const e = await moveCoreUsdc(w, "testnet", 2_000_000n, true).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UnconfirmedPostError);
    expect((e as UnconfirmedPostError).body.action).toMatchObject({ type: "usdClassTransfer", amount: "2" });
  });
});

describe("Core → Arbitrum / Ethereum [R §5.5, §6.4]", () => {
  it("sendToEvmWithData to the connected address; destinationChainId is the CCTP domain (3 Arbitrum, 0 Ethereum)", async () => {
    const { w } = wallet();
    const bodies = stubPosts();
    await withdrawCctp(w, "testnet", 30_000_000n, "", USER, 3);
    await withdrawCctp(w, "testnet", 30_000_000n, "spot", USER, 0);
    const [a, b] = bodies.map((x) => (JSON.parse(x) as Posted).action);
    expect(a).toMatchObject({ type: "sendToEvmWithData", destinationRecipient: USER, destinationChainId: 3, amount: "30", sourceDex: "" });
    expect(b).toMatchObject({ destinationChainId: 0, sourceDex: "spot" });
  });
  it("a bad recipient is refused before the wallet is asked to sign", async () => {
    const { w, signs } = wallet();
    stubPosts();
    await expect(withdrawCctp(w, "testnet", 30_000_000n, "", "0x1234" as never, 3)).rejects.toThrow(/valid 20-byte address/);
    expect(signs).toEqual([]);
  });
  it("the network failing after signing keeps the body and a retry re-posts it unchanged", async () => {
    const { w, signs } = wallet();
    let n = 0;
    const bodies = stubPosts(() => { if (n++ === 0) throw new DOMException("timed out", "TimeoutError"); return okResponse(); });
    const e = await withdrawCctp(w, "testnet", 30_000_000n, "", USER, 3).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UnconfirmedPostError);
    await postSigned("testnet", (e as UnconfirmedPostError).body);
    expect(bodies[1]).toBe(bodies[0]);
    expect(signs).toHaveLength(1);
  });
  it("postSigned: an error answer without text names the action that was posted, not another one", async () => {
    stubPosts(() => new Response(JSON.stringify({ status: "err", response: { nope: 1 } }), { headers: { "content-type": "application/json" } }));
    for (const type of ["sendAsset", "usdClassTransfer", "sendToEvmWithData"]) {
      const body = { action: { type }, nonce: 1, signature: { r: "0x1", s: "0x2", v: 27 } } as never;
      await expect(postSigned("testnet", body)).rejects.toThrow(`${type} failed (HTTP 200)`);
    }
  });
  it("postSigned: an error answer is a plain error; a gateway page is read as text", async () => {
    stubPosts(() => new Response(JSON.stringify({ status: "err", response: "Nonce too low" }), { headers: { "content-type": "application/json" } }));
    const body = { action: { type: "x" }, nonce: 1, signature: { r: "0x1", s: "0x2", v: 27 } } as never;
    const e = await postSigned("testnet", body).catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(UnconfirmedPostError);
    expect((e as Error).message).toBe("Nonce too low");
  });
});

describe("an HTTP 5xx is unconfirmed (ruling 4 extension)", () => {
  it("sendAsset: a 503 keeps the signed body; the re-post is byte for byte the same request", async () => {
    const { w, signs } = wallet();
    let n = 0;
    const bodies = stubPosts(() => (n++ === 0 ? new Response("<html>Service Unavailable</html>", { status: 503 }) : okResponse()));
    const e = await withdrawToHyperEvm(w, "testnet", 12_340_000n, "").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UnconfirmedPostError);
    await postSigned("testnet", (e as UnconfirmedPostError).body);
    expect(bodies[1]).toBe(bodies[0]);
    expect(signs).toHaveLength(1);
  });
  it("sendToEvmWithData: a 502 is unconfirmed and re-posts identically", async () => {
    const { w, signs } = wallet();
    let n = 0;
    const bodies = stubPosts(() => (n++ === 0 ? new Response("bad gateway", { status: 502 }) : okResponse()));
    const e = await withdrawCctp(w, "testnet", 30_000_000n, "", USER, 3).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UnconfirmedPostError);
    await postSigned("testnet", (e as UnconfirmedPostError).body);
    expect(bodies[1]).toBe(bodies[0]);
    expect(signs).toHaveLength(1);
  });
  it("postSigned: a 408 keeps the same body as unconfirmed (final review M2)", async () => {
    let n = 0;
    const bodies = stubPosts(() => (n++ === 0 ? new Response("Request Timeout", { status: 408 }) : okResponse()));
    const body = { action: { type: "sendToEvmWithData" }, nonce: 7, signature: { r: "0x1", s: "0x2", v: 27 } } as never;
    const e = await postSigned("testnet", body).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UnconfirmedPostError);
    expect((e as UnconfirmedPostError).body).toBe(body);
    await postSigned("testnet", (e as UnconfirmedPostError).body);
    expect(bodies[1]).toBe(bodies[0]);
  });
  it("postSigned: a 200 that is not JSON, or JSON without a status, is unconfirmed, not a failure (final review M2)", async () => {
    const body = { action: { type: "sendToEvmWithData" }, nonce: 8, signature: { r: "0x1", s: "0x2", v: 27 } } as never;
    for (const reply of [
      () => new Response("<html>ok</html>", { status: 200 }),
      () => new Response("", { status: 200 }),
      () => new Response(JSON.stringify({ response: { type: "default" } }), { headers: { "content-type": "application/json" } }),
      () => new Response("null", { headers: { "content-type": "application/json" } }),
    ]) {
      stubPosts(reply);
      const e = await postSigned("testnet", body).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(UnconfirmedPostError);
      expect((e as UnconfirmedPostError).body).toBe(body);
    }
  });
  it("SDK path: a 408 and a 200 that is not JSON are unconfirmed and keep the signed body (final review M2)", async () => {
    for (const first of [() => new Response("Request Timeout", { status: 408 }), () => new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } }), () => new Response("{bad", { status: 200, headers: { "content-type": "application/json" } })]) {
      const { w, signs } = wallet();
      let n = 0;
      const bodies = stubPosts(() => (n++ === 0 ? first() : okResponse()));
      const e = await withdrawToHyperEvm(w, "testnet", 3_000_000n, "").catch((x: unknown) => x);
      expect(e).toBeInstanceOf(UnconfirmedPostError);
      await postSigned("testnet", (e as UnconfirmedPostError).body);
      expect(bodies[1]).toBe(bodies[0]);
      expect(signs).toHaveLength(1);
    }
  });
  it("a 4xx, and a 200 with status err, stay plain errors on both paths", async () => {
    const { w } = wallet();
    for (const reply of [
      () => new Response("rate limited", { status: 429 }),
      () => new Response(JSON.stringify({ status: "err", response: "Insufficient balance" }), { headers: { "content-type": "application/json" } }),
    ]) {
      stubPosts(reply);
      expect(await withdrawToHyperEvm(w, "testnet", 1_000_000n, "").catch((x: unknown) => x)).not.toBeInstanceOf(UnconfirmedPostError);
      expect(await withdrawCctp(w, "testnet", 30_000_000n, "", USER, 3).catch((x: unknown) => x)).not.toBeInstanceOf(UnconfirmedPostError);
    }
  });
});

describe("the chain retry never covers the post (a re-sign after a post would be a double send)", () => {
  const MISMATCH = 'Provided chainId "998" must match the active chainId "42161"';
  const answer = () => new Response(JSON.stringify({ status: "err", response: MISMATCH }), { headers: { "content-type": "application/json" } });
  it("sendAsset: an answer to the post that looks like a chain mismatch is not retried: one signature, one post", async () => {
    const { w, signs } = wallet();
    const bodies = stubPosts(answer);
    await expect(withdrawToHyperEvm(w, "testnet", 5_000_000n, "")).rejects.toThrow();
    expect(signs).toHaveLength(1);
    expect(bodies).toHaveLength(1);
  });
  it("usdClassTransfer: the same", async () => {
    const { w, signs } = wallet();
    const bodies = stubPosts(answer);
    await expect(moveCoreUsdc(w, "testnet", 5_000_000n, true)).rejects.toThrow();
    expect(signs).toHaveLength(1);
    expect(bodies).toHaveLength(1);
  });
  it("sendToEvmWithData: the same", async () => {
    const { w, signs } = wallet();
    const bodies = stubPosts(answer);
    await expect(withdrawCctp(w, "testnet", 30_000_000n, "", USER, 3)).rejects.toThrow(MISMATCH);
    expect(signs).toHaveLength(1);
    expect(bodies).toHaveLength(1);
  });
  it("a mismatch while SIGNING is still retried once (nothing was posted)", async () => {
    let chain = "0x3e6";
    let signs = 0;
    const eth = {
      request: async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return chain;
        if (++signs === 1) {
          chain = "0xa4b1";
          throw new Error(MISMATCH);
        }
        return SIG;
      },
    };
    const bodies = stubPosts();
    await moveCoreUsdc(injectedHlWallet(eth, USER), "testnet", 5_000_000n, false);
    expect(signs).toBe(2);
    expect(bodies).toHaveLength(1);
  });
});
