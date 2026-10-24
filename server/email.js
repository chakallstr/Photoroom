import fs from 'node:fs';
import path from 'node:path';

// E-posta gönderimi. Geliştirmede 'log' sağlayıcısı e-postaları konsola yazar ve
// testler için bellekte tutar; canlıda Resend HTTP API'si kullanılır (ek paket gerekmez).
export function createMailer(config, { fetch: fetchFn = fetch, log = console.log } = {}) {
  const { provider, from, resendApiKey } = config.email;
  const outbox = [];

  if (provider === 'resend') {
    if (!resendApiKey || !from) throw new Error('RESEND_API_KEY ve EMAIL_FROM ayarlanmalı.');
    return {
      name: 'resend',
      outbox,
      async send(message) {
        const res = await fetchFn('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      },
    };
  }

  if (provider === 'log') {
    return {
      name: 'log',
      outbox,
      async send(message) {
        outbox.push(message);
        if (outbox.length > 100) outbox.shift();
        log(`\n--- E-posta (gönderilmedi, geliştirme modu) ---\nKime: ${message.to}\nKonu: ${message.subject}\n\n${message.text}\n---\n`);
      },
    };
  }

  throw new Error(`Bilinmeyen e-posta sağlayıcısı: ${provider}`);
}

// Yasal sayfanın metnini e-postaya koymak için HTML'den düz metne çevirir.
export function legalPageText(publicDir, slug) {
  const html = fs.readFileSync(path.join(publicDir, 'yasal', slug), 'utf8');
  const article = html.match(/<article>([\s\S]*?)<\/article>/)?.[1] ?? '';
  return article
    .replace(/<(h1|h2)>/g, '\n\n')
    .replace(/<\/(h1|h2)>/g, '\n')
    .replace(/<tr>/g, '\n')
    .replace(/<\/t[hd]>/g, '  ')
    .replace(/<li>/g, '\n• ')
    .replace(/<\/p>/g, '\n')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n /g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
