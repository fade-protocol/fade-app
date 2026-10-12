#!/usr/bin/env bash
# Build the devnet binary of the fade program into target/devnet: its own
# program address, the Fade-controlled test USDC mint (feature "devnet") and
# governance changes applied without the timelock (feature "no-timelock").
# The production build, its IDL and the tests are untouched.
#
#   pnpm build:sbf:devnet
set -euo pipefail
# shellcheck source=toolchain/env.sh
source "$(dirname "${BASH_SOURCE[0]}")/toolchain/env.sh"
cd "$FADE_ROOT"

out="$FADE_ROOT/target/devnet"
rm -f "$out/fade.so"
mkdir -p "$out"
build_log=$(mktemp)
trap 'rm -f "$build_log"' EXIT

cargo build-sbf --manifest-path programs/fade/Cargo.toml --features devnet,no-timelock \
  --sbf-out-dir "$out" --arch "$SBF_ARCH" --tools-version "$PLATFORM_TOOLS" 2>&1 | tee "$build_log"

if grep -q "overflows the maximum allowed frame space" "$build_log"; then
  echo >&2 "build-sbf-devnet: stack frame overflow; binary removed"
  rm -f "$out/fade.so"
  exit 1
fi
ls -l "$out/fade.so"
