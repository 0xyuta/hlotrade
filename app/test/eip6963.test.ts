import { describe, expect, it } from "vitest";
import { discoverWallets, type Discovered } from "../src/wallet/eip6963";

describe("discoverWallets (EIP-6963)", () => {
  it("collects announced wallets once each and stops listening", () => {
    const target = new EventTarget();
    const provider = { request: async () => null };
    const announce = (rdns: string) =>
      target.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: rdns, name: rdns, icon: "data:,", rdns }, provider } }));
    target.addEventListener("eip6963:requestProvider", () => announce("io.rabby"));
    let last: Discovered[] = [];
    const stop = discoverWallets(target, (w) => (last = w));
    expect(last.map((w) => w.info.rdns)).toEqual(["io.rabby"]);
    announce("io.rabby");
    announce("io.metamask");
    expect(last.map((w) => w.info.rdns)).toEqual(["io.rabby", "io.metamask"]);
    stop();
    announce("app.phantom");
    expect(last).toHaveLength(2);
  });
  it("ignores malformed announcements", () => {
    const target = new EventTarget();
    let last: Discovered[] = [];
    discoverWallets(target, (w) => (last = w));
    target.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: {} } }));
    expect(last).toEqual([]);
  });
  it("a second provider that claims the same rdns does not replace the first (review M4)", () => {
    const target = new EventTarget();
    let last: Discovered[] = [];
    discoverWallets(target, (w) => (last = w));
    const announce = (uuid: string, name: string) =>
      target.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid, name, icon: "data:,", rdns: "io.metamask" }, provider: { request: async () => null } } }));
    announce("u1", "MetaMask");
    announce("u2", "Impostor");
    announce("u1", "MetaMask");
    expect(last.map((w) => w.info.name)).toEqual(["MetaMask", "Impostor"]);
  });
});
