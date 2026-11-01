// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signCheckpoint } from "../../ops/src/sign";
import type { AppConfig } from "../src/config/validate";
import type { LatestFile, UserFile } from "../src/rewards/files";
import { parseLatest, parseUserFile } from "../src/rewards/files";
import { pointsText, UPDATING } from "../src/rewards/model";
import { FIX_CHAIN_ID, FIX_CONTRACT, FIX_LAUNCH, FIX_OTHER_ACCOUNT, FIX_POSTER_ACCOUNT, FIX_THROUGH, FIX_USERS, makeLatest } from "./helpers/checkpoint-fixture";

const A = FIX_USERS[0];
const B = FIX_USERS[1];
const NOBODY = "0x00000000000000000000000000000000000000ee"; // in users/00.json's range, with no entry
const ELSEWHERE = "0xab12000000000000000000000000000000000001"; // users/ab.json, which the fixture does not write
const BASE = "https://store.example/998/";
let cfg: AppConfig;
const readCoreChain = vi.fn();
const readExtraChain = vi.fn();
const readRootOf = vi.fn();

vi.mock("../src/config/context", () => ({ useConfig: () => cfg }));
vi.mock("../src/config/load", () => ({ rewardsBase: "https://store.example/998/" }));
vi.mock("../src/evm/clients", () => ({ publicClient: () => ({}) }));
vi.mock("../src/wallet/chains", () => ({ viemChain: () => ({}) }));
vi.mock("../src/rewards/chain", async (orig) => ({
  ...(await orig<typeof import("../src/rewards/chain")>()),
  readCoreChain: (...a: unknown[]) => readCoreChain(...a),
  readExtraChain: (...a: unknown[]) => readExtraChain(...a),
  readRootOf: (...a: unknown[]) => readRootOf(...a),
}));

import { CLAIM_HOLD_MS, EVERY_MS, useRewards, type RewardsData } from "../src/rewards/useRewards";

const chain = (o: object = {}) => ({
  now: FIX_LAUNCH + 60 * 20, launchTime: FIX_LAUNCH, anySettled: true, latestMinute: FIX_THROUGH - 1, latestValidMinute: FIX_THROUGH - 1, latestRoot: `0x${"99".repeat(32)}`,
  paused: false, poster: FIX_POSTER_ACCOUNT.address, claimed: 0n, claimAvailable: 5000n * 10n ** 18n, ...o,
});
const extra = { user: null, staking: { totalStaked: 1n, undripped: 2n }, protocol: { poolOpen: true } };

// The store is a fake fetch, by URL: latest.json and users/<xx>.json each answer what `latestReply` / `userReply(path)` say.
// A reply is the JSON to serve (200), a status number, an Error (the request fails) or a function returning the Response itself.
type Reply = object | number | Error | (() => Promise<Response>);
let latestReply: Reply;
let userReply: (path: string) => Reply;
const reply = (r: Reply): Promise<Response> => {
  if (r instanceof Error) return Promise.reject(r);
  if (typeof r === "function") return r();
  if (typeof r === "number") return Promise.resolve(new Response("", { status: r }));
  return Promise.resolve(new Response(JSON.stringify(r)));
};
const fetchFn = vi.fn((url: string, _init?: RequestInit) => {
  expect(url.startsWith(BASE)).toBe(true);
  const path = url.slice(BASE.length);
  if (path === "latest.json") return reply(latestReply);
  if (/^users\/[0-9a-f]{2}\.json$/.test(path)) return reply(userReply(path));
  return Promise.reject(new Error(`unexpected request ${url}`));
});
const fetched = (path: string) => fetchFn.mock.calls.filter((c) => c[0] === `${BASE}${path}`);

let made: Awaited<ReturnType<typeof makeLatest>>;
let latest: LatestFile;
let file: UserFile;
let entitlementA: bigint;

