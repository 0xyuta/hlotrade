import { ExchangeClient, HttpTransport, InfoClient, SubscriptionClient, WebSocketTransport, type ExchangeSingleWalletConfig, type IRequestTransport } from "@nktkas/hyperliquid";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HL_HOSTS } from "../config/csp";
import type { Network } from "../config/validate";
import type { HlUserWallet } from "./injected";

export interface HlClients {
  http: HttpTransport;
  info: InfoClient;
  /** One WebSocket per tab, opened on first use [T §4.7]. */
  subs(): SubscriptionClient;
  /** Calls `cb` each time the socket (re)opens, so a screen can backfill what it missed. Returns the remover. */
  onSocketOpen(cb: () => void): () => void;
}

const cache: Partial<Record<Network, HlClients>> = {};

export function getHl(net: Network): HlClients {
  const hit = cache[net];
  if (hit) return hit;
  const isTestnet = net === "testnet";
  const http = new HttpTransport({ isTestnet });
  let ws: WebSocketTransport | null = null;
  let subs: SubscriptionClient | null = null;
  const c: HlClients = {
    http,
    info: new InfoClient({ transport: http }),
    subs: () => (subs ??= new SubscriptionClient({ transport: (ws = new WebSocketTransport({ isTestnet })) })),
    onSocketOpen: (cb) => {
      c.subs(); // makes sure the transport exists
      ws?.socket.addEventListener("open", cb);
      const mine = ws;
      return () => mine?.socket.removeEventListener("open", cb);
    },
  };
  cache[net] = c;
  return c;
}

/** L1 actions (order, cancel, updateLeverage) signed by the local agent key [T §1.6]. */
export const agentExchange = (net: Network, key: Hex) => new ExchangeClient({ transport: getHl(net).http, wallet: privateKeyToAccount(key) });

/** User-signed actions through the Fix A wallet [T §1.6]. */
export const userExchange = (net: Network, wallet: HlUserWallet, transport: IRequestTransport = getHl(net).http) =>
  new ExchangeClient({ transport, wallet: wallet as unknown as ExchangeSingleWalletConfig["wallet"] });

/** A raw /info request, for documented types the app reads without the SDK (activeAssetData, userAbstraction). */
export async function infoPost<T>(net: Network, body: Record<string, unknown>): Promise<T> {
  const r = await fetch(`${HL_HOSTS[net].api}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Hyperliquid info ${String(body.type)}: HTTP ${r.status}`);
  return (await r.json()) as T;
}
