#!/usr/bin/env python3
"""public/vektor-lab.html sayfasını tek dosyalık, internetsiz çalışan bir HTML'e paketler.
Kullanım: python3 tools/vector-proof/build-single.py <çıktı.html>
"""
import base64, re, sys, pathlib
root = pathlib.Path(__file__).resolve().parents[2]
html = (root / 'public/vektor-lab.html').read_text()
vector = (root / 'public/assets/vector.js').read_text()
glue = (root / 'public/assets/vendor/vtracer/vtracer.js').read_text()
wasm = base64.b64encode((root / 'public/assets/vendor/vtracer/vtracer_bg.wasm').read_bytes()).decode()
sample = base64.b64encode((root / 'public/assets/ornek-logo.jpg').read_bytes()).decode()
glue_inline = re.sub(r'^export function ', 'function ', glue, flags=re.M)
glue_inline = re.sub(r'^export (\{ initSync \};|default __wbg_init;)\s*$', '', glue_inline, flags=re.M)
assert not re.search(r'^export ', glue_inline, flags=re.M)
glue_inline += '\nconst __glue = { vectorize, vectorize_exact, initSync, default: __wbg_init };\n'
exported = [a or b for a, b in re.findall(r'^export (?:async )?function (\w+)|^export const (\w+)', vector, flags=re.M)]
vec_inline = re.sub(r'^export ', '', vector, flags=re.M).replace("glue ?? await import('./vendor/vtracer/vtracer.js')", 'glue')
vec_inline = re.sub(r'\bwasm\b', '__engine', vec_inline)  # yapıştırma kodundaki `wasm` ile çakışmasın
vec_inline += '\nconst V = { ' + ', '.join(exported) + ' };\n'
boot = f"\nconst __wasmBytes = Uint8Array.from(atob('{wasm}'), (c) => c.charCodeAt(0));\nawait V.initVectorizer(__wasmBytes, __glue);\n"
start = html.index('/*VEKTOR-MOTORU*/'); end = html.index('/*SON*/') + len('/*SON*/')
html = html[:start] + glue_inline + '\n' + vec_inline + boot + html[end:]
html = html.replace("const SAMPLE = 'assets/ornek-logo.jpg';", f"const SAMPLE = 'data:image/jpeg;base64,{sample}';")
html = html.replace('<link rel="icon" href="assets/logo.svg" type="image/svg+xml">\n', '')
html = html.replace('<p>Kendi görselini yükle', '<p>Bu dosya tek başına çalışır: indirip çift tıklayarak açabilirsin, internet gerekmez. Kendi görselini yükle')
pathlib.Path(sys.argv[1]).write_text(html)
print(f'{sys.argv[1]}: {len(html) // 1024} KB')
