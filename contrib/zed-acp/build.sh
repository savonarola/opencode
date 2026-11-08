#!/usr/bin/env bash
# Build a single-file opencode binary from this checkout.
# Output: contrib/zed-acp/dist/opencode-acp-<target>
#
#   contrib/zed-acp/build.sh                      # linux-x64
#   TARGET=linux-arm64 contrib/zed-acp/build.sh   # also: linux-x64-musl, darwin-arm64, ...
#
# Needs bun 1.4.x (opencode pins bun@1.4.4).
set -euo pipefail

TARGET="${TARGET:-linux-x64}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# A release version sets the channel to "latest". The binary then uses the same opencode.db as a stock install.
# Without a release version, the channel is the branch name, and `acp --standalone` uses a separate database.
VERSION="${VERSION:-$(cd "$ROOT/packages/cli" && node -p 'require("./package.json").version')}"

if ! bun --version | grep -q '^1\.4\.'; then
  echo "needs bun 1.4.x, found $(bun --version)" >&2
  exit 1
fi

(cd "$ROOT" && bun install)
(cd "$ROOT/packages/cli" && OPENCODE_VERSION="$VERSION" OPENCODE_TARGET="$TARGET" bun run script/build.ts --skip-web-ui)

mkdir -p "$HERE/dist"
cp "$ROOT/packages/cli/dist/cli-$TARGET/bin/opencode" "$HERE/dist/opencode-acp-$TARGET"
echo "built: $HERE/dist/opencode-acp-$TARGET (opencode $VERSION)"
