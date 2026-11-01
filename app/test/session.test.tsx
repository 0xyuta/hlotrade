// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ACC = "0x00000000000000000000000000000000000000aa";
const request = vi.fn();
const wallet = { info: { uuid: "u", name: "Test", icon: "", rdns: "io.test" }, provider: { request, on: vi.fn(), removeListener: vi.fn() } };

vi.mock("../src/config/context", () => ({ useConfig: () => ({ network: "testnet" }) }));
vi.mock("../src/wallet/eip6963", () => ({ discoverWallets: (_w: unknown, set: (w: unknown[]) => void) => { set([wallet]); return () => {}; } }));

import { SessionProvider, useSession } from "../src/wallet/session";

function Probe() {
  const { session, wallets, connect, disconnect } = useSession();
  return (
    <div>
      <span>{session.kind}</span>
      <button onClick={() => void connect(wallets[0] as never)}>connect</button>
      <button onClick={disconnect}>disconnect</button>
    </div>
  );
}

beforeEach(() => {
  request.mockReset().mockImplementation(async ({ method }: { method: string }) => (method === "eth_accounts" ? [] : method === "eth_requestAccounts" ? [ACC] : null));
});
afterEach(cleanup);

describe("disconnect", () => {
  it("ends the session and asks the wallet to drop this site's account permission, so Connect prompts again", async () => {
    render(<SessionProvider><Probe /></SessionProvider>);
    await act(async () => fireEvent.click(screen.getByText("connect")));
    expect(screen.getByText("wallet")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByText("disconnect")));
    expect(screen.getByText("none")).toBeTruthy();
    expect(request).toHaveBeenCalledWith({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
  });
  it("a wallet without wallet_revokePermissions still disconnects", async () => {
    render(<SessionProvider><Probe /></SessionProvider>);
    await act(async () => fireEvent.click(screen.getByText("connect")));
    request.mockImplementation(() => { throw new Error("Method not supported"); });
    await act(async () => fireEvent.click(screen.getByText("disconnect")));
    expect(screen.getByText("none")).toBeTruthy();
  });
});
