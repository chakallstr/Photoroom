//! VTracer'ı tarayıcıya açan küçük köprü.
//!
//! Resmi `vtracer::Config` kullanıcı birimlerini (derece, renk biti, piksel) alır ve iç birimlere
//! kendisi çevirir; böylece yanlış birimle çağırma hatası olmaz. SVG çıktısını VTracer'ın kendi
//! yazıcısı yerine burada üretiyoruz: `viewBox` eklenir ve her yoldaki `transform="translate()"`
//! kaldırılıp koordinatlar mutlak yazılır (kesim/lazer yazılımlarıyla uyum için).

pub mod exact;

use std::fmt::Write;
use visioncortex::{CompoundPathElement, PathSimplifyMode, PointF64, PointI32};
use vtracer::{ColorImage, ColorMode, Config, Hierarchical, SvgFile};
use wasm_bindgen::prelude::*;

pub struct Options {
    pub binary: bool,
    pub cutout: bool,
    pub filter_speckle: usize,
    pub color_precision: i32,
    pub layer_difference: i32,
    pub corner_threshold: i32,
    pub length_threshold: f64,
    pub splice_threshold: i32,
    pub path_precision: u32,
}

pub fn vectorize_rgba(rgba: &[u8], width: usize, height: usize, o: &Options) -> Result<String, String> {
    if width == 0 || height == 0 {
        return Err("Görsel boş (genişlik ya da yükseklik 0).".into());
    }
    if rgba.len() != width * height * 4 {
        return Err(format!("Piksel verisi boyutla uyuşmuyor: {} bayt, beklenen {}.", rgba.len(), width * height * 4));
    }
    if !(1..=8).contains(&o.color_precision) {
        return Err("Renk hassasiyeti 1–8 arasında olmalı.".into());
    }
    if width * height > MAX_PIXELS {
        return Err("Görsel çok büyük (en fazla 16 megapiksel).".into());
    }
    let config = Config {
        color_mode: if o.binary { ColorMode::Binary } else { ColorMode::Color },
        hierarchical: if o.cutout { Hierarchical::Cutout } else { Hierarchical::Stacked },
        filter_speckle: o.filter_speckle,
        color_precision: o.color_precision,
        layer_difference: o.layer_difference,
        mode: PathSimplifyMode::Spline,
        corner_threshold: o.corner_threshold,
        length_threshold: o.length_threshold,
        max_iterations: 10,
        splice_threshold: o.splice_threshold,
        path_precision: Some(o.path_precision),
    };
    // Vektörde yarı saydamlık yok: alfayı eşikle (yarı saydam kenarlar renk halesi bırakmasın).
    let mut pixels = rgba.to_vec();
    let mut transparent = 0usize;
    for p in pixels.chunks_exact_mut(4) {
        if p[3] < 128 {
            p.copy_from_slice(&[0, 0, 0, 0]);
            transparent += 1;
        } else {
            p[3] = 255;
        }
    }
    // Tamamen saydam görselde çizilecek bir şey yok (eski visioncortex sürümleri burada çöküyordu).
    if transparent == width * height {
        return Ok(write_svg(&SvgFile::new(width, height, Some(o.path_precision)), o.path_precision, 0));
    }
    // VTracer saydamlığı yalnızca 5 tarama satırında yeterince saydam piksel varsa tanır; yoksa saydam
    // alanlar siyah şekil olarak çizilir. Saydam piksel varsa üste ve alta birer saydam satır ekleyerek
    // tanımayı garanti ederiz; koordinatlar yazılırken geri kaydırılır.
    let (img, shift) = if transparent > 0 && !o.binary {
        let row = width * 4;
        let mut padded = vec![0u8; row];
        padded.extend_from_slice(&pixels);
        padded.extend(std::iter::repeat(0u8).take(row));
        (ColorImage { pixels: padded, width, height: height + 2 }, 1)
    } else {
        (ColorImage { pixels, width, height }, 0)
    };
    let mut svg = vtracer::convert(img, config)?;
    svg.height = height;
    Ok(write_svg(&svg, o.path_precision, shift))
}

const MAX_PIXELS: usize = 16_000_000;

