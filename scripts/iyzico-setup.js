// iyzico'da Photoroot ürününü ve 4 ödeme planını oluşturur, .env için satırları yazdırır.
// Kullanım: IYZICO_API_KEY=... IYZICO_SECRET_KEY=... node scripts/iyzico-setup.js
// (Varsayılan sandbox'tır; canlı için IYZICO_BASE_URL=https://api.iyzipay.com)
import { loadConfig } from '../server/config.js';
import { createIyzicoProvider } from '../server/payments/iyzico.js';
import { PLANS } from '../server/plans.js';

const config = loadConfig({ ...process.env, PAYMENT_PROVIDER: 'iyzico', NODE_ENV: 'development' });
const iyzico = createIyzicoProvider({ ...config.payments.iyzico, publicUrl: config.publicUrl });

function check(res, what) {
  if (res.status !== 'success') {
    console.error(`${what} başarısız: ${res.errorCode ?? ''} ${res.errorMessage ?? JSON.stringify(res)}`);
    process.exit(1);
  }
  return res.data;
}

const product = check(await iyzico.createProduct('Photoroot', 'Ürün fotoğrafı arka plan silme aboneliği'), 'Ürün oluşturma');
console.log(`Ürün oluşturuldu: ${product.referenceCode}\n`);

const lines = [];
for (const plan of ['pro', 'business']) {
  for (const [period, interval] of [['monthly', 'MONTHLY'], ['yearly', 'YEARLY']]) {
    const name = `${PLANS[plan].name} ${period === 'monthly' ? 'Aylık' : 'Yıllık'}`;
    const created = check(await iyzico.createPricingPlan(product.referenceCode, { name, price: PLANS[plan].prices[period], interval }), name);
    lines.push(`IYZICO_PLAN_${plan.toUpperCase()}_${period.toUpperCase()}=${created.referenceCode}`);
  }
}
console.log('.env dosyana ekle:\n' + lines.join('\n'));
