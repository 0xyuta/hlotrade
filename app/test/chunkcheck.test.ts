import { describe, expect, it } from "vitest";
import { CHUNK_RULES, NOT_FOR_PAIR, checkChunks, shortId, staticClosure, toChunkInfo, type ChunkInfo } from "../chunkCheck";

const c = (file: string, o: Partial<ChunkInfo> = {}): ChunkInfo => ({ file, isEntry: false, imports: [], modules: [], bytes: 100, ...o });

const good = (): ChunkInfo[] => [
  c("index.js", { isEntry: true, imports: ["vendor.js"], modules: ["src/main.tsx", "src/config/load.ts", "src/ui/ErrorBoundary.tsx"] }),
  c("vendor.js", { modules: ["node_modules/react-dom/index.js", "node_modules/viem/_esm/accounts/index.js"] }),
  c("App.js", { imports: ["vendor.js", "hl.js"], modules: ["src/App.tsx", "src/ui/trade/TradeScreen.tsx", "src/ui/AccountMenu.tsx"] }),
  c("hl.js", { modules: ["node_modules/@nktkas/hyperliquid/esm/mod.js"] }),
  c("Chart.js", { imports: ["hl.js"], modules: ["src/ui/trade/Chart.tsx", "node_modules/lightweight-charts/dist/x.js"] }),
  c("Rewards.js", { modules: ["src/ui/rewards/RewardsScreen.tsx"] }),
  c("Transfer.js", { modules: ["src/ui/transfer/TransferModal.tsx"] }),
  c("PairPage.js", { imports: ["vendor.js"], modules: ["src/ui/pair/PairPage.tsx", "src/ui/pair/Scanner.tsx", "src/ui/pair/scan.ts", "src/hl/pairing.ts", "src/hl/pairCode.ts", "src/hl/role.ts", "src/hl/agent.ts", "src/ui/format.ts"] }),
  c("jsQR.js", { modules: ["node_modules/jsqr/dist/jsQR.js"] }),
  c("PairModal.js", { modules: ["src/ui/PairModal.tsx", "node_modules/qrcode/lib/browser.js"] }),
  c("SolanaFlow.js", { imports: ["solana.js"], modules: ["src/ui/transfer/SolanaFlow.tsx", "src/routes/solana/burn.ts", "src/wallet/solana.ts", "node_modules/@wallet-standard/app/lib/esm/wallets.js"] }),
  c("solana.js", { modules: ["src/routes/solana/rpc.ts", "src/routes/solana/constants.ts", "node_modules/@solana/kit/dist/index.browser.mjs"] }),
  c("poll.js", { imports: ["solana.js", "Transfer.js"], modules: ["src/routes/solana/poll.ts", "src/routes/solana/settle.ts"] }),
];

