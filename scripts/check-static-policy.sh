#!/usr/bin/env bash
# Rules that are cheaper to grep than to review.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
fail=0

# 1. No floating point in money code. The payout table check is exact integer
#    arithmetic; a float anywhere in the path reintroduces rounding. Tests may
#    use floats to demonstrate exactly that failure, so only src/ is scanned.
if grep -rnE '\b(f32|f64)\b' --include='*.rs' programs/*/src crates/*/src | grep -v '^\s*//' ; then
  echo "floating point found in a program or crate source"; fail=1
fi

# 2. Overflow checks stay on in release.
grep -q '^overflow-checks = true' Cargo.toml || { echo "Cargo.toml: overflow-checks must be true"; fail=1; }

# 3. Anchor.toml must not manage toolchains (that rewrites global state).
if grep -qE '^(solana_version|anchor_version)' Anchor.toml; then
  echo "Anchor.toml: remove solana_version/anchor_version; versions live in toolchain.env"; fail=1
fi

# 4. No keypair ever reaches git.
if git ls-files | grep -qE 'keypair|keys/'; then
  echo "a keypair is tracked by git"; fail=1
fi

exit $fail
