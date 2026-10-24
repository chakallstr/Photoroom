#!/usr/bin/env bash
# VTracer WASM derlemesi. Gerekli: rustup target add wasm32-unknown-unknown; cargo install wasm-bindgen-cli --version 0.2.100
set -euo pipefail
cd "$(dirname "$0")"
cargo test --release
cargo build --release --target wasm32-unknown-unknown
OUT=../../public/assets/vendor/vtracer
mkdir -p "$OUT"
wasm-bindgen --target web --no-typescript --out-dir "$OUT" --out-name vtracer target/wasm32-unknown-unknown/release/photoroot_vtracer.wasm
cp "$(cargo metadata --format-version 1 | python3 -c 'import json,sys;d=json.load(sys.stdin);print([p["manifest_path"] for p in d["packages"] if p["name"]=="vtracer"][0])' | xargs dirname)/LICENSE-MIT" "$OUT/LICENSE-VTRACER-MIT"
ls -la "$OUT"
