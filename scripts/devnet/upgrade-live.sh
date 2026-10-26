#!/usr/bin/env bash
# Upgrade the live devnet deployment in place to target/devnet/fade.so and
# run its migrate_config (scripts/devnet/upgrade-live.ts). A dry run unless
# --confirm is given: the dry run only reads the cluster and prints the plan.
# RPC_URL may name a local validator holding a clone of the live deployment
# (pnpm devnet:migrate-rehearsal --serve) to run the same path there first.
#
#   pnpm build:sbf:devnet && pnpm devnet:upgrade-live
#   pnpm devnet:upgrade-live --confirm --expect-sha256 <sha256 of the reviewed build>
set -euo pipefail
# shellcheck source=../toolchain/env.sh
source "$(dirname "${BASH_SOURCE[0]}")/../toolchain/env.sh"
cd "$FADE_ROOT"

pnpm exec tsx scripts/devnet/upgrade-live.ts "$@"
