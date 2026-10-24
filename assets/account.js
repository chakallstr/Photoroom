// Hesap, günlük hak ve ödeme işlemleri. Sunucu yoksa (yalnızca statik barındırma)
// editör limitsiz "çevrimdışı" modda çalışmaya devam eder.
const $ = (sel) => document.querySelector(sel);

const PRICES = { pro: { monthly: 99, yearly: 990 }, business: { monthly: 249, yearly: 2490 } };
const PLAN_NAMES = { free: 'Ücretsiz', pro: 'Pro', business: 'İşletme' };

const state = { online: false, me: null };
const listeners = new Set();

export const onChange = (fn) => listeners.add(fn);
export const limits = () => state.me?.limits ?? null;
export const isOnline = () => state.online;
export const usage = () => state.me?.usage ?? null;

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function update(me) {
  state.me = me;
  render();
  listeners.forEach((fn) => fn(state));
}

export async function refresh() {
  try {
    const r = await api('GET', '/api/me');
    if (r.status !== 200 || !r.data?.limits) throw new Error();
    state.online = true;
    update(r.data);
  } catch {
    state.online = false;
    update(null);
  }
}

// Bir görsel işlenmeden önce günlük haktan düşer.
export async function consume(count = 1) {
  if (!state.online) return { ok: true };
  try {
    const r = await api('POST', '/api/usage', { count });
    if (state.me) {
      state.me.usage = r.data.usage ?? state.me.usage;
      update(state.me);
    }
    if (r.status === 200) return { ok: true };
    if (r.status === 429 && r.data.error === 'daily_limit') return { ok: false, limit: true, message: r.data.message };
    return { ok: false, message: r.data.message || 'Bir hata oluştu.' };
  } catch {
    return { ok: false, message: 'Sunucuya ulaşılamadı.' };
  }
}

// ---------- Üst bar ----------

function render() {
  const el = $('#account');
  if (!el) return;
  el.replaceChildren();
  if (!state.online) return;
  const { user, plan } = state.me;
  if (!user) {
    const btn = Object.assign(document.createElement('button'), { className: 'btn btn-sm', textContent: 'Giriş yap', type: 'button' });
    btn.onclick = () => openAuth('login');
    el.append(btn);
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'account-menu';
  const badge = Object.assign(document.createElement('span'), { className: 'plan-badge' + (plan !== 'free' ? ' paid' : ''), textContent: PLAN_NAMES[plan] });
  const email = Object.assign(document.createElement('span'), { className: 'account-email', textContent: user.email });
  const toggle = Object.assign(document.createElement('button'), { className: 'btn btn-sm', type: 'button', textContent: 'Hesabım' });
  toggle.setAttribute('aria-expanded', 'false');
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.hidden = true;
  const sub = state.me.subscription;
  const info = document.createElement('p');
  if (sub?.effective && sub.status === 'canceled') info.textContent = `${PLAN_NAMES[sub.plan]} ${formatDate(sub.currentPeriodEnd)} tarihine kadar geçerli (iptal edildi).`;
  else if (sub?.effective) info.textContent = `${PLAN_NAMES[sub.plan]} · ${sub.period === 'yearly' ? 'yıllık' : 'aylık'} · yenileme ${formatDate(sub.currentPeriodEnd)}`;
  else info.textContent = 'Ücretsiz paket';
  menu.append(info);
  const item = (text, fn) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: text });
    b.onclick = () => { menu.hidden = true; fn(); };
    menu.append(b);
  };
  if (plan === 'free') item("Pro'ya geç", () => openUpgrade());
  if (sub && (sub.status === 'active' || sub.status === 'unpaid')) item('Aboneliği iptal et', cancelSubscription);
  item('Hesap ayarları', openSettings);
  item('Çıkış yap', logout);
  toggle.onclick = (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    toggle.setAttribute('aria-expanded', String(!menu.hidden));
  };
  wrap.append(toggle, menu);
  el.append(badge, email, wrap);
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function toast(text, ms = 4000) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

async function logout() {
  await api('POST', '/api/auth/logout', {});
  await refresh();
  toast('Çıkış yaptın.');
}

async function cancelSubscription() {
  if (!confirm('Aboneliğin iptal edilsin mi? Dönem sonuna kadar kullanmaya devam edersin.')) return;
  const r = await api('POST', '/api/billing/cancel', {});
  if (r.status === 200) {
    update(r.data);
    toast('Abonelik iptal edildi. Dönem sonuna kadar Pro özellikleri açık.');
  } else {
    toast(r.data.message || 'İptal edilemedi.');
  }
}

// ---------- Giriş / kayıt ----------

let authMode = 'login';
let authResolve = null;
let resetToken = null;

const AUTH_MODES = {
  login: { submit: 'Giriş yap', lead: 'Hesabına giriş yap.', email: true, password: 'Şifre', autocomplete: 'current-password' },
  register: { submit: 'Hesap oluştur', lead: 'Ücretsiz hesap oluştur.', email: true, password: 'Şifre', autocomplete: 'new-password' },
  forgot: { submit: 'Sıfırlama bağlantısı gönder', lead: 'E-posta adresini yaz; şifreni sıfırlaman için bir bağlantı gönderelim.', email: true, password: null },
  reset: { submit: 'Yeni şifreyi kaydet', lead: 'Hesabın için yeni bir şifre belirle.', email: false, password: 'Yeni şifre', autocomplete: 'new-password' },
};

