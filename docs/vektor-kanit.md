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

### Bant başına gradyan (deneysel, laboratuvarda seçenek)

Vectorizer.AI tarzı "sürekli gölge" için fikir: her eş-ışık bandına kendi doğrusal gradyanı uydurulur
(`fitLabelFills`; renk ≈ a + b·x + c·y, kanal başına; düz renge göre kazanç ≥ %20 ise). Tüm etiketler VTracer'a
eşsiz sahte renkle tek geçişte verilir, yollar etikete çözülüp dolgu değiştirilir. Netleştirilmiş ejderhada
ΔE 6,5 → 5,3 (yol 132 → 356); ama panda 3,2 → 5,3, pikachu 4,2 → 5,1, temiz logo 0,4 → 1,3. Bu yüzden
varsayılan değil; laboratuvarda "Bant gradyanı (deneysel)" kutusu (`BAND_GRADIENT_OVERRIDES`). Öğrenilen:
VTracer kırıntı birleştirirken renkleri ortaladığı için sahte renk tam eşleşmeyebilir; en yakın etikete çözülür
ve kırıntı eşiği düşük tutulur.

### Kullanıcı karşılaştırması (orijinal webp ↔ SVG, aynı boyutta piksel piksel)

Ölçüm `tools/vector-proof` ile aynı mantık: SVG orijinal boyutta (267×218) geri çizilir, her piksel CIE76 ΔE ile
karşılaştırılır; "belirgin fark" ΔE > 6 olan piksel payı. Kaynak: AI ile netleştirilmiş görsel.

| Sürüm | Ort. ΔE | Belirgin fark | Yol |
|---|---|---|---|
| Kullanıcının çıktısı (ilk bant gradyanı, düzlem uçlu) | 6,80 | %35,5 | 295 |
| Çizim (varsayılan, cel 4 ton) | 6,57 | %37,2 | 132 |
| Bant gradyanı, uçlar gerçek piksel ortalaması, adım 8 | 5,57 | %31,3 | 356 |
| Bant gradyanı, adım 4 | 5,08 | %27,6 | 412 |
| Bant gradyanı, adım 3 | 5,05 | %27,8 | 478 |
| Bant gradyanı, adım 2 | 4,83 | %26,3 | 474 |
| + sıkı eğri (köşe 30, uzunluk 2, ekleme 30) | 4,67 | %26,1 | 433 |
| **+ adım 1, ön bulanıklık yok** (BAND_GRADIENT_OVERRIDES) | **4,44** | **%23,1** | 686 |

