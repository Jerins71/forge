#!/bin/bash
set -euo pipefail

# Internal container entry; build-server.mjs owns all inputs and target pins.
mkdir -p /build /toolchain /runtime
cp -a /source/. /build/
cd /build
node_archive=$(node -p 'require("/input/build.json").nodeArchive')
tar -xJf "/input/$node_archive" --strip-components=1 -C /runtime
export PATH="/runtime/bin:/toolchain/bin:$PATH"
pnpm_version=$(node -p 'require("./package.json").packageManager.replace(/^pnpm@/, "")')
npm install --global --prefix /toolchain "pnpm@$pnpm_version" --ignore-scripts --no-audit --no-fund
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
export npm_config_nodedir=/runtime
pnpm install --frozen-lockfile --ignore-scripts
# Sharp uses its target-platform N-API/libvips packages. Only SQLite/PTY need
# source builds with Node headers; forcing Sharp from source requires libvips SDK.
pnpm -r rebuild esbuild sharp
npm_config_build_from_source=true pnpm -r rebuild better-sqlite3 sqlite3 node-pty
node scripts/fix-node-pty-spawn-helper-permissions.mjs
pnpm --filter @forge/protocol build
pnpm --filter @forge/backend build
pnpm --filter @forge/cli build
node apps/electron/scripts/stage-server.mjs
