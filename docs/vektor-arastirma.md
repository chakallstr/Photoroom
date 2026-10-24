# Görselden vektöre (SVG) çevirme: araştırma

Tarih: 24 Ekim 2026. Amaç: Photoroot'a otomatik raster → vektör çevirme eklemek.

## Sonuç

- **Motor: VTracer** (visioncortex, MIT / Apache-2.0). Renkli çalışır, WASM ile tarayıcıda koşar,
  ~140–230 KB. İşlem kullanıcının cihazında olur → sunucu maliyeti yok, fotoğraf cihazdan çıkmaz.
- **Potrace ailesi kullanılmayacak** (potrace, esm-potrace-wasm, potrace-wasm: GPL). Tarayıcıya gönderilen
  kod da dağıtım sayılır; kapalı kaynaklı üründe risklidir.
- **Photoroom'da vektörleştirme yok** (yalnızca sticker için kontur ekleme var) → farklılaşma fırsatı.
- Doğru konumlandırma: **"logo, ikon ve çizimler için"**. Fotoğraflar vektöre iyi çevrilmez; bunu vaat etme.
  Nakış dosyası (DST/PES) vaat etme (dikiş verisi gerekir).

## Uygulamalı test (10 görsel, Node + Chromium)

| Görsel türü | VTracer | ImageTracer (imagetracerjs) |
|---|---|---|
| Logo (temiz / bulanık JPEG) | Çok iyi; 10 KB, 18 yol | İyi ama 4 kat büyük dosya |
| Düz renkli çizim (anime, panda) | Orijinale sadık | Renkler bozuk, kumlu |
| Küçük çizgi çizim (224 px) | Dış çizgiler kayboluyor → **3x büyütünce çok iyi** | Bulanık |
| Ürün kesimi | Renkli: ağır (1–1,5 MB); siyah-beyaz siluet: temiz | Ağır |
| Fotoğraf | Kötü (beklenen) | Kötü |

Süre: görsel başına 10 ms – 1 sn (WASM, tek çekirdek).

**Önemli tuzak:** `vtracer-wasm` paketi ayarları VTracer'ın *iç* birimleriyle bekliyor. Yanlış birimle her görsel
tek bir dev damla şekline dönüşüyor. Dönüşüm:

```js
const deg = (d) => (d * Math.PI) / 180;
{
  colorPrecision: 8 - colorBits,        // "kaç bit renk" değil, "kaç bit kayıp"
  filterSpeckle: speckle * speckle,     // piksel değil, alan
  cornerThreshold: deg(60),             // derece değil, radyan
  spliceThreshold: deg(45),
  layerDifference, lengthThreshold, maxIterations, pathPrecision, mode: 'spline', hierarchical: 'stacked' | 'cutout', binary,
}
```

## Hazır ayarlar (denendi)

| Ayar | colorBits | speckle | layerDiff | corner | length | Not |
|---|---|---|---|---|---|---|
| Logo | 4 | 8 | 48 | 60 | 6 | Az renk, sade; zemin rengini ayrıca temizle |
| Çizim | 6 | 2 | 24 | 45 | 3 | Ayrıntılı; küçük görselleri önce 3x büyüt |
| Siyah-beyaz | binary | 6 | – | 60 | 4 | Lazer/vinil/kaşe; eşik ayarlanabilir ya da otomatik (Otsu) olmalı |

Ön işlem: arka planı sil (mevcut model) → kısa kenar < ~800 px ise büyüt → paleti sınırla.

## Paket seçenekleri

| Paket | Lisans | Durum |
|---|---|---|
| visioncortex/vtracer (kaynak) | MIT / Apache-2.0 | **Önerilen:** wasm-bindgen `--target web` ile derleyip `public/assets/` altına koy |
| vtracer-wasm 0.1.0 | Paket içinde MIT LICENSE var, package.json'da lisans alanı yok | Testte çalıştı; tek geliştirici |
| vtracer-browser 0.0.3 | MIT | ESM + worker; tek sürüm, olgun değil |
| @visioncortex/vtracer | MIT/Apache | Node hedefli, tarayıcıda doğrudan çalışmaz |
| imagetracerjs 1.2.6 | Unlicense | Güvenli yedek, kalite düşük |
| esm-potrace-wasm, potrace-wasm | **GPL** | Kullanma |

MIT kullanımında telif bildirimi üründe gösterilmeli → "Lisanslar" sayfası eklenecek.

## Rakipler

| Ürün | Fiyat | Formatlar | İşlem |
|---|---|---|---|
| Vectorizer.AI | $9.99/ay | SVG, PDF, EPS, DXF, PNG | Sunucu |
| Vector Magic | $9.95/ay, masaüstü $295 | SVG, EPS, PDF (DXF masaüstü) | Sunucu |
| Adobe Express | Ücretsiz | SVG | Belirsiz |
| Illustrator Image Trace | Creative Cloud aboneliği | AI, SVG, PDF, EPS, DXF | Masaüstü |
| Recraft, Kittl, Canva | Kredi/token/Pro | SVG | Sunucu |
| Photoroom | – | Yok | – |
| Türkiye | Türkçe SaaS yok; logo vektörleme freelance (Armut 1.000–6.000 TL) | – | – |

## Satıcı senaryoları ve formatlar

| Senaryo | Format | Gereksinim |
|---|---|---|
| Logo / ambalaj / matbaa | SVG, PDF | Az renk, temiz eğri |
| Cricut / Silhouette / vinil | SVG, DXF | Kapalı yollar, `cutout` katman, ≤ 5000 yol |
| Lazer kesim / kazıma | DXF (mm), SVG | Kontur (dolgu değil), çift çizgi yok |
| Baskı (POD) | Büyük PNG | Vektörden yüksek çözünürlüklü PNG |
| Nakış | DST/PES | **Kapsam dışı** |

## Önerilen yapım sırası

1. VTracer'ı kaynaktan derle, worker'da çalıştır; Logo / Çizim / Siyah-beyaz ayarları, otomatik büyütme.
2. SVG + yüksek çözünürlüklü PNG indirme; önizlemede orijinal / vektör karşılaştırma.
3. PDF (SVG yollarından), sonra DXF (Bezier → polyline, mm, kontur) ve `cutout` kesim ayarı.
4. Paketlere dağıtım (öneri): Ücretsiz önizleme + günlük birkaç SVG; Pro: SVG/PDF/PNG; İşletme: DXF, toplu işlem.
