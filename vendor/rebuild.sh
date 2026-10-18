#!/bin/sh
# Rebuild the three vendored browser bundles from package-lock.json.
# Run from this directory:  npm ci && ./rebuild.sh
set -eu
cd "$(dirname "$0")"

ESBUILD=node_modules/.bin/esbuild
if [ ! -x "$ESBUILD" ]; then
  # npm ci --ignore-scripts leaves no .bin symlink; use the platform binary.
  ESBUILD=$(echo node_modules/@esbuild/*/bin/esbuild)
fi

for name in nostr-tools noble-hashes-utils qrcode; do
  "$ESBUILD" "src/$name.mjs" \
    --bundle --format=esm --platform=browser --target=es2022 --minify \
    --legal-comments=eof \
    --outfile="$name.mjs"
done

sha256sum nostr-tools.mjs noble-hashes-utils.mjs qrcode.mjs
