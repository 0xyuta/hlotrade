import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sendAlert } from "./alerts.js";
import { checkpointsAbi } from "./abi.js";
import { chainNow, checkpointConstants, makeCtx, send, type Ctx } from "./context.js";
import { envFor, feedMaxSilenceMs, loadConfig, registrySource, rewardsSource, wsUrlFor, type Config } from "./config.js";
import { Forwarder } from "./forwarder.js";
import { Keeper } from "./keeper.js";
import { Ingest } from "./ingest.js";
import { builderRewardsUnits, MAINNET, perpCoins, TESTNET, userFillsByTime, type HlNet } from "./hl.js";
import { Pacer, pacedFills } from "./pacer.js";
import { checkPosterKey, Poster, savedTrackerJson } from "./poster.js";
import { R2 } from "./r2.js";
import { DirRegistry, R2Registry, type Registry } from "./registry.js";
import { seedBlocks } from "./seed.js";
import { signCheckpoint } from "./sign.js";
import { ChainTracker, viemChainReader } from "./snapshot.js";
import type { Store } from "./store.js";
import { TradeFeed } from "./tradefeed.js";
import { fetchDayFile } from "./fills-source.js";
import { readPublished } from "./checkpoint-files.js";
import { makeWallet } from "./chain.js";
import { buildRecovery, formatRecovery, loadRecoveryInput } from "./recovery.js";
import { checkVerifierKeys, makeDailyCheck, savedVerifierTracker, Verifier, type ChainEvent } from "./verifier.js";

const envFile = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const [cmd, flag] = process.argv.slice(2);
const cfg = loadConfig(envFor(cmd, process.env));
const alert = (s: string) => sendAlert(process.env, s);

/** The poster's real dependencies. It reads the chain and Hyperliquid, signs, and publishes; it sends no transaction. */
function makeRegistry(rs: ReturnType<typeof registrySource>, store: Store): Registry {
  if (rs.kind === "dir") return new DirRegistry(rs.dir);
  return new R2Registry(new R2(rs.creds), rs.chainId, store);
}

/** The trade feed for a long-running process. One pass (`--once`) cannot wait for it to go live and reads every wallet. */
function makeFeed(cfg: Config, net: HlNet, log: (s: string) => void, once: boolean): TradeFeed | null {
  if (!cfg.tradeFeed || once) return null;
  const feed = new TradeFeed({ url: wsUrlFor(cfg.hlApi), coins: () => perpCoins(net), log, maxSilenceMs: feedMaxSilenceMs(cfg.chainId) });
  feed.start();
  return feed;
}

async function makePoster(ctx: Ctx): Promise<Poster> {
  const { cfg } = ctx;
  if (!cfg.posterKey) throw new Error("POSTER_KEY is required");
  const account = privateKeyToAccount(cfg.posterKey);
  const readPoster = () => ctx.client.readContract({ address: ctx.d.checkpoints, abi: checkpointsAbi, functionName: "poster" });
  await checkPosterKey(account.address, readPoster);
  const { launchTime } = await checkpointConstants(ctx);
  const rs = registrySource(cfg, "poster");
  const registry = makeRegistry(rs, ctx.store);
  const net: HlNet = { ...(cfg.chainId === 999 ? MAINNET : TESTNET), api: cfg.hlApi };
  const reader = viemChainReader(ctx);
  const saved = savedTrackerJson(ctx.store);
  const fills = pacedFills(new Pacer(cfg.hlFillsPerMinute), (user, startMs, endMs) => userFillsByTime(user, startMs, endMs, net));
  return new Poster({
    now: async () => {
      const b = await chainNow(ctx);
      return { time: b.timestamp, block: b.number };
    },
    registry,
    ingest: new Ingest(ctx.store, { fills }, launchTime),
    tracker: saved ? ChainTracker.fromJSON(saved, reader, cfg.logChunk) : new ChainTracker(reader, cfg.logChunk),
    checkSigner: () => checkPosterKey(account.address, readPoster),
    settledMinute: async () => {
      const read = (functionName: "anySettled" | "latestMinute") => ctx.client.readContract({ address: ctx.d.checkpoints, abi: checkpointsAbi, functionName });
      const [anySettled, latestMinute] = await Promise.all([read("anySettled"), read("latestMinute")]);
      return anySettled ? Number(latestMinute) : null;
    },
    sign: (cp) => signCheckpoint(account, cfg.chainId, ctx.d.checkpoints, cp),
    publish: ctx.publisher,
    store: ctx.store,
    launchTime,
    seeds: (from, through, lo, hi) => seedBlocks(ctx.client, launchTime, from, through, lo, hi),
    chainId: cfg.chainId,
    contract: ctx.d.checkpoints,
    graceSeconds: cfg.checkpointGraceSeconds,
    deployBlock: ctx.d.deployBlock,
    feed: makeFeed(cfg, net, ctx.log, flag === "--once"),
    log: ctx.log,
    alert: ctx.alert,
  });
}

/**
 * The verifier's real dependencies. It reads the chain, Hyperliquid and the published files; its only transaction is the
 * pauser's pause(), on every chain, with PAUSER_KEY. It never holds the guardian's key.
 */
