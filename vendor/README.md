# Vendored browser dependencies

Self-contained ES modules built locally from a pinned npm lockfile — the site
loads no runtime CDN code, so the served bytes are exactly these files.

## Rebuild (deterministic)

```bash
cd vendor
npm ci            # resolves package-lock.json (integrity-pinned tarballs)
./rebuild.sh      # esbuild --bundle --format=esm --platform=browser
                  # --target=es2022 --minify --legal-comments=eof
sha256sum *.mjs   # record the fresh digests in the table below
```

Inputs: `package.json` + `package-lock.json` pin every package and builder
(esbuild 0.28.2) byte-for-byte; `src/*.mjs` are the bundle entries.
`nostr-tools` is bundled from its subpath entries (`pure`, `nip19`, `nip44`)
so unused root modules — nostr-wasm, @scure/bip32, @scure/bip39 — are never
included. `qrcode` resolves its `browser` field build, so pngjs and the
yargs CLI chain are never bundled. `node_modules/` is git-ignored.

## Files and shipped dependency graph

| file | entry | packages bundled into the file | sha256 |
|---|---|---|---|
| nostr-tools.mjs | `src/nostr-tools.mjs` | nostr-tools 2.25.2 (pure/nip19/nip44), @noble/curves 2.0.1, @noble/hashes 2.0.1 (nested pin of nostr-tools), @noble/ciphers 2.1.1, @scure/base 2.0.0 | `bca4050a2779b56e909199c61b467176adcd0354bd1c3850586d9749121cc235` |
| noble-hashes-utils.mjs | `src/noble-hashes-utils.mjs` | @noble/hashes 2.4.0 (`utils` subpath) | `b80b27590a589be36b6417e4dcc47b3a8a20e5d5aa0497580b110dc003f063a0` |
| qrcode.mjs | `src/qrcode.mjs` | qrcode 1.5.4 (browser build), dijkstrajs 1.0.3 | `1e86aaf50b9226e588929164ddd03c6da2e10c6c5d71c09faba87ecf9ecddaca` |

The sha256 values describe the currently committed bytes; rerun
`sha256sum *.mjs` after each rebuild and update them.

## Advisory audit (2026-10-18)

Every shipped package above plus every package in `package-lock.json`
(including esbuild and the un-bundled yargs/pngjs/nostr-wasm/bip32/bip39
tree): `npm audit` reports 0 vulnerabilities across all 68 locked packages,
and each package/version in the shipped bundles returns no advisories from
the OSV API (`POST https://api.osv.dev/v1/query`, ecosystem `npm`).

## Licenses

Upstream license texts for every package shipped inside a bundle are in
`licenses/`:

| package | license |
|---|---|
| nostr-tools 2.25.2 | public domain / Unlicense |
| @noble/curves 2.0.1, @noble/hashes 2.0.1 + 2.4.0, @noble/ciphers 2.1.1, @scure/base 2.0.0 | MIT (Paul Miller) |
| qrcode 1.5.4, dijkstrajs 1.0.3 | MIT |

Per-source `/*! … */` license comments are also preserved verbatim at the
end of each built bundle (`--legal-comments=eof`).
