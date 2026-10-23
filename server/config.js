import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const config = {
    production,
    port: int(env.PORT, 8000),
    // Ödeme dönüşlerinde kullanılan, dışarıdan erişilen adres (ör. https://photoroot.app)
    publicUrl: (env.PUBLIC_URL || `http://localhost:${int(env.PORT, 8000)}`).replace(/\/$/, ''),
    dbPath: env.DATABASE_PATH || path.join(root, 'data', 'photoroot.db'),
    publicDir: path.join(root, 'public'),
    timeZone: env.TIME_ZONE || 'Europe/Istanbul',
    // Test ve deneme için ücretsiz paketin günlük limitini değiştirmeye izin verir.
    freeDailyLimit: env.FREE_DAILY_LIMIT != null ? int(env.FREE_DAILY_LIMIT, 10) : null,
    // IP adreslerini saklamadan saymak için kullanılan gizli değer.
    ipSalt: env.IP_SALT || 'dev-ip-salt',
    trustProxy: env.TRUST_PROXY === '1',
    payments: {
      provider: env.PAYMENT_PROVIDER || (production ? 'iyzico' : 'mock'),
      iyzico: {
        apiKey: env.IYZICO_API_KEY || '',
        secretKey: env.IYZICO_SECRET_KEY || '',
        merchantId: env.IYZICO_MERCHANT_ID || '',
        baseUrl: env.IYZICO_BASE_URL || 'https://sandbox-api.iyzipay.com',
        // iyzico panelinde oluşturulan ödeme planlarının referans kodları
        plans: {
          'pro:monthly': env.IYZICO_PLAN_PRO_MONTHLY || '',
          'pro:yearly': env.IYZICO_PLAN_PRO_YEARLY || '',
          'business:monthly': env.IYZICO_PLAN_BUSINESS_MONTHLY || '',
          'business:yearly': env.IYZICO_PLAN_BUSINESS_YEARLY || '',
        },
      },
    },
  };

  if (production) {
    if (config.payments.provider === 'mock') {
      throw new Error('Üretim ortamında sahte ödeme sağlayıcısı kullanılamaz (PAYMENT_PROVIDER=mock).');
    }
    if (config.ipSalt === 'dev-ip-salt') {
      throw new Error('Üretim ortamında IP_SALT ayarlanmalı.');
    }
  }
  return config;
}