Kalan hatanın dağılımı (adım 1): kenar pikselleri (orijinalde kontrastın yüksek olduğu yerler, piksellerin %46'sı)
ort. ΔE 7,1 ve toplam hatanın %73'ü; düz alanlar ort. ΔE 2,2. Netleştirilmiş görselin kendisi orijinalden ΔE 0,94
uzakta; yani kalan fark netleştirmeden değil, keskin vektör kenarının bulanık kenara oturmamasından. Denenip
vazgeçilenler: renkleri orijinalden almak (4,8 → 5,8), kenar yarıçapı 1–3 (daha kötü), 64 renk palet (5,2),
pencere içindeki tüm etiketleri karışım ucu saymak (4,58).

Kalan farkın büyük kısmı kenarlarda: kaynak netleştirildiği için orijinalin bulanık kenarından ΔE olarak
uzaklaşır (netleştirilmiş görsele göre ΔE 5,0). Diğer örneklerde bant gradyanı: bulanık logo 2,75 → 2,17 daha
iyi; panda 3,16 → 3,79, anime 3,95 → 4,26 (yol 278 → 1433), temiz logo 0,39 → 1,25 daha kötü. Bu yüzden varsayılan
değil; laboratuvarda "AI netleştir" açılınca otomatik açılır, istenirse kapatılır.

### Yüksek sadakat: netleştirilmiş görselin renk seviyesi azaltılıp kayıpsız izlenmesi

Hedef "orijinale göre belirgin fark ≤ %5" temiz şekillerle ulaşılamadı (en iyi %23). Ölçümle bulunan yol:
AI ile netleştirilmiş 4× görselin renkleri kanal başına 2^b seviyeye yuvarlanır (`posterize`), sonra piksel
kenarlarından kayıpsız izlenir (`vectorizeExact(..., { colorBits: b })`; `verifyExact` yuvarlanmış görsele göre
0 fark). Orijinal boyutta ölçüm (267 px, kenar yumuşatmalı geri çizim):

| Kaynak | Renk | Yol | Boyut | Ort. ΔE | Belirgin fark |
|---|---|---|---|---|---|
| 4 bit (16 seviye) | 632 | 7.645 | 2,3 MB | 3,06 | %7,9 |
| **5 bit (32 seviye)** | 2.519 | 15.274 | 3,3 MB | **1,89** | **%1,8** |
| 6 bit (64 seviye) | 9.359 | 28.178 | 4,6 MB | 1,29 | %1,5 |
| (netleştirilmiş görselin kendisi) | – | – | – | 0,94 | %1,6 |
| Temiz vektör, bant gradyanı | – | 686 | 0,3 MB | 4,44 | %23,1 |

Diğer örneklerde aynı yöntem (orijinale göre, kendi boyutunda): panda %1,3 (3.865 yol), Pikachu %0,9 (4.656),
bulanık logo %0,0 (1.515), temiz logo %0,8 (512). Editörden indirilen çıktı (arka plan silme atlanarak, kendi
saydamlığıyla), iki ayrı koşuda: ejderha %1,4, 2.283 yol, doğrulayıcı geçerli. Büyük görsel: 640×480 anime karesi
4× netleştirmede (2560×1920) 5 bit sınırı aşıyor, 4 bit %14,5 (8,5 MB); çalışma boyutu 2×'e indirilince
(`shrinkForExact`, 1,4 MP üstünde) 5 bit **%0,1** (2.606 yol, 5,1 MB), 6 bit %0,0 (7,5 MB). Editör ve laboratuvar
bu kuralı uygular.

Laboratuvarın kendi ölçümü (tarayıcıda, viewBox boyutunda çizip ikiye ikiye küçülterek): ejderha %0,23, anime
%0,02. Editörde SVG'nin varsayılan türü "Yüksek sadakat"tır ve gerekirse AI netleştirmeyi kendiliğinden açar;
uçtan uca testte indirilen dosya %1,4 (üç ayrı koşu). `crispEdges` korunur: kenar yumuşatmalı çizimde komşu
şekiller arasında çizgi boşlukları oluşuyor (resvg, yarı boyutta piksellerin %42'si), crispEdges ile 1:1'de birebir.
Köşe kırpma / Douglas–Peucker ile kenar yumuşatma denendi: komşu çokgenler ayrı sadeleşince aralarında beyaz
boşluklar açılıyor (tol 1,0'da şekil farkı 6.905 px), vazgeçildi.

5 bit seçildi: netleştirilmiş görselin tabanına (%1,6) ulaşıyor, dosya 3,3 MB. Laboratuvarda "AI netleştir" açıkken
Kayıpsız mod bunu üretir. Büyütmede kenarlar 1068 piksel çözünürlüğünde basamaklıdır (orijinalin 4 katı); "temiz
eğri" değildir, ama orijinale en yakın vektördür.

### Ürün yolundan kanıt (editör → PNG + SVG), tek yöntemle

`tools/vector-proof/urun-kanit.mjs` altı görseli editöre yükledi, ürünün şeffaf PNG'sini (orijinal boyut) ve
varsayılan SVG'sini (Yüksek sadakat, netleştirme kendiliğinden) indirdi; `urun-olc.sh` hepsini aynı yöntemle ölçtü
(SVG viewBox boyutunda resvg ile çizilir, Lanczos ile küçültülür, CIE76 ΔE; belirgin fark = ΔE > 6 piksel payı).

| Görsel | SVG ↔ ürün PNG | SVG ↔ orijinal dosya | Yol / boyut | Süre (model dahil) |
|---|---|---|---|---|
| Ejderha 267×218 (kendi saydamlığı) | ΔE 1,87, **%1,4** | ΔE 1,87, **%1,4** | 2.283 / 1,9 MB | 21 s |
| Anime 640×480 | ΔE 1,56, **%0,0** | ΔE 1,70, %0,8 | 2.521 / 4,8 MB | 101 s |
| Panda 191×169 | ΔE 2,04, **%1,3** | ΔE 2,84, %5,8* | 2.814 / 0,6 MB | 28 s |
| Pikachu 224×224 | ΔE 1,75, **%1,3** | ΔE 5,58, %13,2* | 3.408 / 1,7 MB | 31 s |
| Temiz logo 771×200 | ΔE 1,85, **%0,3** | ΔE 5,71, %9,2* | 177 / 0,1 MB | 59 s |
| Bulanık logo 771×200 | ΔE 1,80, **%1,9** | ΔE 7,71, %27,5* | 496 / 0,4 MB | 60 s |

\* Bu görseller opak (saydamlık yok); editör arka planı sildiği için ürün çıktısı "kesilmiş ürün"dür ve orijinal
dosyadaki zemin pikselleri farka girer. Bunun için editöre "Arka planı silme (olduğu gibi kullan)" seçeneği
eklendi (model atlanır, hak düşülmez). Aynı koşu bu seçenekle (`KEEP_BG=1`), **orijinal dosyaya göre**:

| Görsel | SVG ↔ orijinal dosya | Yol / boyut | Süre |
|---|---|---|---|
| Ejderha 267×218 | ΔE 1,87, **%1,4** | 2.283 / 1,9 MB | 21 s |
| Anime 640×480 | ΔE 1,68, **%0,1** | 2.545 / 4,9 MB | 85 s |
| Panda 191×169 | ΔE 1,98, **%1,4** | 3.883 / 1,1 MB | 10 s |
| Pikachu 224×224 | ΔE 1,50, **%1,0** | 4.634 / 2,6 MB | 15 s |
| Temiz logo 771×200 | ΔE 1,26, **%0,4** | 262 / 0,2 MB | 43 s |
| Bulanık logo 771×200 | ΔE 1,20, **%0,0** | 1.292 / 1,2 MB | 43 s |

Altı görselde de orijinal dosyaya göre belirgin fark ≤ %1,4 (hedef ≤ %5). Ürün PNG'sine göre ölçüm aynı değerleri
verdi (arka plan silinmediği için ikisi aynı kaynak).

**İkinci koşu (tekrarlanabilirlik) ve "Birebir" türü.** Aynı koşu ikinci kez, iki SVG türüyle:

| Görsel | Yüksek sadakat (2. koşu) | Birebir | Birebir yol / boyut |
|---|---|---|---|
| Ejderha | %1,4 | ΔE 0,02, **%0,0** | 14.383 / 0,9 MB |
| Anime | %0,1 | ΔE 0,00, **%0,0** | 35.768 / 3,4 MB |
| Panda | %1,4 | ΔE 0,00, **%0,0** | 8.397 / 0,6 MB |
| Pikachu | %1,0 | ΔE 0,00, **%0,0** | 12.439 / 0,7 MB |
| Temiz logo | %0,4 | ΔE 0,00, **%0,0** | 518 / 0,1 MB |
| Bulanık logo | %0,0 | ΔE 0,00, **%0,0** | 13.431 / 1,0 MB |

Yüksek sadakat değerleri ilk koşuyla birebir aynı (belirlenimci). "Birebir" türü altı görselde de sıfır fark
(ejderhadaki 0,02 webp/png çözme farkı). Eski eğri tabanlı az parçalı çizim (orijinalden farklı, gölgeli çizimde
belirgin fark ~%20) laboratuvarda "Çizim/Logo" olarak kaldı; onun yerini üründe aşağıdaki "Temiz" tür aldı.

### Temiz vektör: ortak kenarlı çokgenler (piksel ızgarasız, hedefi tutan)

Yüksek sadakat ve Birebir piksel kenarlı yollar üretir (büyütünce basamak görünür, dosya büyük). Eğri tabanlı eski
"Çizim" ise %20'de kalıyordu. Kayıpsız yolları sonradan sadeleştirme denemesi (Chaikin / Douglas–Peucker) komşu
şekiller arasında boşluk açtığı için bırakılmıştı: her şekil kendi sınırını ayrı sadeleştiriyordu. Çözüm, sınırı
**bir kez** sadeleştirmek: `public/assets/sharedtrace.js`.

1. Netleştirilmiş (4×) görselde her piksel Lab uzayında en yakın palet rengine eşlenir (k-ortalamalar, en çok 160
   renk; dolgu rengi bölgenin gerçek ortalaması).
2. Küçük parçalar komşuya katılır (`mergeSpecks`): 4 piksel altı her parça; 16 piksel altı parça yalnızca en benzer
   komşudan ΔE < 8 uzaktaysa. Katılan parça hedef bileşenin üyesi olur, hedef sonra taşınırsa onunla gider (ilk
   sürümde yetim benekler kalıyor, parça sayısı artıyordu: 27.505 → düzeltmeyle ~3.000).
3. Bölgeler arasındaki piksel kenarı ağı, kavşaklar (≥3 bölgenin buluştuğu köşeler) arasında zincirlere bölünür;
   her zincir **bir kez** Douglas–Peucker ile sadeleştirilir (uçlar sabit) ve her bölgenin çokgeni bu ortak
   zincirlerden kurulur. İki komşu aynı zinciri paylaştığı için boşluk ya da bindirme olamaz; test: tamamen opak
   rastgele haritada işaretli alanların toplamı her toleransta tam olarak w·h (`test/sharedtrace.test.js`).
   Tolerans kontrasta duyarlı: 0,6 px taban; iki yanı birbirine yakın renkli sınırlarda (ΔE < 12) 3 katına kadar
   gevşer (görünür fark üretmez), keskin dış çizgiler sıkı kalır. Görsel çerçevesi üzerindeki sınır sadeleştirilmez.
4. Çıktı: renk başına tek `<path>` (M/H/V/L/Z), `validateSvg` denetiminden geçer; `crispEdges` yok.

Sıfır toleransta izleyici kuantalanmış rasterle piksel piksel aynı (1068×872'de 0 farklı piksel; ilk sürümdeki
halka kurma hatası — zincire ortasından girince halka erken kapanıyordu — bu testle bulundu).

Parametre taraması (ejderha, orijinale göre belirgin fark): mod süzgeci zararlı (yarıçap 1: %12,4 → kapalı: %5,9);
64 renk %5,3, 128 renk %2,4 (tolerans 1, benek birleştirmesiz); tolerans 0 → 2 px: %2,6 → %3,5. Benek birleştirme
temizlik getirir ama ayrıntı siler (16 px: %5,6); seçilen denge 4/16/ΔE 8.

Çevrimdışı ölçüm (netleştirilmiş kaynak → `vectorizeClean` varsayılanlarıyla → viewBox boyutunda resvg → Lanczos →
orijinale göre CIE76):

| Görsel | Belirgin fark (ΔE > 6) | Ortalama ΔE | Yol / alt yol / boyut |
|---|---|---|---|
| Ejderha 267×218 | **%3,0** | 2,02 | 110 / 3.109 / 267 KB |
| Anime 640×480 | **%0,6** | 1,87 | 120 / 22.453 / 2,1 MB |
| Panda 191×169 | **%3,3** | 2,01 | 87 / 2.040 / 155 KB |
| Pikachu 224×224 | **%2,6** | 1,65 | 137 / 6.403 / 454 KB |
| Temiz logo 771×200 | **%0,5** | 0,22 | 8 / 111 / 80 KB |
| Bulanık logo 771×200 | **%0,1** | 0,60 | 90 / 6.593 / 616 KB |

Karşılaştırma: aynı görsellerde eski Çizim modu %20–23, kullanıcının kendi SVG'si %35,5. Kalan farkın çoğu düz renge
indirilen gölge geçişleri (hafif, ΔE 2,3–6 bandı %20–29) ve netleştirmeden keskinleşen kenarlar.


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
