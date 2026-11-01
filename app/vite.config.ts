import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { loadEnv, type Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { loadBuildConfig } from "./buildConfig";
import { chunkCheck } from "./chunkCheck";
import { cspFor } from "./src/config/csp";
import type { Flavour } from "./src/config/validate";

const APP_DIR = fileURLToPath(new URL(".", import.meta.url));

function flavourOf(mode: string, command: "serve" | "build"): Flavour {
  if (mode === "testnet") return "testnet";
  return command === "serve" ? "dev" : "mainnet";
}

function contentSecurityPolicy(flavour: Flavour, env: Record<string, string>): Plugin {
  let policy = "";
  return {
    name: "hlo-csp",
    apply: "build",
    buildStart() {
      const b = loadBuildConfig(flavour, env);
      policy = cspFor(b.config);
    },
    transformIndexHtml(html) {
      const attr = policy.replace(/&/g, "&amp;").replace(/"/g, "&quot;"); // the validator already refuses quotes; belt and braces
      return html.replace(/(<meta charset="UTF-8" \/>)/, `$1\n    <meta http-equiv="Content-Security-Policy" content="${attr}" />`);
    },
  };
}

export default defineConfig(({ mode, command }) => {
  const flavour = flavourOf(mode, command);
  const env = loadEnv(mode, APP_DIR, "VITE_"); // the app dir, as Vite's own env root, whatever the cwd
  if (command === "serve" && mode !== "test") loadBuildConfig(flavour, env); // the dev server fails fast on a bad file too
  return {
    // The one flavour decision: load.ts branches on this, so the CSP and the bundle cannot disagree
    // (NODE_ENV=development vite build would flip import.meta.env.DEV but not this).
    define: { __HLO_FLAVOUR__: JSON.stringify(flavour) },
    plugins: [react(), contentSecurityPolicy(flavour, env), chunkCheck(APP_DIR)],
    server: { port: 5173, strictPort: true },
    build: { target: "es2022" },
    test: { environment: "node", include: ["test/**/*.test.{ts,tsx}"] },
  };
});
