# Vektör çıktısı: kanıt raporu

Tarih: 24 Ekim 2026. Soru: Photoroot'un ürettiği SVG **tam vektör ve hatasız** mı?

## Kısa cevap

Evet, ölçülebilir tanımıyla: 12 test çıktısının tamamı üç bağımsız denetimden geçti (kendi katı doğrulayıcımız,
`xmllint`, `resvg`), iki farklı çizici (Chromium ve resvg) aynı sonucu verdi (en fazla %0,12 piksel farkı) ve
logo/çizimlerde vektör orijinalle şekil olarak %99–100 örtüşüyor. Ayrıca her çıktı, kullanıcıya verilmeden önce
sitede `validateSvg` ile denetlenir; geçemeyen çıktı hiç verilmez.

## Kendin dene: `vektor-lab.html`

Kanıtı okumak yerine görmek için sitede **`/vektor-lab.html`** sayfası var (tek dosyalık, internetsiz sürümü
`python3 tools/vector-proof/build-single.py cikti.html` ile üretilir). Kendi görselini yükler, SVG'yi indirir ve
sağ panelde SVG'nin **kendi tarayıcında** geri çizilip orijinalle piksel piksel karşılaştırılmasını görürsün: farklı
piksel sayısı, fark haritası (kırmızı = farklı), doğrulama kontrolleri, 1x/4x/8x yakınlaştırma ile yan yana görünüm.

## Kayıpsız mod: orijinalle piksel piksel aynı (0 piksel fark)

Pürüzsüz eğrili modlar (Logo / Çizim / Detaylı) şekli sadeleştirir; bulanık kenar piksellerini birebir
tutturamaz (eğriyle çizmenin doğası). **"1 piksel bile fark olmayacak"** şartı için ayrı bir **kayıpsız mod**
vardır (`vectorizeExact`): aynı renkteki 4-komşu piksel bölgelerinin sınırı piksel kenarları boyunca, tam sayı
koordinatlarla izlenir (`tools/vtracer-wasm/src/exact.rs`), kenar yumuşatma `shape-rendering="crispEdges"` ile
kapatılır, yarı saydamlık `fill-opacity` ile kayıpsız taşınır.

**Garanti mekanizması:** her kayıpsız çıktı kullanıcıya verilmeden önce tarayıcıda geri çizilip kaynakla
piksel piksel karşılaştırılır (`verifyExact`). Tek bir piksel farklıysa, iki bölge aynı pikseli boyuyorsa ya da
bir köşe görselin dışındaysa çıktı **verilmez**. Bu denetim test görselleriyle sınırlı değil; her yüklemede çalışır.

| Görsel | Boyut | Yarı saydam piksel | Yol | Dosya | Chromium tuval 1x / 2x / 3x | Chromium gömülü SVG | resvg 1x | xmllint |
|---|---|---|---|---|---|---|---|---|
| Temiz logo | 771×200 | 0 | 518 | 73 KB | **0 / 0 / 0** | **0** | **0** | ✓ |
| Bulanık logo (JPEG) | 771×200 | 0 | 13.431 | 1,0 MB | **0 / 0 / 0** | **0** | **0** | ✓ |
| Panda | 191×169 | 0 | 8.397 | 585 KB | **0 / 0 / 0** | **0** | **0** | ✓ |
| Pikachu | 224×224 | 0 | 12.439 | 750 KB | **0 / 0 / 0** | **0** | **0** | ✓ |
| Anime karesi | 640×480 | 0 | 35.768 | 3,5 MB | **0 / 0 / 0** | **0** | **0** | ✓ |
| Kitap kapağı | 403×500 | 0 | 44.755 | 3,6 MB | **0 / 0 / 0** | **0** | **0** | ✓ |
| Kulaklık fotoğrafı | 1000×667 | 0 | 31.081 | 7,0 MB | **0 / 0 / 0** | **0** | **0** | ✓ |
| Kupa kesimi | 1000×667 | 2.729 | 4.899 | 571 KB | **0 / 0 / 0** | **0** | 61* | ✓ |
| Yıldız ikonu | 512×512 | 2.063 | 175 | 65 KB | **0 / 0 / 0** | **0** | 9* | ✓ |

