//! Kayıpsız (piksel kusursuz) vektörleştirme.
//!
//! Aynı RGBA değerine sahip 4-komşu piksellerden oluşan her bölgenin sınırı, piksel kenarları boyunca
//! tam sayı koordinatlarla izlenir. Kenarlar bölge sağda kalacak yönde (saat yönü, y aşağı) dizildiği için
//! dış sınırlar ve delikler zıt dönüş yönündedir; varsayılan "nonzero" dolgu kuralıyla delikler doğru boşalır.
//! Orijinal boyutta çizildiğinde her piksel ya tamamen içeride ya tamamen dışarıdadır: çıktı orijinalle
//! piksel piksel aynıdır (kenar yumuşatma olmasın diye `shape-rendering="crispEdges"`).

use std::collections::HashMap;
use std::fmt::Write;

/// Bir rengin (RGBA) tüm bölgelerinin kapalı döngüleri. Her döngü köşe noktalarından oluşur.
pub struct ColorLoops {
    pub rgba: [u8; 4],
    pub loops: Vec<Vec<(i32, i32)>>,
}

/// Görseli renk başına kapalı döngülere ayırır. Tamamen saydam pikseller (a = 0) çizilmez.
pub fn trace(rgba: &[u8], width: usize, height: usize) -> Vec<ColorLoops> {
    let px = |x: usize, y: usize| -> [u8; 4] {
        let i = (y * width + x) * 4;
        [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
    };
    // Her renk için yönlü kenarlar: başlangıç köşesi → bitiş köşeleri.
    // Piksel (x,y) için kenarlar (bölge sağda): üst (x,y)→(x+1,y), sağ (x+1,y)→(x+1,y+1),
    // alt (x+1,y+1)→(x,y+1), sol (x,y+1)→(x,y). Komşusu aynı renkte olan kenar yazılmaz.
    let mut by_color: HashMap<[u8; 4], HashMap<(i32, i32), Vec<(i32, i32)>>> = HashMap::new();
    let mut order: Vec<[u8; 4]> = Vec::new();
    for y in 0..height {
        for x in 0..width {
            let c = px(x, y);
            if c[3] == 0 {
                continue;
            }
            let same = |nx: i64, ny: i64| -> bool {
                nx >= 0 && ny >= 0 && (nx as usize) < width && (ny as usize) < height && px(nx as usize, ny as usize) == c
            };
            let (xi, yi) = (x as i64, y as i64);
            let (x0, y0, x1, y1) = (x as i32, y as i32, x as i32 + 1, y as i32 + 1);
            let edges = by_color.entry(c).or_insert_with(|| {
                order.push(c);
                HashMap::new()
            });
            if !same(xi, yi - 1) { edges.entry((x0, y0)).or_default().push((x1, y0)); }
            if !same(xi + 1, yi) { edges.entry((x1, y0)).or_default().push((x1, y1)); }
            if !same(xi, yi + 1) { edges.entry((x1, y1)).or_default().push((x0, y1)); }
            if !same(xi - 1, yi) { edges.entry((x0, y1)).or_default().push((x0, y0)); }
        }
    }
    order
        .into_iter()
        .map(|c| {
            let edges = by_color.remove(&c).unwrap();
            ColorLoops { rgba: c, loops: link_loops(edges) }
        })
        .collect()
}

/// Yönlü kenarları kapalı döngülere bağlar. Bir köşeden birden fazla kenar çıkıyorsa (çapraz değen
/// iki piksel) her zaman sağa dönülür: böylece döngüler kendini kesmez ve bölgeler 4-komşulukla ayrılır.
fn link_loops(mut edges: HashMap<(i32, i32), Vec<(i32, i32)>>) -> Vec<Vec<(i32, i32)>> {
    let mut starts: Vec<(i32, i32)> = edges.keys().copied().collect();
    starts.sort_unstable_by_key(|&(x, y)| (y, x));
    let mut loops = Vec::new();
    for start in starts {
        while edges.get(&start).map_or(false, |v| !v.is_empty()) {
            let mut points = vec![start];
            let mut prev = start;
            let mut cur = take_edge(&mut edges, start, None);
            while cur != start {
                let dir = (cur.0 - prev.0, cur.1 - prev.1);
                let next = take_edge(&mut edges, cur, Some(dir));
                points.push(cur);
                prev = cur;
                cur = next;
            }
            loops.push(simplify(points));
        }
    }
    loops
}

fn take_edge(edges: &mut HashMap<(i32, i32), Vec<(i32, i32)>>, at: (i32, i32), incoming: Option<(i32, i32)>) -> (i32, i32) {
    let outs = edges.get_mut(&at).expect("kapalı olmayan sınır");
    let pick = match (incoming, outs.len()) {
        (_, 1) | (None, _) => 0,
        (Some((dx, dy)), _) => {
            // y aşağı koordinatta sağa dönüş: (dx,dy) → (-dy, dx)
            let right = (at.0 - dy, at.1 + dx);
            outs.iter().position(|&o| o == right).unwrap_or(0)
        }
    };
    let next = outs.swap_remove(pick);
    if outs.is_empty() {
        edges.remove(&at);
    }
    next
}

/// Aynı doğru üzerindeki ara noktaları atar (yalnızca köşeler kalır).
fn simplify(points: Vec<(i32, i32)>) -> Vec<(i32, i32)> {
    let n = points.len();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let a = points[(i + n - 1) % n];
        let b = points[i];
        let c = points[(i + 1) % n];
        let collinear = (b.0 - a.0) * (c.1 - b.1) == (b.1 - a.1) * (c.0 - b.0);
        if !collinear {
            out.push(b);
        }
    }
    out
}

