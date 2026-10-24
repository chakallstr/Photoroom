// Ürün yolundan kanıt: her görsel editöre yüklenir; ürünün PNG'si (şeffaf, orijinal boyut) ve üç SVG türü (sadakat, temiz, birebir) indirilir.
import { chromium } from 'playwright';
const [,, outDir, ...files] = process.argv;
const browser = await chromium.launch(); const ctx = await browser.newContext({ acceptDownloads: true }); const page = await ctx.newPage({ viewport: { width: 1280, height: 1000 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
for (let i = 0; i < 30; i++) { try { await page.goto('http://localhost:8000/app.html'); break; } catch { await new Promise((r) => setTimeout(r, 1000)); } }
const t0 = Date.now(); while (Date.now() - t0 < 400000) { const st = await page.evaluate(() => document.querySelector('#status')?.textContent ?? ''); if (/Hazır/.test(st)) break; await page.waitForTimeout(5000); }
await page.click('#bg-mode [data-value="transparent"]'); await page.selectOption('#size', 'original'); if (process.env.KEEP_BG) await page.click('#keep-bg');
for (const file of files) {
  const name = file.split('/').pop().replace(/\.[^.]+$/, '');
  const t1 = Date.now();
  await (await page.$('#file-input')).setInputFiles(file);
  await page.waitForFunction(() => document.querySelector('[data-action="download"]:not([disabled])'), null, { timeout: 600000 });
  // PNG (ürünün kendi tanımı: kesilmiş ürün, şeffaf, orijinal boyut)
  await page.click('#format [data-value="png"]');
  let [d] = await Promise.all([page.waitForEvent('download', { timeout: 600000 }), page.click('[data-action="download"]')]);
  await d.saveAs(`${outDir}/${name}.png`);
  // Varsayılan SVG (Yüksek sadakat; netleştirme kendiliğinden)
  await page.click('#format [data-value="svg"]');
  [d] = await Promise.all([page.waitForEvent('download', { timeout: 900000 }), page.click('[data-action="download"]')]);
  await d.saveAs(`${outDir}/${name}.svg`);
  // Temiz türü (ortak kenarlı çokgenler)
  await page.click('#svg-mode [data-value="temiz"]');
  [d] = await Promise.all([page.waitForEvent('download', { timeout: 900000 }), page.click('[data-action="download"]')]);
  await d.saveAs(`${outDir}/${name}.temiz.svg`);
  // Birebir türü
  await page.click('#svg-mode [data-value="birebir"]');
  [d] = await Promise.all([page.waitForEvent('download', { timeout: 900000 }), page.click('[data-action="download"]')]);
  await d.saveAs(`${outDir}/${name}.birebir.svg`);
  await page.click('#svg-mode [data-value="sadakat"]');
  console.log(`${name}: PNG + SVG indirildi (${Math.round((Date.now() - t1) / 1000)} s) | durum: ${await page.evaluate(() => document.querySelector('#status')?.textContent.trim().slice(0, 70))}`);
  // Sıradaki görsel için temizle
  await page.click('#clear-all'); await page.waitForTimeout(500);
  page.once('dialog', (dl) => dl.accept());
}
await browser.close();