beforeEach(async () => {
  made = await makeLatest();
  latest = parseLatest(made.json)!;
  file = parseUserFile(made.userFile(A))!;
  entitlementA = BigInt(file.users[A].entitlement);
  cfg = { network: "testnet", hyperEvmChainId: FIX_CHAIN_ID, contracts: { mining: "0x1", checkpoints: FIX_CONTRACT } } as unknown as AppConfig;
  readCoreChain.mockReset().mockResolvedValue(chain());
  readExtraChain.mockReset().mockResolvedValue(extra);
  readRootOf.mockReset().mockRejectedValue(new Error("rootOf was not expected in this test")); // only a file older than the chain asks for it
  latestReply = made.json;
  userReply = (path) => made.userFiles.get(path) ?? 404; // a path the poster wrote no file for is a 404
  fetchFn.mockClear();
  vi.stubGlobal("fetch", fetchFn);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ready = (r: { current: { state: { kind: string } } }) => r.current.state as unknown as { kind: "ready"; data: RewardsData };

describe("useRewards", () => {
  it("no deployment → off", async () => {
    cfg = { network: "testnet", contracts: null } as unknown as AppConfig;
    const { result } = renderHook(() => useRewards(A));
    expect(result.current.state).toEqual({ kind: "off" });
    await act(async () => {});
    expect(readCoreChain).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("loading, then ready with the verified file, the wallet's numbers and the claim plan, both from its user file", async () => {
    const { result } = renderHook(() => useRewards(A));
    expect(result.current.state.kind).toBe("loading");
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    const d = ready(result).data;
    expect(fetched("latest.json")).toHaveLength(1);
    expect(fetched("users/00.json")).toHaveLength(1); // A's address starts with 0x00
    expect(d.latest).toEqual(latest);
    expect(d.latestProblem).toBeNull();
    expect(d.yours).toMatchObject({ earned: entitlementA, claimed: 0n, claimable: entitlementA, points: BigInt(file.users[A].points), refined: BigInt(file.users[A].refined) });
    expect(d.yours?.vaultShare).toBeGreaterThan(0n);
    expect(d.plan).toMatchObject({ kind: "settleAndClaim", entitlement: entitlementA, sig: file.sig, proof: file.users[A].proof });
    expect(d.plan?.cp).toEqual(made.cp);
    expect(d.yoursAt).toBe(FIX_THROUGH); // the minute of the user file the figures come from
    expect(d.chain.latestMinute).toBe(FIX_THROUGH - 1);
    expect(d).not.toHaveProperty("mine"); // the user file stays inside the hook
    expect(d).not.toHaveProperty("mineUsable");
  });
  it("latest.json is never stored (no-store); the user file is revalidated each poll (no-cache: a 304 when unchanged)", async () => {
    const { result } = renderHook(() => useRewards(A));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    expect(fetched("latest.json")[0][1]).toMatchObject({ cache: "no-store" });
    expect(fetched("users/00.json")[0][1]).toMatchObject({ cache: "no-cache" });
  });
  it("the user file is the one the wallet's address names: another first byte, another URL, and the case of the address does not matter", async () => {
    const { result } = renderHook(() => useRewards(ELSEWHERE.toUpperCase().replace("0X", "0x") as never));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    expect(fetched("users/ab.json")).toHaveLength(1);
    expect(fetched("users/00.json")).toHaveLength(0);
  });
  it("no account → no user file is fetched, no yours, no plan, and the file still shows", async () => {
    const { result } = renderHook(() => useRewards(null));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    expect(readCoreChain.mock.calls[0][2]).toBeNull();
    expect(fetched("latest.json")).toHaveLength(1);
    expect(fetchFn.mock.calls.filter((c) => String(c[0]).includes("/users/"))).toHaveLength(0);
    expect(ready(result).data).toMatchObject({ latest, yours: null, plan: null, latestProblem: null });
  });
  it("an entry whose entitlement contradicts the signed root is not shown: zero figures, no plan, and the problem says so; the others are fine", async () => {
    const u = file.users[A];
    userReply = () => ({ ...made.userFile(A), users: { ...made.userFile(A)!.users, [A]: { ...u, entitlement: (BigInt(u.entitlement) * 9n).toString() } } });
    const { result } = renderHook(() => useRewards(A));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    const d = ready(result).data;
    expect(d.latest).not.toBeNull();
    expect(d.yours).toMatchObject({ earned: 0n, claimable: 0n, points: 0n, refined: 0n, vaultShare: 0n });
    expect(d.plan).toBeNull();
    expect(d.latestProblem).toBe("Your numbers in the rewards file don't match its signed tree.");
    const other = renderHook(() => useRewards(B));
    await waitFor(() => expect(other.result.current.state.kind).toBe("ready"));
    expect(ready(other.result).data.yours?.earned).toBe(BigInt(file.users[B].entitlement));
    expect(ready(other.result).data.latestProblem).toBeNull();
  });
  it("a nonzero entitlement with no proof is a mismatch for that wallet alone", async () => {
    userReply = () => ({ ...made.userFile(A), users: { ...made.userFile(A)!.users, [A]: { ...file.users[A], proof: [] } } });
    const { result } = renderHook(() => useRewards(A));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    expect(ready(result).data).toMatchObject({ yours: { earned: 0n, points: 0n }, plan: null, latestProblem: "Your numbers in the rewards file don't match its signed tree." });
    const other = renderHook(() => useRewards(B));
    await waitFor(() => expect(other.result.current.state.kind).toBe("ready"));
    expect(ready(other.result).data.plan).not.toBeNull();
  });
  it("a wallet the file does not list has zero figures, 0.00 points and no plan, and no problem", async () => {
    const { result } = renderHook(() => useRewards(NOBODY));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    const d = ready(result).data;
    expect(d.yours).toMatchObject({ earned: 0n, claimable: 0n, points: 0n, vaultShare: 0n });
    expect(pointsText(d.yours!.points)).toBe("0.00");
    expect(d.plan).toBeNull();
    expect(d.latestProblem).toBeNull();
  });
  it("a 404 on the user file with a good latest.json: zero figures for the wallet, and no problem text", async () => {
    userReply = () => 404;
    const { result } = renderHook(() => useRewards(A));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    const d = ready(result).data;
    expect(d.latest).toEqual(latest); // the Vault card still has its numbers
    expect(d.yours).toEqual({ earned: 0n, claimed: 0n, claimable: 0n, claimNow: 0n, youGet: 0n, refined: 0n, points: 0n, vaultShare: 0n });
    expect(d.plan).toBeNull();
    expect(d.latestProblem).toBeNull();
    expect(d.yoursAt).toBeNull(); // no file, so no minute: zeros, not a stale figure
  });
  it("a 500 on the user file: yours is null (never a made-up zero), the files could not be read, and the Vault card keeps latest.json", async () => {
    userReply = () => 500;
    const { result } = renderHook(() => useRewards(A));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    const d = ready(result).data;
    expect(d.yours).toBeNull();
    expect(d.plan).toBeNull();
    expect(d.latestProblem).toMatch(/^The reward files could not be read \(.*users\/00\.json.*HTTP 500/);
    expect(d.latest).toEqual(latest);
  });
  it("a user file that fails to load or to parse is the same: yours null and the files could not be read", async () => {
    for (const bad of [new TypeError("Failed to fetch"), { hello: 1 }, { ...made.userFile(A), users: [] }]) {
      userReply = () => bad;
      const { result, unmount } = renderHook(() => useRewards(A));
      await waitFor(() => expect(result.current.state.kind).toBe("ready"));
      expect(ready(result).data.yours, String(bad)).toBeNull();
      expect(ready(result).data.latestProblem, String(bad)).toMatch(/^The reward files could not be read/);
      unmount();
    }
  });
  it("a user file older than the chain's latest settled minute: no plan, 'Rewards are updating…', and the file's own numbers still show", async () => {
    const old = await makeLatest({ throughMinute: FIX_THROUGH - 2 });
    userReply = () => old.userFile(A)!;
    readCoreChain.mockResolvedValue(chain({ latestMinute: FIX_THROUGH - 1 })); // latest.json (minute 4) is ahead of the chain, the file (minute 2) is behind it
    const { result } = renderHook(() => useRewards(A));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    const d = ready(result).data;
    expect(d.plan).toBeNull();
    expect(d.latestProblem).toBe(UPDATING);
    expect(d.latest).toEqual(latest);
    expect(d.yours).toMatchObject({ earned: BigInt(parseUserFile(old.userFile(A))!.users[A].entitlement) });
    expect(d.yours!.earned).toBeGreaterThan(0n);
    expect(d.yours!.earned).not.toBe(entitlementA);
  });
  describe("a user file older than the chain (the keeper or someone settled a newer minute than the poster's last round)", () => {
    // latest.json is minute 4, the chain's latest settled minute is 3, the user file is minute 2: the file is behind the chain.
    // Mining pays against any settled minute that is not cancelled, so the file may still claim if its own minute is settled at its root.
    let old: Awaited<ReturnType<typeof makeLatest>>;
    let oldFile: UserFile;
    beforeEach(async () => {
      old = await makeLatest({ throughMinute: FIX_THROUGH - 2 });
      oldFile = parseUserFile(old.userFile(A))!;
      userReply = () => old.userFile(A)!;
      readCoreChain.mockResolvedValue(chain({ latestMinute: FIX_THROUGH - 1 }));
    });
    it("its own minute is settled at its root: a claim at that minute and no 'updating' text", async () => {
      readRootOf.mockResolvedValue(oldFile.root);
      const { result } = renderHook(() => useRewards(A));
      await waitFor(() => expect(result.current.state.kind).toBe("ready"));
      const d = ready(result).data;
      expect(readRootOf).toHaveBeenCalledTimes(1);
      expect(readRootOf.mock.calls[0][2]).toBe(FIX_THROUGH - 2); // rootOf(the file's minute)
      expect(d.latestProblem).toBeNull();
      expect(d.plan).toMatchObject({ kind: "claim", entitlement: BigInt(oldFile.users[A].entitlement), proof: oldFile.users[A].proof });
      expect(d.plan?.cp.throughMinute).toBe(FIX_THROUGH - 2);
      expect(d.yours?.earned).toBe(BigInt(oldFile.users[A].entitlement));
      expect(d.yoursAt).toBe(FIX_THROUGH - 2);
    });
    it("never settled, or cancelled (rootOf reads zero): 'Rewards are updating…' and no plan, the file's numbers still show", async () => {
      readRootOf.mockResolvedValue(null);
      const { result } = renderHook(() => useRewards(A));
      await waitFor(() => expect(result.current.state.kind).toBe("ready"));
      const d = ready(result).data;
      expect(readRootOf).toHaveBeenCalledTimes(1);
      expect(d.latestProblem).toBe(UPDATING);
      expect(d.plan).toBeNull();
      expect(d.yours?.earned).toBe(BigInt(oldFile.users[A].entitlement));
    });
    it("settled at another root: 'Rewards are updating…' and no plan", async () => {
      readRootOf.mockResolvedValue(`0x${"77".repeat(32)}`);
      const { result } = renderHook(() => useRewards(A));
      await waitFor(() => expect(result.current.state.kind).toBe("ready"));
      expect(ready(result).data.latestProblem).toBe(UPDATING);
      expect(ready(result).data.plan).toBeNull();
    });
    it("a rootOf read that fails is the same as no answer: updating and no plan, and nothing is thrown", async () => {
      readRootOf.mockRejectedValue(new Error("rpc down"));
      const { result } = renderHook(() => useRewards(A));
      await waitFor(() => expect(result.current.state.kind).toBe("ready"));
      expect(ready(result).data.latestProblem).toBe(UPDATING);
      expect(ready(result).data.plan).toBeNull();
      expect(ready(result).data.yours).not.toBeNull();
    });
    it("a wallet that has already claimed more than the file says gets no plan, and no text", async () => {
      readRootOf.mockResolvedValue(oldFile.root);
      readCoreChain.mockResolvedValue(chain({ latestMinute: FIX_THROUGH - 1, claimed: BigInt(oldFile.users[A].entitlement) + 5n }));
      const { result } = renderHook(() => useRewards(A));
      await waitFor(() => expect(result.current.state.kind).toBe("ready"));
      expect(ready(result).data.plan).toBeNull();
      expect(ready(result).data.latestProblem).toBeNull();
      expect(ready(result).data.yours).toMatchObject({ claimable: 0n });
    });
    it("a file that is also badly signed gets nothing, and the chain is not even asked for its root: the signature is checked before the minute", async () => {
      const other = await makeLatest({ signer: FIX_OTHER_ACCOUNT, throughMinute: FIX_THROUGH - 2 });
      userReply = () => other.userFile(A)!;
      readRootOf.mockResolvedValue(parseUserFile(other.userFile(A))!.root); // would vouch for the file, if it were asked
      const { result } = renderHook(() => useRewards(A));
      await waitFor(() => expect(result.current.state.kind).toBe("ready"));
      const d = ready(result).data;
      expect(readRootOf).not.toHaveBeenCalled();
      expect(d.yours).toBeNull();
      expect(d.plan).toBeNull();
      expect(d.yoursAt).toBeNull();
      expect(d.latestProblem).toBe("The reward file was not signed by the rewards poster, so it was ignored.");
    });
    it("an altered file (its root changed after signing) that is also older gets nothing either", async () => {
      userReply = () => ({ ...old.userFile(A), root: `0x${"12".repeat(32)}` });
      readRootOf.mockResolvedValue(`0x${"12".repeat(32)}`);
      const { result } = renderHook(() => useRewards(A));
      await waitFor(() => expect(result.current.state.kind).toBe("ready"));
      expect(readRootOf).not.toHaveBeenCalled();
      expect(ready(result).data.yours).toBeNull();
      expect(ready(result).data.plan).toBeNull();
      expect(ready(result).data.latestProblem).not.toBe(UPDATING);
    });
    it("an ordinary poll costs no extra call: a file at or ahead of the chain never asks for rootOf", async () => {
      userReply = () => made.userFile(A)!; // minute 4, the chain is at 3
      const { result } = renderHook(() => useRewards(A));
      await waitFor(() => expect(result.current.state.kind).toBe("ready"));
      expect(ready(result).data.plan?.kind).toBe("settleAndClaim");
      readCoreChain.mockResolvedValue(chain({ latestMinute: FIX_THROUGH, latestRoot: latest.root }));
      act(() => result.current.reload());
      await waitFor(() => expect(ready(result).data.plan?.kind).toBe("claim"));
      expect(readRootOf).not.toHaveBeenCalled();
    });
  });
  it("a user file signed by someone else is not used: yours null and the reason says so; latest.json still shows", async () => {
    const other = await makeLatest({ signer: FIX_OTHER_ACCOUNT });
    userReply = () => other.userFile(A)!;
    const { result } = renderHook(() => useRewards(A));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    const d = ready(result).data;
    expect(d.yours).toBeNull();
    expect(d.plan).toBeNull();
    expect(d.latestProblem).toBe("The reward file was not signed by the rewards poster, so it was ignored.");
    expect(d.latest).toEqual(latest);
  });
  it("a user file signed for another Checkpoints contract (even with fields rewritten to match) is not used", async () => {
    const elsewhere = "0x00000000000000000000000000000000000000d1";
    const sig = await signCheckpoint(FIX_POSTER_ACCOUNT, FIX_CHAIN_ID, elsewhere, made.cp);
    userReply = () => ({ ...made.userFile(A), contract: elsewhere, sig });
    const { result } = renderHook(() => useRewards(A));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    expect(ready(result).data.yours).toBeNull();
    expect(ready(result).data.plan).toBeNull();
    expect(ready(result).data.latestProblem).toBe("The reward file was not signed by the rewards poster, so it was ignored.");
  });
  it("a user file altered after signing (its root) is not used", async () => {
    userReply = () => ({ ...made.userFile(A), root: `0x${"12".repeat(32)}` });
    const { result } = renderHook(() => useRewards(A));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    expect(ready(result).data.yours).toBeNull();
    expect(ready(result).data.plan).toBeNull();
    expect(ready(result).data.latestProblem).toMatch(/poster/i);
  });
  it("a user file the poster signed at the chain's own minute but with another root is refused as not matching the chain", async () => {
    readCoreChain.mockResolvedValue(chain({ latestMinute: FIX_THROUGH, latestRoot: latest.root })); // latest.json is exactly what the chain settled
    const root = `0x${"77".repeat(32)}` as const;
    const sig = await signCheckpoint(FIX_POSTER_ACCOUNT, FIX_CHAIN_ID, FIX_CONTRACT, { ...made.cp, root });
    userReply = () => ({ ...made.userFile(A), root, sig });
    const { result } = renderHook(() => useRewards(A));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    const d = ready(result).data;
    expect(d.latest).toEqual(latest);
    expect(d.yours).toBeNull();
    expect(d.plan).toBeNull();
    expect(d.latestProblem).toBe("The reward file does not match the chain, so it was ignored.");
  });
  it("a user file newer than the chain: Settle & claim with the user file's own checkpoint, even when latest.json is a minute behind it", async () => {
    const behind = await makeLatest({ throughMinute: FIX_THROUGH - 1 });
    latestReply = behind.json; // the CDN has not yet shown the newest latest.json
    readCoreChain.mockResolvedValue(chain({ latestMinute: FIX_THROUGH - 2, latestRoot: `0x${"55".repeat(32)}` }));
    const { result } = renderHook(() => useRewards(A));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    const d = ready(result).data;
    expect(d.latest?.throughMinute).toBe(FIX_THROUGH - 1);
    expect(d.plan).toMatchObject({ kind: "settleAndClaim", sig: file.sig, entitlement: entitlementA });
    expect(d.plan?.cp).toEqual(made.cp);
    expect(d.plan?.cp.throughMinute).toBe(FIX_THROUGH);
    expect(d.latestProblem).toBeNull();
  });
  it("a user file older than latest.json but equal to the chain's settled minute: a plain claim still works", async () => {
    const old = await makeLatest({ throughMinute: FIX_THROUGH - 1 });
    userReply = () => old.userFile(A)!;
    readCoreChain.mockResolvedValue(chain({ latestMinute: FIX_THROUGH - 1, latestRoot: old.cp.root }));
    const { result } = renderHook(() => useRewards(A));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    const d = ready(result).data;
    expect(d.latestProblem).toBeNull();
    expect(d.plan).toMatchObject({ kind: "claim", entitlement: BigInt(parseUserFile(old.userFile(A))!.users[A].entitlement) });
    expect(d.plan?.cp.throughMinute).toBe(FIX_THROUGH - 1);
  });
  it("HyperEVM unreachable → down, with the reason in plain words (first line only)", async () => {
    readCoreChain.mockRejectedValue(new Error("HTTP request failed.\n\nURL: http://x\nRequest body: {...}"));
    const { result } = renderHook(() => useRewards(A));
    await waitFor(() => expect(result.current.state).toEqual({ kind: "down", error: "HTTP request failed." }));
  });
  it("a Staking failure is not an unhandled rejection when the core read fails too, nor is a failed file read", async () => {
    readCoreChain.mockRejectedValue(new Error("rpc down"));
    readExtraChain.mockRejectedValue(new Error("rpc down"));
    latestReply = new Error("store down");
    userReply = () => new Error("store down");
    const { result } = renderHook(() => useRewards(A));
    await waitFor(() => expect(result.current.state.kind).toBe("down"));
    await act(async () => {});
  });
  it("no file published yet (404): ready, latest null, no problem, and yours null (not zeros: nothing was read)", async () => {
    latestReply = 404;
    const { result } = renderHook(() => useRewards(A));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    expect(ready(result).data).toMatchObject({ latest: null, latestProblem: null, yours: null, plan: null });
  });
  it("a 404 on the user file means zero only while latest.json was read: with latest.json down, its problem text is what shows", async () => {
    latestReply = 503;
    userReply = () => 404;
    const { result } = renderHook(() => useRewards(A));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    const d = ready(result).data;
    expect(d.latest).toBeNull();
    expect(d.yours).toBeNull();
    expect(d.latestProblem).toMatch(/^The reward files could not be read \(.*latest\.json.*HTTP 503/);
  });
  it("both files failing shows latest.json's problem, not the user file's", async () => {
    latestReply = 503;
    userReply = () => 500;
    const { result } = renderHook(() => useRewards(A));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    expect(ready(result).data.latestProblem).toMatch(/latest\.json.*HTTP 503/);
    expect(ready(result).data.latestProblem).not.toMatch(/users\//);
  });
  it("the files unreachable: the chain parts still show, and the problem says the files could not be read", async () => {
    latestReply = 503;
    const { result } = renderHook(() => useRewards(A));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    const d = ready(result).data;
    expect(d.latest).toBeNull();
    expect(d.latestProblem).toMatch(/could not be read.*HTTP 503/);
    expect(d.chain.poster).toBe(FIX_POSTER_ACCOUNT.address);
    expect(d.yours).toBeNull();
  });
  it("a latest.json signed by another key is not used (and so no wallet numbers), and says so", async () => {
    latestReply = (await makeLatest({ signer: FIX_OTHER_ACCOUNT })).json;
    const { result } = renderHook(() => useRewards(A));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    expect(ready(result).data).toMatchObject({ latest: null, yours: null, plan: null });
    expect(ready(result).data.latestProblem).toMatch(/poster/i);
  });
  it("a latest.json whose vault odds are not this network's is refused like a bad file", async () => {
    latestReply = { ...made.json, vault: { ...latest.vault, odds: 1250 } };
    const { result } = renderHook(() => useRewards(A));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    const d = ready(result).data;
    expect(d.latest).toBeNull();
    expect(d.yours).toBeNull();
    expect(d.latestProblem).toBe("The reward file's vault odds are not this network's, so it was ignored.");
  });
  it("a latest.json behind the chain is 'updating', not used", async () => {
    readCoreChain.mockResolvedValue(chain({ latestMinute: FIX_THROUGH + 3 }));
    const { result } = renderHook(() => useRewards(A));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    expect(ready(result).data.latest).toBeNull();
    expect(ready(result).data.latestProblem).toBe(UPDATING);
    expect(ready(result).data.yours).toBeNull();
  });
  it("the chain has settled this very checkpoint: the plan is a plain claim", async () => {
    readCoreChain.mockResolvedValue(chain({ latestMinute: FIX_THROUGH, latestRoot: latest.root }));
    const { result } = renderHook(() => useRewards(A));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    expect(ready(result).data.plan?.kind).toBe("claim");
  });
  it("another account never sees the previous account's data, and a slow old answer is dropped: the chain read and the user file alike", async () => {
    let finishA: (v: unknown) => void = () => {};
    let finishAFile: (r: Response) => void = () => {};
    let calls = 0;
    readCoreChain.mockImplementationOnce(() => new Promise((r) => (finishA = r)));
    userReply = (path) => (++calls === 1 ? () => new Promise<Response>((r) => (finishAFile = r)) : made.userFiles.get(path)!); // A's file is the first one asked for
    const { result, rerender } = renderHook(({ u }: { u: string }) => useRewards(u as never), { initialProps: { u: A as string } });
    rerender({ u: B });
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    finishA(chain({ now: 1 }));
    finishAFile(new Response(JSON.stringify({ ...made.userFile(A), users: { [A]: { ...file.users[A], points: "999999999999" } } })));
    await act(async () => {});
    expect(ready(result).data.chain.now).toBe(FIX_LAUNCH + 60 * 20);
    expect(ready(result).data.yours?.earned).toBe(BigInt(file.users[B].entitlement));
    expect(ready(result).data.yours?.points).toBe(BigInt(file.users[B].points));
  });
  it("a slow user file for the old account is dropped too: its late answer never shows under the new account", async () => {
    let finishA: (r: Response) => void = () => {};
    let calls = 0;
    userReply = (path) => (++calls === 1 ? () => new Promise<Response>((r) => (finishA = r)) : made.userFiles.get(path)!); // A's read is the first one, and it hangs
    const { result, rerender } = renderHook(({ u }: { u: string }) => useRewards(u as never), { initialProps: { u: A as string } });
    await act(async () => {}); // A's chain and latest.json are in, its user file is not
    expect(result.current.state.kind).toBe("loading");
    rerender({ u: B });
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    expect(ready(result).data.yours?.earned).toBe(BigInt(file.users[B].entitlement));
    // A's file arrives late, and says A has far more: it must change nothing
    const rich = { ...made.userFile(A), users: { ...made.userFile(A)!.users, [A]: { ...file.users[A], points: "999999999999" } } };
    await act(async () => finishA(new Response(JSON.stringify(rich))));
    await act(async () => {});
    expect(ready(result).data.yours?.earned).toBe(BigInt(file.users[B].entitlement));
    expect(ready(result).data.yours?.points).toBe(BigInt(file.users[B].points));
    expect(ready(result).data.plan?.entitlement).toBe(BigInt(file.users[B].entitlement));
  });
  it("a network switch with a user file in flight shows only the new network's numbers", async () => {
    let finish: (r: Response) => void = () => {};
    let calls = 0;
    userReply = (path) => (++calls === 1 ? () => new Promise<Response>((r) => (finish = r)) : made.userFiles.get(path)!);
    const { result, rerender } = renderHook(() => useRewards(A));
    await act(async () => {});
    cfg = { ...cfg, network: "mainnet" } as AppConfig;
    rerender();
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    expect(ready(result).data.yours?.earned).toBe(entitlementA);
    await act(async () => finish(new Response(JSON.stringify({ ...made.userFile(A), users: {} }))));
    await act(async () => {});
    expect(ready(result).data.yours?.earned).toBe(entitlementA); // the old network's late, empty file did not replace it
  });
  it("account switch shows loading, not the old account's numbers", async () => {
    const { result, rerender } = renderHook(({ u }: { u: string }) => useRewards(u as never), { initialProps: { u: A as string } });
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    readCoreChain.mockImplementation(() => new Promise(() => {}));
    rerender({ u: B });
    expect(result.current.state.kind).toBe("loading");
  });
  it("Staking or Buyback failing does not pause the rewards: ready, with extraError and no full chain", async () => {
    readExtraChain.mockRejectedValue(new Error("HTTP request failed.\nRequest body: {...}"));
    const { result } = renderHook(() => useRewards(A));
    await waitFor(() => expect(ready(result).data?.extraError).toBe("HTTP request failed."));
    expect(ready(result).data.full).toBeNull();
    expect(ready(result).data.yours).not.toBeNull();
  });
  it("when both groups answer, full is the core chain joined with the extra reads", async () => {
    readCoreChain.mockResolvedValue(chain({ claimed: 7n }));
    readExtraChain.mockResolvedValue({ ...extra, user: { hlo: 1n, staked: 2n, pending: 3n, allowance: 4n } });
    const { result } = renderHook(() => useRewards(A));
    await waitFor(() => expect(ready(result).data?.full).not.toBeNull());
    expect(ready(result).data.full?.user).toEqual({ claimed: 7n, hlo: 1n, staked: 2n, pending: 3n, allowance: 4n });
    expect(ready(result).data.extraError).toBeNull();
  });
  it("a slow Staking read does not hold the rewards back", async () => {
    readExtraChain.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useRewards(A));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    expect(ready(result).data).toMatchObject({ full: null, extraError: null });
  });
  it("a refresh keeps the data on screen (no flash back to loading)", async () => {
    const { result } = renderHook(() => useRewards(A));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    latestReply = () => new Promise(() => {});
    userReply = () => () => new Promise(() => {});
    act(() => result.current.reload());
    await act(async () => {});
    expect(result.current.state.kind).toBe("ready");
    expect(ready(result).data.latest).toEqual(latest);
    expect(ready(result).data.yours?.earned).toBe(entitlementA);
  });
  it("reload() reads again at once", async () => {
    const { result } = renderHook(() => useRewards(A));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    act(() => result.current.reload());
    await waitFor(() => expect(readCoreChain).toHaveBeenCalledTimes(2));
    expect(fetched("latest.json")).toHaveLength(2);
    expect(fetched("users/00.json")).toHaveLength(2);
  });
});

describe("useRewards polling and visibility", () => {
  const setVisibility = (v: "visible" | "hidden") => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
  };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
  });
  const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));

  it("reads again every 30 s while the tab is visible", async () => {
    expect(EVERY_MS).toBe(30_000);
    setVisibility("visible");
    renderHook(() => useRewards(A));
    await flush();
    expect(readCoreChain).toHaveBeenCalledTimes(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(readCoreChain).toHaveBeenCalledTimes(2);
    expect(fetched("latest.json")).toHaveLength(2);
    expect(fetched("users/00.json")).toHaveLength(2);
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(readCoreChain).toHaveBeenCalledTimes(3);
  });
  it("skips the tick while the tab is hidden", async () => {
    setVisibility("visible");
    renderHook(() => useRewards(A));
    await flush();
    setVisibility("hidden");
    await act(async () => void (await vi.advanceTimersByTimeAsync(180_000)));
    expect(readCoreChain).toHaveBeenCalledTimes(1);
  });
  it("reads at once when the tab becomes visible again", async () => {
    setVisibility("visible");
    renderHook(() => useRewards(A));
    await flush();
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(readCoreChain).toHaveBeenCalledTimes(1); // hiding does not read
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(readCoreChain).toHaveBeenCalledTimes(2);
  });
  it("after unmount there is no polling and no visibility reads", async () => {
    setVisibility("visible");
    const { unmount } = renderHook(() => useRewards(A));
    await flush();
    unmount();
    await act(async () => void (await vi.advanceTimersByTimeAsync(120_000)));
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(readCoreChain).toHaveBeenCalledTimes(1);
  });
});

describe("useRewards claim hold", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

  it("the hold lasts at most 10 minutes", () => {
    expect(CLAIM_HOLD_MS).toBe(10 * 60_000);
  });
  it("after a claim, a node that still reports the old claimed cannot make it claimable again, however long it lags, until the 10-minute cap", async () => {
    readExtraChain.mockResolvedValue({ ...extra, user: { hlo: 1n, staked: 2n, pending: 3n, allowance: 4n } });
    const { result } = renderHook(() => useRewards(A));
    await flush();
    expect(ready(result).data.yours?.claimable).toBe(entitlementA);
    act(() => result.current.hold(entitlementA));
    await flush();
    let d = ready(result).data;
    expect(d.chain.claimed).toBe(entitlementA);
    expect(d.yours).toMatchObject({ claimed: entitlementA, claimable: 0n, claimNow: 0n, youGet: 0n });
    expect(d.plan).toBeNull();
    expect(d.full?.user?.claimed).toBe(entitlementA);
    // polls keep reading the old number; the hold covers them well past a minute
    await advance(5 * 60_000);
    expect(readCoreChain.mock.calls.length).toBeGreaterThan(5);
    expect(ready(result).data.yours?.claimable).toBe(0n);
    expect(ready(result).data.plan).toBeNull();
    await advance(CLAIM_HOLD_MS - 5 * 60_000 - 1);
    expect(ready(result).data.yours?.claimable).toBe(0n);
    await advance(2);
    d = ready(result).data;
    expect(d.yours?.claimable).toBe(entitlementA);
    expect(d.plan).not.toBeNull();
    expect(d.chain.claimed).toBe(0n);
  });
  it("a partial claim: the hold is expectClaimed, below the entitlement, and is released when the chain reaches it; the rest stays claimable", async () => {
    readCoreChain.mockResolvedValue(chain({ claimAvailable: 40n }));
    const { result } = renderHook(() => useRewards(A));
    await flush();
    expect(ready(result).data.yours).toMatchObject({ claimable: entitlementA, claimNow: 40n, youGet: 36n });
    expect(ready(result).data.plan?.expectClaimed).toBe(40n);
    act(() => result.current.hold(40n));
    await flush();
    // the chain still reports claimed 0 and allowance 40: the held 40 is taken off the allowance too, so Claim does not offer it a second time
    expect(ready(result).data.yours).toMatchObject({ claimed: 40n, claimable: entitlementA - 40n, claimNow: 0n });
    expect(ready(result).data.chain.claimAvailable).toBe(0n);
    expect(ready(result).data.plan?.expectClaimed).toBe(40n);
    readCoreChain.mockResolvedValue(chain({ claimed: 40n, claimAvailable: 0n }));
    act(() => result.current.reload());
    await flush();
    expect(ready(result).data.yours).toMatchObject({ claimed: 40n, claimable: entitlementA - 40n, claimNow: 0n });
    readCoreChain.mockResolvedValue(chain({ claimed: 3n }));
    act(() => result.current.reload());
    await flush();
    expect(ready(result).data.chain.claimed).toBe(3n); // released, not covered by the old hold
  });
  it("the held amount is taken off the allowance only down to 0, and only while the chain lags behind the hold", async () => {
    readCoreChain.mockResolvedValue(chain({ claimAvailable: 100n }));
    const { result } = renderHook(() => useRewards(A));
    await flush();
    act(() => result.current.hold(30n));
    await flush();
    expect(ready(result).data.chain.claimAvailable).toBe(70n);
    expect(ready(result).data.yours?.claimNow).toBe(70n);
    readCoreChain.mockResolvedValue(chain({ claimed: 30n, claimAvailable: 70n })); // the chain caught up: its own numbers
    act(() => result.current.reload());
    await flush();
    expect(ready(result).data.chain.claimAvailable).toBe(70n);
  });
  it("a hold bigger than the allowance leaves 0, never a negative", async () => {
    readCoreChain.mockResolvedValue(chain({ claimAvailable: 10n }));
    const { result } = renderHook(() => useRewards(A));
    await flush();
    act(() => result.current.hold(50n));
    await flush();
    expect(ready(result).data.chain.claimAvailable).toBe(0n);
  });
  it("once a read shows claimed caught up, the hold is released and the chain's own number is used", async () => {
    const { result } = renderHook(() => useRewards(A));
    await flush();
    act(() => result.current.hold(entitlementA - 5n));
    readCoreChain.mockResolvedValue(chain({ claimed: entitlementA }));
    act(() => result.current.reload());
    await flush();
    expect(ready(result).data.chain.claimed).toBe(entitlementA);
    expect(ready(result).data.yours?.claimable).toBe(0n);
    // released: a later read from a node that lags again is shown as it is, not covered by the old hold
    readCoreChain.mockResolvedValue(chain({ claimed: 3n }));
    act(() => result.current.reload());
    await flush();
    expect(ready(result).data.chain.claimed).toBe(3n);
  });
  it("a hold lower than what the chain reports changes nothing", async () => {
    readCoreChain.mockResolvedValue(chain({ claimed: 100n }));
    const { result } = renderHook(() => useRewards(A));
    await flush();
    act(() => result.current.hold(50n));
    await flush();
    expect(ready(result).data.chain.claimed).toBe(100n);
  });
  it("a hold belongs to the account that claimed: another account is not affected", async () => {
    const { result, rerender } = renderHook(({ u }: { u: string }) => useRewards(u as never), { initialProps: { u: A as string } });
    await flush();
    act(() => result.current.hold(entitlementA));
    rerender({ u: B });
    await flush();
    expect(ready(result).data.yours?.claimed).toBe(0n);
    expect(ready(result).data.yours?.claimable).toBe(BigInt(file.users[B].entitlement));
  });
});
