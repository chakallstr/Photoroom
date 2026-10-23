# Photoroot

Ürün fotoğrafları için basit ve uygun fiyatlı arka plan silme aracı.

- **index.html**: Tanıtım ve fiyat sayfası
- **app.html**: Editör (arka plan silme, zemin rengi, ölçü şablonları, gölge, PNG/JPG, ZIP ile toplu indirme)

## Nasıl çalışır

Arka plan silme tamamen tarayıcıda yapılır ([transformers.js](https://github.com/huggingface/transformers.js) + ONNX). Fotoğraflar sunucuya gönderilmez, bu yüzden görsel başına sunucu maliyeti yoktur.

| Tarayıcı | Model | Lisans | İndirme (ilk sefer) |
|---|---|---|---|
| WebGPU var (Chrome, Edge, yeni Safari) | BiRefNet lite | MIT | ~115 MB (fp16) / ~215 MB (fp32) |
| WebGPU yok | ormbg (uint8) | Apache 2.0 | ~45 MB |

Model indirildikten sonra tarayıcı önbelleğinde kalır. Standart modu zorlamak için `app.html?wasm` adresini kullan.

## Çalıştırma

Derleme adımı yok. Herhangi bir statik sunucu yeterli:

```bash
python3 -m http.server 8000
# http://localhost:8000
```

Yayına almak için klasörü Vercel, Netlify, Cloudflare Pages veya GitHub Pages'e yüklemek yeterli.

## Paketler

| | Ücretsiz | Pro | İşletme |
|---|---|---|---|
| Aylık | 0 ₺ | 99 ₺ | 249 ₺ |
| Yıllık | 0 ₺ | 990 ₺ | 2.490 ₺ |
| Görsel | Günde 10 | Sınırsız | Sınırsız |
| Çözünürlük | 1080 px | Tam | Tam |
| Toplu işleme + ZIP | – | ✓ | ✓ |
| Kullanıcı | 1 | 1 | 5 |

## Sıradaki adımlar

Şu an tüm özellikler herkese açık; paket limitleri henüz uygulanmıyor.

1. Hesap sistemi (ör. Supabase Auth)
2. Ödeme (iyzico veya Paddle) ve abonelik durumuna göre limitler
3. Ücretsiz pakette günlük 10 görsel ve 1080 px sınırı
4. Alan adı ve marka tescili kontrolü
