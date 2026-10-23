import { createMockProvider } from './mock.js';
import { createIyzicoProvider } from './iyzico.js';

export function createPaymentProvider(config) {
  const { provider } = config.payments;
  if (provider === 'mock') return createMockProvider({ publicUrl: config.publicUrl });
  if (provider === 'iyzico') return createIyzicoProvider({ ...config.payments.iyzico, publicUrl: config.publicUrl });
  throw new Error(`Bilinmeyen ödeme sağlayıcısı: ${provider}`);
}
