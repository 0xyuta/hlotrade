import type { Plugin, UserConfig } from "vite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadBuildConfig = vi.fn(() => ({ config: null }));
vi.mock("../buildConfig", () => ({ loadBuildConfig: (...a: unknown[]) => loadBuildConfig(...(a as [])) }));

import viteConfig from "../vite.config";

type ConfigFn = (env: { mode: string; command: "build" | "serve"; isSsrBuild?: boolean; isPreview?: boolean }) => UserConfig;
const run = (mode: string, command: "build" | "serve") => (viteConfig as unknown as ConfigFn)({ mode, command });
const plugin = (c: UserConfig, name: string) => (c.plugins as unknown[]).flat(Infinity).find((p) => (p as Plugin | null)?.name === name) as Plugin;

beforeEach(() => loadBuildConfig.mockClear());

describe("vite.config: the build runs the guarded loader (E1)", () => {
  it("a production build's CSP plugin calls loadBuildConfig with the mainnet flavour", () => {
    const c = run("production", "build");
    expect(plugin(c, "hlo-csp").apply).toBe("build"); // a "serve"-only plugin would never run in `vite build`
    expect(loadBuildConfig).not.toHaveBeenCalled(); // only the plugin calls it, at build start
    (plugin(c, "hlo-csp").buildStart as () => void).call({});
    expect(loadBuildConfig).toHaveBeenCalledWith("mainnet", expect.any(Object));
  });
  it("--mode testnet builds use the testnet flavour", () => {
    (plugin(run("testnet", "build"), "hlo-csp").buildStart as () => void).call({});
    expect(loadBuildConfig).toHaveBeenCalledWith("testnet", expect.any(Object));
  });
  it("the dev server checks its file when it starts", () => {
    run("development", "serve");
    expect(loadBuildConfig).toHaveBeenCalledWith("dev", expect.any(Object));
  });
  it("a loader error fails the build (it is not caught)", () => {
    loadBuildConfig.mockImplementationOnce(() => {
      throw new Error("[hlo] refused");
    });
    expect(() => (plugin(run("production", "build"), "hlo-csp").buildStart as () => void).call({})).toThrow("[hlo] refused");
  });
});
