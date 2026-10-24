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

## Gölgeli çizimler: bölgeye duyarlı palet ve gradyan (yeni)

Tek paletle (16 renk) tüm görseli boyamak gölgeli çizimlerde iki sorun çıkarıyordu: yumuşak geçişler üst üste
renk bantlarına bölünüyor, komşu bölgelerin tonları birbirine karışıyordu. Yeni akış (`public/assets/gradients.js`,
`applyRegionPalette`):

1. Görsel renk-sürekli **bölgelere** ayrılır (komşu farkı ≤ 6; 2·ölçek aralıklı fark > 14 olan pikseller kenardır,
   bölgeye girmez; bu sayede 3–4× büyütmede yumuşayan kenarlar bölgeleri birleştirmez).
2. Her bölgeye **gradyan** sığdırılır (doğrusal düzlem ya da paraboloit tepe noktalı dairesel; 48 kutuluk renk
   profili, en fazla 8 durak). Kabul: artık hata RMS ≤ 7 ve renk değişiminin ≥ %85'i açıklanıyor. Sığmayan büyük
   bölge daha sıkı adımla bölünüp parçaları denenir.
3. Sığmayan bölge **kendi içinde** en az sayıda tona ayrılır (ortalama ΔE ≤ 4 olana kadar 1→4 ton): çizgi film
   gölgelemesi gibi ana ton + gölge + ışık. Bölge dışı pikseller (kontur, küçük ayrıntı) ortak paletle boyanır;
   ΔE < 5 yakınlıktaki tonlar birleştirilir (aynı mavi on harfte on renk olmasın).
4. Gradyan bölgeleri ikili maske olarak ayrıca izlenir; düz çizimin üstüne `fill="url(#gN)"` ile eklenir.
   `validateSvg` artık yalnızca başta tek `<defs>`, içinde yalnızca `linearGradient`/`radialGradient`
   (`gradientUnits="userSpaceOnUse"`, koordinatlar görsel içinde, duraklar 0'dan 1'e sıralı, renkler `#RRGGBB`),
   tanımsız ya da kullanılmayan gradyan yok kuralıyla denetler. Kayıpsız mod değişmedi (gradyan kullanmaz).

Ek adımlar (ikinci tur):

5. **Karışım yapıştırma** (`snapBlends`): kontur ile dolgu arasındaki bulanık piksel, rengi iki komşu rengin
   arasındaysa (C ≈ A + t·(B−A)) yakın olduğu uca eşlenir; ikinci bir "gölge kontur" oluşmaz.
6. **Bölge içi bulanıklaştırma**: ton ataması bölgeyle sınırlı bulanık renk üzerinden yapılır; bant sınırı piksel
   gürültüsüne değil gölgenin eş-ışık eğrisine oturur.
