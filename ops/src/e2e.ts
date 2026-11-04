/**
 * Anvil end-to-end for minute settlement: deploys the real contracts (mock USDC + mock V2 factory; the vault's odds are 1
 * on anvil, so every minute pops), starts a fake Hyperliquid API, and runs the real poster, keeper and verifier (as
 * `main.ts` processes with `--once`) against them. `npm run e2e -w ops` (after `forge build` in contracts/).
 * Uses only anvil's published dev mnemonic. Account roles: #0 deployer, #1 poster (its key leaks in the recovery step),
 * #2 guardian, #3 admin, #4 the replacement poster (recovery step), #5-#6 traders, #7 the attacker in the recovery step,
 * #8 builder, #9 verifier (the pauser), #10 keeper (funded by setBalance).
 * Order matters: the tampered-file step (a fresh verifier pauses Checkpoints), then the recovery step (a leaked poster key
 * settles a bad checkpoint; the guardian cancels it, writes off the excess and replaces the poster), which runs last.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTree, verifyProof, type Addr, type ApiFill } from "@hlo/calc";
import { createTestClient, http, parseAbi, parseEventLogs, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { buybackAbi, checkpointsAbi, erc20Abi, miningAbi, splitterAbi, tokenAbi } from "./abi.js";
import { makeChain, makePublic, makeWallet } from "./chain.js";
import { LATEST_PATH, checkpointPath, parseLatestFile, parseUserFile, userFilePath, type UserFileEntry } from "./checkpoint-files.js";
import { loadConfig } from "./config.js";
import { makeCtx, send } from "./context.js";
import { loadDeployments } from "./deployments.js";
import { Forwarder, type HlPort } from "./forwarder.js";
import { Keeper } from "./keeper.js";
import { signCheckpoint } from "./sign.js";
import { ChainTracker, viemChainReader } from "./snapshot.js";
import { PATIENCE_SECONDS } from "./verifier.js";

const MNEMONIC = "test test test test test test test test test test test junk";
const acct = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
const pk = (i: number) => ("0x" + Buffer.from(acct(i).getHdKey().privateKey!).toString("hex")) as Hex;
const PORT = 8546;
const RPC = `http://127.0.0.1:${PORT}`;
const mockUsdcAbi = parseAbi(["function mint(address to, uint256 amount)"]);
const splitterTotalAbi = parseAbi(["function totalDeposited() view returns (uint256)"]);
const opsDir = fileURLToPath(new URL("..", import.meta.url));
/** anvil and forge live in ~/.foundry/bin, which is not always on PATH. */
const toolEnv = { ...process.env, PATH: [join(homedir(), ".foundry", "bin"), process.env.PATH ?? ""].join(delimiter) };

const lastLine = (out: string) => out.split("\n").pop() ?? "";

let checks = 0;
function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`FAILED: ${what}`);
  checks++;
  console.log(`  ✓ ${what}`);
}

/** True when something already accepts connections on the port (for example an anvil left over from an earlier run). */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
  });
}

async function waitForRpc() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("anvil did not start");
}

function deploy() {
  const contractsDir = fileURLToPath(new URL("../../contracts", import.meta.url));
  try {
    execFileSync(
      "forge",
      ["script", "script/DevDeploy.s.sol", "--sig", "runDev()", "--rpc-url", RPC, "--broadcast", "--private-key", pk(0)],
      {
        cwd: contractsDir,
        env: { ...toolEnv, POSTER: acct(1).address, GUARDIAN: acct(2).address, PAUSER: acct(9).address, ADMIN: acct(3).address },
        stdio: "pipe",
      },
    );
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer };
    console.error(String(err.stdout ?? ""), String(err.stderr ?? ""));
    throw new Error("DevDeploy failed");
  }
}