/// Kayıpsız SVG: renk başına bir yol, yalnızca yatay/dikey kenarlar (H/V), tam sayı koordinatlar.
pub fn to_svg(width: usize, height: usize, colors: &[ColorLoops]) -> String {
    let mut out = String::new();
    let _ = write!(
        out,
        r#"<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="{w}" height="{h}" viewBox="0 0 {w} {h}" shape-rendering="crispEdges">"#,
        w = width,
        h = height
    );
    for c in colors {
        if c.loops.is_empty() {
            continue;
        }
        let mut d = String::new();
        for l in &c.loops {
            let (sx, sy) = l[0];
            let _ = write!(d, "M{} {}", sx, sy);
            for i in 1..l.len() {
                let (px, py) = l[i - 1];
                let (x, y) = l[i];
                if y == py { let _ = write!(d, "H{}", x); } else if x == px { let _ = write!(d, "V{}", y); }
            }
            d.push('Z');
        }
        let [r, g, b, a] = c.rgba;
        let _ = write!(out, "\n<path d=\"{}\" fill=\"#{:02X}{:02X}{:02X}\"", d, r, g, b);
        if a < 255 {
            // 8 bitlik alfayı kayıpsız taşımak için 6 basamak yeterli (çizici alfa*255'i yuvarlar).
            let _ = write!(out, " fill-opacity=\"{:.6}\"", a as f64 / 255.0);
        }
        out.push_str("/>");
    }
    out.push_str("\n</svg>\n");
    out
}

/// Doğrulama için: SVG'yi kendimiz piksel merkezlerinde (nonzero kuralıyla) geri çizeriz.
#[cfg(test)]
pub fn rasterize(width: usize, height: usize, colors: &[ColorLoops]) -> Vec<u8> {
    let mut out = vec![0u8; width * height * 4];
    for c in colors {
        for y in 0..height {
            let cy = y as f64 + 0.5;
            // Bu satırı kesen dikey kenarlar ve dönüş yönleri.
            let mut crossings: Vec<(f64, i32)> = Vec::new();
            for l in &c.loops {
                for i in 0..l.len() {
                    let (x0, y0) = l[i];
                    let (x1, y1) = l[(i + 1) % l.len()];
                    if x0 != x1 { continue; }
                    let (ya, yb) = (y0.min(y1) as f64, y0.max(y1) as f64);
                    if cy > ya && cy < yb {
                        crossings.push((x0 as f64, if y1 > y0 { 1 } else { -1 }));
                    }
                }
            }
            crossings.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
            let mut winding = 0;
            for w in crossings.windows(2) {
                winding += w[0].1;
                if winding != 0 {
                    let (xa, xb) = (w[0].0 as usize, w[1].0 as usize);
                    for x in xa..xb {
                        out[(y * width + x) * 4..(y * width + x) * 4 + 4].copy_from_slice(&c.rgba);
                    }
                }
            }
        }
    }
    out
}