describe("checkChunks", () => {
  it("a good split passes", () => {
    expect(checkChunks(good())).toEqual([]);
  });
  it("finds a trading module the entry loads through a shared static import", () => {
    const chunks = good();
    chunks[1].modules.push("node_modules/@nktkas/hyperliquid/esm/api/info.js");
    expect(checkChunks(chunks).join("\n")).toMatch(/entry loads node_modules\/@nktkas\/hyperliquid\/esm\/api\/info\.js up front/);
  });
  it("a module reached only through a dynamic import is not loaded up front", () => {
    expect(staticClosure(good(), good()[0]).map((x) => x.file).sort()).toEqual(["index.js", "vendor.js"]);
  });
  it("the App chunk must not pull the chart, rewards, transfer or pair modal in", () => {
    const chunks = good();
    chunks[2].imports.push("Chart.js");
    expect(checkChunks(chunks).join("\n")).toMatch(/src\/App\.tsx loads src\/ui\/trade\/Chart\.tsx up front/);
  });
  it("the App chunk must not pull the Referrals screen in (Plan 10)", () => {
    const chunks = good();
    chunks[2].modules.push("src/ui/referrals/ReferralsScreen.tsx");
    expect(checkChunks(chunks).join("\n")).toMatch(/src\/App\.tsx loads src\/ui\/referrals\/ReferralsScreen\.tsx up front/);
  });
  it("the App chunk must not pull the Tokenomics screen in (Plan 10)", () => {
    const chunks = good();
    chunks[2].modules.push("src/ui/tokenomics/TokenomicsScreen.tsx");
    expect(checkChunks(chunks).join("\n")).toMatch(/src\/App\.tsx loads src\/ui\/tokenomics\/TokenomicsScreen\.tsx up front/);
  });
  it("the App chunk must not pull the Bots screen in", () => {
    const chunks = good();
    chunks[2].modules.push("src/ui/bots/BotsScreen.tsx");
    expect(checkChunks(chunks).join("\n")).toMatch(/src\/App\.tsx loads src\/ui\/bots\/BotsScreen\.tsx up front/);
  });
  it("the App chunk must not pull the Explore screen in", () => {
    const chunks = good();
    chunks[2].modules.push("src/ui/explore/ExploreScreen.tsx");
    expect(checkChunks(chunks).join("\n")).toMatch(/src\/App\.tsx loads src\/ui\/explore\/ExploreScreen\.tsx up front/);
  });
  it("the phone's pair page must not load the trading code or jsQR up front", () => {
    const chunks = good();
    chunks.find((x) => x.file === "PairPage.js")!.imports.push("hl.js", "jsQR.js");
    const text = checkChunks(chunks).join("\n");
    expect(text).toMatch(/src\/ui\/pair\/PairPage\.tsx loads node_modules\/@nktkas\//);
    expect(text).toMatch(/src\/ui\/pair\/PairPage\.tsx loads node_modules\/jsqr\//);
  });
  it("the pair page must not share the App chunk, or any App-only module, with the App", () => {
    const withApp = good();
    withApp.find((x) => x.file === "PairPage.js")!.imports.push("App.js");
    expect(checkChunks(withApp).join("\n")).toMatch(/src\/ui\/pair\/PairPage\.tsx loads src\/App\.tsx/);
    for (const m of ["src/hl/trade.ts", "src/hl/HlProvider.tsx", "src/rewards/useRewards.ts", "src/routes/exec.ts", "src/ui/TopBar.tsx", "src/ui/AccountMenu.tsx", "src/wallet/eip6963.ts"]) {
      const chunks = good();
      chunks.find((x) => x.file === "PairPage.js")!.modules.push(m);
      expect(checkChunks(chunks).join("\n"), m).toContain(`src/ui/pair/PairPage.tsx loads ${m} up front`);
    }
  });
  it("/pair loads only what is allowed: src/geo or any new directory is the App's (an allow-list; Task 7 review m2)", () => {
    for (const m of ["src/geo/blocked.ts", "src/newdir/x.ts", "src/hl/trade.ts", "src/ui/Modal.tsx", "src/App.tsx", "src/routes/list.ts"]) {
      const chunks = good();
      chunks.find((x) => x.file === "PairPage.js")!.modules.push(m);
      expect(checkChunks(chunks).join("\n"), m).toMatch(new RegExp(`src/ui/pair/PairPage\\.tsx loads ${m.replace(/[./]/g, "\\$&")} up front`));
    }
    for (const m of ["src/config/load.ts", "src/entry.ts", "src/main.tsx", "src/styles.css", "src/hl/agent.ts", "src/hl/pairCode.ts", "src/hl/pairing.ts", "src/hl/role.ts", "src/ui/pair/Scanner.tsx", "src/ui/format.ts", "src/ui/Loading.tsx", "src/ui/ErrorBoundary.tsx", "src/ui/NotDeployed.tsx"]) {
      expect(NOT_FOR_PAIR.test(m), m).toBe(false);
    }
    expect(NOT_FOR_PAIR.test("node_modules/react/index.js")).toBe(false); // packages have their own rules
  });
  it("a chunk's size is counted in bytes, not characters", () => {
    const info = toChunkInfo({ fileName: "a.js", isEntry: false, imports: [], modules: { "/app/src/a.ts": {} }, code: "é€" }, "/app");
    expect(info.bytes).toBe(5);
    expect(info.modules).toEqual(["src/a.ts"]);
  });
  it("jsQR in the entry chunk or in the App chunk is a problem (it is for the scanner's lazy import alone)", () => {
    const inEntry = good();
    inEntry[0].modules.push("node_modules/jsqr/dist/jsQR.js");
    expect(checkChunks(inEntry).join("\n")).toMatch(/entry loads node_modules\/jsqr\/dist\/jsQR\.js up front/);
    const inApp = good();
    inApp.find((x) => x.file === "App.js")!.imports.push("jsQR.js");
    expect(checkChunks(inApp).join("\n")).toMatch(/src\/App\.tsx loads node_modules\/jsqr\//);
  });
  it("the entry and the App must not hold the pair page", () => {
    const chunks = good();
    chunks[0].modules.push("src/ui/pair/PairPage.tsx");
    expect(checkChunks(chunks).join("\n")).toMatch(/entry loads src\/ui\/pair\/PairPage\.tsx up front/);
  });
  it("a missing chunk for a rule is a problem, not a pass", () => {
    expect(checkChunks(good().filter((x) => x.file !== "App.js"))).toEqual(["no chunk is built for src/App.tsx (is it still imported lazily?)"]);
  });
  it("a start that ended up in the entry chunk is a problem too (the lazy import is gone)", () => {
    const chunks = good().filter((x) => x.file !== "App.js");
    chunks[0].modules.push("src/App.tsx");
    expect(checkChunks(chunks, [{ from: "src/App.tsx", mustNotContain: [] }])).toEqual(["no chunk is built for src/App.tsx (is it still imported lazily?)"]);
  });
  it("every rule names a start", () => {
    expect(CHUNK_RULES.map((r) => r.from)).toEqual(expect.arrayContaining(["entry", "src/App.tsx", "src/ui/pair/PairPage.tsx", "src/ui/transfer/TransferModal.tsx", "src/routes/solana/poll.ts"]));
  });
  it("the transfer modal must not load Solana code up front (scope C)", () => {
    const chunks = good();
    chunks.find((x) => x.file === "Transfer.js")!.imports.push("SolanaFlow.js");
    const text = checkChunks(chunks).join("\n");
    expect(text).toMatch(/src\/ui\/transfer\/TransferModal\.tsx loads node_modules\/@solana\/kit\//);
    expect(text).toMatch(/src\/ui\/transfer\/TransferModal\.tsx loads src\/routes\/solana\/burn\.ts/);
    expect(text).toMatch(/src\/ui\/transfer\/TransferModal\.tsx loads node_modules\/@wallet-standard\//);
  });
  it("Solana code in the entry, the App chunk or the phone's /pair chunk is a problem", () => {
    for (const [file, from] of [["index.js", "entry"], ["App.js", "src/App.tsx"], ["PairPage.js", "src/ui/pair/PairPage.tsx"]]) {
      const chunks = good();
      chunks.find((x) => x.file === file)!.imports.push("solana.js");
      expect(checkChunks(chunks).join("\n"), file).toContain(`${from} loads node_modules/@solana/kit/dist/index.browser.mjs up front`);
    }
  });
  it("the Solana poll chunk stays small: no form, no wallet code, no deposit or withdraw builder", () => {
    for (const m of ["src/ui/transfer/SolanaFlow.tsx", "src/wallet/solana.ts", "node_modules/@wallet-standard/app/lib/esm/wallets.js", "src/routes/solana/burn.ts", "src/routes/solana/deposit.ts", "src/routes/solana/withdraw.ts"]) {
      const chunks = good();
      chunks.find((x) => x.file === "poll.js")!.modules.push(m);
      expect(checkChunks(chunks).join("\n"), m).toContain(`src/routes/solana/poll.ts loads ${m} up front`);
    }
  });
});

describe("shortId", () => {
  const APP = "/w/hlo/app/";
  it("app files become src/…, packages node_modules/<pkg>/…, wherever node_modules is", () => {
    expect(shortId("/w/hlo/app/src/App.tsx", APP)).toBe("src/App.tsx");
    expect(shortId("/w/hlo/node_modules/viem/_esm/index.js", APP)).toBe("node_modules/viem/_esm/index.js");
    expect(shortId("/w/hlo/app/node_modules/qrcode/lib/browser.js?commonjs-proxy", APP)).toBe("node_modules/qrcode/lib/browser.js");
    expect(shortId("\0vite/preload-helper.js", APP)).toBe("vite/preload-helper.js");
  });
});
