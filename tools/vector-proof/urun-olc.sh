#!/bin/bash
# Ürün yolundan kanıt ölçümü. Kullanım: urun-olc.sh <klasör> [orijinaller klasörü]
# Klasörde urun-kanit.mjs'nin indirdiği <ad>.png (ürünün şeffaf PNG'si) ve <ad>.svg çiftleri olmalı.
# Tek yöntem: SVG viewBox boyutunda çizilir (resvg), Lanczos ile PNG boyutuna indirilir, CIE76 ΔE ile karşılaştırılır.
D=$1; ORIG=${2:-}; HERE=$(cd "$(dirname "$0")" && pwd)
printf "%-14s | %-30s | %-30s | %s\n" "görsel" "SVG vs ürün PNG" "SVG vs orijinal" "yol / boyut"
for svg in "$D"/*.svg; do
  n=$(basename "${svg%.svg}"); base=${n%.birebir}; [ -f "$D/$base.png" ] || continue
  vb=$(grep -o 'viewBox="0 0 [0-9]* [0-9]*"' "$svg" | head -1 | awk '{print $3}')
  resvg -w "$vb" "$svg" "$D/$n-render.png" || { echo "$n: render HATA"; continue; }
  fit() { python3 -I -c "
from PIL import Image; import sys
o=Image.open(sys.argv[1]); Image.open(sys.argv[2]).convert('RGBA').resize(o.size, Image.LANCZOS).save(sys.argv[3])" "$1" "$D/$n-render.png" "$2"; }
  fit "$D/$base.png" "$D/$n-aa.png"
  a=$(python3 -I "$HERE/karsilastir.py" "$D/$base.png" "$D/$n-aa.png" "$D/$n-fark" | sed 's/ortalama ΔE=\([0-9.]*\).*belirgin fark (ΔE>6): \([0-9.]*%\).*/ΔE \1, belirgin \2/')
  b="-"
  if [ -n "$ORIG" ]; then o=$(ls "$ORIG/$base".* 2>/dev/null | head -1); if [ -n "$o" ]; then fit "$o" "$D/$n-aa2.png"; b=$(python3 -I "$HERE/karsilastir.py" "$o" "$D/$n-aa2.png" "$D/$n-fark-orj" | sed 's/ortalama ΔE=\([0-9.]*\).*belirgin fark (ΔE>6): \([0-9.]*%\).*/ΔE \1, belirgin \2/'); fi; fi
  printf "%-14s | %-30s | %-30s | %s / %s\n" "$n" "$a" "$b" "$(grep -o '<path' "$svg" | wc -l)" "$(du -k "$svg" | awk '{printf "%.1f MB", $1/1024}')"
done
