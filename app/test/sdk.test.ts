import { ExchangeClient, HttpTransport, InfoClient, SubscriptionClient } from "@nktkas/hyperliquid";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

describe("@nktkas/hyperliquid 0.33.3 surface used by the app", () => {
  const transport = new HttpTransport({ isTestnet: true });
  it("InfoClient", () => {
    const info = new InfoClient({ transport }) as unknown as Record<string, unknown>;
    for (const m of ["metaAndAssetCtxs", "maxBuilderFee", "extraAgents", "userFees", "clearinghouseState", "spotClearinghouseState", "frontendOpenOrders", "userFills", "userFillsByTime", "candleSnapshot"]) {
      expect(typeof info[m], m).toBe("function");
    }
  });
  it("ExchangeClient", () => {
    const ex = new ExchangeClient({ transport, wallet: privateKeyToAccount(generatePrivateKey()) }) as unknown as Record<string, unknown>;
    for (const m of ["approveAgent", "approveBuilderFee", "order", "cancel", "updateLeverage", "usdClassTransfer", "sendAsset"]) {
      expect(typeof ex[m], m).toBe("function");
    }
  });
  it("SubscriptionClient", () => {
    const proto = SubscriptionClient.prototype as unknown as Record<string, unknown>;
    for (const m of ["allMids", "candle", "userFills", "orderUpdates"]) expect(typeof proto[m], m).toBe("function");
  });
});
