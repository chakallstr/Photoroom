# Photoroot

Ürün fotoğrafları için basit ve uygun fiyatlı arka plan silme aracı.

## Yapı

```
public/            Site (tanıtım + fiyat sayfası, editör)
  assets/app.js      Editör: kuyruk, kompozisyon, indirme
  assets/account.js  Hesap, günlük hak, Pro'ya geçiş
  assets/worker.js   Tarayıcıda çalışan arka plan silme modeli
server/            API (ek paket yok: node:http + node:sqlite)
  app.js             Uç noktalar
  auth.js            Şifre (scrypt), oturum, deneme sınırı
  usage.js           Günlük hak (İstanbul saatine göre)
  billing.js         Abonelik durumu
  payments/          iyzico ve geliştirme için sahte (mock) ödeme
scripts/iyzico-setup.js  iyzico'da ürün ve planları oluşturur
test/              Otomatik testler (sahte iyzico sunucusu dahil)
```

## Çalıştırma

Node.js 22.13 veya üstü gerekir. `npm install` gerekmez.

```bash
npm start      # http://localhost:8000, sahte ödeme ile
npm test       # tüm testler
```

Geliştirme modunda ödeme sahtedir: "Ödemeyi onayla" düğmesi kart çekmeden aboneliği açar.

## Paketler

| | Ücretsiz | Pro | İşletme |
|---|---|---|---|
| Aylık | 0 ₺ | 99 ₺ | 249 ₺ |
| Yıllık | – | 990 ₺ | 2.490 ₺ |
| Görsel | Günde 10 | Sınırsız | Sınırsız |
| Çözünürlük | 1080 px | Tam | Tam |
| Toplu ZIP | – | ✓ | ✓ |

Paket tanımlarının tek kaynağı `server/plans.js`.

## API

| Uç nokta | Açıklama |
|---|---|
| `GET /api/me` | Kullanıcı, paket, limitler, bugünkü kullanım, abonelik |
| `POST /api/auth/register` · `login` · `logout` | Hesap |
| `POST /api/usage` | Bir görsel için günlük haktan düşer (limit dolunca 429) |
| `POST /api/billing/checkout` | Ödemeyi başlatır, ödeme sayfası adresini döner |
| `GET /api/billing/pay` | iyzico ödeme formunu gösterir |
| `GET/POST /api/billing/callback` | iyzico dönüşü; ödeme iyzico'dan doğrulanır |
| `POST /api/billing/webhook` | iyzico abonelik bildirimleri (imza doğrulamalı) |
| `POST /api/billing/cancel` | Aboneliği iptal eder (dönem sonuna kadar geçerli) |

Güvenlik: `HttpOnly` + `SameSite=Lax` çerezler; POST istekleri yalnızca JSON kabul eder ve `Origin` kontrol edilir (CSRF);
giriş denemeleri sınırlıdır; çerez silerek ek hak alınmasın diye IP başına da (gizli tuzla özetlenmiş) sınır vardır.

## iyzico'ya bağlanma

1. iyzico'da işyeri hesabı aç ve panelden **Abonelik** eklentisini etkinleştir.
2. Sandbox anahtarlarını al (https://sandbox-merchant.iyzipay.com) ve planları oluştur:
   ```bash
   IYZICO_API_KEY=... IYZICO_SECRET_KEY=... node scripts/iyzico-setup.js
   ```
3. `.env.example` dosyasını `.env` olarak kopyalayıp doldur.
4. iyzico panelinde **Abonelik Bildirimleri** adresini `https://<alan-adın>/api/billing/webhook` yap.
   `X-IYZ-SIGNATURE-V3` imzası için iyzico'dan (entegrasyon@iyzico.com) webhook imzasının açılmasını iste.
5. Sandbox'ta bir test kartıyla uçtan uca dene, sonra `IYZICO_BASE_URL=https://api.iyzipay.com` ile canlıya geç.

Sandbox'ta mutlaka doğrulanması gerekenler (dokümanda belirsiz ya da çelişkili):
- Webhook imzasındaki alan sırası (dokümandaki kod örnekleri `merchantId + secretKey + ...` diyor, metin `secretKey` ile başlıyor).
- GET isteklerinde imzaya gövde eklenmemesi (doküman böyle diyor, resmi SDK `{}` ekliyor).

## Arka plan silme

Tamamen tarayıcıda yapılır ([transformers.js](https://github.com/huggingface/transformers.js) + ONNX); fotoğraflar sunucuya gönderilmez.

| Tarayıcı | Model | Lisans | İndirme (ilk sefer) |
|---|---|---|---|
| WebGPU var | BiRefNet lite | MIT | ~115 MB (fp16) / ~215 MB (fp32) |
| WebGPU yok | ormbg (uint8) | Apache 2.0 | ~45 MB |

Bilinen sınır: işlem tarayıcıda olduğu için günlük limit ve 1080 px sınırı, tarayıcı kodunu değiştiren biri tarafından aşılabilir.
Asıl gelir koruması toplu işleme, tam çözünürlük ve kolaylıktır.