function setAuthMode(mode) {
  authMode = mode;
  const m = AUTH_MODES[mode];
  const form = $('#auth-form');
  document.querySelectorAll('[data-auth-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.authMode === mode)));
  form.querySelector('.billing-toggle').hidden = mode === 'forgot' || mode === 'reset';
  $('#auth-email').hidden = !m.email;
  form.email.required = m.email;
  $('#auth-password').hidden = !m.password;
  form.password.required = Boolean(m.password);
  if (m.password) {
    $('#auth-password-label').textContent = m.password;
    form.password.autocomplete = m.autocomplete;
  }
  $('#auth-submit').textContent = m.submit;
  $('#forgot-link').hidden = mode !== 'login';
  if (!$('#auth-lead').dataset.reason || mode === 'forgot' || mode === 'reset') $('#auth-lead').textContent = m.lead;
  $('#auth-lead').className = 'modal-lead';
  $('#auth-error').hidden = true;
}

// Giriş başarılı olursa true, pencere kapatılırsa false döner.
export function openAuth(mode = 'login', reason = '') {
  const lead = $('#auth-lead');
  lead.dataset.reason = reason;
  lead.textContent = reason;
  setAuthMode(mode);
  authResolve?.(false); // önceki bekleyen çağrıyı kapat
  const dialog = $('#auth-dialog');
  dialog.returnValue = ''; // Esc ile kapatılınca önceki girişin 'ok' değeri kalmasın
  if (!dialog.open) dialog.showModal();
  return new Promise((resolve) => { authResolve = resolve; });
}

function initAuth() {
  document.querySelectorAll('[data-auth-mode]').forEach((b) => { b.onclick = () => setAuthMode(b.dataset.authMode); });
  $('#forgot-link').onclick = () => setAuthMode('forgot');
  const form = $('#auth-form');
  form.addEventListener('submit', async (e) => {
    if (e.submitter?.value === 'cancel') return;
    e.preventDefault();
    const btn = $('#auth-submit');
    btn.disabled = true;
    const requests = {
      login: ['/api/auth/login', { email: form.email.value, password: form.password.value }],
      register: ['/api/auth/register', { email: form.email.value, password: form.password.value }],
      forgot: ['/api/auth/forgot', { email: form.email.value }],
      reset: ['/api/auth/reset', { token: resetToken, password: form.password.value }],
    };
    const r = await api('POST', ...requests[authMode]).catch(() => ({ status: 0, data: {} }));
    btn.disabled = false;
    if (r.status === 200 && authMode === 'forgot') {
      const lead = $('#auth-lead');
      lead.textContent = r.data.message;
      lead.className = 'form-ok';
      return;
    }
    if (r.status === 200 || r.status === 201) {
      const messages = { login: 'Hoş geldin!', register: 'Hesabın oluşturuldu.', reset: 'Yeni şifren kaydedildi, giriş yaptın.' };
      toast(messages[authMode]);
      form.reset();
      resetToken = null;
      $('#auth-dialog').close('ok');
      update(r.data);
    } else {
      $('#auth-error').textContent = r.data.message || 'Bir hata oluştu.';
      $('#auth-error').hidden = false;
    }
  });
  $('#auth-dialog').addEventListener('close', () => {
    authResolve?.($('#auth-dialog').returnValue === 'ok');
    authResolve = null;
  });
}

// ---------- Paket yükseltme ----------

const upgrade = { plan: 'pro', period: 'monthly' };

function renderUpgrade() {
  for (const [id, key] of [['#upgrade-plan', 'plan'], ['#upgrade-period', 'period']]) {
    document.querySelectorAll(`${id} button`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === upgrade[key])));
  }
  const price = PRICES[upgrade.plan][upgrade.period];
  $('#upgrade-price').innerHTML = upgrade.period === 'monthly'
    ? `<strong>${price} ₺</strong> / ay`
    : `<strong>${price.toLocaleString('tr-TR')} ₺</strong> / yıl <span class="hint">(aylık ${Math.floor(price / 12)} ₺)</span>`;
  $('#upgrade-dialog h2').textContent = `${PLAN_NAMES[upgrade.plan]} paketine geç`;
}

export async function openUpgrade(reason = '', preset = {}) {
  if (!state.online) {
    toast('Ödeme için sunucu bağlantısı gerekli.');
    return;
  }
  if (!state.me.user) {
    const ok = await openAuth('register', 'Pro\'ya geçmek için önce ücretsiz bir hesap oluştur.');
    if (!ok) return;
  }
  if (state.me.plan !== 'free') {
    toast(`Zaten ${PLAN_NAMES[state.me.plan]} paketindesin.`);
    return;
  }
  if (PRICES[preset.plan]) upgrade.plan = preset.plan;
  if (preset.period === 'monthly' || preset.period === 'yearly') upgrade.period = preset.period;
  $('#upgrade-reason').textContent = reason || 'Sınırsız görsel, tam çözünürlük ve toplu indirme.';
  $('#customer-fields').hidden = !state.me.billing?.needsCustomer;
  $('#upgrade-error').hidden = true;
  renderUpgrade();
  $('#upgrade-dialog').showModal();
}

