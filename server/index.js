import http from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { cleanup, openDb } from './db.js';
import { createPaymentProvider } from './payments/index.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const payments = createPaymentProvider(config);
const server = http.createServer(createApp({ db, config, payments }));

cleanup(db);
setInterval(() => cleanup(db), 6 * 3600_000).unref();

server.listen(config.port, () => {
  console.log(`Photoroot çalışıyor: ${config.publicUrl} (ödeme: ${payments.name})`);
});

// Son savunma hattı: beklenmeyen bir hata tüm sunucuyu düşürmesin.
process.on('unhandledRejection', (err) => console.error('Yakalanmamış hata:', err));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
}
