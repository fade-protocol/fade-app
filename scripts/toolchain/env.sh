# shellcheck shell=bash
# Source this file to put the pinned toolchain first on PATH for the current
# shell. It touches nothing global: Agave and anchor live under FADE_TOOLS_DIR,
# and Rust toolchains live under an isolated RUSTUP_HOME so that cargo-build-sbf
# never sees (or unlinks) toolchains belonging to other projects.

# Works when sourced from bash or zsh.
if [ -n "${BASH_SOURCE:-}" ]; then _fade_src="${BASH_SOURCE[0]}"; else eval '_fade_src="${(%):-%x}"'; fi
_fade_root=$(cd "$(dirname "$_fade_src")/../.." && pwd)
# shellcheck source=../../toolchain.env
# A caller may override the arch for one build (CI builds the v0 fallback).
_fade_arch_override="${SBF_ARCH:-}"
set -a
source "$_fade_root/toolchain.env"
set +a
[ -n "$_fade_arch_override" ] && SBF_ARCH="$_fade_arch_override"

export FADE_ROOT="$_fade_root"
export FADE_TOOLS_DIR="${FADE_TOOLS_DIR:-$HOME/.local/share/fade-tools}"
export RUSTUP_HOME="$FADE_TOOLS_DIR/rustup"
export PATH="$FADE_TOOLS_DIR/agave-v$AGAVE_VERSION/solana-release/bin:$FADE_TOOLS_DIR/anchor-$ANCHOR_CLI/bin:$PATH"
export ANCHOR_BUILD_SBF_ARCH="$SBF_ARCH"
export SBF_OUT_DIR="$_fade_root/target/deploy"
unset _fade_root _fade_src _fade_arch_override
