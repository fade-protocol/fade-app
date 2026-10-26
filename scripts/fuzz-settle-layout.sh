#!/usr/bin/env bash
# The cargo-fuzz target on settle_round_tickets' account layout (Spec 08 §13.8).
# Needs the SBF programs built (pnpm build:sbf), a nightly
# toolchain and cargo-fuzz (`cargo install cargo-fuzz`), from the developer's own
# rustup: the pinned toolchain has no nightly. Arguments go to libFuzzer, e.g.
#   bash scripts/fuzz-settle-layout.sh -max_total_time=3600 -fork=8
# No sanitizer: the program runs as SBF bytecode in LiteSVM, out of a
# sanitizer's reach, and the harness is safe Rust; debug assertions are on.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
export SBF_OUT_DIR="$root/target/deploy"
# Two dependencies are also cdylibs (the ORAO stand-in, solana-zk-sdk): on macOS
# their link needs the coverage symbols that only the fuzz binary defines.
if [ "$(uname -s)" = Darwin ]; then
  export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-undefined -C link-arg=dynamic_lookup"
fi
cd "$root/fuzz"
mkdir -p corpus/settle-round-layout
exec cargo +nightly fuzz run --sanitizer none --debug-assertions settle-round-layout corpus/settle-round-layout -- "$@"