function initUpgrade() {
  for (const [id, key] of [['#upgrade-plan', 'plan'], ['#upgrade-period', 'period']]) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-value]');
      if (!b) return;
      upgrade[key] = b.dataset.value;
      renderUpgrade();
    });
  }
  const form = $('#upgrade-form');
  form.addEventListener('submit', async (e) => {
    if (e.submitter?.value === 'cancel') return;
    e.preventDefault();
    const btn = $('#upgrade-submit');
    btn.disabled = true;
    btn.textContent = 'Yönlendiriliyor…';
    const body = { ...upgrade, acceptTerms: form.acceptTerms.checked };
    if (state.me.billing?.needsCustomer) {
      body.customer = Object.fromEntries(['name', 'surname', 'gsmNumber', 'identityNumber', 'city', 'address'].map((k) => [k, form[k].value]));
    }
    const r = await api('POST', '/api/billing/checkout', body).catch(() => ({ status: 0, data: {} }));
    if (r.status === 200 && r.data.url) {
      location.href = r.data.url;
      return;
    }
    btn.disabled = false;
    btn.textContent = 'Ödemeye geç';
    $('#upgrade-error').textContent = r.data.message || 'Ödeme başlatılamadı.';
    $('#upgrade-error').hidden = false;
  });
  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-upgrade]');
    if (!link) return;
    e.preventDefault();
    openUpgrade(link.dataset.upgrade === 'resolution' ? 'Tam çözünürlükte indirmek için Pro\'ya geç.' : '');
  });
}

// ---------- Hesap ayarları ----------

function openSettings() {
  for (const f of document.querySelectorAll('#settings-dialog form[id]')) {
    f.reset();
    f.querySelector('.form-error').hidden = true;
  }
  $('#settings-dialog').showModal();
}

function initSettings() {
  const bind = (id, path, fields, onOk, confirmText) => {
    const form = $(id);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (confirmText && !confirm(confirmText)) return;
      const btn = form.querySelector('button[type=submit]');
      const err = form.querySelector('.form-error');
      btn.disabled = true;
      const body = Object.fromEntries(fields.map((k) => [k, form[k].value]));
      const r = await api('POST', path, body).catch(() => ({ status: 0, data: {} }));
      btn.disabled = false;
      if (r.status === 200) return onOk(form);
      err.textContent = r.data.message || 'Bir hata oluştu.';
      err.hidden = false;
    });
  };
  bind('#password-form', '/api/account/password', ['currentPassword', 'newPassword'], (form) => {
    form.reset();
    $('#settings-dialog').close();
    toast('Şifren değiştirildi. Diğer cihazlardaki oturumlar kapatıldı.');
  });
  bind('#delete-form', '/api/account/delete', ['password'], async () => {
    $('#settings-dialog').close();
    await refresh();
    toast('Hesabın ve verilerin silindi.', 6000);
  }, 'Hesabın kalıcı olarak silinecek. Emin misin?');
}

// E-postadaki bağlantı: #sifre-sifirla=<token>. Token adres çubuğundan hemen silinir.
function handleResetLink() {
  const match = location.hash.match(/^#sifre-sifirla=([A-Za-z0-9_-]+)$/);
  if (!match) return;
  resetToken = match[1];
  history.replaceState(null, '', location.pathname + location.search);
  openAuth('reset');
}

// ---------- Başlangıç ----------

export async function init() {
  initAuth();
  initUpgrade();
  initSettings();
  document.addEventListener('click', (e) => {
    const menu = document.querySelector('.account-menu .menu');
    if (menu && !e.target.closest('.account-menu')) menu.hidden = true;
  });
  await refresh();

  // E-postadaki şifre sıfırlama bağlantısı. Sayfa zaten açıkken tıklanırsa yalnızca # değişir.
  handleResetLink();
  window.addEventListener('hashchange', handleResetLink);

  // Ödeme dönüşü ve fiyat sayfasından gelen bağlantılar
  const params = new URLSearchParams(location.search);
  const result = params.get('odeme');
  if (result === 'basarili') toast(`Ödeme tamamlandı. ${PLAN_NAMES[state.me?.plan] ?? ''} paketine hoş geldin!`, 6000);
  else if (result === 'basarisiz') toast('Ödeme tamamlanamadı. Kart bilgilerini kontrol edip tekrar deneyebilirsin.', 6000);
  else if (result === 'gecersiz') toast('Ödeme oturumu geçersiz ya da süresi dolmuş.', 6000);
  const wanted = params.get('plan');
  if (result || wanted) history.replaceState(null, '', location.pathname);
  if (PRICES[wanted] && state.online && state.me?.plan === 'free') openUpgrade('', { plan: wanted, period: params.get('period') });
}
