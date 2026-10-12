#!/usr/bin/env bash
# Assert that the pinned toolchain is the one on PATH, and show — never change —
# the global state other projects on this machine depend on.
set -euo pipefail
# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

fail=0
check() { # label, expected substring, actual
  if [[ "$3" == *"$2"* ]]; then printf '  ok   %-16s %s\n' "$1" "$3"
  else printf '  FAIL %-16s %s (expected %s)\n' "$1" "$3" "$2"; fail=1; fi
}

echo "pinned toolchain"
check solana "$AGAVE_VERSION" "$(solana --version 2>&1 | head -1)"
check build-sbf "cargo-build-sbf" "$(cargo build-sbf --version 2>&1 | head -1)"
check anchor "$ANCHOR_CLI" "$(anchor --version 2>&1)"
check anchor-path "$FADE_TOOLS_DIR" "$(command -v anchor)"
check rustc "$RUST_HOST" "$(rustc --version)"
check rustup-home "$FADE_TOOLS_DIR" "$RUSTUP_HOME"
check node "v$NODE_MAJOR." "$(node --version)"
pt="$HOME/.cache/solana/$PLATFORM_TOOLS/platform-tools/rust/bin/rustc"
if [ -x "$pt" ]; then check platform-tools "rustc" "$("$pt" --version)"; else printf '  FAIL %-16s missing %s\n' platform-tools "$pt"; fail=1; fi

echo "global state of other projects (informational, must not drift)"
printf '  active_release  %s\n' "$(readlink "$HOME/.local/share/solana/install/active_release" 2>/dev/null || echo none)"
printf '  avm version     %s\n' "$(cat "$HOME/.avm/.version" 2>/dev/null || echo none)"
printf '  default rustup  %s\n' "$(RUSTUP_HOME= rustup toolchain list 2>/dev/null | tr '\n' ' ')"

exit $fail
