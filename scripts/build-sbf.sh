#!/usr/bin/env bash
# Build every program with the pinned arch and platform-tools (the devnet
# binary of fade included, into target/devnet), and write the
# IDLs into idls/ (committed). Paths are absolute: anchor chdirs into each
# program directory while building, so a relative --idl lands in the wrong place.
#
#   scripts/build-sbf.sh            production build, IDL refreshed
#   scripts/build-sbf.sh --no-idl   binaries only
#   SBF_ARCH=v0 scripts/build-sbf.sh   override the arch (CI fallback job)
set -euo pipefail
# shellcheck source=toolchain/env.sh
source "$(dirname "${BASH_SOURCE[0]}")/toolchain/env.sh"
cd "$FADE_ROOT"

# A failed build must never leave a stale binary behind for the tests to pick up.
rm -f target/deploy/*.so
mkdir -p idls/types target/idl target/types

idl_args=(--idl "$FADE_ROOT/idls" --idl-ts "$FADE_ROOT/idls/types")
if [ "${1:-}" = "--no-idl" ]; then idl_args=(--no-idl); fi

build_log=$(mktemp)
trap 'rm -f "$build_log"' EXIT

anchor build --ignore-keys --arch "$SBF_ARCH" --tools-version "$PLATFORM_TOOLS" "${idl_args[@]}" 2>&1 | tee "$build_log"

# Test doubles live outside programs/ so anchor ignores them; build them with
# the same arch and tools, into the same output directory, without an IDL.
for manifest in tests/programs/*/Cargo.toml; do
  [ -f "$manifest" ] || continue
  cargo build-sbf --manifest-path "$manifest" --sbf-out-dir "$FADE_ROOT/target/deploy" --arch "$SBF_ARCH" --tools-version "$PLATFORM_TOOLS" 2>&1 | tee -a "$build_log"
done

# A function whose frame exceeds SBPF's 4 KiB writes into the neighbouring frame:
# the program still links, still loads, and then returns corrupted values at
# runtime. The linker reports it as "Error:" but exits 0, so it has to be caught
# here. The usual cause is an Anchor accounts struct deserialising large accounts
# onto the stack; the fix is Box<Account<'info, T>>.
if grep -q "overflows the maximum allowed frame space" "$build_log"; then
  echo >&2
  echo "build-sbf: stack frame overflow — the binary would corrupt memory at runtime:" >&2
  grep "overflows the maximum allowed frame space" "$build_log" >&2
  rm -f target/deploy/*.so
  exit 1
fi

# The devnet binary carries instructions the mainnet build cannot (migrate_config);
# its tests run in the gate, so it is built with every other binary.
bash "$FADE_ROOT/scripts/build-sbf-devnet.sh"

# Record what was built so tests and CI can assert the arch instead of assuming it.
for so in target/deploy/*.so; do
  flags=$(python3 -c "import struct,sys; print(struct.unpack_from('<I', open(sys.argv[1],'rb').read(), 0x30)[0])" "$so")
  printf '%s  e_flags=%s (sbpf v%s)  %s bytes\n' "$(basename "$so")" "$flags" "$flags" "$(stat -c %s "$so")"
done