async function makeVerifier(ctx: Ctx): Promise<Verifier> {
  const { cfg } = ctx;
  const pauserKey = cfg.pauserKey;
  await checkVerifierKeys({
    chainId: cfg.chainId,
    guardianKey: Boolean(cfg.guardianKey),
    pauser: pauserKey ? privateKeyToAccount(pauserKey).address : null,
    readPauser: () => ctx.client.readContract({ address: ctx.d.checkpoints, abi: checkpointsAbi, functionName: "pauser" }),
  });
  const { launchTime } = await checkpointConstants(ctx);
  const rs = registrySource(cfg, "verifier");
  const registry = makeRegistry(rs, ctx.store);
  const src = rewardsSource(cfg);
  const base = src.kind === "url" ? src.base : { dir: src.dir };
  const net = { ...(cfg.chainId === 999 ? MAINNET : TESTNET), api: cfg.hlApi };
  const reader = viemChainReader(ctx);
  const saved = savedVerifierTracker(ctx.store);
  const cp = { address: ctx.d.checkpoints, abi: checkpointsAbi } as const;
  return new Verifier({
    now: async () => {
      const b = await chainNow(ctx);
      return { time: b.timestamp, block: b.number };
    },
    read: (path) => readPublished(base, path),
    registry,
    fills: pacedFills(new Pacer(cfg.hlFillsPerMinute), (user, startMs, endMs) => userFillsByTime(user, startMs, endMs, net)),
    feed: makeFeed(cfg, net, ctx.log, flag === "--once"),
    graceSeconds: cfg.checkpointGraceSeconds,
    omissionFullMax: cfg.omissionFullMax,
    // the fake Hyperliquid of the e2e (anvil) has no `referral` endpoint
    builderRewards: cfg.chainId === 31337 ? null : () => builderRewardsUnits(cfg.builder, net),
    tracker: saved ? ChainTracker.fromJSON(saved, reader, cfg.logChunk) : new ChainTracker(reader, cfg.logChunk),
    wasPoster: (a) => ctx.client.readContract({ ...cp, functionName: "wasPoster", args: [a] }),
    cancelled: async () => {
      const n = Number(await ctx.client.readContract({ ...cp, functionName: "cancelledCount" }));
      const out: { from: number; to: number }[] = [];
      for (let i = 0; i < n; i++) {
        const [f, t] = await ctx.client.readContract({ ...cp, functionName: "cancelledAt", args: [BigInt(i)] });
        out.push({ from: Number(f), to: Number(t) });
      }
      return out;
    },
    events: async (from, to) => {
      const out: ChainEvent[] = [];
      for (let a = from; a <= to; a += cfg.logChunk) {
        const b = a + cfg.logChunk - 1n < to ? a + cfg.logChunk - 1n : to;
        const logs = await ctx.client.getContractEvents({ ...cp, fromBlock: a, toBlock: b });
        for (const l of logs) {
          const block = l.blockNumber;
          if (l.eventName === "Settled") out.push({ kind: "settled", throughMinute: Number(l.args.throughMinute!), root: l.args.root!, block });
          else if (l.eventName === "PosterSet") out.push({ kind: "posterSet", address: l.args.poster!, block });
          else if (l.eventName === "GuardianSet") out.push({ kind: "guardianSet", address: l.args.guardian!, block });
          else if (l.eventName === "PauserSet") out.push({ kind: "pauserSet", address: l.args.pauser!, block });
          else if (l.eventName === "Cancelled") out.push({ kind: "cancelled", from: Number(l.args.fromMinute!), to: Number(l.args.toMinute!), block });
          else if (l.eventName === "WrittenOff") out.push({ kind: "writtenOff", amount: l.args.amount!, total: l.args.total!, block });
          else if (l.eventName === "PausedSet") out.push({ kind: "pausedSet", paused: l.args.paused!, block });
        }
      }
      return out;
    },
    pause: pauserKey
      ? async () => {
          const wallet = makeWallet(cfg, pauserKey);
          const call = { address: ctx.d.checkpoints, abi: checkpointsAbi, functionName: "pause", args: [] } as const;
          await ctx.client.simulateContract({ ...call, account: wallet.account });
          await send(ctx, wallet, call);
        }
      : null,
    store: ctx.store,
    launchTime,
    seeds: (from, through, lo, hi) => seedBlocks(ctx.client, launchTime, from, through, lo, hi),
    chainId: cfg.chainId,
    contract: ctx.d.checkpoints,
    deployBlock: ctx.d.deployBlock,
    fileDelayHours: cfg.fileDelayHours,
    alert: ctx.alert,
    log: ctx.log,
    dailyCheck:
      cfg.chainId === 999
        ? makeDailyCheck({
            store: ctx.store,
            registry,
            launchTime,
            file: async (day) => {
              const r = await fetchDayFile(cfg.fills, cfg.builder, day);
              return r.kind === "file" ? r.text : null;
            },
          })
        : null,
  });
}

if (cmd === "poster") {
  const p = await makePoster(await makeCtx(cfg, "poster", alert));
  if (flag === "--once") console.log(await p.tick());
  else await p.run();
} else if (cmd === "verifier") {
  const v = await makeVerifier(await makeCtx(cfg, "verifier", alert));
  if (flag === "--once") console.log(await v.tick());
  else await v.run();
} else if (cmd === "forwarder") {
  const f = new Forwarder(await makeCtx(cfg, "forwarder", alert));
  if (flag === "--once") console.log(await f.runOnce());
  else await f.loop();
} else if (cmd === "keeper") {
  const k = new Keeper(await makeCtx(cfg, "keeper", alert));
  if (flag === "--once") console.log(await k.runOnce());
  else await k.loop();
} else if (cmd === "recovery") {
  // Read-only: prints the Safe transactions for a recovery (spec 2026-10-30 §4). The store is the verifier's state dir.
  const np = process.env.NEW_POSTER?.trim();
  if (np && !/^0x[0-9a-fA-F]{40}$/.test(np)) throw new Error("NEW_POSTER must be an address");
  const ctx = await makeCtx(cfg, "verifier", alert);
  console.log(formatRecovery(buildRecovery(await loadRecoveryInput(ctx, np ? (np as Address) : null))));
} else {
  console.error("usage: main.ts poster|verifier|forwarder|keeper|recovery [--once]");
  process.exit(2);
}
