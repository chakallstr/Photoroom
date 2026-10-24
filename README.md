# Photoroot

Ürün fotoğrafları için basit ve uygun fiyatlı arka plan silme aracı.

## Yapı

```
public/            Site (tanıtım + fiyat sayfası, editör)
  assets/app.js      Editör: kuyruk, kompozisyon, indirme
  assets/touchup.js  Elle rötuş: sil / geri getir fırçası
  assets/account.js  Hesap, günlük hak, Pro'ya geçiş
  assets/worker.js   Tarayıcıda çalışan arka plan silme modeli
server/            API (ek paket yok: node:http + node:sqlite)
  app.js             Uç noktalar
  auth.js            Şifre (scrypt), oturum, deneme sınırı
  usage.js           Günlük hak (İstanbul saatine göre)
  billing.js         Abonelik durumu
  payments/          iyzico ve geliştirme için sahte (mock) ödeme
public/yasal/      Mesafeli satış, ön bilgilendirme, iptal/iade, gizlilik/KVKK, iletişim (taslak)
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
| `POST /api/auth/forgot` · `reset` | Şifremi unuttum: e-postaya 1 saatlik, tek kullanımlık bağlantı |
| `POST /api/account/password` | Şifre değiştirir (diğer oturumlar kapanır) |
| `POST /api/account/delete` | Hesabı ve verileri siler, aboneliği iptal eder (KVKK) |
| `GET /api/health` | Sağlık kontrolü |

Güvenlik: `HttpOnly` + `SameSite=Lax` çerezler; POST istekleri yalnızca JSON kabul eder ve `Origin` kontrol edilir (CSRF);
giriş denemeleri sınırlıdır; çerez silerek ek hak alınmasın diye IP başına da (gizli tuzla özetlenmiş, IPv6'da /64) sınır vardır.
Sahte ödeme sağlayıcısı yalnızca `localhost` adresinde açılır.

Abonelik kuralları:
- Ödeme dönüşü iyzico'dan doğrulanmadan abonelik açılmaz; aynı dönüş iki kez işlenemez.
- iyzico geçici hata verirse ödeme beklemede kalır; kullanıcı sekmeyi kapatsa bile hesabına girdiğinde
  ya da iyzico bildirimi geldiğinde ödeme tekrar kontrol edilip abonelik açılır.
- Aynı kullanıcı iki ödeme yaparsa yeni abonelik açılır, eskisi iyzico'da iptal edilir (çift çekim olmaz).
- Yenileme ödemesi alınamazsa kullanıcı ödediği dönemin sonu + 3 gün boyunca paketinde kalır.
- İptal edilen abonelik dönem sonuna kadar geçerlidir; ödemesi alınamamış abonelikler de iptal edilebilir.

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

## E-postalar

Şifre sıfırlama, satın alma (sipariş özeti + mesafeli satış sözleşmesinin tam metni), iptal, ödeme alınamadı
ve hesap silindi e-postaları gönderilir. Metinler `server/emails.js` içinde. Geliştirmede e-postalar konsola yazılır.

## Vektör (SVG) çevirme

Logo, ikon ve çizimler için görselden SVG'ye çevirme tarayıcıda yapılır (VTracer, kaynaktan WASM'a derlenmiş).
Gölgeli çizimlerde görsel bölgelere ayrılır; yumuşak geçişli bölgeler SVG gradyanıyla, diğerleri bölgeye özel
birkaç tonla boyanır (`public/assets/gradients.js`). Kayıpsız mod orijinalle piksel piksel aynı çıktı verir ve
her çıktı verilmeden önce doğrulanır.
Kendin denemek için: `/vektor-lab.html`. Ölçümler ve kanıt: `docs/vektor-kanit.md`.

### Editörde SVG indirme

"Dosya türü → SVG" seçilince üç vektör türü var: **Temiz** (eğriler, az parça; logo/ikon/çizim), **Yüksek
sadakat** (AI netleştirme + kanal başına 32 renk seviyesi + piksel kenarlı kayıpsız izleme; orijinale göre
belirgin fark ≈ %1–2) ve **Birebir** (kesilmiş görselle piksel piksel aynı). SVG kesilmiş ürünü şeffaf zeminde
verir; ölçü/kenar boşluğu/gölge uygulanmaz. Zaten şeffaf zeminli PNG/WebP yüklenirse arka plan silme atlanır ve
hak düşülmez.

## AI netleştirme (4× büyütme)

Küçük ya da bulanık görseller için isteğe bağlı adım: waifu2x `swin_unet` "art" 4× modeli (nunif, MIT;
`public/assets/vendor/waifu2x/`) tarayıcıda onnxruntime-web ile çalışır; görsel hiçbir yere gönderilmez.
Editörde "AI netleştir" seçeneği kesilmiş ürünü büyütür; vektör laboratuvarında vektör bu netleştirilmiş görselden
çekilir (küçük çizimlerde kontur ve ayrıntı belirgin biçimde iyileşir). WebGPU varsa birkaç saniye, yoksa WASM'de
küçük görselde 20–30 s sürer; 1 megapikselden büyük girdilerde atlanır. Veri hazırlığı `public/assets/upscale.js`
(testli), model çalıştırma `public/assets/upscale-worker.js`.

## Yayına alma (Render)

1. Render'da **New → Blueprint** ile bu repoyu seç; `render.yaml` servisi ve 1 GB kalıcı diski oluşturur.
2. Panelde gizli değerleri gir (`PUBLIC_URL`, iyzico anahtarları ve plan kodları).
3. Alan adını bağla ve iyzico panelinde webhook adresini güncelle.

Başka bir platformda `Dockerfile` kullanılabilir; `/data` klasörü kalıcı bir diske bağlanmalı.

## Yayından önce yapılacaklar

- `public/yasal/` altındaki köşeli parantezli alanları doldur, metinleri hukukçuya kontrol ettir ve sayfalardaki taslak uyarısını kaldır.
- E-posta servisi: [Resend](https://resend.com) hesabı aç, alan adını doğrula, `RESEND_API_KEY` ve `EMAIL_FROM` ayarla.
  Ayarlanmazsa şifre sıfırlama ve sözleşme e-postaları gönderilmez (yalnızca günlüğe yazılır).
- İşletme paketindeki ekip hesabı (5 kullanıcı) henüz yok; fiyat sayfasında "yakında" olarak gösteriliyor.

## Arka plan silme

Tamamen tarayıcıda yapılır ([transformers.js](https://github.com/huggingface/transformers.js) + ONNX); fotoğraflar sunucuya gönderilmez.

| Tarayıcı | Model | Lisans | İndirme (ilk sefer) |
|---|---|---|---|
| WebGPU var | BiRefNet lite 1024 | MIT | ~115 MB (fp16) / ~215 MB (fp32) |
| WebGPU yok | BiRefNet lite 512 (fp16) | MIT | ~98 MB |

Model çıktısı tarayıcıda temizlenir (`public/assets/mask.js`): sisli yarı saydam alanlar netleştirilir,
ürüne bağlı olmayan kırıntılar silinir ve kenara sinen zemin rengi giderilir.

WebGPU olmayan tarayıcılar için model seçimi 8 gerçek ürün fotoğrafıyla yapıldı: BiRefNet lite 512, ormbg'den
belirgin şekilde iyi ve MVANet'e yakın sonuç verdi; görsel başına ~9 sn (MVANet ~46 sn). ISNet bu kütüphaneyle çalışmadı.

Bilinen sınır: işlem tarayıcıda olduğu için günlük limit ve 1080 px sınırı, tarayıcı kodunu değiştiren biri tarafından aşılabilir.
Asıl gelir koruması toplu işleme, tam çözünürlük ve kolaylıktır.