/** A fake Hyperliquid info API: userFillsByTime from an in-memory list, maxBuilderFee 100. */
function fakeHyperliquid(fills: Map<string, ApiFill[]>): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      try {
        const q = JSON.parse(body) as { type: string; user?: string; startTime?: number; endTime?: number };
        if (req.url !== "/info") throw new Error(`unexpected path ${req.url}`);
        if (q.type === "userFillsByTime") {
          const all = fills.get((q.user ?? "").toLowerCase()) ?? [];
          res.end(JSON.stringify(all.filter((f) => f.time >= q.startTime! && f.time <= q.endTime!)));
        } else if (q.type === "maxBuilderFee") {
          res.end("100");
        } else throw new Error(`unexpected info type ${q.type}`);
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` })));
}

async function main() {
  // Otherwise the e2e would run against whatever answers there, and could not kill it afterwards.
  if (await portInUse(PORT)) throw new Error(`port ${PORT} is already in use: stop what is listening there (an earlier anvil?) and run again`);
  const anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore", env: toolEnv });
  const startFailed = new Promise<never>((_, reject) => {
    anvil.on("error", (e) => reject(new Error(`anvil: ${e.message}`)));
    anvil.on("exit", (code, signal) => reject(new Error(`anvil exited (code ${code}, signal ${signal}) before its RPC answered`)));
  });
  startFailed.catch(() => {});
  let tmp: string | undefined;
  let hl: Server | undefined;
  try {
    await Promise.race([waitForRpc(), startFailed]);

    console.log("deploy");
    deploy();

    tmp = mkdtempSync(join(tmpdir(), "hlo-e2e-"));
    const publicDir = join(tmp, "public");
    const registryDir = join(tmp, "registry");
    mkdirSync(registryDir);

    // ---- fake Hyperliquid
    const fills = new Map<string, ApiFill[]>();
    const started = await fakeHyperliquid(fills);
    hl = started.server;

    // ---- config shared by the in-process parts and the child processes
    const env = (state: string, extra: Record<string, string> = {}): Record<string, string> => ({
      // Blank values keep a stray ops/.env (main.ts loads one, and never overrides what is set) from adding keys or channels.
      POSTER_KEY: "", GUARDIAN_KEY: "", PAUSER_KEY: "", BUILDER_KEY: "", KEEPER_KEY: "", ALERT_WEBHOOK_URL: "", TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_CHAT_ID: "", BLOB_READ_WRITE_TOKEN: "", REWARDS_URL: "", FILLS_URL: "", DEPLOYMENTS: "", BLOB_PREFIX: "",
      SETTLE_AFTER_MINUTES: "60", CHECKPOINT_GRACE_SECONDS: "10", FILE_DELAY_HOURS: "2",
      CHAIN_ID: "31337", RPC_URL: RPC, BUILDER: acct(8).address, REGISTRY_DIR: registryDir,
      STATE_DIR: join(tmp!, "state", state), PUBLISH: `local:${publicDir}`, HL_API: started.url, LOG_CHUNK: "5000", POLL_SECONDS: "1",
      ...extra,
    });
    const alerts: string[] = [];
    const note = (s: string) => {
      alerts.push(s);
      console.log(`    (alert) ${s}`);
    };
    const alert = async (s: string) => note(s);

    /** `main.ts <cmd> --once` as a child process; its stderr ALERT lines are collected. Returns everything it printed to stdout (a poster or verifier prints one word as its last line). */
    const run = (cmd: "poster" | "verifier" | "keeper" | "recovery", e: Record<string, string>): Promise<string> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts", cmd, "--once"], {
          cwd: opsDir,
          env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...e },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (c) => (out += c));
        child.stderr.on("data", (c) => (err += c));
        const timer = setTimeout(() => child.kill(), 120_000);
        child.on("close", (code) => {
          clearTimeout(timer);
          for (const l of err.split("\n")) if (l.startsWith("ALERT: ")) note(l.slice(7));
          if (code !== 0) reject(new Error(`${cmd} --once exited ${code}:\n${out}\n${err}`));
          else resolve(out.trim());
        });
      });
    const posterEnv = env("poster", { POSTER_KEY: pk(1) });
    const keeperEnv = env("keeper", { KEEPER_KEY: pk(10) });
    const verifierEnv = (dir = "verifier") => env(dir, { PAUSER_KEY: pk(9) });

    const cfg = loadConfig(env("inproc", { KEEPER_KEY: pk(10), BUILDER_KEY: pk(8) }));
    const client = makePublic(cfg);
    const test = createTestClient({ mode: "anvil", chain: makeChain(31337, [RPC]), transport: http(RPC) });
    const d = loadDeployments(cfg.deploymentsFile, 31337);
    const ctx = { ...(await makeCtx(cfg, "forwarder", alert)), log: (s: string) => console.log(`    e2e: ${s}`) };
    const nowTs = async () => Number((await client.getBlock({ blockTag: "latest" })).timestamp);
    const warpTo = async (t: number) => {
      await test.setNextBlockTimestamp({ timestamp: BigInt(Math.max(t, (await nowTs()) + 1)) });
      await test.mine({ blocks: 1 });
    };
    const read = <T,>(path: string): T => JSON.parse(readFileSync(join(publicDir, path), "utf8")) as T;
    /** Every wallet's entry, as the app reads them: the merged `users` of the users/<xx>.json files, which must all be `at`'s checkpoint (latest.json has no users). */
    const usersOf = (at: { throughMinute: number }): Record<string, UserFileEntry> => {
      const out: Record<string, UserFileEntry> = {};
      const minutes = new Set<number>();
      for (const name of readdirSync(join(publicDir, "users")).sort()) {
        const f = parseUserFile(readFileSync(join(publicDir, "users", name), "utf8"));
        minutes.add(f.throughMinute);
        Object.assign(out, f.users);
      }
      check(minutes.size === 1 && minutes.has(at.throughMinute), `every users/<xx>.json is minute ${at.throughMinute} (latest.json's)`);
      return out;
    };
    const cp = <T,>(fn: "latestMinute" | "paused" | "anySettled") => client.readContract({ address: d.checkpoints, abi: checkpointsAbi, functionName: fn }) as Promise<T>;
    const bal = (u: Address) => client.readContract({ address: d.token, abi: tokenAbi, functionName: "balanceOf", args: [u] });

    const L = Number(await client.readContract({ address: d.checkpoints, abi: checkpointsAbi, functionName: "launchTime" }));
    const buybackLaunch = await client.readContract({ address: d.buyback, abi: buybackAbi, functionName: "launchTime" });
    check(buybackLaunch >= BigInt(L) && buybackLaunch - BigInt(L) <= 3600n, "Buyback.launchTime() is Checkpoints.launchTime() + 0..1 h");
    console.log(`launch ${L}`);

    // ---- register two wallets
    const [U5, U6] = [5, 6].map((i) => acct(i).address.toLowerCase() as Addr);
    for (const u of [U5, U6]) writeFileSync(join(registryDir, `${u}.json`), JSON.stringify({ user: u, registeredAt: L }));
    check(true, "two wallets registered (accounts #5 and #6, registeredAt = launchTime)");

    // ---- trade: minutes 0..2 at our exact rate (0.1% of px·sz), plus one fill at another rate
    let tid = 1;
    const fill = (minute: number, px: string, sz: string, builderFee: string, coin = "BTC"): ApiFill => ({
      time: (L + 60 * minute + 20) * 1000, coin, px, sz, builderFee, tid: tid++,
    });
    fills.set(U5, [fill(0, "1000", "1", "1"), fill(1, "2000", "0.5", "1"), fill(2, "500", "1", "0.5")]);
    fills.set(U6, [fill(0, "2000", "1", "2"), fill(1, "1000", "0.5", "0.5"), fill(2, "1000", "1", "1"), fill(2, "1000", "1", "3") /* wrong rate */, fill(0, "1000", "1", "1", "@7") /* spot */]);

    // ---- post: minute 2 plus 10 s, three poster passes
    console.log("poster");
    // One block just past each minute's end, so minutes 0..2 get three different seed blocks (a single warp would give them all one).
    await warpTo(L + 60 + 5);
    await warpTo(L + 60 * 2 + 5);
    await warpTo(L + 60 * 3 + 10);
    for (let i = 0; i < 3; i++) {
      const r = lastLine(await run("poster", posterEnv));
      check(r === "published", `poster pass ${i + 1}: ${r}`);
    }
    const latest = parseLatestFile(readFileSync(join(publicDir, LATEST_PATH), "utf8"));
    check(latest.throughMinute === 2, "latest.json is at minute 2");
    for (const m of [0, 1, 2]) check(read<{ throughMinute: number }>(checkpointPath(m)).throughMinute === m, `checkpoints/${m}.json published`);
    const users2 = usersOf(latest);
    check(users2[U5].fees === "250000000" && users2[U6].fees === "350000000", "only fills at our exact rate count (U5 2.5 USDC, U6 3.5 USDC)");
    // Odds 1 on anvil: every minute pops. Minute 0: the traders' 1 HLO splits 1:2 (1 wei of dust), so the vault is
    // 0.1 HLO + 1 wei; 90% of it (0.09 HLO) goes 1:2 by points and 0.01 HLO + 1 wei stays.
    check(latest.vault.odds === 1 && latest.vault.lastPopMinute === 2 && latest.pops.map((p) => p.minute).join(",") === "2,1,0", "odds 1 on anvil: minutes 2, 1 and 0 popped (newest first)");
    check(new Set(latest.pops.map((p) => p.block)).size === 3, "minutes 0, 1 and 2 have three different seed blocks");
    const pop0 = latest.pops[2];
    check(pop0.amount === "90000000000000000" && pop0.kept === "10000000000000001" && pop0.recipients === 2, "minute 0's pop gave 90% of 0.1 HLO + 1 wei to the two traders and kept the rest");
    for (const p of latest.pops) {
      const pay = ((BigInt(p.amount) + BigInt(p.kept)) * 9n) / 10n;
      check(p.recipients === 2 && BigInt(p.amount) <= pay && BigInt(p.amount) > pay - BigInt(p.recipients), `minute ${p.minute}'s pop shared 90% of the vault by points (each share rounded down)`);
      const end = BigInt(L + 60 * (p.minute + 1));
      const [b, before] = await Promise.all([client.getBlock({ blockNumber: BigInt(p.block) }), client.getBlock({ blockNumber: BigInt(p.block) - 1n })]);
      check(b.timestamp >= end && before.timestamp < end, `minute ${p.minute}'s seed block ${p.block} is the first block at or after the minute's end`);
    }
    check(
      latest.vault.amount === latest.pops[0].kept && latest.vault.pointsTotal === "0" && users2[U5].points === "0" && users2[U6].points === "0",
      "after minute 2's pop the vault holds what it kept and every point is back to 0",
    );
    const fromVault = BigInt(users2[U5].fromVault) + BigInt(users2[U6].fromVault);
    check(fromVault === latest.pops.reduce((s, p) => s + BigInt(p.amount), 0n), "the traders' fromVault totals are the three pops' payouts");
    const tree = buildTree(new Map(Object.entries(users2).map(([u, e]) => [u as Addr, BigInt(e.entitlement)] as const)));
    check(tree.root === latest.root, "the tree rebuilt from the user files' entries has the signed root");

    // ---- settle & claim as #5
    console.log("settleAndClaim");
    // The proof comes from #5's own file (users/<xx>.json), as the app reads it.
    const file5 = parseUserFile(readFileSync(join(publicDir, userFilePath(U5)), "utf8"));
    check(
      file5.throughMinute === latest.throughMinute && file5.refBlock === latest.refBlock && file5.root === latest.root && file5.totalEntitled === latest.totalEntitled && file5.sig === latest.sig && file5.publishedAt === latest.publishedAt,
      "the user file carries the checkpoint's signed fields",
    );
    const entry5 = file5.users[U5];
    const mine = { entitlement: BigInt(entry5.entitlement), proof: entry5.proof };
    check(mine.entitlement === BigInt(users2[U5].entitlement) && mine.entitlement > 0n, "#5 has an entitlement");
    check(mine.proof.length > 0 && verifyProof(file5.root, U5, mine.entitlement, mine.proof), "#5's proof comes from its user file and verifies against the signed root");
    const wallet5 = makeWallet(cfg, pk(5));
    const hash = await wallet5.writeContract({
      address: d.mining, abi: miningAbi, functionName: "settleAndClaim", chain: wallet5.chain, account: wallet5.account,
      args: [{ throughMinute: BigInt(latest.throughMinute), refBlock: BigInt(latest.refBlock), root: latest.root, totalEntitled: BigInt(latest.totalEntitled) }, latest.sig, mine.entitlement, mine.proof],
    });
    const rcpt = await client.waitForTransactionReceipt({ hash });
    check(rcpt.status === "success", "settleAndClaim succeeded");
    check((await cp<bigint>("latestMinute")) === 2n, "Checkpoints.latestMinute() == 2");
    check((await bal(acct(5).address)) === (mine.entitlement * 9n) / 10n, "#5 received 90% of its entitlement");
    const claimed = parseEventLogs({ abi: miningAbi, logs: rcpt.logs, eventName: "Claimed" });
    check(claimed.length === 1 && claimed[0].args.user.toLowerCase() === U5 && claimed[0].args.refined === mine.entitlement - (mine.entitlement * 9n) / 10n, "Claimed emitted with 10% refined");
    check(claimed[0].args.claimedTotal === mine.entitlement && (await client.readContract({ address: d.mining, abi: miningAbi, functionName: "claimed", args: [acct(5).address] })) === mine.entitlement, "Claimed.claimedTotal is Mining.claimed[#5] (the whole entitlement: the allowance was not binding)");

    // ---- keeper: 61 minutes later the poster posts minute 3, and the keeper settles it
    console.log("keeper settle");
    await warpTo((await nowTs()) + 61 * 60);
    check(lastLine(await run("poster", posterEnv)) === "published", "poster pass 4 (minute 3, with the refining from #5's claim)");
    const latest3 = parseLatestFile(readFileSync(join(publicDir, LATEST_PATH), "utf8"));
    check(latest3.throughMinute === 3, "latest.json is at minute 3");
    const users3 = usersOf(latest3);
    const pop3 = latest3.pops[0];
    check(
      pop3.minute === 3 && pop3.amount === "0" && pop3.recipients === 0 && pop3.kept === (BigInt(latest.vault.amount) + 10n ** 17n).toString(),
      "minute 3 (nobody traded) popped with no points: it paid nothing and the vault kept everything, 0.1 HLO more (a minute nobody trades mines no trader HLO)",
    );
    check(BigInt(latest3.totalEntitled) >= BigInt(latest.totalEntitled), "totalEntitled did not decrease");
    // Claimed event -> tracker -> poster: minute 3 has no traders and #5 has claimed everything it had, so the whole refining pool
    // (the event's `refined`, no carry before) goes to the only unclaimed holder, #6: floor(pool x base / base) = pool.
    const refinedByClaim = claimed[0].args.refined;
    check(BigInt(users2[U6].refined) === 0n && refinedByClaim > 0n, "before the claim no refining was shared");
    check(BigInt(users3[U6].refined) === refinedByClaim, "#5's 10% refining reached #6 in checkpoint 3, exactly");
    check(users3[U5].refined === users2[U5].refined, "#5, who has claimed everything, received none of it");
    await test.setBalance({ address: acct(10).address, value: 10n ** 19n });
    await test.mine({ blocks: 2 }); // settle() needs refBlock < block.number, and eth_call runs in the head block
    const k = await run("keeper", keeperEnv);
    check(/settle: .settled./.test(k), "keeper settled the newest checkpoint after an hour without a settle");
    check((await cp<bigint>("latestMinute")) >= 3n, "Checkpoints.latestMinute() >= 3");
    check(!k.includes("kind: 'buy'") && k.includes("pool not due yet"), "keeper did not buy (the pool is not open)");

    // ---- verifier: four passes, minutes 0..3
    console.log("verifier");
    await test.mine({ blocks: 5 }); // the verifier reads Settled events up to 3 blocks behind the head
    for (let i = 0; i < 4; i++) {
      const v = lastLine(await run("verifier", verifierEnv()));
      check(v === "ok", `verifier pass ${i + 1} (minute ${i}): ${v}`);
    }
    check(alerts.length === 0, "no alert from the poster, keeper or verifier");
    check(!(await cp<boolean>("paused")), "Checkpoints is not paused");

    console.log("forwarder (EVM leg, fake HyperCore)");
    const usdc = await client.readContract({ address: d.splitter, abi: splitterAbi, functionName: "usdc" });
    const core = { unclaimed: 50_000_000n, perp: 110_000_000n, spot: 0n };
    const minter = makeWallet(cfg, pk(0));
    const fake: HlPort = {
      unclaimed: async () => core.unclaimed,
      perpWithdrawable: async () => core.perp,
      spotUsdc: async () => core.spot,
      claim: async () => void ((core.perp += core.unclaimed), (core.unclaimed = 0n)),
      toSpot: async (a) => void ((core.perp -= a), (core.spot += a)),
      toEvm: async (a) => {
        core.spot -= a;
        await send(ctx, minter, { address: usdc, abi: mockUsdcAbi, functionName: "mint", args: [acct(8).address, a] });
      },
    };
    const steps = await new Forwarder(await makeCtx(cfg, "forwarder", alert), fake).runOnce();
    check(steps.map((s) => s.kind).join(",") === "claim,toSpot,toEvm,deposit,idle", `forwarder steps ${steps.map((s) => s.kind).join(",")}`);
    const deposited = await client.readContract({ address: d.splitter, abi: splitterTotalAbi, functionName: "totalDeposited" });
    check(deposited === 50_000_000n && core.perp === 110_000_000n, "50 USDC reached the Splitter; the 110 USDC reserve stayed");

    console.log("keeper: pool open and buyback");
    const keeper = new Keeper(await makeCtx(cfg, "keeper", alert));
    const openDelay = await client.readContract({ address: d.buyback, abi: buybackAbi, functionName: "OPEN_DELAY" });
    await warpTo(Number(buybackLaunch + openDelay) + 1);
    const k1 = await keeper.runOnce();
    const poolOpen = await client.readContract({ address: d.buyback, abi: buybackAbi, functionName: "poolOpen" });
    check(k1.step.kind === "open" && k1.result === "opened" && poolOpen, "keeper opened the pool once it was due");
    const k2 = await keeper.runOnce();
    check(k2.step.kind === "idle" && k2.step.why.includes("next fee deposit"), "slice 0 right after opening: keeper waits for a fee deposit");
    // A fee deposit raises the slice to 1/144 of Buyback's new USDC (20 USDC → 18 to Buyback).
    await send(ctx, minter, { address: usdc, abi: mockUsdcAbi, functionName: "mint", args: [acct(0).address, 20_000_000n] });
    await send(ctx, minter, { address: usdc, abi: erc20Abi, functionName: "approve", args: [d.splitter, 20_000_000n] });
    await send(ctx, minter, { address: d.splitter, abi: splitterAbi, functionName: "deposit", args: [20_000_000n] });
    const k3 = await keeper.runOnce();
    check(k3.step.kind === "buy" && k3.result === "skipped", "a buy inside the first 30 minutes is a TWAP skip, counted as success");
    const k3b = await keeper.runOnce();
    check(k3b.step.kind === "wait", "after a skip the keeper waits one BUY_INTERVAL");
    await warpTo((await nowTs()) + 31 * 60);
    const burnedBefore = await client.readContract({ address: d.token, abi: tokenAbi, functionName: "totalBurned" });
    const k4 = await keeper.runOnce();
    check(k4.step.kind === "buy" && k4.result === "bought", "keeper bought once the TWAP window had 30 minutes");
    const spent = await client.readContract({ address: d.buyback, abi: buybackAbi, functionName: "totalSpent" });
    check(spent === 18_000_000n / 144n, "the buy spent one 1/144 slice");
    check((await client.readContract({ address: d.token, abi: tokenAbi, functionName: "totalBurned" })) > burnedBefore, "the buy burned HLO");
    // The checkpoints' burned total comes from Transfer-to-zero logs, never from a past-block state read: it must equal totalBurned().
    const head = await client.getBlockNumber();
    const logBurned = (await new ChainTracker(viemChainReader(ctx), 100n).snapshot(d.deployBlock - 1n, head)).burned;
    const stateBurned = await client.readContract({ address: d.token, abi: tokenAbi, functionName: "totalBurned" });
    check(logBurned > 0n && logBurned === stateBurned, `burned from Transfer logs (${logBurned}) equals HloToken.totalBurned() (${stateBurned})`);
    check(alerts.length === 0, "no alert from the forwarder or the in-process keeper");

    // The fresh verifier pauses Checkpoints and stays stopped at minute 3; only the recovery step below runs after this.
    console.log("tampered checkpoint 3");
    const file3 = read<{ root: Hex }>(checkpointPath(3));
    const flipped = file3.root.slice(0, -1) + (file3.root.endsWith("0") ? "1" : "0");
    writeFileSync(join(publicDir, checkpointPath(3)), JSON.stringify({ ...file3, root: flipped }));
    // Any of the verifier's checks may fire first (the Settled event against the file, the signature, the root); it must reach minute 3 at most.
    let result = "";
    for (let i = 0; i < 4 && result !== "mismatch"; i++) result = lastLine(await run("verifier", verifierEnv("verifier-fresh")));
    check(result === "mismatch", "a fresh verifier flags the changed root of checkpoint 3");
    check(alerts.some((a) => a.startsWith("verifier: checkpoint 3 mismatch")), "mismatch alerted");
    check(await cp<boolean>("paused"), "the pauser key paused Checkpoints");

    // Last: the poster's key leaks. The attacker settles a checkpoint that pays itself, claims, and the recovery runs.
    console.log("recovery: a leaked poster key settles a bad checkpoint");
    const ck = <T,>(functionName: string, args: readonly unknown[] = []) =>
      client.readContract({ address: d.checkpoints, abi: checkpointsAbi, functionName, args } as never) as Promise<T>;
    const mn = <T,>(functionName: string, args: readonly unknown[] = []) =>
      client.readContract({ address: d.mining, abi: miningAbi, functionName, args } as never) as Promise<T>;
    const guardian = makeWallet(cfg, pk(2));
    const gsend = (functionName: "setPaused" | "cancelAfter" | "writeOff" | "setPoster", args: readonly unknown[]) =>
      send(ctx, guardian, { address: d.checkpoints, abi: checkpointsAbi, functionName, args });
    // The tamper was a published-file change: nothing bad was settled, so the guardian unpauses.
    await gsend("setPaused", [false]);
    check(!(await cp<boolean>("paused")), "the guardian unpaused Checkpoints after the tampered file");

    const attacker = acct(7);
    const attackerAddr = attacker.address.toLowerCase() as Addr;
    const badMinute = Number(await cp<bigint>("latestMinute")) + 1;
    await warpTo(L + 60 * (badMinute + 1) + 1);
    await test.mine({ blocks: 1 });
    // The most a checkpoint may declare at this minute, and the most Mining lets the attacker take against it (claims are
    // bounded by the declared total): the attacker's leaf is that, at most 100 HLO.
    const badTotal = (await ck<bigint>("emissionAllowedThrough", [BigInt(badMinute)])) + (await mn<bigint>("totalRefined"));
    const room = badTotal - (await mn<bigint>("totalClaimedGross"));
    const stolen = room < 100n * 10n ** 18n ? room : 100n * 10n ** 18n;
    check(stolen > 0n, `the attacker's leaf is ${stolen} (the schedule at minute ${badMinute} allows ${badTotal} in all)`);
    const badTree = buildTree(new Map([[attackerAddr, stolen]]));
    const badCp = { throughMinute: badMinute, refBlock: (await client.getBlockNumber()) - 1n, root: badTree.root, totalEntitled: badTotal };
    const badSig = await signCheckpoint(acct(1), 31337, d.checkpoints, badCp);
    const attackerWallet = makeWallet(cfg, pk(7));
    await send(ctx, attackerWallet, {
      address: d.checkpoints, abi: checkpointsAbi, functionName: "settle",
      args: [{ throughMinute: BigInt(badMinute), refBlock: badCp.refBlock, root: badCp.root, totalEntitled: badCp.totalEntitled }, badSig],
    });
    check((await ck<Hex>("rootOf", [BigInt(badMinute)])) === badTree.root, `the leaked key's checkpoint ${badMinute} is settled`);
    const attackerProof = badTree.proofs.get(attackerAddr)!;
    await send(ctx, attackerWallet, { address: d.mining, abi: miningAbi, functionName: "claim", args: [BigInt(badMinute), stolen, attackerProof.proof] });
    check(
      (await mn<bigint>("claimed", [attacker.address])) === stolen && (await bal(attacker.address)) === (stolen * 9n) / 10n,
      "the attacker claimed its whole leaf and received 90% of it",
    );

    // The main verifier is at minute 4 with no file for it: the Settled event with no published checkpoint becomes a
    // mismatch once PATIENCE_SECONDS of chain time have passed.
    await test.mine({ blocks: 5 });
    const alertsBefore = alerts.length;
    result = "";
    for (let i = 0; i < 4 && result !== "mismatch"; i++) {
      if (i > 0) await warpTo((await nowTs()) + PATIENCE_SECONDS + 1);
      result = lastLine(await run("verifier", verifierEnv()));
    }
    const newAlerts = () => alerts.slice(alertsBefore);
    check(result === "mismatch", `the verifier flags the settled checkpoint ${badMinute} (no published file)`);
    check(
      newAlerts().some((a) => a.startsWith(`verifier: checkpoint ${badMinute} mismatch`) && a.includes("has no published checkpoint")),
      `mismatch of checkpoint ${badMinute} alerted as a settled checkpoint with no published file`,
    );
    check(newAlerts().some((a) => a.startsWith(`verifier: paused Checkpoints because of the checkpoint ${badMinute} mismatch`)), "the verifier announced its pause");
    check(await cp<boolean>("paused"), "the verifier's pauser key paused Checkpoints");

    // The recovery report, from the verifier's state dir.
    const report = await run("recovery", { ...verifierEnv(), NEW_POSTER: acct(4).address });
    console.log(report.split("\n").map((l) => `    | ${l}`).join("\n"));
    check(report.includes("cancelAfter(") && report.includes("writeOff("), "the report lists cancelAfter and writeOff");
    const keepMatch = /keep minute (\d+), cancel minutes (\d+)\.\.(\d+)/.exec(report);
    check(keepMatch !== null && Number(keepMatch[1]) === badMinute - 1 && Number(keepMatch[2]) === badMinute && Number(keepMatch[3]) === badMinute, `the report keeps minute ${badMinute - 1} and cancels ${badMinute}..${badMinute}`);
    const keep = BigInt(keepMatch[1]);
    const writeOffMatch = /writeOff\((\d+)\)/.exec(report);
    check(writeOffMatch !== null && BigInt(writeOffMatch[1]) === stolen, "the report's write-off is exactly what the attacker claimed");
    const writeOffAmount = BigInt(writeOffMatch[1]);
    check(report.includes(`setPoster(${acct(4).address})`), "the report lists setPoster(the new poster)");

    // The guardian (the Safe) sends them in order.
    await gsend("cancelAfter", [keep]);
    await gsend("writeOff", [writeOffAmount]);
    await gsend("setPoster", [acct(4).address]);
    check((await ck<Hex>("rootOf", [BigInt(badMinute)])) === `0x${"0".repeat(64)}`, `rootOf(${badMinute}) reads zero once cancelled`);
    check((await ck<bigint>("latestValidMinute")) === keep && (await ck<boolean>("isCancelled", [BigInt(badMinute)])), `latestValidMinute() is ${keep}; minute ${badMinute} is cancelled`);
    check((await ck<bigint>("writtenOff")) === writeOffAmount, "Checkpoints.writtenOff() is the write-off");
    check((await ck<Address>("poster")).toLowerCase() === acct(4).address.toLowerCase() && (await ck<boolean>("wasPoster", [acct(1).address])), "#4 is the poster; #1 is remembered as a former one");

    // A human clears the verifier's stored mismatch.
    const vDir = join(tmp, "state", "verifier", "verifier");
    const [vId] = readdirSync(vDir);
    const vStatePath = join(vDir, vId, "verifier-state.json");
    writeFileSync(vStatePath, JSON.stringify({ ...JSON.parse(readFileSync(vStatePath, "utf8")), mismatch: null }));

    // The new poster publishes the cancelled minute (it can never be settled again) and the next one; the verifier checks both.
    const newPosterEnv = env("poster", { POSTER_KEY: pk(4) });
    const nextMinute = badMinute + 1;
    await warpTo(L + 60 * (nextMinute + 1) + 11);
    for (const m of [badMinute, nextMinute]) {
      check(lastLine(await run("poster", newPosterEnv)) === "published", `the new poster published minute ${m}`);
      check(read<{ throughMinute: number }>(checkpointPath(m)).throughMinute === m, `checkpoints/${m}.json is the new poster's`);
      await test.mine({ blocks: 1 });
    }
    await test.mine({ blocks: 5 }); // the guardian's events must be 3 blocks behind the head for the verifier to read them
    for (const m of [badMinute, nextMinute]) {
      const v = lastLine(await run("verifier", verifierEnv()));
      check(v === "ok", `the verifier verified the new poster's minute ${m}: ${v}`);
    }
    // Each announcement ends with its event's block (" (block N)").
    check(newAlerts().some((a) => new RegExp(`^checkpoints: cancelled minutes ${badMinute}\\.\\.${badMinute} \\(block \\d+\\)$`).test(a)), "the verifier announced the cancel");
    check(newAlerts().some((a) => /^checkpoints: wrote off .* \(block \d+\)$/.test(a)), "the verifier announced the write-off");
    check(newAlerts().some((a) => new RegExp(`^checkpoints: poster set to ${acct(4).address.toLowerCase()} \\(block \\d+\\)$`).test(a.toLowerCase())), "the verifier announced the new poster");

    await gsend("setPaused", [false]);
    check(!(await cp<boolean>("paused")), "the guardian unpaused Checkpoints");

    // The attacker's leaf is gone; an honest trader claims against the new poster's checkpoint with Settle & claim.
    let attackerRevert = "";
    try {
      await client.simulateContract({ address: d.mining, abi: miningAbi, functionName: "claim", args: [BigInt(badMinute), stolen, attackerProof.proof], account: attacker });
    } catch (e) {
      attackerRevert = (e as Error).message;
    }
    check(attackerRevert.includes("NotSettled"), `the attacker's claim against the cancelled minute ${badMinute} reverts NotSettled`);
    const latestNew = parseLatestFile(readFileSync(join(publicDir, LATEST_PATH), "utf8"));
    check(latestNew.throughMinute === nextMinute, `latest.json is the new poster's minute ${nextMinute}`);
    const usersNew = usersOf(latestNew);
    const treeNew = buildTree(new Map(Object.entries(usersNew).map(([u, e]) => [u as Addr, BigInt(e.entitlement)] as const)));
    check(treeNew.root === latestNew.root, "the tree rebuilt from the new checkpoint's user files has its signed root");
    const file6 = parseUserFile(readFileSync(join(publicDir, userFilePath(U6)), "utf8"));
    check(file6.throughMinute === latestNew.throughMinute && file6.root === latestNew.root && file6.sig === latestNew.sig, "#6's user file is the new poster's checkpoint, with its signed fields");
    const entry6 = file6.users[U6];
    const proof6 = { entitlement: BigInt(entry6.entitlement), proof: entry6.proof };
    check(proof6.entitlement > 0n && proof6.entitlement === BigInt(usersNew[U6].entitlement), "#6 has an entitlement in the new checkpoint");
    check(verifyProof(file6.root, U6, proof6.entitlement, proof6.proof), "#6's proof comes from its user file and verifies against the signed root");
    const bal6 = await bal(acct(6).address);
    const wallet6 = makeWallet(cfg, pk(6));
    const hash6 = await wallet6.writeContract({
      address: d.mining, abi: miningAbi, functionName: "settleAndClaim", chain: wallet6.chain, account: wallet6.account,
      args: [{ throughMinute: BigInt(latestNew.throughMinute), refBlock: BigInt(latestNew.refBlock), root: latestNew.root, totalEntitled: BigInt(latestNew.totalEntitled) }, latestNew.sig, proof6.entitlement, proof6.proof],
    });
    check((await client.waitForTransactionReceipt({ hash: hash6 })).status === "success", `#6's settleAndClaim against minute ${nextMinute} succeeded`);
    check((await ck<bigint>("latestValidMinute")) === BigInt(nextMinute), `latestValidMinute() is ${nextMinute}`);
    check(
      (await mn<bigint>("claimed", [acct(6).address])) === proof6.entitlement && (await bal(acct(6).address)) - bal6 === (proof6.entitlement * 9n) / 10n,
      "#6 claimed its whole entitlement and received 90% of it",
    );

    console.log(`e2e: ${checks} checks passed`);
    rmSync(tmp, { recursive: true, force: true });
  } catch (e) {
    if (tmp) console.error(`state kept in ${tmp}`);
    throw e;
  } finally {
    hl?.close();
    anvil.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
