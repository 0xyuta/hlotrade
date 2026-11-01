import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import { concat, hashTypedData, keccak256, recoverAddress, stringToBytes, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { injectedHlWallet } from "../src/hl/injected";
import { SEND_TO_EVM_TYPES, UnconfirmedPostError, checkSendToEvm, sendToEvmAction, sendToEvmTypedData, submitSendToEvm } from "../src/hl/userSigned";
import { digestOf, encodeType, type Field } from "./helpers/eip712";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const BUILDER = "0x2222222222222222222222222222222222222222";
const SIG = `0x${"11".repeat(32)}${"22".repeat(32)}1b`;

function mockEth(chainHex: string) {
  const calls: { method: string; params?: unknown }[] = [];
  return {
    calls,
    async request(a: { method: string; params?: unknown }) {
      calls.push(a);
      if (a.method === "eth_chainId") return chainHex;
      if (a.method === "eth_signTypedData_v4") return SIG;
      throw new Error(`unexpected ${a.method}`);
    },
  };
}
function stubFetch() {
  const bodies: Record<string, any>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(init?.body ? String(init.body) : await (input as Request).clone().text()));
    return new Response(JSON.stringify({ status: "ok", response: { type: "default" } }), { headers: { "content-type": "application/json" } });
  }));
  return bodies;
}
afterEach(() => vi.unstubAllGlobals());

describe("Fix A wallet [T §1.3]", () => {
  it("nktkas approveBuilderFee reaches eth_signTypedData_v4 with the colon primaryType and the wallet's chain", async () => {
    const eth = mockEth("0xa4b1");
    const bodies = stubFetch();
    const ex = new ExchangeClient({ transport: new HttpTransport({ isTestnet: true }), wallet: injectedHlWallet(eth, ACCOUNT) as never });
    await ex.approveBuilderFee({ builder: BUILDER, maxFeeRate: "0.1%" });
    const sign = eth.calls.find((c) => c.method === "eth_signTypedData_v4")!;
    const [addr, json] = sign.params as [string, string];
    const typed = JSON.parse(json);
    expect(addr).toBe(ACCOUNT);
    expect(typed.primaryType).toBe("HyperliquidTransaction:ApproveBuilderFee");
    expect(typed.domain).toMatchObject({ name: "HyperliquidSignTransaction", version: "1", chainId: 42161 });
    expect(typed.message).toMatchObject({ hyperliquidChain: "Testnet", maxFeeRate: "0.1%", builder: BUILDER });
    expect(bodies[0].action).toMatchObject({ type: "approveBuilderFee", signatureChainId: "0xa4b1", maxFeeRate: "0.1%" });
  });
  it("nktkas approveAgent with a named agent carries the name verbatim (two named agents can coexist)", async () => {
    const eth = mockEth("0x3e7");
    const bodies = stubFetch();
    const ex = new ExchangeClient({ transport: new HttpTransport({ isTestnet: false }), wallet: injectedHlWallet(eth, ACCOUNT) as never });
    await ex.approveAgent({ agentAddress: BUILDER, agentName: "hlo phone valid_until 1800000000000" });
    const typed = JSON.parse((eth.calls.find((c) => c.method === "eth_signTypedData_v4")!.params as [string, string])[1]);
    expect(typed.primaryType).toBe("HyperliquidTransaction:ApproveAgent");
    expect(typed.message).toMatchObject({ agentName: "hlo phone valid_until 1800000000000", hyperliquidChain: "Mainnet" });
    expect(bodies[0].action).toMatchObject({ type: "approveAgent", agentName: "hlo phone valid_until 1800000000000" });
  });
});

// A throwaway key derived from a label: never a real account.
const VECTOR_KEY = keccak256(stringToBytes("hlo sendToEvmWithData test vector"));
const VECTOR_ACTION = sendToEvmAction({
  net: "mainnet", signatureChainId: 999, amount: "10.5", sourceDex: "", recipient: "0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD", destinationDomain: 3, nonce: 1_800_000_000_000,
});

