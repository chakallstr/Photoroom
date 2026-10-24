import { PLANS } from './plans.js';
import { legalPageText } from './email.js';

// Kullanıcıya giden e-postaların metinleri. Hepsi düz metin; her e-posta istemcisinde okunur.
const fmtDate = (ms) => new Date(ms).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Istanbul' });
const fmtPrice = (n) => `${n.toLocaleString('tr-TR')} ₺`;
const periodName = (p) => (p === 'yearly' ? 'Yıllık' : 'Aylık');
const footer = (url) => `\n\n—\nPhotoroot · ${url}\nBu e-postayı Photoroot hesabınla ilgili bir işlem yapıldığı için aldın.`;

export function passwordResetEmail({ to, link, publicUrl }) {
  return {
    to,
    subject: 'Photoroot şifre sıfırlama',
    text: `Merhaba,

Photoroot hesabın için şifre sıfırlama isteği aldık. Yeni şifre belirlemek için bu bağlantıyı aç:

${link}

Bağlantı 1 saat geçerlidir ve yalnızca bir kez kullanılabilir.
Bu isteği sen yapmadıysan bu e-postayı yok sayabilirsin; şifren değişmez.${footer(publicUrl)}`,
  };
}

export function subscriptionStartedEmail({ to, plan, period, startedAt, periodEnd, publicUrl, publicDir }) {
  const price = PLANS[plan].prices[period];
  let contract = '';
  try {
    contract = legalPageText(publicDir, 'mesafeli-satis.html');
  } catch {
    contract = `${publicUrl}/yasal/mesafeli-satis.html`;
  }
  return {
    to,
    subject: `Photoroot ${PLANS[plan].name} aboneliğin başladı`,
    text: `Merhaba,

Ödemen alındı ve ${PLANS[plan].name} paketin hesabında açıldı. Teşekkür ederiz!

Sipariş özeti
  Paket: ${PLANS[plan].name} (${periodName(period)})
  Tutar: ${fmtPrice(price)} (KDV dahil)
  Başlangıç: ${fmtDate(startedAt)}
  Sonraki yenileme: ${fmtDate(periodEnd)}

Aboneliğin her dönem sonunda otomatik yenilenir. Dilediğin zaman editörde Hesabım → Aboneliği iptal et
adımıyla iptal edebilirsin; ödediğin dönemin sonuna kadar kullanmaya devam edersin.

Satın alma sırasında onayladığın Mesafeli Satış Sözleşmesi aşağıdadır.

==============================
${contract}
==============================${footer(publicUrl)}`,
  };
}

export function subscriptionCanceledEmail({ to, plan, periodEnd, publicUrl }) {
  return {
    to,
    subject: 'Photoroot aboneliğin iptal edildi',
    text: `Merhaba,

${PLANS[plan].name} aboneliğin iptal edildi. Kartından bir daha ücret alınmayacak.

Paketinin tüm özelliklerini ${fmtDate(periodEnd)} tarihine kadar kullanmaya devam edebilirsin.
Sonrasında hesabın ücretsiz pakete geçer; hesabın ve ayarların silinmez.

Fikrini değiştirirsen istediğin zaman tekrar abone olabilirsin.${footer(publicUrl)}`,
  };
}

export function paymentFailedEmail({ to, plan, graceEnd, publicUrl }) {
  return {
    to,
    subject: 'Photoroot ödemen alınamadı',
    text: `Merhaba,

${PLANS[plan].name} aboneliğinin yenileme ödemesi kartından alınamadı. Ödeme sağlayıcımız birkaç kez daha deneyecek.

Kartında yeterli bakiye ya da limit olduğundan emin ol. ${fmtDate(graceEnd)} tarihine kadar ödeme alınamazsa
hesabın ücretsiz pakete geçer.${footer(publicUrl)}`,
  };
}

export function accountDeletedEmail({ to, publicUrl }) {
  return {
    to,
    subject: 'Photoroot hesabın silindi',
    text: `Merhaba,

İsteğin üzerine Photoroot hesabın ve kişisel verilerin silindi. Aktif bir aboneliğin varsa iptal edildi.

Bu işlemi sen yapmadıysan hemen bize yaz.${footer(publicUrl)}`,
  };
}
