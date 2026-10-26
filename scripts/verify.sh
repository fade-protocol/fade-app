#!/usr/bin/env bash
# The gate: everything CI runs, in the same order, from the pinned toolchain.
# Assumes the toolchain is on PATH (run through scripts/toolchain/with-toolchain.sh).
set -euo pipefail
cd "$FADE_ROOT"

step() { printf '\n== %s\n' "$*"; }

step "binary present and not stale"
so=target/deploy/toolchain_smoke.so
[ -f "$so" ] || { echo "missing $so — run pnpm build:sbf"; exit 1; }
stale=$(find programs crates Cargo.toml Cargo.lock \( -name '*.rs' -o -name Cargo.toml -o -name Cargo.lock \) -not -path '*/target/*' -newer "$so" -print -quit)
[ -z "$stale" ] || { echo "$stale is newer than $so — run pnpm build:sbf"; exit 1; }
devnet_so=target/devnet/fade.so
[ -f "$devnet_so" ] || { echo "missing $devnet_so — run pnpm build:sbf"; exit 1; }
stale=$(find programs crates Cargo.toml Cargo.lock \( -name '*.rs' -o -name Cargo.toml -o -name Cargo.lock \) -not -path '*/target/*' -newer "$devnet_so" -print -quit)
[ -z "$stale" ] || { echo "$stale is newer than $devnet_so — run pnpm build:sbf"; exit 1; }

step "format"
pnpm exec prettier --check .
cargo fmt --all --check

step "clippy"
cargo clippy --workspace --all-targets -- -D warnings

step "static policy"
bash scripts/check-static-policy.sh

step "event schemas"
node scripts/check-event-schemas.mjs

step "generated client is current"
node scripts/codama-generate.mjs >/dev/null
node scripts/landing-idl.mjs
git diff --quiet --exit-code -- clients/js/src/generated idls apps/landing/public/idl || { echo "generated client or IDL is stale — commit the regenerated files"; git --no-pager diff --stat -- clients/js/src/generated idls apps/landing/public/idl; exit 1; }

step "typecheck"
pnpm exec tsc -p tsconfig.json

step "rust tests"
# The devnet-only instruction's tests must not skip here (programs/fade/tests/migrate_config.rs).
FADE_REQUIRE_DEVNET_BINARY=1 cargo test --workspace

step "typescript tests"
pnpm exec vitest run
