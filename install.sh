#!/usr/bin/env bash
# Contributor script: build murkfun-mcp from this checkout and install it locally (no sudo), then run `murkfun-mcp init`.
#   ./install.sh       from the package's root folder (the root of a checkout of murkfun/murkfun-mcp, or wherever this
#                      folder sits); it runs from its own directory, so any working directory works
# Users install the released package instead:
#   npm install -g https://github.com/murkfun/murkfun-mcp/releases/latest/download/murkfun-mcp.tgz && murkfun-mcp init
# Builds and packs the package, installs it into $MURKFUN_PREFIX (default ~/.murkfun/npm), and runs `init`: creates a
# random vault passphrase file if none exists, downloads + verifies the 0xbow circuits, prints the MCP client config.
set -euo pipefail
cd "$(dirname "$0")"
PREFIX=${MURKFUN_PREFIX:-$HOME/.murkfun/npm}
npm ci --silent
npm pack --silent >/dev/null
npm install -g --silent --prefix "$PREFIX" ./murkfun-mcp-*.tgz
rm -f ./murkfun-mcp-*.tgz
echo "Installed: $PREFIX/bin/murkfun-mcp" >&2
"$PREFIX/bin/murkfun-mcp" init