/// viewBox'lı, transform'suz, mutlak koordinatlı SVG. `shift`: üste eklenen satır sayısı (geri kaydırılır).
pub fn write_svg(svg: &SvgFile, precision: u32, shift: i32) -> String {
    let mut out = String::with_capacity(svg.paths.len() * 256);
    let _ = write!(
        out,
        r#"<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="{w}" height="{h}" viewBox="0 0 {w} {h}">"#,
        w = svg.width,
        h = svg.height
    );
    for p in &svg.paths {
        let mut d = String::new();
        for element in &p.path.paths {
            d.push_str(&match element {
                CompoundPathElement::PathI32(e) => e.to_svg_string(true, &PointI32::new(0, -shift), Some(precision)),
                CompoundPathElement::PathF64(e) => e.to_svg_string(true, &PointF64::new(0.0, -shift as f64), Some(precision)),
                CompoundPathElement::Spline(e) => e.to_svg_string(true, &PointF64::new(0.0, -shift as f64), Some(precision)),
            });
        }
        let d = clamp_path(d.trim(), svg.width as f64, svg.height as f64, precision);
        if d.is_empty() {
            continue;
        }
        let _ = write!(out, "\n<path d=\"{}\" fill=\"{}\"/>", d, p.color.to_hex_string());
    }
    out.push_str("\n</svg>\n");
    out
}

/// Yoldaki tüm noktaları (eğri kontrol noktaları dahil) görsel sınırına sabitler. VTracer yalnızca mutlak
/// M/L/C/Q komutları ve x,y çiftleri üretir. Bézier eğrisi kontrol noktalarının dışbükey zarfı içinde kaldığı
/// için noktalar sınır içindeyse eğri de sınır içindedir: hiçbir şekil görselin dışına taşmaz.
pub fn clamp_path(d: &str, w: f64, h: f64, precision: u32) -> String {
    let mut out = String::with_capacity(d.len());
    let mut is_x = true;
    let mut num = String::new();
    let flush = |num: &mut String, out: &mut String, is_x: &mut bool| {
        if num.is_empty() { return; }
        let v: f64 = num.parse().unwrap_or(0.0);
        let c = if *is_x { v.clamp(0.0, w) } else { v.clamp(0.0, h) };
        let p = 10f64.powi(precision as i32);
        let r = (c * p).round() / p + 0.0; // + 0.0: eksi sıfırı (-0) sıfıra çevirir
        if !out.is_empty() && !out.ends_with(|ch: char| ch.is_ascii_alphabetic()) { out.push(' '); }
        let _ = write!(out, "{}", r);
        *is_x = !*is_x;
        num.clear();
    };
    for ch in d.chars() {
        if ch.is_ascii_digit() || ch == '.' || (ch == '-' && num.is_empty()) || ch == 'e' {
            num.push(ch);
        } else {
            flush(&mut num, &mut out, &mut is_x);
            if ch.is_ascii_alphabetic() {
                if !out.is_empty() && !out.ends_with(' ') { out.push(' '); }
                out.push(ch);
                if ch == 'Z' || ch == 'z' { out.push(' '); }
            }
        }
    }
    flush(&mut num, &mut out, &mut is_x);
    out.trim().to_string()
}

#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn vectorize(
    rgba: &[u8],
    width: usize,
    height: usize,
    binary: bool,
    cutout: bool,
    filter_speckle: usize,
    color_precision: i32,
    layer_difference: i32,
    corner_threshold: i32,
    length_threshold: f64,
    splice_threshold: i32,
    path_precision: u32,
) -> Result<String, JsValue> {
    let o = Options {
        binary, cutout, filter_speckle, color_precision, layer_difference,
        corner_threshold, length_threshold, splice_threshold, path_precision,
    };
    vectorize_rgba(rgba, width, height, &o).map_err(|e| JsValue::from_str(&e))
}

