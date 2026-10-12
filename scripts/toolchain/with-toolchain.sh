#!/usr/bin/env bash
# Run a command with the pinned toolchain on PATH. Every pnpm script and every
# git hook goes through this wrapper, so nothing depends on the developer's
# global Solana, Anchor or Rust installation.
set -euo pipefail
# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
exec "$@"
