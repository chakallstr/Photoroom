# Vektör çıktısı kanıt düzeneği

Her test görselini sitedeki vektör motoruyla (public/assets/vector.js + VTracer WASM) çevirir ve şunları ölçer:

| Kontrol | Araç | Neyi kanıtlar |
|---|---|---|
| Doğrulayıcı | `validateSvg` (vector.js) | Saf vektör (yalnızca `<svg>` ve `<path>`), `viewBox`, `transform` yok, standart sözdizimine göre ayrıştırılan yol verisi, sonlu sayılar, kapalı alt yollar, sınır içinde koordinatlar |
| XML | `xmllint --noout` | İyi biçimli XML |
| Bağımsız çizici | `resvg` | Katı ayrıştırıcıyla açılıyor; Chromium çizimiyle piksel farkı |
| Şekil örtüşmesi (IoU) | Chromium | Vektörün kapladığı alan orijinalle ne kadar örtüşüyor (siyah-beyazda koyu alanlar) |
| Renk farkı (ΔE, CIE76) | Chromium | Ortalama algısal renk farkı (2 altı: gözle neredeyse ayırt edilemez) |

Not: Tarayıcılar ve resvg hatalı bir yolu sessizce ilk hataya kadar çizer (SVG 2 §9.5.4); bu yüzden "düzgün
görünüyor" kanıt değildir, katı ayrıştırıcı (`validateSvg`) şarttır.

## Çalıştırma

Gerekli: Node 22, `npm i -g playwright` (Chromium), `cargo install resvg`, `xmllint`.

```bash
# Test görsellerini (PNG) tools/vector-proof/images/ altına koy; adları proof.mjs içindeki CASES listesinde.
python3 -m http.server 8795      # repo kökünde
node tools/vector-proof/proof.mjs
```