\* resvg yarı saydam pikselleri 8 bit önçarpımlı saklar; PNG'ye yazarken geri bölünce bazı piksellerde renk
±1 yuvarlanır (saydamlık ve önçarpımlı değerler birebir aynı). Kanıt: **orijinal PNG de resvg ile çizilince
vektörün resvg çizimiyle birebir aynı çıkıyor (0 piksel fark)**; sapma vektörden değil çizicinin kendisinden.

Testler: Rust'ta 3.000 rastgele görselde (çapraz değen pikseller, yarı saydamlık, delikler dahil) kendi
çizicimizle geri çizim = kaynak; JavaScript'te 300 rastgele görselde `verifyExact`; tek piksellik bozulmanın ve
görsel dışına taşan köşenin yakalandığını gösteren testler.

Bedeli: dosya boyutu (her farklı renk ayrı bölge). Logolarda küçük, fotoğraflarda büyük; 60.000 yolu aşan
görsellerde (ör. ayakkabı kesimi) kayıpsız mod reddedilir ve pürüzsüz bir ayar önerilir. Büyütüldüğünde kenarlar
orijinal gibi piksel basamaklıdır; pürüzsüz eğri isteniyorsa Logo / Çizim ayarları kullanılır.

## "Tam vektör ve hatasız" tanımı (her çıktıda otomatik denetlenir)

1. **Saf vektör:** yalnızca `<svg>` ve `<path>`; gömülü resim, `data:` adresi, bağlantı, betik, stil yok.
2. **Ölçeklenir:** `viewBox` var ve `width/height` ile aynı oranda; yollarda `transform` yok (mutlak koordinat).
3. **Geçerli yol verisi:** SVG standardındaki sözdizimine göre katı ayrıştırma; `M` ile başlar, sayılar sonlu
   (NaN/sonsuz yok), argüman sayıları doğru, her alt yol `Z` ile kapalı, koordinatlar görsel içinde.
4. **Geçerli renk:** her yolun dolgusu `#RRGGBB`.
5. **Sınırlar:** en fazla 60.000 yol / 15 MB; 5.000 yolu aşarsa Cricut uyarısı.

## Sonuçlar (son tur)

| Görsel | Ayar | Doğrulayıcı | xmllint | resvg | Chromium↔resvg | Örtüşme (IoU) | Renk farkı (ΔE) | Yol | Boyut |
|---|---|---|---|---|---|---|---|---|---|
| Temiz logo (PNG) | Logo | ✓ | ✓ | ✓ | %0,03 | 1,000 | 0,9 | 18 | 28 KB |
| Bulanık logo (JPEG) | Logo | ✓ | ✓ | ✓ | %0,02 | 1,000 | 3,1* | 18 | 33 KB |
| Bulanık logo | Siyah-beyaz, kesim | ✓ | ✓ | ✓ | %0,12 | 0,867** | – | 13 | 38 KB |
| Yıldız ikonu | Logo | ✓ | ✓ | ✓ | %0,00 | 0,997 | 3,7 | 1 | 11 KB |
| Panda çizimi | Çizim | ✓ | ✓ | ✓ | %0,02 | 1,000 | 3,9 | 29 | 85 KB |
| Pikachu (224 px) | Çizim | ✓ | ✓ | ✓ | %0,01 | 1,000 | 4,6 | 26 | 65 KB |
| Anime karesi | Çizim | ✓ | ✓ | ✓ | %0,00 | 1,000 | 4,9 | 156 | 262 KB |
| Anime karesi | Detaylı | ✓ | ✓ | ✓ | %0,00 | 1,000 | 3,5 | 1900 | 1,2 MB |
| Kitap kapağı | Detaylı | ✓ | ✓ | ✓ | %0,00 | 1,000 | 10,1 | 4133 | 1,9 MB |
| Ayakkabı kesimi | Logo, kesim | ✓ | ✓ | ✓ | %0,02 | 0,993 | 12,9 | 79 | 163 KB |
| Kupa kesimi | Logo | ✓ | ✓ | ✓ | %0,00 | 0,982 | 4,3 | 7 | 13 KB |
| Kulaklık fotoğrafı | Detaylı | ✓ | ✓ | ✓ | %0,01 | 1,000 | 12,4 | 1024 | 523 KB |

