# Photoroot

Ürün fotoğrafları için basit ve uygun fiyatlı arka plan silme aracı. Ayrıntılar: `README.md`.

## Kurallar

- Arayüz metinleri, hata mesajları, kod yorumları ve commit mesajları **Türkçe**.
- **Ek npm paketi yok.** Sunucu yalnızca Node.js 22 yerleşik modüllerini kullanır (`node:http`, `node:sqlite`, `node:crypto`).
  Tarayıcı tarafı derleme adımı olmadan çalışır; dış kütüphaneler yalnızca CDN'den, sabit sürümle yüklenir.
  İstisna: VTracer kaynaktan WASM'a derlenip `public/assets/vendor/vtracer/` altında tutulur
  (kaynak ve derleme: `tools/vtracer-wasm/build.sh`; değiştirirsen yeniden derle ve `cargo test` çalıştır).
  İkinci istisna: waifu2x ONNX modeli (MIT) `public/assets/vendor/waifu2x/` altında; onnxruntime-web CDN'den sabit
  sürümle yüklenir (`public/assets/upscale-worker.js`).
- Vektör çıktısı kullanıcıya verilmeden önce `validateSvg` ile denetlenir; kayıpsız modda ayrıca `verifyExact`
  ile piksel piksel doğrulanır. Bu denetimleri atlama.
  Ayrıntılar ve ölçümler: `docs/vektor-kanit.md`.
- Paket ve fiyat tanımlarının tek kaynağı `server/plans.js`. Fiyat değişirse `public/index.html` ve
  `public/assets/account.js` (PRICES) de güncellenmeli.
- Her değişiklikten sonra `npm test` çalıştır; yeni davranış için `test/` altına test ekle.
  Ödeme akışı değişirse `test/iyzico.test.js` ve sahte iyzico sunucusu (`test/fake-iyzico.js`) ile test et.
- Fotoğraflar asla sunucuya gönderilmez; arka plan silme tarayıcıda (`public/assets/worker.js`) yapılır.

## Güvenlik

- POST uç noktaları yalnızca JSON kabul eder (CSRF). iyzico dönüşü ve webhook hariç; onlar sağlayıcıdan doğrulanır.
- Sırlar (iyzico anahtarları, IP_SALT) yalnızca ortam değişkeninde; koda ya da repoya yazılmaz.
- Sahte ödeme sağlayıcısı yalnızca localhost'ta açılır; bu korumayı kaldırma.

## Komutlar

```bash
npm start   # http://localhost:8000 (sahte ödeme)
npm test
```
