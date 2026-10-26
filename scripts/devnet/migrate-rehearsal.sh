#!/usr/bin/env bash
# Rehearse migrate_config on a clone of the live devnet deployment, never on
# the deployment itself: a local solana-test-validator is started with the
# live program and program data as deployed, its config, vault, queue, token
# accounts and share mint, its live beacon rounds (their tickets,
# sponsorships and round_vrf), and devnet's feature set, all cloned read-only
# from devnet; scripts/devnet/migrate-rehearsal.ts then upgrades the clone to
# target/devnet/fade.so, migrates it and runs a beacon round on it, against
# the local validator only. Nothing is sent to devnet: it is only read
# (the clone, and a dump of the live binary to compare with the clone's).
#
# With --serve, the clone is left running at 127.0.0.1:18899 instead, the
# deployer funded on it, until interrupted: upgrade-live.ts runs against it
# with RPC_URL=http://127.0.0.1:18899 (the live upgrade's own path, dry run
# and --confirm, on the clone).
#
#   pnpm build:sbf:devnet && pnpm devnet:migrate-rehearsal
#   pnpm devnet:migrate-rehearsal --serve
set -euo pipefail
# shellcheck source=../toolchain/env.sh
source "$(dirname "${BASH_SOURCE[0]}")/../toolchain/env.sh"
cd "$FADE_ROOT"

live="GqWqMEubSHgrqJCZ9zPfMHq6uQPZkr6EbiBy78j7engt"
devnet="https://api.devnet.solana.com"
port=18899
local_url="http://127.0.0.1:${port}"
so="target/devnet/fade.so"
serve=false
case "${1:-}" in
  "") ;;
  --serve) serve=true ;;
  *) echo >&2 "unknown argument $1: --serve or none"; exit 1 ;;
esac

[ -f "$so" ] || { echo >&2 "missing $so: run pnpm build:sbf:devnet"; exit 1; }
# The binary the live deployment would be upgraded to carries its address.
python3 - "$so" "$live" <<'EOF'
import sys
alpha = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def b58(s):
    n = 0
    for c in s:
        n = n * 58 + alpha.index(c)
    return n.to_bytes(32, "big")
data = open(sys.argv[1], "rb").read()
if b58(sys.argv[2]) not in data:
    sys.exit("the binary does not carry the live deployment's address: rebuild with pnpm build:sbf:devnet")
EOF

run_ts() {
  RPC_URL="$local_url" WS_URL="ws://127.0.0.1:$((port + 1))" \
    pnpm exec tsx scripts/devnet/migrate-rehearsal.ts "$@"
}

accounts=$(run_ts accounts)
clone_args=()
while read -r flag addr; do clone_args+=("$flag" "$addr"); done < <(
  python3 -c '
import json, sys
a = json.loads(sys.argv[1])
for x in a["required"]: print("--clone", x)
for x in a["optional"]: print("--maybe-clone", x)
' "$accounts"
)

ledger=$(mktemp -d)
solana-test-validator --reset --quiet --ledger "$ledger" \
  --rpc-port "$port" --faucet-port $((port + 1001)) \
  --url "$devnet" --clone-feature-set \
  --clone-upgradeable-program "$live" \
  "${clone_args[@]}" >"$ledger/validator.log" 2>&1 &
validator=$!
trap 'kill "$validator" 2>/dev/null || true; wait "$validator" 2>/dev/null || true; rm -rf "$ledger"' EXIT

for _ in $(seq 1 120); do
  solana cluster-version -u "$local_url" >/dev/null 2>&1 && break
  kill -0 "$validator" 2>/dev/null || { cat "$ledger/validator.log" >&2; exit 1; }
  sleep 1
done
solana cluster-version -u "$local_url" >/dev/null

# The clone runs the live binary as deployed.
solana program dump -u "$devnet" "$live" "$ledger/live.so" >/dev/null
solana program dump -u "$local_url" "$live" "$ledger/clone.so" >/dev/null
cmp -s "$ledger/live.so" "$ledger/clone.so" || { echo >&2 "the clone is not the live binary"; exit 1; }

deployer=$(solana-keygen pubkey keys/deployer.json)
solana airdrop 50 "$deployer" -u "$local_url" >/dev/null
if [ "$serve" = true ]; then
  echo "the clone of the live deployment runs at $local_url until interrupted (ctrl-c):"
  echo "  RPC_URL=$local_url pnpm devnet:upgrade-live [--confirm --expect-sha256 <hex>]"
  wait "$validator"
  exit 0
fi
run_ts