/// Kayıpsız (piksel kusursuz) SVG: orijinal boyutta çizildiğinde her piksel orijinalle aynıdır.
pub fn vectorize_exact_rgba(rgba: &[u8], width: usize, height: usize) -> Result<String, String> {
    if width == 0 || height == 0 {
        return Err("Görsel boş (genişlik ya da yükseklik 0).".into());
    }
    if rgba.len() != width * height * 4 {
        return Err(format!("Piksel verisi boyutla uyuşmuyor: {} bayt, beklenen {}.", rgba.len(), width * height * 4));
    }
    if width * height > MAX_PIXELS {
        return Err("Görsel çok büyük (en fazla 16 megapiksel).".into());
    }
    // Tamamen saydam piksellerin rengi anlamsızdır; hepsi tek değere indirilir (çizilmezler).
    let mut px = rgba.to_vec();
    for p in px.chunks_exact_mut(4) {
        if p[3] == 0 { p.copy_from_slice(&[0, 0, 0, 0]); }
    }
    Ok(exact::to_svg(width, height, &exact::trace(&px, width, height)))
}

#[wasm_bindgen]
pub fn vectorize_exact(rgba: &[u8], width: usize, height: usize) -> Result<String, JsValue> {
    vectorize_exact_rgba(rgba, width, height).map_err(|e| JsValue::from_str(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> Options {
        Options {
            binary: false, cutout: false, filter_speckle: 4, color_precision: 6, layer_difference: 16,
            corner_threshold: 60, length_threshold: 4.0, splice_threshold: 45, path_precision: 2,
        }
    }

    fn image(w: usize, h: usize, f: impl Fn(usize, usize) -> [u8; 4]) -> Vec<u8> {
        let mut v = Vec::with_capacity(w * h * 4);
        for y in 0..h { for x in 0..w { v.extend_from_slice(&f(x, y)); } }
        v
    }

    #[test]
    fn kirmizi_kare_viewbox_ve_transformsuz() {
        let px = image(40, 30, |x, y| if (10..30).contains(&x) && (5..25).contains(&y) { [255, 0, 0, 255] } else { [255, 255, 255, 255] });
        let svg = vectorize_rgba(&px, 40, 30, &opts()).unwrap();
        assert!(svg.contains(r#"viewBox="0 0 40 30""#));
        assert!(!svg.contains("transform"));
        assert!(svg.contains(r##"fill="#FF0000""##));
    }

    #[test]
    fn hatali_girdiler_hata_dondurur() {
        assert!(vectorize_rgba(&[], 0, 10, &opts()).is_err());
        assert!(vectorize_rgba(&[0; 12], 2, 2, &opts()).is_err());
        let mut o = opts();
        o.color_precision = 9;
        assert!(vectorize_rgba(&[0; 16], 2, 2, &o).is_err());
    }

    #[test]
    fn tamamen_saydam_gorsel_bos_ve_gecerli_svg_verir() {
        let svg = vectorize_rgba(&vec![0u8; 20 * 20 * 4], 20, 20, &opts()).unwrap();
        let _ = MAX_PIXELS;
        assert!(svg.contains(r#"viewBox="0 0 20 20""#));
        assert!(!svg.contains("<path"));
    }

    /// Rastgele 2000 görselle (boyut, saydamlık, renk, şekiller) hiçbir girdinin çökertmediğini doğrular.
    #[test]
    fn rastgele_girdilerle_cokme_yok() {
        let mut seed: u64 = 0x5eed_1234_abcd_ef01;
        let mut rnd = move || { seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; seed };
        let mut failures = Vec::new();
        for case in 0..2000 {
            let w = 1 + (rnd() % 80) as usize;
            let h = 1 + (rnd() % 80) as usize;
            let kind = rnd() % 6;
            let palette: Vec<[u8; 4]> = (0..1 + rnd() % 6).map(|_| {
                let a = match rnd() % 4 { 0 => 0, 1 => (rnd() % 256) as u8, _ => 255 };
                [(rnd() % 256) as u8, (rnd() % 256) as u8, (rnd() % 256) as u8, a]
            }).collect();
            let mut px = Vec::with_capacity(w * h * 4);
            for y in 0..h { for x in 0..w {
                let c = match kind {
                    0 => palette[(rnd() % palette.len() as u64) as usize],                    // gürültü
                    1 => palette[((x / 3 + y / 3) % palette.len())],                           // desen
                    2 => if (x * x + y * y) % 37 < 9 { palette[0] } else { [0, 0, 0, 0] },     // çoğu saydam
                    3 => palette[if x * 2 > w { 0 } else { palette.len() - 1 }],               // iki blok
                    4 => [x as u8, y as u8, (x ^ y) as u8, 255],                               // gradyan
                    _ => if rnd() % 50 == 0 { palette[0] } else { [0, 0, 0, 0] },              // seyrek pikseller
                };
                px.extend_from_slice(&c);
            }}
            let mut o = opts();
            o.binary = rnd() % 4 == 0;
            o.cutout = rnd() % 2 == 0;
            o.filter_speckle = (rnd() % 12) as usize;
            o.color_precision = 1 + (rnd() % 8) as i32;
            o.layer_difference = (rnd() % 64) as i32;
            o.corner_threshold = (rnd() % 180) as i32;
            o.length_threshold = 3.5 + (rnd() % 7) as f64;
            o.splice_threshold = (rnd() % 180) as i32;
            let result = std::panic::catch_unwind(|| vectorize_rgba(&px, w, h, &o));
            match result {
                Err(_) => failures.push(format!("#{case}: {w}x{h} tür={kind} ÇÖKTÜ")),
                Ok(Ok(svg)) => {
                    if svg.contains("NaN") || svg.contains("inf") { failures.push(format!("#{case}: geçersiz sayı")); }
                    if svg.contains("d=\"M-") || svg.contains(" -") {
                        let i = svg.find(" -").or(svg.find("d=\"M-")).unwrap();
                        failures.push(format!("#{case}: negatif (sınır dışı) koordinat: …{}…", &svg[i..(i + 80).min(svg.len())]));
                    }
                    if !svg.contains("viewBox") || svg.contains("transform") { failures.push(format!("#{case}: biçim")); }
                }
                Ok(Err(_)) => {} // anlaşılır hata dönmesi kabul edilir
            }
        }
        assert!(failures.is_empty(), "{} hata:\n{}", failures.len(), failures.join("\n"));
    }

    /// Saydam alanı az olan (VTracer'ın tarama satırlarına denk gelmeyen) görselde saydamlık siyah şekle dönüşmemeli.
    #[test]
    fn az_saydamlik_siyah_sekil_olmaz() {
        // Kırmızı zemin, ortada küçük saydam bir delik; kenarlarda hiç saydam piksel yok.
        let px = image(100, 100, |x, y| if (40..60).contains(&x) && (45..55).contains(&y) { [0, 0, 0, 0] } else { [200, 30, 40, 255] });
        for cutout in [false, true] {
            let mut o = opts();
            o.cutout = cutout;
            let svg = vectorize_rgba(&px, 100, 100, &o).unwrap();
            assert!(!svg.contains("#000000"), "saydam alan siyah çizilmiş (cutout={cutout}):\n{svg}");
            assert!(svg.contains(r#"viewBox="0 0 100 100""#));
        }
    }

    /// Kesim katmanında saydam zemin, anahtar renk olarak sızmamalı (üçüncü taraf pakette görülen hata).
    #[test]
    fn kesim_katmaninda_anahtar_renk_sizmaz() {
        let px = image(80, 60, |x, y| if (x as i32 - 40).abs() + (y as i32 - 30).abs() < 20 { [20, 120, 60, 255] } else { [0, 0, 0, 0] });
        let mut o = opts();
        o.cutout = true;
        let svg = vectorize_rgba(&px, 80, 60, &o).unwrap();
        let fills: std::collections::BTreeSet<_> = svg.match_indices("fill=\"").map(|(i, _)| &svg[i + 6..i + 13]).collect();
        assert_eq!(fills.into_iter().collect::<Vec<_>>(), vec!["#14783C"], "{svg}");
    }

    /// Koordinatlar geri kaydırılmalı: kenara dayanan kare yine 0..20 aralığında olmalı.
    #[test]
    fn kaydirma_geri_alinir() {
        let px = image(40, 40, |x, y| if x < 20 && y < 20 { [0, 0, 255, 255] } else { [0, 0, 0, 0] });
        let svg = vectorize_rgba(&px, 40, 40, &opts()).unwrap();
        assert!(svg.contains("M0 0") || svg.contains("M0,0") || svg.contains("M20 0") || svg.contains("M0 20"), "{svg}");
        assert!(!svg.contains("-1"), "negatif koordinat kalmamalı: {svg}");
    }

    /// Kayıpsız mod: binlerce rastgele görselde SVG'yi kendimiz geri çiziyoruz; her piksel aynı olmalı.
    #[test]
    fn kayipsiz_mod_rastgele_gorsellerde_piksel_piksel_ayni() {
        let mut seed: u64 = 0x1234_5678_9abc_def1;
        let mut rnd = move || { seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; seed };
        for case in 0..3000 {
            let w = 1 + (rnd() % 24) as usize;
            let h = 1 + (rnd() % 24) as usize;
            let ncolors = 1 + rnd() % 5;
            let palette: Vec<[u8; 4]> = (0..ncolors).map(|_| {
                let a = match rnd() % 4 { 0 => 0, 1 => (1 + rnd() % 254) as u8, _ => 255 };
                [(rnd() % 256) as u8, (rnd() % 256) as u8, (rnd() % 256) as u8, a]
            }).collect();
            let kind = rnd() % 3;
            let mut px = Vec::with_capacity(w * h * 4);
            for y in 0..h { for x in 0..w {
                let c = match kind {
                    0 => palette[(rnd() % ncolors) as usize],                       // gürültü: çapraz değmeler bol
                    1 => palette[((x / 2 + y / 3) as u64 % ncolors) as usize],       // desen
                    _ => palette[if (x as i64 - w as i64 / 2).pow(2) + (y as i64 - h as i64 / 2).pow(2) < (w * h / 6) as i64 { 0 } else { (ncolors - 1) as usize }],
                };
                px.extend_from_slice(&c);
            }}
            let mut expect = px.clone();
            for p in expect.chunks_exact_mut(4) { if p[3] == 0 { p.copy_from_slice(&[0, 0, 0, 0]); } }
            let colors = exact::trace(&expect, w, h);
            let got = exact::rasterize(w, h, &colors);
            assert_eq!(got, expect, "#{case}: {w}x{h} tür={kind} piksel farkı var");
            let svg = exact::to_svg(w, h, &colors);
            assert!(svg.contains("viewBox") && !svg.contains("NaN"), "#{case}");
        }
    }

    /// Delikli şekil: delik ayrı ve ters yönlü döngü olmalı (nonzero ile boşalır).
    #[test]
    fn kayipsiz_delik_ters_yonlu() {
        let px = image(5, 5, |x, y| if (1..4).contains(&x) && (1..4).contains(&y) && !(x == 2 && y == 2) { [255, 0, 0, 255] } else { [255, 255, 255, 255] });
        let colors = exact::trace(&px, 5, 5);
        let red = colors.iter().find(|c| c.rgba == [255, 0, 0, 255]).unwrap();
        assert_eq!(red.loops.len(), 2);
        assert_eq!(exact::rasterize(5, 5, &colors), px);
    }

    #[test]
    fn yol_noktalari_sinira_sabitlenir() {
        assert_eq!(clamp_path("M-1.9 14.2 C120.5 3 5 -2 10 10 Z", 100.0, 50.0, 2), "M0 14.2 C100 3 5 0 10 10 Z");
        assert_eq!(clamp_path("M1 2 L3 4 Z M5 6 L7 8 Z", 10.0, 10.0, 2), "M1 2 L3 4 Z M5 6 L7 8 Z");
        assert_eq!(clamp_path("M-0.001 3 L-0 4 Z", 10.0, 10.0, 2), "M0 3 L0 4 Z");
    }

    #[test]
    fn tek_renk_ve_tek_piksel_gorseller_cokmez() {
        for px in [image(20, 20, |_, _| [0, 0, 0, 0]), image(20, 20, |_, _| [9, 120, 200, 255]), image(1, 1, |_, _| [1, 2, 3, 255])] {
            let w = if px.len() == 4 { 1 } else { 20 };
            let _ = vectorize_rgba(&px, w, w, &opts());
        }
    }
}

