# HLO

A trading app on top of Hyperliquid perps. It charges a 0.1% builder fee and returns the fees to users through the HLO token. Mining runs in HyperEVM contracts.

- Design: `docs/superpowers/specs/2026-10-27-hlo-design.md`.
- `contracts/`: the HyperEVM contracts (Foundry).
- `calc/`: the rewards calculator (TypeScript).
- `ops/`: the poster, verifier and forwarder. The runbook is `docs/OPS.md`.
- Notes for agents: `CLAUDE.md`.

Tests:

```bash
npm install
cd contracts && forge build && forge test && cd ..   # contracts (forge build is also needed by the ops ABI check)
npm test                                             # calc + ops unit tests
npm run e2e -w ops                                   # anvil end-to-end: contracts + calculator + poster/verifier/forwarder
```