describe("sendToEvmWithData [R §2.1, §5.5]", () => {
  it("field list and order are the research's", () => {
    expect(SEND_TO_EVM_TYPES.map((f) => `${f.name}:${f.type}`)).toEqual([
      "hyperliquidChain:string", "token:string", "amount:string", "sourceDex:string", "destinationRecipient:string",
      "addressEncoding:string", "destinationChainId:uint32", "gasLimit:uint64", "data:bytes", "nonce:uint64",
    ]);
  });
  it("signs with the wallet's chain and posts the action with r, s, v", async () => {
    const eth = mockEth("0x3e7");
    const bodies = stubFetch();
    await submitSendToEvm(injectedHlWallet(eth, ACCOUNT), "mainnet", {
      amount: "10", sourceDex: "", recipient: "0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD", destinationDomain: 3,
    });
    const typed = JSON.parse((eth.calls.find((c) => c.method === "eth_signTypedData_v4")!.params as [string, string])[1]);
    expect(typed.primaryType).toBe("HyperliquidTransaction:SendToEvmWithData");
    expect(typed.domain.chainId).toBe(999);
    const b = bodies[0];
    expect(b.action).toMatchObject({
      type: "sendToEvmWithData", hyperliquidChain: "Mainnet", signatureChainId: "0x3e7", token: "USDC", amount: "10", sourceDex: "",
      destinationRecipient: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", addressEncoding: "hex", destinationChainId: 3, gasLimit: 200000, data: "0x",
    });
    expect(b.nonce).toBe(b.action.nonce);
    expect(b.signature).toEqual({ r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}`, v: 27 });
  });
  it("typed data message has exactly the signed fields", () => {
    const t = sendToEvmTypedData({
      type: "sendToEvmWithData", hyperliquidChain: "Testnet", signatureChainId: "0x1", token: "USDC", amount: "1", sourceDex: "spot",
      destinationRecipient: "0x00", addressEncoding: "hex", destinationChainId: 0, gasLimit: 200000, data: "0x", nonce: 5,
    });
    expect(Object.keys(t.message).sort()).toEqual(SEND_TO_EVM_TYPES.map((f) => f.name).sort());
  });
  it("throws the exchange's error text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "err", response: "Insufficient balance" }))));
    await expect(submitSendToEvm(injectedHlWallet(mockEth("0x1"), ACCOUNT), "testnet", { amount: "1", sourceDex: "", recipient: ACCOUNT, destinationDomain: 0 })).rejects.toThrow("Insufficient balance");
  });

  describe("input checks before anything is signed (review I2)", () => {
    const good = { amount: "10.5", recipient: "0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD", destinationDomain: 3 };
    const run = (o: Partial<typeof good>, net: "mainnet" | "testnet" = "mainnet") => {
      const eth = mockEth("0x3e7");
      const bodies = stubFetch();
      return { eth, bodies, p: submitSendToEvm(injectedHlWallet(eth, ACCOUNT), net, { sourceDex: "", ...good, ...o } as never) };
    };
    it("accepts and normalizes like nktkas (leading and trailing zeros)", () => {
      expect(checkSendToEvm("mainnet", good)).toEqual({ amount: "10.5", recipient: good.recipient });
      expect(checkSendToEvm("mainnet", { ...good, amount: "010.500" }).amount).toBe("10.5");
      expect(checkSendToEvm("mainnet", { ...good, amount: "0.000001" }).amount).toBe("0.000001");
      expect(checkSendToEvm("mainnet", { ...good, amount: "5.0" }).amount).toBe("5");
      expect(checkSendToEvm("testnet", { ...good, destinationDomain: 0 }).amount).toBe("10.5");
    });
    it.each([
      ["negative", "-1"], ["exponent", "1e3"], ["exponent after a point", "1.5e2"], ["zero", "0"], ["zero with zeros", "0.000"], ["empty", ""],
      ["bare point", "."], ["leading point", ".5"], ["trailing point", "5."], ["hex", "0x10"], ["comma", "1,5"], ["words", "ten"], ["7 decimals", "0.0000001"],
      ["spaces inside", "1 0"], ["plus sign", "+5"], ["infinity", "Infinity"], ["NaN", "NaN"],
    ])("refuses amount: %s", async (_n, amount) => {
      const { eth, bodies, p } = run({ amount });
      await expect(p).rejects.toThrow();
      expect(eth.calls).toEqual([]); // the wallet was never asked, not even for the chain
      expect(bodies).toEqual([]);
    });
    it.each([
      ["too short", "0xdead"], ["too long", `0x${"ab".repeat(21)}`], ["no prefix", "ab".repeat(20)], ["not hex", `0x${"zz".repeat(20)}`],
      ["zero address", `0x${"0".repeat(40)}`], ["empty", ""], ["mixed case, bad checksum", "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD"], ["base58 style", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"],
    ])("refuses recipient: %s", async (_n, recipient) => {
      const { eth, bodies, p } = run({ recipient: recipient as never });
      await expect(p).rejects.toThrow();
      expect(eth.calls).toEqual([]);
      expect(bodies).toEqual([]);
    });
    it.each([[1], [5], [19], [42161], [-1], [3.5], [Number.NaN]])("refuses destination chain %s (only this network's CCTP domains 0 and 3)", async (d) => {
      const { eth, bodies, p } = run({ destinationDomain: d as never });
      await expect(p).rejects.toThrow("not supported");
      expect(eth.calls).toEqual([]);
      expect(bodies).toEqual([]);
    });
    it("a valid request still signs and posts the normalized amount", async () => {
      const { eth, bodies, p } = run({ amount: "010.50" });
      await p;
      expect(bodies[0].action.amount).toBe("10.5");
      const typed = JSON.parse((eth.calls.find((c) => c.method === "eth_signTypedData_v4")!.params as [string, string])[1]);
      expect(typed.message.amount).toBe("10.5");
    });
  });

  it("a non-JSON error response reads as text, not a parse error (review M5)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>\n Bad   gateway </html>", { status: 400 })));
    const e = await submitSendToEvm(injectedHlWallet(mockEth("0x3e7"), ACCOUNT), "mainnet", { amount: "1", sourceDex: "", recipient: ACCOUNT, destinationDomain: 3 }).catch((x: Error) => x);
    expect((e as Error).message).toBe("Hyperliquid answered HTTP 400: <html> Bad gateway </html>");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429 })));
    await expect(submitSendToEvm(injectedHlWallet(mockEth("0x3e7"), ACCOUNT), "mainnet", { amount: "1", sourceDex: "", recipient: ACCOUNT, destinationDomain: 3 })).rejects.toThrow("HTTP 429: (empty)");
  });

  it("an HTTP 5xx is unconfirmed, not an answer: the signed body is kept for a re-post (ruling 4 extension)", async () => {
    for (const status of [500, 502, 503]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Bad gateway</html>", { status })));
      const e = await submitSendToEvm(injectedHlWallet(mockEth("0x3e7"), ACCOUNT), "mainnet", { amount: "1", sourceDex: "", recipient: ACCOUNT, destinationDomain: 3 }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(UnconfirmedPostError);
      expect((e as UnconfirmedPostError).body.action).toMatchObject({ type: "sendToEvmWithData", amount: "1" });
    }
  });

  it("retries once when the wallet's chain changed between reading it and signing (review M1)", async () => {
    let chain = "0x3e7";
    let signs = 0;
    const eth = {
      calls: [] as string[],
      async request(a: { method: string; params?: unknown }) {
        this.calls.push(a.method);
        if (a.method === "eth_chainId") return chain;
        signs++;
        if (signs === 1) {
          chain = "0xa4b1"; // the user switched networks while the prompt was open
          throw new Error('Provided chainId "999" must match the active chainId "42161"');
        }
        return SIG;
      },
    };
    const bodies = stubFetch();
    await submitSendToEvm(injectedHlWallet(eth, ACCOUNT), "mainnet", { amount: "1", sourceDex: "", recipient: ACCOUNT, destinationDomain: 3 });
    expect(eth.calls).toEqual(["eth_chainId", "eth_signTypedData_v4", "eth_chainId", "eth_signTypedData_v4"]);
    expect(bodies[0].action.signatureChainId).toBe("0xa4b1");
    // twice in a row is an error, and any other error is not retried
    const always = { request: async (a: { method: string }) => (a.method === "eth_chainId" ? "0x3e7" : Promise.reject(new Error('Provided chainId "999" must match the active chainId "42161"'))) };
    await expect(submitSendToEvm(injectedHlWallet(always, ACCOUNT), "mainnet", { amount: "1", sourceDex: "", recipient: ACCOUNT, destinationDomain: 3 })).rejects.toThrow("must match the active chainId");
    let n = 0;
    const rejecting = { request: async (a: { method: string }) => (a.method === "eth_chainId" ? "0x1" : (n++, Promise.reject(Object.assign(new Error("denied"), { code: 4001 })))) };
    await expect(submitSendToEvm(injectedHlWallet(rejecting, ACCOUNT), "mainnet", { amount: "1", sourceDex: "", recipient: ACCOUNT, destinationDomain: 3 })).rejects.toThrow("denied");
    expect(n).toBe(1);
  });

  it("the in-house field list is nktkas's own (second oracle, review M9)", async () => {
    const { SendToEvmWithDataTypes } = await import("@nktkas/hyperliquid/api/exchange");
    expect([...SEND_TO_EVM_TYPES]).toEqual(SendToEvmWithDataTypes["HyperliquidTransaction:SendToEvmWithData"]);
  });

  describe("known-good vector", () => {
    const typed = sendToEvmTypedData(VECTOR_ACTION) as ReturnType<typeof sendToEvmTypedData> & { types: Record<string, readonly Field[]> };
    it("the encoded type string is the research's, in order, with the colon primaryType", () => {
      expect(encodeType(typed.primaryType, typed.types[typed.primaryType])).toBe(
        "HyperliquidTransaction:SendToEvmWithData(string hyperliquidChain,string token,string amount,string sourceDex,string destinationRecipient,string addressEncoding,uint32 destinationChainId,uint64 gasLimit,bytes data,uint64 nonce)",
      );
      expect(typed.primaryType).toBe("HyperliquidTransaction:SendToEvmWithData");
      expect(typed.domain).toEqual({ name: "HyperliquidSignTransaction", version: "1", chainId: 999, verifyingContract: "0x0000000000000000000000000000000000000000" });
    });
    it("the independent encoder agrees with viem on the same struct under a colon-free name", () => {
      const fields = typed.types["HyperliquidTransaction:SendToEvmWithData"];
      const plain = {
        domain: typed.domain, primaryType: "SendToEvmWithData", message: typed.message,
        types: { EIP712Domain: typed.types.EIP712Domain, SendToEvmWithData: fields },
      };
      const viemDigest = hashTypedData({ domain: typed.domain, primaryType: "SendToEvmWithData", message: typed.message, types: { SendToEvmWithData: [...fields] } } as never);
      expect(digestOf(plain)).toBe(viemDigest);
    });
    it("pinned digest for the fixed action", () => {
      expect(digestOf(typed as never)).toBe(PINNED_DIGEST);
    });
    it("a local key's signature over that digest recovers to its address, and submitSendToEvm posts exactly what was signed", async () => {
      const acct = privateKeyToAccount(VECTOR_KEY);
      const eth = {
        async request(a: { method: string; params?: unknown }) {
          if (a.method === "eth_chainId") return "0x3e7";
          if (a.method !== "eth_signTypedData_v4") throw new Error(a.method);
          const [, json] = a.params as [string, string];
          return acct.sign({ hash: digestOf(JSON.parse(json)) });
        },
      };
      const bodies = stubFetch();
      vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      await submitSendToEvm(injectedHlWallet(eth, acct.address), "mainnet", {
        amount: "10.5", sourceDex: "", recipient: "0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD", destinationDomain: 3,
      });
      vi.restoreAllMocks();
      const { action, signature } = bodies[0] as { action: typeof VECTOR_ACTION; signature: { r: Hex; s: Hex; v: number } };
      expect(action).toEqual(VECTOR_ACTION);
      const sig = concat([signature.r, signature.s, toHex(signature.v, { size: 1 })]);
      // What the exchange will rebuild from the posted action must be what the wallet signed.
      expect(await recoverAddress({ hash: digestOf(sendToEvmTypedData(action) as never), signature: sig })).toBe(acct.address);
    });
  });
});

// Computed once with a separate script that hand-assembles the bytes from [R §2.1] with @noble/hashes keccak_256 only
// (no viem, no code from src/): domain {HyperliquidSignTransaction, 1, 999, 0x0} and the action in VECTOR_ACTION.
const PINNED_DIGEST: Hex = "0x7ffc13ce0c507b98d0a0427976179e9467eb0895add025a942b3a882c24457bb";
