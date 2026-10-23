import http from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createPaymentProvider } from './payments/index.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const payments = createPaymentProvider(config);
const server = http.createServer(createApp({ db, config, payments }));

server.listen(config.port, () => {
  console.log(`Photoroot çalışıyor: ${config.publicUrl} (ödeme: ${payments.name})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
}
