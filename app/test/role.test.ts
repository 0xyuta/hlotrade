import { afterEach, describe, expect, it, vi } from "vitest";
import { HL_HOSTS } from "../src/config/csp";
import { fetchAgentMaster, parseAgentMaster } from "../src/hl/role";

const MASTER = "0x00000000000000000000000000000000000000aa";
const AGENT = "0x89AEF553A06ab0C3173e79DE1Ce241A9ed3b992C";
afterEach(() => vi.unstubAllGlobals());

describe("parseAgentMaster [P4 §6]", () => {
  it("an agent's master, lowercased", () => {
    expect(parseAgentMaster({ role: "agent", data: { user: "0x00000000000000000000000000000000000000AA" } })).toBe(MASTER);
  });
  it("anything else is not an approved agent", () => {
    for (const raw of [{ role: "user" }, { role: "missing" }, { role: "agent" }, { role: "agent", data: { user: "0x12" } }, null, "agent", { role: "subAccount", data: { master: MASTER } }]) {
      expect(parseAgentMaster(raw)).toBeNull();
    }
  });
});

describe("fetchAgentMaster", () => {
  it("posts userRole for the lowercased agent to the network's info endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ role: "agent", data: { user: MASTER } })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchAgentMaster("testnet", AGENT)).toBe(MASTER);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${HL_HOSTS.testnet.api}/info`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ type: "userRole", user: AGENT.toLowerCase() });
  });
  it("a non-2xx or a network failure throws (the page offers a retry)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 502 })));
    await expect(fetchAgentMaster("mainnet", AGENT)).rejects.toThrow(/HTTP 502/);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(fetchAgentMaster("mainnet", AGENT)).rejects.toThrow();
  });
});