\* Bulanık logoda vektör orijinalden *daha temiz*: bulanık kenar pikselleri (kırmızı→beyaz geçiş tonları) bilinçli
olarak atıldı; ölçülen fark bundan. Logo tam olarak gerçek 3 rengine (beyaz, kırmızı, lacivert) indi.
\*\* Siyah-beyazda eşik farkı: orijinalin bulanık kenarları eşikte iki tarafa da düşebiliyor.

Fotoğraflar ve fotoğraf benzeri ürün görselleri vektörde doğal olarak sadeleşir (ΔE 10–13); bu bir hata değil,
vektörün doğası. Ürün sayfasında "logo, ikon ve çizimler için" diye konumlandırılmalı.

## Test ve dayanıklılık

- **Rust (köprü, `tools/vtracer-wasm`)**: 8 test; rastgele üretilmiş **2.000 görselle** (boyut, saydamlık,
  renk, ayar kombinasyonları) hiçbir çökme, NaN/sonsuz değer, `viewBox` eksikliği ya da `transform` yok.
- **JavaScript (`test/vector.test.js`)**: doğrulayıcı 16 farklı bozuk SVG türünü yakalıyor; 4 ayar × 2 katman
  modu × 8 görsel türünde (daire, delikli halka, logo, saydam zeminde ürün, gradyan, tamamen saydam, 1 piksel,
  ince çizgiler) her çıktı geçerli; kesim katmanında delikler gerçek delik; palet temizliği testleri.

## Bulunan ve giderilen hatalar

| Hata | Kaynak | Çözüm |
|---|---|---|
| Ayarlar iç birimle verilince her görsel tek bir damla şekle dönüşüyor | üçüncü taraf `vtracer-wasm` paketi | VTracer kaynaktan derlendi; resmi `Config` (derece, bit, piksel) kullanılıyor |
| Tamamen saydam görselde çökme | visioncortex 0.8.8 | 0.8.10'a yükseltildi + köprüde koruma |
| Kenarlarda saydamlık yoksa saydam alanlar **siyah şekil** oluyor | VTracer saydamlığı yalnızca 5 tarama satırına bakarak tanıyor | Saydam piksel varsa üste/alta saydam satır ekleyip tanıma garanti ediliyor |
| `viewBox` yok, her yolda `transform` | VTracer'ın SVG yazıcısı | Kendi yazıcımız: `viewBox`, mutlak koordinat |
| Yarı saydam kenarlarda renk halesi | alfa eşiklenmiyordu | Alfa 128'de eşikleniyor |
| Logo ayarında renk sapması (ΔE 22) | renk/katman ayarı fazla birleştiriyordu | Ölçümle yeni ayar (ΔE ~1–4) |
| Bulanık kenarların vektörde ayrı renk halkalarına dönüşmesi | JPEG/bulanık geçiş tonları | Palet çıkarma + geçiş rengi temizliği |
| 16 MP üstünde renk toplamı taşması riski | visioncortex | Çevirme en fazla 4 MP |
| Kesim katmanında anahtar rengin sızması | yalnızca üçüncü taraf pakette | Resmi kodda yok; testle güvenceye alındı |

## Kesim makineleri için not

Cricut/lazer/vinil için **kesim katmanı** kullanılmalı: delikler gerçek delik olarak yolda bulunur ve şekiller
üst üste binmez. Üst üste katman (varsayılan) ekranda ve baskıda aynı görünür ama delikleri üstüne çizilen şekille
gösterir. Kesim katmanında bitişik renkler arasında ekranda ince açık çizgiler görülebilir (kenar yumuşatma);
geometri ortak kenarlıdır, kesimi etkilemez.

Yeniden üretmek için: `tools/vector-proof/README.md`.
