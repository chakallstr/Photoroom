import { chromium } from 'playwright';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
// Kullanım: tools/vector-proof/README.md
const P = process.argv[2] || new URL('.', import.meta.url).pathname;
fs.mkdirSync(P + '/out', { recursive: true });
const CASES = [
  ['logo-temiz', 'logo', false], ['logo-bulanik', 'logo', false], ['logo-bulanik', 'siyahBeyaz', true],
  ['star-icon', 'logo', false], ['panda', 'cizim', false], ['pikachu', 'cizim', false], ['anime', 'cizim', false], ['anime', 'detayli', false],
  ['book-cover', 'detayli', false], ['ayakkabi-kesim', 'logo', true], ['kupa-kesim', 'logo', false], ['kulaklik-foto', 'detayli', false],
];
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto('http://localhost:8795/tools/vector-proof/proof.html');
await page.waitForFunction(() => window.ready);
const rows = [];
for (const [name, preset, cutout] of CASES) {
  const r = await page.evaluate(([n, p, c]) => window.run(n, p, c), [name, preset, cutout]);
  const tag = `${name}__${preset}${cutout ? '_kesim' : ''}`;
  const file = `${P}/out/${tag}.svg`;
  fs.writeFileSync(file, r.svg);
  // 1) XML geçerliliği (xmllint)
  let xml = 'geçerli';
  try { execSync(`xmllint --noout ${file}`, { stdio: 'pipe' }); } catch (e) { xml = 'HATA ' + e.stderr; }
  // 2) Bağımsız çizici: resvg (katı ayrıştırıcı) ile çiz, Chromium çizimiyle karşılaştır
  let resvg = 'geçerli';
  try { execSync(`resvg ${file} ${P}/out/${tag}__resvg.png`, { stdio: 'pipe' }); } catch (e) { resvg = 'HATA ' + e.stderr; }
  const chromePng = `${P}/out/${tag}__chrome.png`;
  await page.setViewportSize({ width: r.W, height: r.H });
  const view = await browser.newPage({ viewport: { width: r.W, height: r.H } });
  await view.setContent(`<body style="margin:0">${r.svg}</body>`);
  await view.screenshot({ path: chromePng, omitBackground: true, clip: { x: 0, y: 0, width: r.W, height: r.H } });
  await view.close();
  const diff = execSync(`python3 -c "
from PIL import Image, ImageChops
a=Image.open('${chromePng}').convert('RGBA'); b=Image.open('${P}/out/${tag}__resvg.png').convert('RGBA').resize(a.size)
bg=lambda im:(lambda c:(c.alpha_composite(im),c)[1])(Image.new('RGBA',im.size,'white')).convert('RGB')
d=ImageChops.difference(bg(a),bg(b)).convert('L'); h=d.histogram(); n=sum(h)
print(round(100*sum(h[32:])/n,3))"`).toString().trim();
  rows.push({ tag, ...r, svg: undefined, xml, resvg, crossDiff: diff });
}
await browser.close();
const fmt = (r) => [r.tag, `${r.W}x${r.H}${r.k > 1 ? ` (${r.k}x)` : ''}`, r.valid.ok ? 'GEÇTİ' : 'KALDI: ' + r.valid.errors[0], r.xml, r.resvg,
  `${r.crossDiff}%`, r.iou.toFixed(3), r.dE.toFixed(1), r.stats.paths, `${(r.stats.bytes / 1024).toFixed(0)} KB`, `${r.ms} ms`].join(' | ');
console.log('görsel | boyut | doğrulayıcı | xmllint | resvg | Chromium↔resvg farkı | şekil örtüşmesi (IoU) | renk farkı (ΔE) | yol | boyut | süre');
for (const r of rows) console.log(fmt(r));
fs.writeFileSync(`${P}/results.json`, JSON.stringify(rows, null, 2));