7. **Yumuşak gölge katmanı** (Çizim ayarı): birden çok tonlu büyük bölgenin bantları ayrı bir `<g>` içinde
   `feGaussianBlur` ile bulanıklaştırılıp `clipPath` ile bölge şekline kırpılır; kenarlar keskin kalır, gölge
   airbrush gibi yumuşar. Doğrulayıcı bu üçünü de sıkı kurallarla kabul eder (tek defs; clipPath yalnızca
   d'li yollar; filter yalnızca bir feGaussianBlur; g yalnızca clip-path + filter; kullanılmayan tanım yok).
   Kesim makineleri ve bazı eski programlar filtreyi yok sayar; çıktı uyarır.

Denenip vazgeçilenler (ölçümle): bölgelemeyi özgün çözünürlükte yapıp etiketleri büyütmek konturu inceltiyor
ama kontur dibindeki koyu gölgeyi siliyor (ejderha ΔE 6,8 → 10,0; görüntü düz ve pastel). Kenar maskesi
yarıçapını küçültmek de kötüleştiriyor (3 → 2 piksel: ΔE 6,5 → 7,2). Dairesel "ışık lekesi" toplamıyla gölge
uydurma (8 leke) gövdede RMS 12 → 9,8: tonlardan kötü, vazgeçildi.

Ölçüm (uygulamadaki gibi `planScale` büyütmesiyle; Chromium'da geri çizilip orijinalle karşılaştırıldı):

| Görsel | Ayar | Eski ΔE | Yeni ΔE | Eski yol | Yeni yol | Gradyan |
|---|---|---|---|---|---|---|
| Ejderha çizimi (267 px, gölgeli) | Çizim | 8,8 | **7,1** | 77 | 236 | 2 |
| Ejderha çizimi | Logo | 11,6 | **7,6** | 41 | 66 | 2 |
| Anime karesi | Çizim | 4,8 | **3,9** | 151 | 1015 | 1 |
| Anime karesi | Logo | 7,1 | **3,8** | 58 | 146 | 1 |
| Panda çizimi | Logo | 3,5 | 3,1 | 18 | 17 | 0 |
| Pikachu | Çizim | 4,3 | 4,3 | 22 | 26 | 0 |
| Bulanık logo | Logo | 2,8 | 2,7 | 18 | 21 | 0 |
| Temiz logo | Çizim / Logo | 0,4 | 0,5 | 18 | 18 | 0 |

Düz logolarda sonuç aynı; gölgeli çizimlerde renk hatası %20–45 düştü, yol sayısı ve dosya arttı (yumuşak
katman bantları ayrıca içerir). Gölgeli çizimde kalan fark: kontur dibindeki ±1 piksel (büyütmede ±3) kuşak
ortak paletle boyanıyor ve orijinalden koyu/kalın görünüyor; ayrıca vektör çözünürlük eklemez, bulanık
kaynaktaki ayrıntı (göz, diş) geri gelmez. Sonraki adım: kontur piksellerini ince çizgi olarak ayrı izlemek.

### Çizgi film tonlaması (cel) ve küçük ayrıntılar

Çizim ayarı artık bölge tonlarını k-means yerine bulanık parlaklığın eşit aralıklı seviyelerine göre böler
(gölge / ana ton / ışık; `celTones`). Sınırlar eş-ışık eğrileri olduğu için pürüzsüz, ışık alanları küçük de
olsa korunur; gölge bantlarının bulanıklaştırılması kaldırıldı (puslu/pastel görünüm veriyordu). Küçük ama
anlamlı alanlar için bölge eşiği %0,3 → %0,05, ortak palet 16 → 32 renk ve pay eşiği %0,2 → %0,05 (göz akı ve
ağız kırmızısı geri geldi); kenar yapıştırma yarıçapı 2·ölçek → ölçek, çoğunluk filtresi en fazla 2 piksel
(göz, diş erimesin). Ölçüm: netleştirilmiş ejderhada ΔE 6,5; netleştirilmemiş bulanık kaynakta 8,5 (cel
tonlama bulanık kaynakta k-means'ten daha az isabetli; Çizim ayarı AI netleştirmeyle birlikte düşünülmeli).
Logolar değişmedi (temiz logo 0,4; bulanık logo 2,7); anime 3,9 (yol 1015 → 278).

### AI netleştirme ile (waifu2x)

Küçük, bulanık kaynakta tracer'ın yapabileceği sınırlı: ayrıntı kaynakta yok. Vektörden önce görsel waifu2x
swin_unet art 4× (nunif, MIT) ile büyütülünce kontur ince ve temiz, göz/diş/pençe gibi ayrıntılar geri geliyor.
Ejderha (267 px): netleştirilmiş görselden Çizim ΔE 6,2 (yumuşak katmansız 5,6), netleştirmesiz 7,1. Gürültü
azaltma varyantları (noise1/noise3/art_scan) arasında gözle fark yok; düz `scale4x` kullanılıyor. Tarayıcıda
onnxruntime-web WASM tek iş parçacığıyla 267×218 → 1068×872: 23–29 s; Python onnxruntime CPU: 19 s.
Denenen genel amaçlı Swin2SR (fotoğraf modeli) renkleri kaydırdı (ΔE 17–27), çizim için uygun değil.

Yöntem, açık kaynak iki projenin yaklaşımından esinlendi ve sıfırdan yazıldı (kod kopyalanmadı):
[KurtVonSchaeffer/vectorize](https://github.com/KurtVonSchaeffer/vectorize) (bölge → düzlem/paraboloit uydurma,
RMS/açıklanan varyans kabulü) ve [RidhuanDEV/png-to-svg-vectorize](https://github.com/RidhuanDEV/png-to-svg-vectorize)
(MIT; çizgi film için bölge birleştirme ve gradyan).

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
