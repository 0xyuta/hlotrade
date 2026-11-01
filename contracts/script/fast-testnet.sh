#!/usr/bin/env bash
# TESTNET ONLY. Builds and runs Deploy.s.sol against a copy of src/ with a short pool delay, so a testnet run can buy
# back the same day instead of after 7 days. src/ itself is never touched; mainnet uses Deploy.s.sol as is.
#
# The copy (contracts/fast/, git-ignored) changes OPEN_DELAY and the output file name only:
#   Buyback.OPEN_DELAY     7 days -> 10 minutes
#   Deploy.s.sol           writes deployments/<chainid>-fast.json instead of <chainid>.json
# Checkpoints settle at once and need no shorter timer. The vault period is an env var: VAULT_PERIOD (seconds), use
# 3600 on testnet (Deploy.s.sol requires 7 days only on chain 999).
#
# Usage (same env as Deploy.s.sol):
#   VAULT_PERIOD=3600 USDC=… V2_FACTORY=… SWAP_FEE_BPS=30 POSTER=… GUARDIAN=… PAUSER=… ADMIN=… \
#     script/fast-testnet.sh --rpc-url $RPC [--broadcast]
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf fast && mkdir -p fast && cp -R src fast/src && cp -R script fast/script

# each edit must apply exactly once, or the copy is not what this header says
edit() { # file, from, to
  local n; n=$(grep -cF -- "$2" "$1" || true)
  [[ "$n" == 1 ]] || { echo "fast copy: expected '$2' once in $1, found $n" >&2; exit 1; }
  F="$2" T="$3" perl -0pi -e 's/\Q$ENV{F}\E/$ENV{T}/' "$1"
}
edit fast/src/Buyback.sol "OPEN_DELAY = 7 days;" "OPEN_DELAY = 10 minutes;"
edit fast/script/Deploy.s.sol 'vm.toString(block.chainid), ".json"' 'vm.toString(block.chainid), "-fast.json"'

FOUNDRY_SRC=fast/src FOUNDRY_SCRIPT=fast/script FOUNDRY_OUT=fast/out FOUNDRY_CACHE_PATH=fast/cache FOUNDRY_BROADCAST=fast/broadcast \
  forge script fast/script/Deploy.s.sol "$@"
