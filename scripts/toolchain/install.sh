#!/usr/bin/env bash
# Install the pinned toolchain under FADE_TOOLS_DIR without changing anything
# global. Safe to re-run: every step is skipped when already satisfied.
#
#   Agave      extracted from the release tarball after a sha256 check.
#              Never `agave-install init`: that rewrites the global
#              active_release symlink shared with other projects.
#   Rust       installed under an isolated RUSTUP_HOME. cargo-build-sbf 4.x
#              uninstalls any rustup toolchain named *solana* that is not its
#              own; isolation keeps it away from other projects' toolchains.
#   anchor     `cargo install --root`. Without --root the binary would overwrite
#              the avm proxy in ~/.cargo/bin used by other projects.
#   platform-tools  pre-fetched so that a failed GitHub API lookup can never
#              silently fall back to an older version at build time.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../.." && pwd)
# shellcheck source=../../toolchain.env
source "$root/toolchain.env"
export FADE_TOOLS_DIR="${FADE_TOOLS_DIR:-$HOME/.local/share/fade-tools}"
export RUSTUP_HOME="$FADE_TOOLS_DIR/rustup"
mkdir -p "$FADE_TOOLS_DIR"

log() { printf '\n[install] %s\n' "$*"; }

# 1. Agave ---------------------------------------------------------------------
agave_dir="$FADE_TOOLS_DIR/agave-v$AGAVE_VERSION"
if [ -x "$agave_dir/solana-release/bin/solana" ]; then
  log "agave v$AGAVE_VERSION already present"
else
  log "downloading agave v$AGAVE_VERSION"
  tmp=$(mktemp -d)
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) triple=x86_64-unknown-linux-gnu sha=$AGAVE_TARBALL_SHA256_X86_64_LINUX ;;
    Darwin-arm64) triple=aarch64-apple-darwin sha=$AGAVE_TARBALL_SHA256_AARCH64_DARWIN ;;
    *) echo "[install] no pinned agave tarball for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
  esac
  url="https://github.com/anza-xyz/agave/releases/download/v$AGAVE_VERSION/solana-release-$triple.tar.bz2"
  curl -fsSL --retry 3 "$url" -o "$tmp/agave.tar.bz2"
  echo "$sha  $tmp/agave.tar.bz2" | shasum -a 256 -c -
  mkdir -p "$agave_dir"
  tar -xjf "$tmp/agave.tar.bz2" -C "$agave_dir"
  rm -rf "$tmp"
fi
export PATH="$agave_dir/solana-release/bin:$PATH"

# 2. Rust host toolchain, isolated ----------------------------------------------
log "rust $RUST_HOST under $RUSTUP_HOME"
rustup toolchain install "$RUST_HOST" --profile minimal -c rustfmt -c clippy
rustup default "$RUST_HOST" >/dev/null

# 3. anchor-cli ----------------------------------------------------------------
anchor_dir="$FADE_TOOLS_DIR/anchor-$ANCHOR_CLI"
if [ -x "$anchor_dir/bin/anchor" ] && "$anchor_dir/bin/anchor" --version | grep -q "$ANCHOR_CLI"; then
  log "anchor-cli $ANCHOR_CLI already present"
else
  log "building anchor-cli $ANCHOR_CLI (several minutes)"
  cargo install anchor-cli --version "$ANCHOR_CLI" --locked --root "$anchor_dir"
fi
export PATH="$anchor_dir/bin:$PATH"

# 4. platform-tools ------------------------------------------------------------
if [ -x "$HOME/.cache/solana/$PLATFORM_TOOLS/platform-tools/rust/bin/rustc" ]; then
  log "platform-tools $PLATFORM_TOOLS already cached"
else
  log "fetching platform-tools $PLATFORM_TOOLS"
  tmp=$(mktemp -d)
  cargo new --lib --vcs none -q "$tmp/probe"
  (cd "$tmp/probe" && cargo build-sbf --tools-version "$PLATFORM_TOOLS" --arch "$SBF_ARCH" >/dev/null)
  rm -rf "$tmp"
fi

log "done — run scripts/toolchain/doctor.sh"
