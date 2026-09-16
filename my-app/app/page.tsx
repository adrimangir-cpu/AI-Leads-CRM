"use client";

/* ============================================================
   ADRIANA RETOUCH — один файл на два состояния:
   • не авторизован → публичное портфолио (обо мне, категории,
     каталоги съёмок, до/после, контакты, форма → Telegram)
   • авторизован    → закрытая CRM и панель управления сайтом

   Firestore:
     portfolio_shoots     { category, title, year, order, cover, photos:[{url,w,h,path}] }
     before_after         { title, note, beforeUrl, afterUrl, order }
     site_settings/public { tagline, aboutNote, about[], facts[], heroUrl, aboutUrl, contacts{} }
     leads_portfolio      { name, contact, task, message, photosCount, status, createdAt }

   Фото съёмок и до/после лежат в Firebase Storage, в Firestore — только ссылки.
   ============================================================ */

import { useState, useEffect, useMemo, useRef } from 'react';
import { collection, getDocs, getDoc, addDoc, updateDoc, deleteDoc, doc, setDoc, query, orderBy } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';

const TABS = [
  { id: 'base', num: '01', label: 'База клиентов' },
  { id: 'search', num: '02', label: 'Умный поиск' },
  { id: 'portfolio', num: '03', label: 'Сайт и портфолио' },
  { id: 'orders', num: '04', label: 'Учет заказов' },
  { id: 'mail', num: '05', label: 'Рассылка' },
];

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:5000';

const CATEGORIES = [
  { id: 'beauty', num: '01', label: 'Бьюти' },
  { id: 'lookbook', num: '02', label: 'Лук бук' },
  { id: 'fashion', num: '03', label: 'Фешн' },
  { id: 'art', num: '04', label: 'Творчество' },
  { id: 'still', num: '05', label: 'Предметка' },
];

/* контакты-заглушки: показываются, пока в дашборде не заполнены свои */
const FALLBACK_CONTACTS = {
  telegram: { handle: '@adriana_retouch', url: 'https://t.me/adriana_retouch', sub: 'отвечаю быстрее всего' },
  whatsapp: { handle: '+48 000 000 000', url: 'https://wa.me/48000000000', sub: 'звонки и сообщения' },
  instagram: { handle: '@adriana.retouch', url: 'https://instagram.com/adriana.retouch', sub: 'свежие работы' },
  email: { handle: 'hello@adriana.studio', url: 'mailto:hello@adriana.studio', sub: 'для брифов и договоров' },
};

/* Бегущая строка в самом верху публичного сайта */
const TICKER = [
  'Кожа остаётся кожей',
  'Первый кадр — бесплатно',
  'Beauty · Fashion · Still life',
  'Отвечаю в тот же день',
  'Photoshop · Capture One',
  'PSD со слоями по запросу',
  'Warsaw / Online',
];

/* ───────── умная раскладка: съёмка любого объёма → ряды по 1–3 кадра ───────── */
const ROW_MAP = { 1: [1], 2: [2], 3: [1, 2], 4: [2, 2], 5: [2, 3], 6: [3, 3], 7: [2, 2, 3], 8: [3, 2, 3], 9: [3, 3, 3] };
function rowsFor(n) {
  if (ROW_MAP[n]) return ROW_MAP[n];
  const r = []; let left = n;
  while (left > 0) {
    if (left === 4) { r.push(2, 2); left = 0; }
    else if (left === 1 && r.length) { r[r.length - 1] += 1; left = 0; }
    else { const t = Math.min(3, left); r.push(t); left -= t; }
  }
  return r;
}
const W = { 1: [1], 2: [[1.32, 1], [1, 1.32]], 3: [[1, 1.24, 1], [1.24, 1, 1.1]] };
const H = { 1: ['100%'], 2: [['100%', '87%'], ['88%', '100%']], 3: [['93%', '100%', '85%'], ['100%', '86%', '96%']] };
const ROWH = { 1: 'clamp(400px,46vw,600px)', 2: 'clamp(300px,32vw,500px)', 3: 'clamp(230px,23vw,370px)' };

function buildRows(photos) {
  if (!photos || photos.length === 0) return [];
  const sizes = rowsFor(photos.length);
  const out = []; let i = 0;
  sizes.forEach((size, ri) => {
    const items = photos.slice(i, i + size).map((p, k) => ({
      photo: p,
      idx: i + k,
      flex: size === 1 ? 1 : W[size][ri % 2][k],
      h: size === 1 ? '100%' : H[size][ri % 2][k],
    }));
    out.push({ size, h: ROWH[size], items, single: size === 1 });
    i += size;
  });
  return out;
}

const plural = (n) => (n === 1 ? 'кадр' : n > 1 && n < 5 ? 'кадра' : 'кадров');

/* Подготовка кадра перед загрузкой: уменьшаем и пересохраняем в JPEG.
   Порядок важен для iPhone: сначала createImageBitmap (умеет HEIC и EXIF-поворот),
   затем обычный <img> через blob-ссылку. Data-URL больше не используем — на iOS
   он падал на тяжёлых кадрах с «The string did not match the expected pattern». */
async function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (e1) {
      try { return await createImageBitmap(file); } catch (e2) { /* пробуем через <img> */ }
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new window.Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('браузер не смог открыть этот файл'));
      img.src = url;
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
}

/* Хранилище фотографий — Cloudinary.
   Загрузка идёт «неподписанным» способом (unsigned upload preset), поэтому
   в коде нет ни одного секрета: нужны только два публичных значения —
   имя облака и имя preset. Они лежат в site_settings/public и задаются
   в дашборде, в блоке «Хранилище фотографий». XMLHttpRequest выбран
   вместо fetch ради честного процента загрузки. */
function storageConfig(settings) {
  return {
    cloud: (settings && settings.cloudName) || process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD || '',
    preset: (settings && settings.uploadPreset) || process.env.NEXT_PUBLIC_CLOUDINARY_PRESET || '',
  };
}

function uploadImage(blob, folder, cfg, onProgress) {
  return new Promise((resolve, reject) => {
    if (!cfg || !cfg.cloud || !cfg.preset) {
      reject(new Error('не заданы имя облака и upload preset — впиши их в блоке «Хранилище фотографий» и сохрани'));
      return;
    }
    const form = new FormData();
    form.append('file', blob);
    form.append('upload_preset', cfg.preset);
    if (folder) form.append('folder', folder);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `https://api.cloudinary.com/v1_1/${cfg.cloud}/image/upload`);
    xhr.timeout = 180000;
    if (xhr.upload) {
      xhr.upload.onprogress = (e) => {
        if (onProgress && e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch (e) { /* пустой ответ */ }
      if (xhr.status >= 200 && xhr.status < 300 && data.secure_url) {
        if (onProgress) onProgress(100);
        resolve({ url: data.secure_url, w: data.width || 0, h: data.height || 0, path: data.public_id || '' });
        return;
      }
      const msg = (data.error && data.error.message) || ('код ' + xhr.status);
      if (/preset/i.test(msg)) reject(new Error('Cloudinary не принял preset («' + msg + '») — проверь имя и что режим стоит Unsigned'));
      else if (/unknown api key|invalid cloud/i.test(msg) || xhr.status === 404) reject(new Error('Cloudinary не узнал облако «' + cfg.cloud + '» — проверь Cloud name на главной странице аккаунта'));
      else reject(new Error('Cloudinary отклонил загрузку: ' + msg));
    };
    xhr.onerror = () => reject(new Error('запрос не дошёл до Cloudinary — проверь Cloud name и соединение'));
    xhr.ontimeout = () => reject(new Error('файл не загрузился за 3 минуты — попробуй ещё раз'));
    xhr.send(form);
  });
}

async function compressImage(file, maxSide = 1600, quality = 0.82) {
  if (!file) throw new Error('файл не выбран');
  const name = file.name || '';
  const isHeic = /heic|heif/i.test(file.type || '') || /\.(heic|heif)$/i.test(name);
  if (!/^image\//.test(file.type || '') && !/\.(jpe?g|png|webp|heic|heif|avif)$/i.test(name)) {
    throw new Error('это не изображение');
  }
  if (file.size > 60 * 1024 * 1024) throw new Error('файл тяжелее 60 МБ, уменьши его');

  let src;
  try {
    src = await loadBitmap(file);
  } catch (e) {
    throw new Error(isHeic
      ? 'кадр в формате HEIC не открылся. На iPhone: Настройки → Камера → Форматы → «Наиболее совместимый», либо пересохрани кадр в JPEG'
      : 'не удалось открыть изображение (' + (e.message || 'неизвестный формат') + ')');
  }

  const iw = src.width, ih = src.height;
  if (!iw || !ih) throw new Error('у файла нулевой размер');
  const scale = Math.min(1, maxSide / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('браузер не дал холст для сжатия');
  ctx.drawImage(src, 0, 0, w, h);
  if (typeof src.close === 'function') src.close();

  let blob = null;
  if (canvas.toBlob) {
    blob = await new Promise((resolve) => { try { canvas.toBlob(resolve, 'image/jpeg', quality); } catch (e) { resolve(null); } });
  }
  if (!blob) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const bin = atob((dataUrl.split(',')[1] || ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    blob = new Blob([bytes], { type: 'image/jpeg' });
  }
  if (!blob || !blob.size) throw new Error('не получилось пересохранить кадр в JPEG');
  return { blob, w, h };
}

const fileToDataUri = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = reject;
  reader.readAsDataURL(file);
});

/* ───────── ползунок до/после ───────── */
function BeforeAfter({ item }) {
  const stage = useRef(null);
  const [pos, setPos] = useState(50);
  const drag = useRef(false);

  const set = (clientX) => {
    if (!stage.current) return;
    const r = stage.current.getBoundingClientRect();
    setPos(Math.max(2, Math.min(98, ((clientX - r.left) / r.width) * 100)));
  };

  useEffect(() => {
    const up = () => { drag.current = false; };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, []);

  return (
    <div className="ba">
      <div
        className="ba-stage"
        ref={stage}
        onPointerDown={(e) => { drag.current = true; set(e.clientX); }}
        onPointerMove={(e) => { if (drag.current) set(e.clientX); }}
      >
        <img src={item.beforeUrl} alt="До обработки" draggable={false} />
        <img className="ba-after" src={item.afterUrl} alt="После обработки" draggable={false} style={{ clipPath: `inset(0 0 0 ${pos}%)` }} />
        <span className="ba-tag l">До</span>
        <span className="ba-tag r">После</span>
        <div className="ba-line" style={{ left: `${pos}%` }} />
        <div className="ba-knob" style={{ left: `${pos}%` }}>⇄</div>
      </div>
      <div className="ba-cap">
        <span className="label">{item.title}</span>
        <span className="label">{item.note}</span>
      </div>
    </div>
  );
}

/* ───────── лайтбокс ───────── */
function Lightbox({ list, idx, onClose, onMove }) {
  useEffect(() => {
    const k = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') onMove(-1);
      if (e.key === 'ArrowRight') onMove(1);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose, onMove]);

  if (idx === null || idx === undefined || !list[idx]) return null;
  return (
    <div className="lb on" onClick={(e) => { if (e.target.classList.contains('lb')) onClose(); }}>
      <button className="lb-x" onClick={onClose} aria-label="Закрыть">✕</button>
      <button className="lb-p" onClick={() => onMove(-1)} aria-label="Предыдущий кадр">‹</button>
      <img src={list[idx].url} alt={list[idx].cap} />
      <button className="lb-n" onClick={() => onMove(1)} aria-label="Следующий кадр">›</button>
      <div className="lb-cap">{list[idx].cap}</div>
    </div>
  );
}

/* ───────── форма: быстрое сообщение + фото → Telegram ───────── */
function LeadForm() {
  const [files, setFiles] = useState([]);
  const [hot, setHot] = useState(false);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(null);
  const [err, setErr] = useState('');

  const add = async (list) => {
    const imgs = [...list].filter((f) => f.type.startsWith('image/')).slice(0, 6);
    const next = await Promise.all(imgs.map(async (f) => ({ name: f.name, dataUrl: await fileToDataUri(f) })));
    setFiles((prev) => [...prev, ...next].slice(0, 6));
  };

  useEffect(() => {
    const onPaste = (e) => { if (e.clipboardData && e.clipboardData.files.length) add(e.clipboardData.files); };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const payload = {
      name: f.get('name'),
      contact: f.get('contact'),
      task: f.get('task'),
      message: f.get('message'),
      photos: files,
      source: 'Сайт-портфолио',
    };
    setSending(true); setErr('');
    try {
      const res = await fetch(`${API_BASE}/api/lead-photo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || `статус ${res.status}`);

      // дубль заявки в дашборд (без самих фото — они уже в Telegram)
      try {
        await addDoc(collection(db, 'leads_portfolio'), {
          name: payload.name, contact: payload.contact, task: payload.task, message: payload.message,
          photosCount: files.length, status: 'New', createdAt: new Date().toISOString(),
        });
      } catch (e2) { console.error('лог заявки не записался', e2); }

      setDone({ name: payload.name, contact: payload.contact, count: files.length });
    } catch (e3) {
      setErr('Не получилось отправить: ' + e3.message + '. Напиши мне напрямую в Telegram — так точно дойдёт.');
    } finally {
      setSending(false);
    }
  };

  if (done) {
    return (
      <div className="ok">
        <strong>Заявка отправлена.</strong>
        <br />
        {done.name}, я получила {done.count > 0 ? `${done.count} ${done.count === 1 ? 'фото' : 'фото'}` : 'твоё сообщение'} и отвечу на {done.contact} в течение дня.
        <br />
        <button type="button" className="btn ghost" style={{ marginTop: 18 }} onClick={() => { setDone(null); setFiles([]); }}>
          Отправить ещё
        </button>
      </div>
    );
  }

  return (
    <form className="form" onSubmit={submit}>
      <div className="form-row">
        <label className="field"><span>Имя</span><input name="name" required placeholder="Как к тебе обращаться" /></label>
        <label className="field"><span>Телефон или telegram</span><input name="contact" required placeholder="+48… или @username" /></label>
      </div>
      <label className="field">
        <span>Что нужно обработать</span>
        <select name="task" defaultValue="Бьюти — портрет / макро">
          <option>Бьюти — портрет / макро</option>
          <option>Лук бук</option>
          <option>Фешн-съёмка</option>
          <option>Творческий проект</option>
          <option>Предметка</option>
        </select>
      </label>
      <label className="field"><span>Сообщение</span><textarea name="message" placeholder="Пара слов о задаче и сроках" /></label>

      <div
        className={`drop ${hot ? 'hot' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setHot(true); }}
        onDragLeave={() => setHot(false)}
        onDrop={(e) => { e.preventDefault(); setHot(false); add(e.dataTransfer.files); }}
      >
        <span>Приложи фото на тест — перетащи сюда, вставь из буфера или</span>
        <label className="pick">
          Выбрать файлы
          <input type="file" accept="image/*" multiple hidden onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
        </label>
        {files.length > 0 && (
          <div className="thumbs">
            {files.map((f, i) => (
              <div className="thumb" key={i}>
                <img src={f.dataUrl} alt={`Вложение ${i + 1}`} />
                <button type="button" onClick={() => setFiles(files.filter((_, k) => k !== i))} aria-label="Убрать фото">✕</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <button type="submit" className="btn" style={{ width: 'fit-content' }} disabled={sending}>
        {sending ? 'Отправляю…' : 'Отправить'} <span>→</span>
      </button>
      {err && <p className="note" style={{ color: '#8A3B33' }}>{err}</p>}
      <p className="note">Заявка приходит мне в Telegram вместе с фото — обычно отвечаю в тот же день.</p>
    </form>
  );
}

/* ═════════════════ ПУБЛИЧНОЕ ПОРТФОЛИО ═════════════════ */
function PublicSite({ onAdminClick }) {
  const [shoots, setShoots] = useState([]);
  const [ba, setBa] = useState([]);
  const [settings, setSettings] = useState(null);
  const [cat, setCat] = useState(CATEGORIES[0].id);
  const [lb, setLb] = useState({ list: [], idx: null });
  const [loading, setLoading] = useState(true);
  const [scrolled, setScrolled] = useState(false); // ушли ниже первого экрана
  const [menu, setMenu] = useState(false);         // открыто боковое меню
  const [atForm, setAtForm] = useState(false);     // форма отправки на экране

  useEffect(() => {
    (async () => {
      try {
        const [sSnap, bSnap, cfg] = await Promise.all([
          getDocs(query(collection(db, 'portfolio_shoots'), orderBy('order', 'asc'))),
          getDocs(query(collection(db, 'before_after'), orderBy('order', 'asc'))),
          getDoc(doc(db, 'site_settings', 'public')),
        ]);
        setShoots(sSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((s) => (s.photos || []).length));
        setBa(bSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
        if (cfg.exists()) setSettings(cfg.data());
      } catch (e) {
        console.error('не загрузился контент сайта', e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  /* верхняя панель уезжает, вместо неё — кнопка бокового меню */
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 170);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  /* при открытом меню страница под ним не скроллится */
  useEffect(() => {
    document.body.style.overflow = menu ? 'hidden' : '';
    const onKey = (e) => { if (e.key === 'Escape') setMenu(false); };
    window.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = ''; window.removeEventListener('keydown', onKey); };
  }, [menu]);

  const counts = useMemo(() => {
    const m = {};
    CATEGORIES.forEach((c) => {
      m[c.id] = shoots.filter((s) => s.category === c.id).reduce((a, s) => a + (s.photos?.length || 0), 0);
    });
    return m;
  }, [shoots]);

  /* если в выбранной категории пусто — показываем первую непустую */
  useEffect(() => {
    if (!loading && !shoots.some((s) => s.category === cat)) {
      const first = CATEGORIES.find((c) => shoots.some((s) => s.category === c.id));
      if (first) setCat(first.id);
    }
  }, [loading, shoots]); // eslint-disable-line react-hooks/exhaustive-deps

  const withCoverFirst = (s) => {
    const ph = [...(s.photos || [])];
    const i = ph.findIndex((p) => p.url === s.cover);
    if (i > 0) ph.unshift(ph.splice(i, 1)[0]);
    return ph;
  };
  const visible = shoots.filter((s) => s.category === cat).map((s) => ({ ...s, photos: withCoverFirst(s) }));
  const contacts = { ...FALLBACK_CONTACTS, ...(settings?.contacts || {}) };
  const facts = settings?.facts || [
    { label: 'Опыт', value: '06', note: 'лет в постобработке' },
    { label: 'Съёмок', value: '240+', note: 'обработано с 2020' },
    { label: 'Тест-ретушь', value: 'Free', note: 'одно фото бесплатно' },
  ];
  const heroPhoto = settings?.heroUrl || '';
  const aboutPhoto = settings?.aboutUrl || '';
  const year = new Date().getFullYear();

  const nav = [
    ['#about', 'Обо мне'],
    ['#work', 'Портфолио'],
    ...(ba.length > 0 ? [['#ba', 'До / после']] : []),
    ['#contact', 'Контакты'],
    ['#form', 'Тест-ретушь'],
  ];

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const el = document.getElementById('form');
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setAtForm(e.isIntersecting), { threshold: 0.08 });
    io.observe(el);
    return () => io.disconnect();
  }, [loading]);

  const openLb = (shoot, idx) => setLb({
    list: shoot.photos.map((p, i) => ({ url: p.url, cap: `${shoot.title} — ${i + 1} / ${shoot.photos.length}` })),
    idx,
  });

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: SITE_CSS }} />

      {/* бегущая строка вместо статичной плашки */}
      <div className="ticker" aria-hidden="true">
        <div className="ticker-track">
          {[0, 1].map((k) => (
            <div className="ticker-row" key={k}>
              {TICKER.map((t, i) => (
                <span key={i}>{t}<i>/</i></span>
              ))}
            </div>
          ))}
        </div>
      </div>

      <nav className="topnav">
        <div className="brand">
          <svg width="24" height="24" viewBox="0 0 26 26" fill="none" aria-label="Adriana Retouch">
            <rect x=".5" y=".5" width="25" height="25" stroke="currentColor" />
            <path d="M6 20 13 6l7 14" stroke="currentColor" strokeWidth="1.4" />
            <path d="M9 15h8" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          <div><span className="brand-word">Adriana</span> <span className="brand-sub">Retouch</span></div>
        </div>
        <div className="navlinks">
          {nav.map(([href, label]) => <a key={href} href={href}>{label}</a>)}
          <button className="admin" onClick={onAdminClick}>Admin</button>
        </div>
        <button className="nav-burger" onClick={() => setMenu(true)} aria-label="Открыть меню">
          <span /><span /><span />
        </button>
      </nav>

      {/* кнопка меню появляется, когда верхняя панель уехала вверх */}
      <button
        className={`menu-btn ${scrolled && !menu ? 'on' : ''}`}
        onClick={() => setMenu(true)}
        aria-label="Открыть меню"
      >
        <span /><span /><span />
      </button>

      <div className={`drawer-bg ${menu ? 'on' : ''}`} onClick={() => setMenu(false)} />
      <aside className={`drawer ${menu ? 'on' : ''}`} aria-hidden={!menu}>
        <div className="drawer-top">
          <span className="label">Меню</span>
          <button className="drawer-x" onClick={() => setMenu(false)} aria-label="Закрыть меню">✕</button>
        </div>
        <nav className="drawer-nav">
          {nav.map(([href, label], i) => (
            <a key={href} href={href} onClick={() => setMenu(false)}>
              <span className="d-num">{String(i + 1).padStart(2, '0')}</span>{label}
            </a>
          ))}
        </nav>
        <div className="drawer-foot">
          <a href="#form" className="btn" onClick={() => setMenu(false)}>Фото на тест <span>→</span></a>
          <button className="drawer-admin" onClick={() => { setMenu(false); onAdminClick(); }}>Вход для владельца</button>
        </div>
      </aside>

      <section className="hero">
        <div className="hero-l">
          <div className="hero-over">post-production</div>
          <h1 className="display hero-main">adriana</h1>
          <div className="hero-meta">
            <span className="label">Ретушь для beauty, fashion и предметной съёмки</span>
            <p>{settings?.tagline || 'Сохраняю текстуру кожи и характер кадра. Работаю с фотографами, брендами и журналами — от одного портрета до полной обработки съёмки.'}</p>
          </div>
          <div className="hero-cta">
            <a href="#form" className="btn">Отправить фото на тест <span>→</span></a>
            <a href="#work" className="btn ghost">Смотреть работы</a>
          </div>
        </div>
        <figure className="hero-img">
          {heroPhoto
            ? <img src={heroPhoto} alt="Бьюти-портрет после ретуши" />
            : <div className="hero-empty"><span className="label">Титульное фото задаётся в дашборде · Портфолио · Настройки сайта</span></div>}
          <figcaption><span className="label">Beauty · {year}</span><span className="label">— 001</span></figcaption>
        </figure>
      </section>

      {/* ── 01 обо мне: тёплый серый фон ── */}
      <section className="sec tone" id="about">
        <div className="sec-head">
          <div>
            <div className="sec-num">01 — about</div>
            <h2 className="display sec-title">обо мне</h2>
          </div>
          {settings?.aboutNote ? <p className="sec-note">{settings.aboutNote}</p> : null}
        </div>
        <div className="about">
          {aboutPhoto ? <img src={aboutPhoto} alt="Адриана, ретушёр" /> : <div className="about-empty" />}
          <div className="about-body">
            {(settings?.about?.length ? settings.about : [
              'Привет. Меня зовут Адриана, я ретушёр. Начинала с бьюти-макро, сейчас закрываю полный цикл постобработки: отбор, цвет, чистка, dodge & burn, финальная подготовка под печать и веб.',
              'Главный принцип — кожа должна остаться кожей. Никакого пластика и «замыленных» лиц: я убираю лишнее, но оставляю поры, родинки и характер.',
              'Работаю в Photoshop и Capture One, отдаю PSD со слоями по запросу. Средний срок — 1–2 дня на портрет, 5–7 дней на съёмку.',
            ]).map((p, i) => <p key={i}>{p}</p>)}
          </div>
        </div>
        {/* цифры на чёрном — визуальная пауза между блоками текста */}
        <div className="factband">
          {facts.map((f, i) => (
            <div className="fact" key={i}>
              <div className="label">{f.label}</div>
              <div className="fact-v">{f.value}</div>
              <div className="fact-d">{f.note}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── 02 портфолио ── */}
      <section className="sec" id="work">
        <div className="sec-head">
          <div>
            <div className="sec-num">02 — portfolio</div>
            <h2 className="display sec-title">портфолио</h2>
          </div>
        </div>

        <div className="cats" role="tablist">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              className="cat"
              role="tab"
              aria-selected={c.id === cat}
              onClick={(e) => { setCat(c.id); e.currentTarget.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }); }}
            >
              <span className="c-num">{c.num}</span>{c.label}<span className="c-count">{counts[c.id] || 0}</span>
            </button>
          ))}
        </div>

        {loading && <p className="note" style={{ padding: '40px 0' }}>Загружаю съёмки…</p>}
        {!loading && visible.length === 0 && <p className="note" style={{ padding: '40px 0' }}>В этой категории пока нет съёмок.</p>}

        {visible.map((s) => (
          <article className="shoot" key={s.id}>
            <header className="shoot-head">
              <div className="shoot-t">
                <h3 className="shoot-name">{s.title}</h3>
                {s.team ? <div className="shoot-team">{s.team}</div> : null}
              </div>
              <div className="shoot-meta">
                <span className="label">{s.photos.length} {plural(s.photos.length)}</span>
                {s.year && <span className="label">{s.year}</span>}
              </div>
            </header>
            <div className="mosaic">
              {buildRows(s.photos).map((row, ri) => (
                <div className={`mrow ${row.single ? 'single' : ''}`} style={{ height: row.h }} key={ri}>
                  {row.items.map((it) => (
                    <figure
                      key={it.idx}
                      className="cell"
                      data-n={String(it.idx + 1).padStart(2, '0')}
                      style={{
                        flex: `${it.flex} 1 0`,
                        height: it.h,
                        ...(row.single ? { maxWidth: '66%', marginLeft: 'auto', marginRight: 'auto' } : {}),
                      }}
                      onClick={() => openLb(s, it.idx)}
                    >
                      <img src={it.photo.url} alt={`${s.title} — кадр ${it.idx + 1}`} loading="lazy" />
                    </figure>
                  ))}
                </div>
              ))}
            </div>
          </article>
        ))}
      </section>

      {/* ── 03 до / после: на чёрном фото читаются лучше всего ── */}
      {ba.length > 0 && (
        <section className="sec inv" id="ba">
          <div className="sec-head">
            <div>
              <div className="sec-num">03 — before / after</div>
              <h2 className="display sec-title">до / после</h2>
            </div>
          </div>
          <div className="ba-grid">
            {ba.map((item) => <BeforeAfter key={item.id} item={item} />)}
          </div>
        </section>
      )}

      {/* ── 04 контакты: карточки мессенджеров ── */}
      <section className="sec tone" id="contact">
        <div className="sec-head">
          <div>
            <div className="sec-num">04 — contact</div>
            <h2 className="display sec-title">связаться</h2>
          </div>
        </div>
        <div className="chgrid">
          {[
            ['Telegram', contacts.telegram],
            ['WhatsApp', contacts.whatsapp],
            ['Instagram', contacts.instagram],
            ['Почта', contacts.email],
          ].filter(([, v]) => v && v.url).map(([name, v]) => (
            <a key={name} href={v.url} target={v.url.startsWith('mailto') ? undefined : '_blank'} rel="noopener noreferrer">
              <span className="ch-name">{name}</span>
              <span className="ch-sub">{v.handle}{v.sub ? ` · ${v.sub}` : ''}</span>
              <span className="ch-arrow">↗</span>
            </a>
          ))}
        </div>
      </section>

      {/* ── 05 тест-ретушь: главный блок, на чёрном ── */}
      <section className="sec inv" id="form">
        <div className="sec-head">
          <div>
            <div className="sec-num">05 — test</div>
            <h2 className="display sec-title">фото на тест</h2>
          </div>
        </div>
        <div className="testgrid">
          <div className="steps">
            {[
              ['01', 'Приложи кадр', 'JPEG или PNG прямо с телефона — можно несколько.'],
              ['02', 'Опиши задачу', 'Что важно сохранить, для чего съёмка и к какому сроку.'],
              ['03', 'Получи результат', 'Отвечаю в указанный контакт, обычно в тот же день.'],
            ].map(([n, t, d]) => (
              <div className="step" key={n}>
                <span className="label">{n}</span>
                <div>
                  <div className="step-t">{t}</div>
                  <div className="step-d">{d}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="testform"><LeadForm /></div>
        </div>
      </section>

      <footer className="site-footer inv">
        <span className="label">© {year} Adriana Retouch</span>
        <span className="label">Beauty · Fashion · Still life</span>
      </footer>

      {/* мобильная кнопка внизу: тест-ретушь всегда в одном касании */}
      <a href="#form" className={`mob-cta ${scrolled && !atForm && !menu ? 'on' : ''}`}>Фото на тест — бесплатно <span>→</span></a>

      <Lightbox
        list={lb.list}
        idx={lb.idx}
        onClose={() => setLb({ list: [], idx: null })}
        onMove={(d) => setLb((p) => ({ ...p, idx: (p.idx + d + p.list.length) % p.list.length }))}
      />
    </>
  );
}

/* ═════════════════ СТРАНИЦА ═════════════════ */
export default function Home() {
  const [activeTab, setActiveTab] = useState('search');

  // --- БАЗА КЛИЕНТОВ ---
  const [leads, setLeads] = useState([]);
  const [newName, setNewName] = useState('');
  const [newNiche, setNewNiche] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [selectedLeadIds, setSelectedLeadIds] = useState([]);
  const [isDeletingLeads, setIsDeletingLeads] = useState(false);
  const [editingLeadId, setEditingLeadId] = useState(null);
  const [editEmailValue, setEditEmailValue] = useState('');

  // --- УМНЫЙ ПОИСК ---
  const [visualPrompt, setVisualPrompt] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [isTransferring, setIsTransferring] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [selectedForBase, setSelectedForBase] = useState([]);
  const [referenceProfile, setReferenceProfile] = useState('');
  const [referencePhotoDataUris, setReferencePhotoDataUris] = useState([]);
  const [referencePhotoUrlInput, setReferencePhotoUrlInput] = useState('');
  const [selectedStyle, setSelectedStyle] = useState('Beauty');
  const [activePreviewData, setActivePreviewData] = useState(null);
  const [imgFailed, setImgFailed] = useState(false);

  // --- АВТОРИЗАЦИЯ И РАЗДЕЛЕНИЕ САЙТА ---
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [showAdminLogin, setShowAdminLogin] = useState(false);

  // --- КОНТЕНТ САЙТА (для панели управления) ---
  const [publicSettings, setPublicSettings] = useState(null);
  const [publicShoots, setPublicShoots] = useState([]);
  const [publicBeforeAfter, setPublicBeforeAfter] = useState([]);

  // --- ПАНЕЛЬ УПРАВЛЕНИЯ САЙТОМ ---
  const [cmsTab, setCmsTab] = useState('requests');
  const [siteRequests, setSiteRequests] = useState([]);

  // --- ТЕКСТЫ И КОНТАКТЫ ---
  const [editTagline, setEditTagline] = useState('');
  const [editAboutNote, setEditAboutNote] = useState('');
  const [editAbout, setEditAbout] = useState('');
  const [editTg, setEditTg] = useState('');
  const [editWa, setEditWa] = useState('');
  const [editIg, setEditIg] = useState('');
  const [editEmail, setEditEmail] = useState('');

  // --- ЗАГРУЗКИ (СЪЁМКИ И ДО/ПОСЛЕ) ---
  const [showAddShoot, setShowAddShoot] = useState(false);
  const [shootTitle, setShootTitle] = useState('');
  const [shootCategory, setShootCategory] = useState('beauty');
  const [shootYear, setShootYear] = useState('');
  const [shootTeam, setShootTeam] = useState('');
  const [shootFiles, setShootFiles] = useState([]);
  const [teamDraft, setTeamDraft] = useState({});   // id съёмки → текст команды, пока правим
  const [teamSavedId, setTeamSavedId] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStep, setUploadStep] = useState('');

  const [showAddBA, setShowAddBA] = useState(false);
  const [baTitle, setBaTitle] = useState('');
  const [baNote, setBaNote] = useState('');
  const [baBefore, setBaBefore] = useState(null);
  const [baAfter, setBaAfter] = useState(null);
  const [isUploadingBA, setIsUploadingBA] = useState(false);
  const [baStep, setBaStep] = useState('');
  const [baError, setBaError] = useState('');
  const [shootError, setShootError] = useState('');
  const [siteImgBusy, setSiteImgBusy] = useState('');
  const [siteImgError, setSiteImgError] = useState('');
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [upPct, setUpPct] = useState(0);
  const [shootBusyId, setShootBusyId] = useState('');
  const [openShootId, setOpenShootId] = useState('');
  const [cloudName, setCloudName] = useState('');
  const [uploadPreset, setUploadPreset] = useState('');
  const storeCfg = storageConfig({ cloudName, uploadPreset });

  // Эффект: загрузка входящих заявок
  useEffect(() => {
    if (user) {
      getDocs(collection(db, 'leads_portfolio')).then(snap => {
        setSiteRequests(snap.docs.map(d => ({ id: d.id, ...d.data() }))
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
      });
    }
  }, [user, cmsTab]);

  // Эффект: контент сайта для панели управления (только для авторизованной)
  useEffect(() => {
    if (!user) return;
    async function fetchPublic() {
      try {
        const cfg = await getDoc(doc(db, 'site_settings', 'public'));
        if (cfg.exists()) setPublicSettings(cfg.data());

        const snapShoots = await getDocs(collection(db, 'portfolio_shoots'));
        setPublicShoots(snapShoots.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0)));

        const snapBA = await getDocs(collection(db, 'before_after'));
        setPublicBeforeAfter(snapBA.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0)));
      } catch (e) {
        console.error('не загрузился контент сайта:', e);
      }
    }
    fetchPublic();
  }, [user]);

  // Эффект: подтягивание настроек в поля админки
  useEffect(() => {
    if (publicSettings) {
      setEditTagline(publicSettings.tagline || '');
      setEditAboutNote(publicSettings.aboutNote || '');
      setEditAbout((publicSettings.about || []).join('\n'));
      setEditTg(publicSettings.contacts?.telegram?.url || '');
      setEditWa(publicSettings.contacts?.whatsapp?.url || '');
      setEditIg(publicSettings.contacts?.instagram?.url || '');
      setEditEmail(publicSettings.contacts?.email?.url?.replace('mailto:', '') || '');
      setCloudName(publicSettings.cloudName || '');
      setUploadPreset(publicSettings.uploadPreset || '');
    }
  }, [publicSettings]);

  // Эффект: проверка авторизации
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (user) fetchLeads();
  }, [user]);

  async function fetchLeads() {
    const querySnapshot = await getDocs(collection(db, 'leads'));
    const leadsArray = [];
    querySnapshot.forEach((docSnap) => {
      leadsArray.push({ id: docSnap.id, ...docSnap.data() });
    });
    setLeads(leadsArray);
  }

  // --- ХЭНДЛЕРЫ АВТОРИЗАЦИИ ---
  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError('');
    try {
      await signInWithEmailAndPassword(auth, loginEmail, loginPassword);
    } catch (error) {
      setLoginError('Неверный email или пароль');
    }
  };

  const handleLogout = () => signOut(auth);

  // --- ХЭНДЛЕРЫ CMS И ПОРТФОЛИО ---
  const handleSaveSettings = async () => {
    const handleFromUrl = (u) => {
      if (!u) return '';
      const clean = u.replace(/\/$/, '');
      if (clean.startsWith('mailto:')) return clean.replace('mailto:', '');
      if (clean.includes('wa.me/')) return '+' + clean.split('wa.me/')[1];
      return '@' + clean.split('/').filter(Boolean).pop();
    };
    const contacts = { ...(publicSettings?.contacts || {}) };
    if (editTg) contacts.telegram = { handle: handleFromUrl(editTg), url: editTg, sub: 'отвечаю быстрее всего' };
    else delete contacts.telegram;
    if (editWa) contacts.whatsapp = { handle: handleFromUrl(editWa), url: editWa, sub: 'звонки и сообщения' };
    else delete contacts.whatsapp;
    if (editIg) contacts.instagram = { handle: handleFromUrl(editIg), url: editIg, sub: 'свежие работы' };
    else delete contacts.instagram;
    if (editEmail) contacts.email = { handle: editEmail, url: `mailto:${editEmail}`, sub: 'для брифов и договоров' };
    else delete contacts.email;

    const newSettings = {
      ...publicSettings,
      tagline: editTagline,
      aboutNote: editAboutNote,
      about: editAbout.split('\n').map(s => s.trim()).filter(Boolean),
      contacts,
      cloudName: cloudName.trim(),
      uploadPreset: uploadPreset.trim(),
      facts: publicSettings?.facts || [
        { label: 'Опыт', value: '06', note: 'лет в постобработке' },
        { label: 'Съёмок', value: '240+', note: 'обработано с 2020' },
        { label: 'Тест-ретушь', value: 'Free', note: 'одно фото бесплатно' },
      ],
    };
    await setDoc(doc(db, 'site_settings', 'public'), newSettings, { merge: true });
    setPublicSettings(newSettings);
    setSettingsSaved(true);
    setTimeout(() => setSettingsSaved(false), 2600);
  };

  // Съёмка: сжимаем кадры и кладём в Firebase Storage, в Firestore — только ссылки.
  // (Base64 в документ не влезает: лимит документа 1 МБ, 5 фото его пробивают.)
  const handleCreateShoot = async () => {
    if (!shootTitle.trim() || shootFiles.length === 0) { setShootError('Укажи название и выбери фото'); return; }
    setShootError('');
    setIsUploading(true);
    try {
      const stamp = Date.now();
      const photos = [];
      for (let i = 0; i < shootFiles.length; i++) {
        setUploadStep(`${i + 1} / ${shootFiles.length}`);
        const { blob, w, h: hh } = await compressImage(shootFiles[i], 1600, 0.82);
        setUpPct(0);
        const up = await uploadImage(blob, 'portfolio', storeCfg, setUpPct);
        photos.push({ url: up.url, w: up.w || w, h: up.h || hh, path: up.path });
      }
      const newShoot = {
        title: shootTitle.trim(),
        category: shootCategory,
        year: shootYear.trim(),
        team: shootTeam.trim(),
        order: stamp,
        photos,
        cover: photos[0]?.url || '',
      };
      const docRef = await addDoc(collection(db, 'portfolio_shoots'), newShoot);
      setPublicShoots(prev => [...prev, { id: docRef.id, ...newShoot }]);
      setShowAddShoot(false);
      setShootTitle(''); setShootFiles([]); setShootYear(''); setShootTeam('');
    } catch (error) {
      setShootError('Не загрузилось: ' + (error.message || error.code || 'неизвестная ошибка'));
    } finally {
      setIsUploading(false);
      setUploadStep('');
    }
  };

  const handleCreateBA = async () => {
    if (!baTitle.trim() || !baBefore || !baAfter) { setBaError('Заполни заголовок и прикрепи оба кадра'); return; }
    setBaError('');
    setIsUploadingBA(true);
    try {
      const stamp = Date.now();

      setBaStep('готовлю кадр «до»');
      let before;
      try { before = await compressImage(baBefore, 1600, 0.82); }
      catch (e) { throw new Error('кадр «до»: ' + e.message); }

      setBaStep('загружаю кадр «до»');
      setUpPct(0);
      const upBefore = await uploadImage(before.blob, 'before_after', storeCfg, setUpPct);
      const beforeUrl = upBefore.url;

      setBaStep('готовлю кадр «после»');
      let after;
      try { after = await compressImage(baAfter, 1600, 0.82); }
      catch (e) { throw new Error('кадр «после»: ' + e.message); }

      setBaStep('загружаю кадр «после»');
      setUpPct(0);
      const upAfter = await uploadImage(after.blob, 'before_after', storeCfg, setUpPct);
      const afterUrl = upAfter.url;

      setBaStep('сохраняю на сайт');
      const newBA = { title: baTitle.trim(), note: baNote.trim(), beforeUrl, afterUrl, order: stamp };
      const docRef = await addDoc(collection(db, 'before_after'), newBA);

      setPublicBeforeAfter(prev => [...prev, { id: docRef.id, ...newBA }]);
      setShowAddBA(false);
      setBaTitle(''); setBaNote(''); setBaBefore(null); setBaAfter(null);
    } catch (e) {
      setBaError(e.message || e.code || 'неизвестная ошибка');
    } finally {
      setIsUploadingBA(false);
      setBaStep('');
      setUpPct(0);
    }
  };

  // Титульное фото и портрет «обо мне» — управляются только отсюда
  const handleUploadSiteImage = async (kind, file) => {
    if (!file) return;
    setSiteImgError('');
    setSiteImgBusy(kind);
    try {
      setUpPct(0);
      const { blob } = await compressImage(file, 1800, 0.84);
      const up = await uploadImage(blob, 'site', storeCfg, setUpPct);
      const url = up.url;
      const field = kind === 'hero' ? 'heroUrl' : 'aboutUrl';
      await setDoc(doc(db, 'site_settings', 'public'), { [field]: url }, { merge: true });
      setPublicSettings(prev => ({ ...(prev || {}), [field]: url }));
    } catch (e) {
      setSiteImgError((kind === 'hero' ? 'Титульное фото: ' : 'Портрет: ') + (e.message || e.code || 'ошибка'));
    } finally {
      setSiteImgBusy('');
      setUpPct(0);
    }
  };

  const handleClearSiteImage = async (kind) => {
    const field = kind === 'hero' ? 'heroUrl' : 'aboutUrl';
    await setDoc(doc(db, 'site_settings', 'public'), { [field]: '' }, { merge: true });
    setPublicSettings(prev => ({ ...(prev || {}), [field]: '' }));
  };

  // Команда съёмки: одно свободное поле, выводится строкой под названием
  const handleSaveTeam = async (shoot) => {
    const team = (teamDraft[shoot.id] !== undefined ? teamDraft[shoot.id] : (shoot.team || '')).trim();
    await updateDoc(doc(db, 'portfolio_shoots', shoot.id), { team });
    setPublicShoots(prev => prev.map(x => (x.id === shoot.id ? { ...x, team } : x)));
    setTeamDraft(prev => ({ ...prev, [shoot.id]: team }));
    setTeamSavedId(shoot.id);
    setTimeout(() => setTeamSavedId(''), 2600);
  };

  // Кадры внутри съёмки: обложка, удаление, добавление
  const handleSetCover = async (shoot, url) => {
    await updateDoc(doc(db, 'portfolio_shoots', shoot.id), { cover: url });
    setPublicShoots(prev => prev.map(x => (x.id === shoot.id ? { ...x, cover: url } : x)));
  };

  const handleDeletePhoto = async (shoot, idx) => {
    const photos = (shoot.photos || []).filter((_, i) => i !== idx);
    const cover = photos.some(ph => ph.url === shoot.cover) ? shoot.cover : (photos[0]?.url || '');
    await updateDoc(doc(db, 'portfolio_shoots', shoot.id), { photos, cover });
    setPublicShoots(prev => prev.map(x => (x.id === shoot.id ? { ...x, photos, cover } : x)));
  };

  const handleAddPhotosToShoot = async (shoot, files) => {
    const list = Array.from(files || []);
    if (!list.length) return;
    setShootError('');
    setShootBusyId(shoot.id);
    try {
      const stamp = Date.now();
      const added = [];
      for (let i = 0; i < list.length; i++) {
        setUploadStep(`${i + 1} / ${list.length}`);
        const { blob, w, h } = await compressImage(list[i], 1600, 0.82);
        setUpPct(0);
        const up = await uploadImage(blob, 'portfolio', storeCfg, setUpPct);
        added.push({ url: up.url, w: up.w || w, h: up.h || h, path: up.path });
      }
      const photos = [...(shoot.photos || []), ...added];
      const cover = shoot.cover || photos[0]?.url || '';
      await updateDoc(doc(db, 'portfolio_shoots', shoot.id), { photos, cover });
      setPublicShoots(prev => prev.map(x => (x.id === shoot.id ? { ...x, photos, cover } : x)));
    } catch (e) {
      setShootError('Не удалось добавить кадры: ' + (e.message || e.code || 'ошибка'));
    } finally {
      setShootBusyId('');
      setUploadStep('');
      setUpPct(0);
    }
  };

  // --- ХЭНДЛЕРЫ РАБОТЫ С БАЗОЙ ---
  const handleAddLead = async () => {
    if (!newName) return;
    if (leads.some(l => l.username.toLowerCase() === newName.toLowerCase().trim())) {
      alert('Этот профиль уже есть в вашей базе!');
      return;
    }
    const docRef = await addDoc(collection(db, 'leads'), {
      username: newName.trim(), niche: newNiche, email: newEmail, status: 'New'
    });
    setLeads([...leads, { id: docRef.id, username: newName.trim(), niche: newNiche, email: newEmail, status: 'New' }]);
    setNewName(''); setNewNiche(''); setNewEmail('');
  };

  const handleStatusChange = async (leadId, newStatus) => {
    await updateDoc(doc(db, 'leads', leadId), { status: newStatus });
    setLeads(leads.map(lead => lead.id === leadId ? { ...lead, status: newStatus } : lead));
  };

  const handleSaveLeadEmail = async (leadId) => {
    await updateDoc(doc(db, 'leads', leadId), { email: editEmailValue });
    setLeads(leads.map(lead => lead.id === leadId ? { ...lead, email: editEmailValue } : lead));
    setEditingLeadId(null);
  };

  const toggleLeadSelection = (id) => {
    setSelectedLeadIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const handleSelectAllLeads = () => {
    const allSelected = displayLeads.length > 0 && displayLeads.every(l => selectedLeadIds.includes(l.id));
    if (allSelected) {
      setSelectedLeadIds(prev => prev.filter(id => !displayLeads.some(l => l.id === id)));
    } else {
      const displayIds = displayLeads.map(l => l.id);
      setSelectedLeadIds(prev => [...new Set([...prev, ...displayIds])]);
    }
  };

  const handleDeleteSelectedLeads = async () => {
    if (selectedLeadIds.length === 0 || isDeletingLeads) return;
    if (!confirm(`Удалить ${selectedLeadIds.length} контакт(ов) из базы? Это необратимо.`)) return;
    setIsDeletingLeads(true);
    try {
      await Promise.all(selectedLeadIds.map(id => deleteDoc(doc(db, 'leads', id))));
      setSelectedLeadIds([]);
      await fetchLeads();
    } catch (e) {
      alert('Не удалось удалить некоторые контакты. Попробуй ещё раз.');
    }
    setIsDeletingLeads(false);
  };

  // --- ХЭНДЛЕРЫ УМНОГО ПОИСКА ---
  const addReferencePhotoFiles = async (files) => {
    const arr = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (arr.length === 0) return;
    const dataUris = await Promise.all(arr.map(fileToDataUri));
    setReferencePhotoDataUris(prev => [...prev, ...dataUris]);
  };

  const handleReferencePhotoFileInput = (e) => {
    if (e.target.files) addReferencePhotoFiles(e.target.files);
    e.target.value = '';
  };

  const handleReferencePhotoPaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      addReferencePhotoFiles(files);
    }
  };

  const handleReferencePhotoDrop = (e) => {
    e.preventDefault();
    if (e.dataTransfer.files) addReferencePhotoFiles(e.dataTransfer.files);
  };

  const removeReferencePhoto = (idx) => {
    setReferencePhotoDataUris(prev => prev.filter((_, i) => i !== idx));
  };

  const handleSmartSearch = async () => {
    if (!referenceProfile) return;
    setIsSearching(true);
    setSelectedForBase([]);
    
    const rejectedBios = leads.filter(l => l.status === 'Rejected' && l.bio).map(l => l.bio).slice(-10);
    const referencePhotos = [
      ...referencePhotoDataUris,
      ...referencePhotoUrlInput.split(/[\n,]/).map(u => u.trim()).filter(Boolean)
    ];

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10 * 60 * 1000);

    try {
      const response = await fetch(`${API_BASE}/api/smart-search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            visualPrompt, selectedStyle, referenceProfile, referencePhotos, rejectedBios,
            existingUsernames: leads.map(l => l.username)
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      const data = await response.json();
      
      if (data.success) {
        setSearchResults(data.data);
      } else {
        alert('Ошибка поиска на сервере: ' + data.error);
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        alert('Поиск занял больше 10 минут и был прерван. Проверь консоль сервера — там теперь видно, на каком шаге зависло.');
      } else {
        alert('Ошибка связи с сервером. Проверь запущен ли сервер в терминале (порт 5000).');
      }
    } finally {
      clearTimeout(timeoutId);
      setIsSearching(false);
    }
  };

  const toggleSelection = (id) => {
    setSelectedForBase(prev => prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]);
  };

  const openPreview = (result) => {
    setImgFailed(false);
    setActivePreviewData(result);
  };
  
  const handleTransferToBase = async () => {
    if (selectedForBase.length === 0 || isTransferring) return;
    setIsTransferring(true);
    
    const leadsToTransfer = searchResults.filter(r => selectedForBase.includes(r.id));
    const existingUsernames = leads.map(l => l.username.toLowerCase());
    const newLeads = leadsToTransfer.filter(lead => !existingUsernames.includes(lead.username.toLowerCase()));
    
    if (newLeads.length > 0) {
      const promises = newLeads.map(lead =>
        addDoc(collection(db, 'leads'), {
          username: lead.username, niche: selectedStyle, email: lead.email,
          status: 'New', aiOpinion: lead.opinion || '', bio: lead.bio || ''
        })
      );
      await Promise.all(promises); 
      alert(`Успешно! ${newLeads.length} контактов добавлено в базу.`);
    } else {
      alert('Выбранные профили уже есть в базе!');
    }
    setSelectedForBase([]);
    await fetchLeads();
    setIsTransferring(false);
  };

  const handleReject = async () => {
    if (selectedForBase.length === 0 || isRejecting) return;
    setIsRejecting(true);
    
    const leadsToTransfer = searchResults.filter(r => selectedForBase.includes(r.id));
    const existingUsernames = leads.map(l => l.username.toLowerCase());
    const newLeads = leadsToTransfer.filter(lead => !existingUsernames.includes(lead.username.toLowerCase()));
    
    if (newLeads.length > 0) {
      const promises = newLeads.map(lead =>
        addDoc(collection(db, 'leads'), {
          username: lead.username, niche: 'Blacklist', email: lead.email,
          status: 'Rejected', aiOpinion: 'Отбракован вручную', bio: lead.bio || ''
        })
      );
      await Promise.all(promises);
    }
    setSelectedForBase([]);
    await fetchLeads();
    setIsRejecting(false);
  };

  const stats = [
    { label: 'Total Revenue', value: '$4,250', delta: '+12% к прошлому месяцу' },
    { label: 'Active Projects', value: '03', delta: '2 съёмки на этой неделе' },
    { label: 'Pending Feedback', value: '05', delta: 'ожидают ответа > 3 дней' },
  ];

  // ================= ФИЛЬТРЫ ДЛЯ ОТОБРАЖЕНИЯ ================= //
  const existingUsernamesDisplay = leads.map(l => l.username.toLowerCase());
  const cleanResults = searchResults.filter(r =>
    !(r.status || '').includes('МУСОР') && !existingUsernamesDisplay.includes(r.username.toLowerCase())
  );

  const displayLeads = leads
    .filter(lead => lead.status !== 'Rejected' && lead.niche !== 'Blacklist')
    .filter((lead, index, self) => index === self.findIndex((t) => t.username.toLowerCase() === lead.username.toLowerCase()));

  if (authLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', fontFamily: "'Archivo',sans-serif", fontSize: 11, letterSpacing: '.22em', textTransform: 'uppercase', color: '#7C776E', background: '#F4F2EF' }}>
        Загрузка…
      </div>
    );
  }

  // ================= ГОСТЬ: ПОРТФОЛИО ИЛИ ВХОД ================= //
  if (!user) {
    if (showAdminLogin) {
      return (
        <div className="app">
          <style dangerouslySetInnerHTML={{ __html: CSS }} />
          <div className="strip"><span>Adriana Retouch</span><span>Вход для владельца</span></div>
          <form onSubmit={handleLogin} style={{ maxWidth: 340, margin: '14vh auto', display: 'flex', flexDirection: 'column', gap: 14, padding: '0 24px' }}>
            <h1 className="display" style={{ fontSize: 34, margin: '0 0 6px' }}>вход в crm</h1>
            <p className="mono-label" style={{ marginBottom: 10 }}>Только для меня</p>
            <input type="email" placeholder="Email" value={loginEmail} onChange={e => setLoginEmail(e.target.value)} style={{ padding: 14, border: '1px solid var(--ink)', background: 'transparent', fontFamily: 'inherit', outline: 'none' }} />
            <input type="password" placeholder="Пароль" value={loginPassword} onChange={e => setLoginPassword(e.target.value)} style={{ padding: 14, border: '1px solid var(--ink)', background: 'transparent', fontFamily: 'inherit', outline: 'none' }} />
            {loginError && <span style={{ fontSize: 12, color: '#8A3B33' }}>{loginError}</span>}
            <button type="submit" className="badge solid" style={{ padding: 16, border: 'none', cursor: 'pointer', fontSize: 11 }}>Войти</button>
            <button type="button" onClick={() => { setShowAdminLogin(false); setLoginError(''); }} style={{ background: 'none', border: 'none', color: 'var(--mute)', cursor: 'pointer', fontSize: 12, textDecoration: 'underline' }}>Вернуться на сайт</button>
          </form>
        </div>
      );
    }
    return <PublicSite onAdminClick={() => setShowAdminLogin(true)} />;
  }

  // ================= ЗАКРЫТАЯ CRM (АДМИНКА) ================= //
  return (
    <div className="app">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      <div className="strip">
        <span>CRM Dashboard</span>
        <span>Secure Connection</span>
      </div>

      <header>
        <div className="logo">
          <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-label="Adriana">
            <rect x=".5" y=".5" width="25" height="25" stroke="currentColor" />
            <path d="M6 20 13 6l7 14" stroke="currentColor" strokeWidth="1.4" />
            <path d="M9 15h8" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          <div>
            <span className="logo-word">Adriana</span> <span className="logo-sub">Studio</span>
          </div>
        </div>
       <div className="header-meta">
          <span className="mono-label">03 Active projects</span>
          <span className="mono-label">sept 04 2026</span>
          <button onClick={handleLogout} className="logout">Выйти из аккаунта</button>
        </div>
      </header>

      <section className="hero">
        <div className="hero-over">management & outreach</div>
        <h1 className="display hero-main">workspace</h1>
        <div className="hero-rule">
          <span className="mono-label">Lead management · Analytics</span>
        </div>
      </section>

      <nav className="tabs" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            className="tab"
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="num">{tab.num}</span>
            {tab.label}
          </button>
        ))}
      </nav>

      <main>
        <div className="sheet">
          {activeTab === 'base' && (
            <div>
              <div className="sec-head">
                <h2 className="display sec-title">clients database</h2>
              </div>
              
              <div style={{ display: 'flex', gap: '12px', marginBottom: '20px', flexWrap: 'wrap' }}>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} type="text" placeholder="Имя / Instagram" style={{ padding: '10px 12px', border: '1px solid var(--line-soft)', background: 'transparent', fontFamily: 'inherit', fontSize: '13px', outline: 'none' }} />
                <input value={newNiche} onChange={(e) => setNewNiche(e.target.value)} type="text" placeholder="Ниша" style={{ padding: '10px 12px', border: '1px solid var(--line-soft)', background: 'transparent', fontFamily: 'inherit', fontSize: '13px', outline: 'none' }} />
                <input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} type="email" placeholder="Email" style={{ padding: '10px 12px', border: '1px solid var(--line-soft)', background: 'transparent', fontFamily: 'inherit', fontSize: '13px', outline: 'none' }} />
                <button onClick={handleAddLead} className="badge solid" style={{ cursor: 'pointer', border: 'none', padding: '0 24px' }}>+ Добавить</button>
              </div>

              <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', alignItems: 'center' }}>
                <button
                  disabled={selectedLeadIds.length === 0 || isDeletingLeads}
                  onClick={handleDeleteSelectedLeads}
                  className="badge solid"
                  style={{
                    opacity: selectedLeadIds.length === 0 || isDeletingLeads ? 0.5 : 1,
                    padding: '10px 20px',
                    cursor: selectedLeadIds.length === 0 ? 'not-allowed' : 'pointer',
                    border: '1px solid var(--ink)',
                    background: 'transparent',
                    color: 'var(--ink)'
                  }}
                >
                  {isDeletingLeads ? 'Удаляем...' : `Удалить выбранных (${selectedLeadIds.length}) 🗑️`}
                </button>
                {selectedLeadIds.length === 0 && <span style={{ fontSize: '12px', color: 'var(--mute)' }}>← Отметь галочками или нажми на галочку в шапке таблицы, чтобы выделить всё</span>}
              </div>

              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: '36px', padding: '0 12px 12px 0' }}>
                        <input type="checkbox" checked={displayLeads.length > 0 && displayLeads.every(l => selectedLeadIds.includes(l.id))} onChange={handleSelectAllLeads} style={{ cursor: 'pointer' }} title="Выделить все" />
                      </th>
                      <th aria-label="№" />
                      <th>Client / IG</th>
                      <th>Niche</th>
                      <th>Email</th>
                      <th>Status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayLeads.map((lead, i) => (
                      <tr key={lead.id}>
                        <td style={{ padding: '22px 12px 22px 0' }}>
                          <input type="checkbox" checked={selectedLeadIds.includes(lead.id)} onChange={() => toggleLeadSelection(lead.id)} style={{ cursor: 'pointer' }} />
                        </td>
                        <td className="idx">{String(i + 1).padStart(2, '0')}</td>
                        <td className="handle">{lead.username}</td>
                        <td className="niche">{lead.niche}</td>
                        <td className="niche">
                          {editingLeadId === lead.id ? (
                            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                              <input type="email" value={editEmailValue} onChange={(e) => setEditEmailValue(e.target.value)} style={{ padding: '6px 8px', border: '1px solid var(--ink)', background: 'transparent', fontFamily: 'inherit', fontSize: '12px', outline: 'none', width: '160px' }} autoFocus />
                              <button onClick={() => handleSaveLeadEmail(lead.id)} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '14px' }} title="Сохранить">✓</button>
                              <button onClick={() => setEditingLeadId(null)} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '14px', color: 'var(--mute)' }} title="Отмена">✕</button>
                            </div>
                          ) : ( lead.email || '—' )}
                        </td>
                        <td>
                          <select value={lead.status || 'New'} onChange={(e) => handleStatusChange(lead.id, e.target.value)} style={{ border: '1px solid var(--line-soft)', background: 'transparent', padding: '6px', fontSize: '11px', fontFamily: 'Archivo', textTransform: 'uppercase', cursor: 'pointer', outline: 'none', color: 'var(--ink)' }}>
                            <option value="New">NEW</option>
                            <option value="Pitched">PITCHED</option>
                            <option value="Warm">WARM</option>
                            <option value="Portfolio">В ПОРТФОЛИО 🌟</option>
                            <option value="Rejected">REJECTED</option>
                          </select>
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: '14px', justifyContent: 'flex-end' }}>
                            <button className="open" onClick={() => { setEditingLeadId(lead.id); setEditEmailValue(lead.email || ''); }}>Edit</button>
                            <button className="open" onClick={() => window.open(`https://instagram.com/${lead.username.replace('@', '')}`, '_blank')}>Open</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'portfolio' && (
            <div>
              <div className="sec-head" style={{ marginBottom: '24px' }}>
                <div>
                  <h2 className="display sec-title">site management</h2>
                  <p className="sec-note">Управление контентом публичного портфолио и входящие заявки на тестовую ретушь.</p>
                </div>
              </div>

              <div className="cms-tabs">
                {[
                  { id: 'requests', label: 'Заявки с сайта' },
                  { id: 'settings', label: 'Тексты и фото сайта' },
                  { id: 'shoots', label: 'Галерея съёмок' },
                  { id: 'beforeAfter', label: 'До / после' }
                ].map(tab => (
                  <button 
                    key={tab.id}
                    onClick={() => setCmsTab(tab.id)}
                    className="badge"
                    style={{ 
                      background: cmsTab === tab.id ? 'var(--ink)' : 'transparent',
                      color: cmsTab === tab.id ? 'var(--paper)' : 'var(--ink)',
                      cursor: 'pointer',
                      border: cmsTab === tab.id ? '1px solid var(--ink)' : '1px solid var(--line-soft)'
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {cmsTab === 'requests' && (
                <div>
                  <h3 style={{ fontFamily: 'Archivo', fontSize: '18px', marginBottom: '16px' }}>Входящие брифы</h3>
                  {siteRequests.length === 0 ? (
                    <p style={{ color: 'var(--mute)', fontSize: '14px' }}>Пока новых заявок нет. Все заполненные формы с публичного сайта появятся здесь и продублируются тебе в Telegram.</p>
                  ) : (
                    <div style={{ display: 'grid', gap: '16px' }}>
                      {siteRequests.map(req => (
                        <div key={req.id} style={{ padding: '20px', border: '1px solid var(--line-soft)', background: 'var(--paper-2)', borderRadius: '4px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                            <strong style={{ fontSize: '16px', fontFamily: 'Archivo' }}>{req.name}</strong>
                            <span style={{ fontSize: '12px', color: 'var(--mute)' }}>{new Date(req.createdAt).toLocaleString('ru-RU')}</span>
                          </div>
                          <p style={{ margin: '0 0 8px', fontSize: '14px' }}><strong>Связь:</strong> {req.contact}</p>
                          <p style={{ margin: '0 0 12px', fontSize: '14px' }}><strong>Задача:</strong> {req.task || 'Не указана'}</p>
                          <span className="badge" style={{ background: 'var(--ink)', color: 'var(--paper)' }}>Прикреплено фото: {req.photosCount || 0}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {cmsTab === 'settings' && (
                <div className="cms-2col">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <h3 style={{ fontFamily: 'Archivo', fontSize: '18px', margin: 0 }}>Главный экран</h3>
                    <textarea value={editTagline} onChange={e => setEditTagline(e.target.value)} placeholder="Слоган (Tagline)" rows={3} style={{ padding: '12px', border: '1px solid var(--line-soft)', background: 'transparent', outline: 'none', fontFamily: 'inherit' }} />
                    <textarea value={editAboutNote} onChange={e => setEditAboutNote(e.target.value)} placeholder="Короткая подпись к разделу «Обо мне»" rows={2} style={{ padding: '12px', border: '1px solid var(--line-soft)', background: 'transparent', outline: 'none', fontFamily: 'inherit' }} />
                    <textarea value={editAbout} onChange={e => setEditAbout(e.target.value)} placeholder="Обо мне: каждый абзац с новой строки" rows={8} style={{ padding: '12px', border: '1px solid var(--line-soft)', background: 'transparent', outline: 'none', fontFamily: 'inherit' }} />
                    <button onClick={handleSaveSettings} className="badge solid" style={{ padding: '12px', cursor: 'pointer', border: 'none', width: 'fit-content' }}>Сохранить тексты и контакты</button>
                    {settingsSaved && <span style={{ fontSize: '12px', color: 'var(--mute)' }}>Сохранено, сайт обновлён</span>}

                    <h3 style={{ fontFamily: 'Archivo', fontSize: '18px', margin: '18px 0 0' }}>Фото сайта</h3>
                    <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.55, color: 'var(--mute)' }}>
                      Титульный кадр и портрет для раздела «Обо мне» ставятся только здесь. Сайт не берёт фото из съёмок автоматически.
                      На кнопке виден процент загрузки.
                    </p>
                    {siteImgError && <span style={{ fontSize: '12px', color: '#8A3B33' }}>{siteImgError}</span>}
                    <div className="cms-2col tight">
                      {[['hero', 'Титульный кадр', publicSettings?.heroUrl], ['about', 'Портрет «Обо мне»', publicSettings?.aboutUrl]].map(([kind, label, url]) => (
                        <div key={kind} style={{ border: '1px solid var(--line-soft)', padding: '14px', background: 'var(--paper-2)', display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 }}>
                          <span className="mono-label">{label}</span>
                          <div style={{ aspectRatio: '4 / 5', background: 'var(--paper)', border: '1px solid var(--line-soft)', overflow: 'hidden', display: 'grid', placeItems: 'center' }}>
                            {url
                              ? <img src={url} alt={label} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                              : <span style={{ fontSize: '12px', color: 'var(--mute)', textAlign: 'center', padding: '10px' }}>пока не выбрано</span>}
                          </div>
                          <label className="badge solid" style={{ cursor: 'pointer', textAlign: 'center', padding: '10px 12px' }}>
                            {siteImgBusy === kind ? (upPct > 0 ? `Загружаю ${upPct}%` : upPct < 0 ? 'Загружаю, это может занять минуту…' : 'Готовлю кадр…') : (url ? 'Заменить' : 'Выбрать фото')}
                            <input type="file" accept="image/*" hidden disabled={siteImgBusy === kind}
                              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; handleUploadSiteImage(kind, f); }} />
                          </label>
                          {url && <button onClick={() => handleClearSiteImage(kind)} style={{ background: 'none', border: 'none', color: 'var(--mute)', cursor: 'pointer', fontSize: '12px', textDecoration: 'underline' }}>Убрать</button>}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <h3 style={{ fontFamily: 'Archivo', fontSize: '18px', margin: 0 }}>Контакты (Ссылки)</h3>
                    <input value={editTg} onChange={e => setEditTg(e.target.value)} type="text" placeholder="Telegram URL (https://t.me/...)" style={{ padding: '12px', border: '1px solid var(--line-soft)', background: 'transparent', outline: 'none' }} />
                    <input value={editWa} onChange={e => setEditWa(e.target.value)} type="text" placeholder="WhatsApp URL (https://wa.me/48...)" style={{ padding: '12px', border: '1px solid var(--line-soft)', background: 'transparent', outline: 'none' }} />
                    <input value={editIg} onChange={e => setEditIg(e.target.value)} type="text" placeholder="Instagram URL (https://instagram.com/...)" style={{ padding: '12px', border: '1px solid var(--line-soft)', background: 'transparent', outline: 'none' }} />
                    <input value={editEmail} onChange={e => setEditEmail(e.target.value)} type="text" placeholder="Email (почта@домен.com)" style={{ padding: '12px', border: '1px solid var(--line-soft)', background: 'transparent', outline: 'none' }} />

                    <h3 style={{ fontFamily: 'Archivo', fontSize: '18px', margin: '18px 0 0' }}>Хранилище фотографий</h3>
                    <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.55, color: 'var(--mute)' }}>
                      Все фото уходят в Cloudinary. Два значения из его настроек: Cloud name на главной странице аккаунта,
                      Upload preset в Settings · Upload, режим Unsigned. Это публичные имена, не пароли.
                    </p>
                    <input value={cloudName} onChange={e => setCloudName(e.target.value)} type="text" placeholder="Cloud name (например dq8xk2abc)" style={{ padding: '12px', border: '1px solid var(--line-soft)', background: 'transparent', outline: 'none' }} />
                    <input value={uploadPreset} onChange={e => setUploadPreset(e.target.value)} type="text" placeholder="Upload preset (например adriana_unsigned)" style={{ padding: '12px', border: '1px solid var(--line-soft)', background: 'transparent', outline: 'none' }} />
                    <span style={{ fontSize: '12px', color: storeCfg.cloud && storeCfg.preset ? 'var(--mute)' : '#8A3B33' }}>
                      {storeCfg.cloud && storeCfg.preset
                        ? 'Значения заполнены — можно пробовать загрузку.'
                        : 'Пока не заполнено — загрузка фото выдаст ошибку.'}
                    </span>
                    <button onClick={handleSaveSettings} className="badge solid" style={{ padding: '12px', cursor: 'pointer', border: 'none', width: 'fit-content' }}>Сохранить хранилище</button>
                  </div>
                </div>
              )}

              {cmsTab === 'shoots' && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
                    <h3 style={{ fontFamily: 'Archivo', fontSize: '18px', margin: 0 }}>Управление съёмками</h3>
                    <button onClick={() => { setShootError(''); setShowAddShoot(true); }} className="badge solid" style={{ cursor: 'pointer', border: 'none', padding: '10px 20px' }}>+ Добавить съёмку</button>
                  </div>
                  {shootError && <p style={{ fontSize: '12px', color: '#8A3B33', margin: '0 0 14px' }}>{shootError}</p>}
                  <div style={{ display: 'grid', gap: '16px' }}>
                    {publicShoots.map(s => (
                       <div key={s.id} style={{ padding: '16px', border: '1px solid var(--line-soft)', background: 'var(--paper-2)', minWidth: 0 }}>
                         <div className="shoot-row">
                           <div style={{ minWidth: 0 }}>
                             <strong style={{ fontFamily: 'Archivo' }}>{s.title}</strong>{' '}
                             <span style={{color: 'var(--mute)', fontSize: '13px'}}>({s.category}, {s.photos?.length || 0} фото)</span>
                           </div>
                           <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
                             <button onClick={() => setOpenShootId(openShootId === s.id ? '' : s.id)} style={{ background: 'none', border: 'none', color: 'var(--ink)', cursor: 'pointer', fontSize: '12px', textDecoration: 'underline' }}>
                               {openShootId === s.id ? 'Свернуть кадры' : 'Кадры и обложка'}
                             </button>
                             <button onClick={async () => {
                               if(confirm('Точно удалить съёмку?')) {
                                 await deleteDoc(doc(db, 'portfolio_shoots', s.id));
                                 setPublicShoots(prev => prev.filter(x => x.id !== s.id));
                               }
                             }} style={{ background: 'none', border: 'none', color: 'var(--mute)', cursor: 'pointer', fontSize: '12px', textDecoration: 'underline' }}>Удалить съёмку</button>
                           </div>
                         </div>

                         {openShootId === s.id && (
                           <div style={{ marginTop: '16px', borderTop: '1px solid var(--line-soft)', paddingTop: '16px' }}>
                             <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '18px' }}>
                               <span className="mono-label">Команда съёмки</span>
                               <textarea
                                 rows={2}
                                 placeholder="Фото — Аня К. · Модель — Саша · MUAH — Лера"
                                 value={teamDraft[s.id] !== undefined ? teamDraft[s.id] : (s.team || '')}
                                 onChange={e => setTeamDraft(prev => ({ ...prev, [s.id]: e.target.value }))}
                                 style={{ padding: '10px 12px', border: '1px solid var(--line-soft)', background: 'transparent', outline: 'none', fontFamily: 'inherit', fontSize: '13px', resize: 'vertical' }}
                               />
                               <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
                                 <button onClick={() => handleSaveTeam(s)} className="badge solid" style={{ cursor: 'pointer', border: 'none', padding: '9px 16px' }}>Сохранить команду</button>
                                 {teamSavedId === s.id && <span style={{ fontSize: '12px', color: 'var(--mute)' }}>Сохранено, сайт обновлён</span>}
                               </div>
                             </div>
                             <div className="ph-grid">
                               {(s.photos || []).map((ph, i) => (
                                 <div key={ph.url + i} className={`ph ${s.cover === ph.url ? 'is-cover' : ''}`}>
                                   <img src={ph.url} alt={`${s.title} — кадр ${i + 1}`} />
                                   <div className="ph-acts">
                                     {s.cover === ph.url
                                       ? <span className="ph-tag">обложка</span>
                                       : <button onClick={() => handleSetCover(s, ph.url)}>обложка</button>}
                                     <button onClick={() => { if (confirm('Убрать этот кадр с сайта?')) handleDeletePhoto(s, i); }}>удалить</button>
                                   </div>
                                 </div>
                               ))}
                             </div>
                             <label className="badge" style={{ display: 'inline-block', marginTop: '14px', cursor: 'pointer', border: '1px solid var(--ink)' }}>
                               {shootBusyId === s.id ? `Загружаю ${uploadStep}${upPct > 0 && upPct < 100 ? ` · ${upPct}%` : ''}` : '+ Добавить кадры'}
                               <input type="file" accept="image/*" multiple hidden disabled={shootBusyId === s.id}
                                 onChange={(e) => { const f = e.target.files; e.target.value = ''; handleAddPhotosToShoot(s, f); }} />
                             </label>
                           </div>
                         )}
                       </div>
                    ))}
                  </div>
                </div>
              )}

              {cmsTab === 'beforeAfter' && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
                    <h3 style={{ fontFamily: 'Archivo', fontSize: '18px', margin: 0 }}>Интерактивные ползунки</h3>
                    <button onClick={() => { setBaError(''); setShowAddBA(true); }} className="badge solid" style={{ cursor: 'pointer', border: 'none', padding: '10px 20px' }}>+ Добавить пару фото</button>
                  </div>
                  <div style={{ display: 'grid', gap: '16px' }}>
                    {publicBeforeAfter.map(ba => (
                       <div key={ba.id} style={{ padding: '16px', border: '1px solid var(--line-soft)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--paper-2)' }}>
                         <div>
                           <strong style={{ fontFamily: 'Archivo' }}>{ba.title}</strong> <span style={{color: 'var(--mute)', fontSize: '13px'}}>- {ba.note}</span>
                         </div>
                         <button onClick={async () => {
                           if(confirm('Удалить этот ползунок?')) {
                             await deleteDoc(doc(db, 'before_after', ba.id));
                             setPublicBeforeAfter(prev => prev.filter(x => x.id !== ba.id));
                           }
                         }} style={{ background: 'none', border: 'none', color: 'var(--mute)', cursor: 'pointer', fontSize: '12px', textDecoration: 'underline' }}>Удалить</button>
                       </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'orders' && (
            <div>
              <div className="sec-head">
                <h2 className="display sec-title">revenue &amp; orders</h2>
                <p className="sec-note">Сводка по текущему сезону: доход, активные съёмки и ожидание фидбека.</p>
              </div>
              <div className="stats">
                {stats.map((s) => (
                  <div className="stat" key={s.label}>
                    <div className="mono-label">{s.label}</div>
                    <div className="stat-val">{s.value}</div>
                    <div className="stat-delta">{s.delta}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'search' && (
            <div>
              <div className="sec-head">
                <h2 className="display sec-title">ai lead search</h2>
                <p className="sec-note">Укажи профиль(и)-пример — это единственный и главный критерий поиска. Система найдёт похожие аккаунты и оценит их по твоему промту, тематике и фото-референсам.</p>
              </div>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '32px', maxWidth: '600px' }}>
                <div className="cms-2col tight">
                  <select value={selectedStyle} onChange={(e) => setSelectedStyle(e.target.value)} style={{ flex: 1, padding: '14px', border: '1px solid var(--line-soft)', background: 'transparent', fontFamily: 'inherit', fontSize: '14px', outline: 'none', cursor: 'pointer' }}>
                    <option value="Beauty">Стиль: Beauty (макро, кожа, макияж)</option>
                    <option value="Fashion">Стиль: Fashion (лукбуки, журналы)</option>
                    <option value="Natural">Стиль: Natural (естественность, без пластики)</option>
                  </select>

                  <input type="text" value={referenceProfile} onChange={(e) => setReferenceProfile(e.target.value)} placeholder="Профиль(и)-пример через запятую (monicalis_, anotherpro)" style={{ flex: 1, padding: '14px', border: '1px solid var(--line-soft)', background: 'transparent', fontFamily: 'inherit', fontSize: '14px', outline: 'none' }} />
                </div>

                <div>
                  <div onPaste={handleReferencePhotoPaste} onDrop={handleReferencePhotoDrop} onDragOver={(e) => e.preventDefault()} tabIndex={0} style={{ border: '1px dashed var(--line-soft)', padding: '16px', fontSize: '13px', color: 'var(--mute)', outline: 'none', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
                      <span>Фото-референсы: кликни сюда и вставь (Ctrl+V), перетащи файлы, или</span>
                      <label style={{ border: '1px solid var(--line-soft)', padding: '6px 12px', fontSize: '11px', fontFamily: 'Archivo', textTransform: 'uppercase', cursor: 'pointer', color: 'var(--ink)' }}>
                        Выбрать файлы
                        <input type="file" accept="image/*" multiple onChange={handleReferencePhotoFileInput} style={{ display: 'none' }} />
                      </label>
                    </div>

                    {referencePhotoDataUris.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                        {referencePhotoDataUris.map((uri, idx) => (
                          <div key={idx} style={{ position: 'relative', width: '64px', height: '64px' }}>
                            <img src={uri} alt={`Референс ${idx + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '4px', border: '1px solid var(--line-soft)' }} />
                            <button onClick={() => removeReferencePhoto(idx)} style={{ position: 'absolute', top: '-6px', right: '-6px', width: '18px', height: '18px', borderRadius: '50%', border: 'none', background: 'var(--ink)', color: 'var(--paper)', fontSize: '10px', cursor: 'pointer', lineHeight: '18px', padding: 0 }} title="Убрать">✕</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <input type="text" value={referencePhotoUrlInput} onChange={(e) => setReferencePhotoUrlInput(e.target.value)} placeholder="Или вставь ссылку на фото, если оно уже где-то лежит (необязательно)" style={{ marginTop: '8px', width: '100%', padding: '10px 12px', border: '1px solid var(--line-soft)', background: 'transparent', fontFamily: 'inherit', fontSize: '13px', outline: 'none' }} />
                </div>

                <textarea value={visualPrompt} onChange={(e) => setVisualPrompt(e.target.value)} placeholder="Что ИИ должен искать на фото? (Например: Макро бьюти, глубокие тени. Исключить предметку)" rows={3} style={{ padding: '14px', border: '1px solid var(--line-soft)', background: 'transparent', fontFamily: 'inherit', fontSize: '14px', outline: 'none', resize: 'vertical' }} />

                <button onClick={handleSmartSearch} disabled={isSearching} className="badge solid" style={{ padding: '14px 24px', cursor: 'pointer', border: 'none', width: 'fit-content' }}>
                  {isSearching ? 'Сбор профилей...' : 'Найти ✨'}
                </button>
              </div>

              {cleanResults.length > 0 && (
                <div>
                  <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', alignItems: 'center' }}>
                    <button disabled={selectedForBase.length === 0 || isTransferring} onClick={handleTransferToBase} className="badge solid" style={{ opacity: selectedForBase.length === 0 || isTransferring ? 0.5 : 1, padding: '10px 20px', cursor: selectedForBase.length === 0 ? 'not-allowed' : 'pointer', border: 'none', background: 'var(--ink)', color: 'var(--paper)' }}>
                      {isTransferring ? 'Переносим...' : `Перенести в Базу (${selectedForBase.length}) ➔`}
                    </button>
                    <button disabled={selectedForBase.length === 0 || isRejecting} onClick={handleReject} className="badge solid" style={{ opacity: selectedForBase.length === 0 || isRejecting ? 0.5 : 1, padding: '10px 20px', cursor: selectedForBase.length === 0 ? 'not-allowed' : 'pointer', border: '1px solid var(--ink)', background: 'transparent', color: 'var(--ink)' }}>
                      {isRejecting ? 'Удаляем...' : 'В черный список 🚫'}
                    </button>
                    {selectedForBase.length === 0 && <span style={{ fontSize: '12px', color: 'var(--mute)' }}>← Выбери профили галочками слева</span>}
                  </div>

                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', textAlign: 'left', marginBottom: '24px' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--line-soft)' }}>
                        <th style={{ padding: '12px 16px', fontWeight: 'normal', color: 'var(--ink-50)', width: '40px' }}>✓</th>
                        <th style={{ padding: '12px 16px', fontWeight: 'normal', color: 'var(--ink-50)' }}>Профиль</th>
                        <th style={{ padding: '12px 16px', fontWeight: 'normal', color: 'var(--ink-50)' }}>Аудитория</th>
                        <th style={{ padding: '12px 16px', fontWeight: 'normal', color: 'var(--ink-50)' }}>Email</th>
                        <th style={{ padding: '12px 16px', fontWeight: 'normal', color: 'var(--ink-50)', width: '45%' }}>Мнение ИИ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cleanResults.map(result => (
                        <tr key={result.id} style={{ borderBottom: '1px solid var(--line-soft)', background: selectedForBase.includes(result.id) ? 'rgba(0,0,0,0.02)' : 'transparent' }}>
                          <td style={{ padding: '16px', verticalAlign: 'top' }}>
                            <input type="checkbox" checked={selectedForBase.includes(result.id)} onChange={() => toggleSelection(result.id)} style={{ cursor: 'pointer' }} />
                          </td>
                          <td style={{ padding: '16px', fontWeight: 500, verticalAlign: 'top' }}>
                            <span onClick={() => openPreview(result)} style={{ color: 'var(--ink)', textDecoration: 'none', borderBottom: '1px solid var(--ink)', cursor: 'pointer', fontSize: '14px' }} title="Открыть предпросмотр">{result.username}</span>
                            <br/>
                            <button onClick={() => openPreview(result)} style={{ marginTop: '12px', background: 'transparent', border: '1px solid var(--line-soft)', padding: '6px 12px', fontSize: '11px', borderRadius: '4px', cursor: 'pointer', color: 'var(--mute)' }}>Предпросмотр 👁️</button>
                          </td>
                          <td style={{ padding: '16px', color: 'var(--mute)', verticalAlign: 'top' }}>{result.followers}</td>
                          <td style={{ padding: '16px', color: 'var(--mute)', verticalAlign: 'top' }}>{result.email}</td>
                          <td style={{ padding: '16px', verticalAlign: 'top' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                              <span className="badge" style={{ fontSize: '11px', width: 'fit-content', background: (result.status || '').includes('ПРОФИ') || (result.status || '').includes('ПОТЕНЦИАЛ') ? 'var(--ink)' : 'transparent', color: (result.status || '').includes('ПРОФИ') || (result.status || '').includes('ПОТЕНЦИАЛ') ? 'var(--paper)' : 'var(--ink)' }}>
                                {result.status || 'Нет статуса'}
                              </span>
                              <span style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--ink)', textTransform: 'uppercase', marginTop: '4px' }}>{result.direction || ''}</span>
                              <span style={{ fontSize: '10px', fontWeight: 'bold', color: 'var(--mute)' }}>Совпадение: {result.matchScore ?? 0}%</span>
                              <span style={{ fontSize: '12px', color: 'var(--mute)', lineHeight: '1.5' }}>{result.opinion}</span>
                              <span style={{ fontSize: '10px', color: 'var(--mute)' }}>{result.photoAnalyzed ? '📷 фото учтено' : '📝 только био'}</span>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {activeTab === 'mail' && (
            <div>
              <div className="sec-head" style={{ marginBottom: '24px' }}>
                <h2 className="display sec-title">cold outreach</h2>
              </div>
              
              <div className="stats" style={{ borderBottom: '1px solid var(--ink)', marginBottom: '24px', borderTop: '1px solid var(--ink)' }}>
                <div className="stat" style={{ padding: '16px 24px' }}><div className="mono-label">Отправлено</div><div className="stat-val" style={{ fontSize: '32px', margin: '8px 0' }}>124</div></div>
                <div className="stat" style={{ padding: '16px 24px' }}><div className="mono-label">Ответили (Теплые)</div><div className="stat-val" style={{ fontSize: '32px', margin: '8px 0' }}>18</div></div>
                <div className="stat" style={{ padding: '16px 24px' }}><div className="mono-label">Конверсия</div><div className="stat-val" style={{ fontSize: '32px', margin: '8px 0' }}>14.5%</div></div>
              </div>

              <div className="cms-search">
                <div style={{ borderRight: '1px solid var(--line-soft)', paddingRight: '24px' }}>
                  <h3 className="mono-label" style={{ marginBottom: '16px' }}>Выбор получателя</h3>
                  {displayLeads.map(lead => (
                    <button key={lead.id} style={{ width: '100%', textAlign: 'left', padding: '12px', background: 'transparent', border: '1px solid var(--line-soft)', marginBottom: '8px', cursor: 'pointer', transition: 'background 0.2s' }} onMouseOver={(e) => e.currentTarget.style.background = 'var(--paper-2)'} onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}>
                      <strong style={{ fontFamily: 'Archivo', fontSize: '14px' }}>{lead.username}</strong> <br/>
                      <span style={{ fontSize: '12px', color: 'var(--mute)' }}>{lead.niche}</span>
                    </button>
                  ))}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <input type="text" defaultValue="Post-production / Adriana x Vogue" style={{ padding: '12px', border: '1px solid var(--ink)', background: 'transparent', fontFamily: 'inherit', fontSize: '14px', outline: 'none' }} />
                  <textarea rows={10} defaultValue="Hi there! I absolutely loved your recent shoot..." style={{ padding: '12px', border: '1px solid var(--ink)', background: 'transparent', fontFamily: 'inherit', fontSize: '14px', resize: 'vertical', outline: 'none' }}></textarea>
                  <button className="badge solid" style={{ padding: '14px', cursor: 'pointer', textAlign: 'center', fontSize: '12px', border: 'none' }}>Отправить предложение ✉️</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      <footer>
        <span className="mono-label">© 2026 Adriana Studio</span>
        <span className="mono-label">Internal use only</span>
      </footer>

      {/* --- МОДАЛЬНЫЕ ОКНА --- */}

      {/* 1. Модалка "Новая съёмка" */}
      {showAddShoot && (
        <div onClick={() => !isUploading && setShowAddShoot(false)} style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
          <div onClick={(e) => e.stopPropagation()} className="modal-card">
            <h2 style={{ margin: '0 0 8px', fontFamily: 'Archivo', fontSize: '24px' }}>Новая съёмка</h2>
            
            <input type="text" placeholder="Название (например: Украшения — золото)" value={shootTitle} onChange={e => setShootTitle(e.target.value)} style={{ padding: '12px', border: '1px solid var(--ink)', background: 'transparent', outline: 'none', fontFamily: 'inherit' }} />
            
            <select value={shootCategory} onChange={e => setShootCategory(e.target.value)} style={{ padding: '12px', border: '1px solid var(--ink)', background: 'transparent', outline: 'none', fontFamily: 'inherit' }}>
              <option value="beauty">Бьюти</option>
              <option value="lookbook">Лук бук</option>
              <option value="fashion">Фешн</option>
              <option value="art">Творчество</option>
              <option value="still">Предметка</option>
            </select>

            <input type="text" placeholder="Год (необязательно, например: 2026)" value={shootYear} onChange={e => setShootYear(e.target.value)} style={{ padding: '12px', border: '1px solid var(--ink)', background: 'transparent', outline: 'none', fontFamily: 'inherit' }} />

            <textarea rows={2} placeholder="Команда (например: Фото — Аня К. · Модель — Саша · MUAH — Лера)" value={shootTeam} onChange={e => setShootTeam(e.target.value)} style={{ padding: '12px', border: '1px solid var(--ink)', background: 'transparent', outline: 'none', fontFamily: 'inherit', resize: 'vertical' }} />
            
            <div style={{ border: '1px dashed var(--ink)', padding: '24px', textAlign: 'center', background: 'var(--paper-2)' }}>
               <input type="file" multiple accept="image/*" onChange={(e) => setShootFiles(Array.from(e.target.files || []))} style={{ width: '100%' }} />
               <p style={{ fontSize: '12px', color: 'var(--mute)', marginTop: '12px' }}>Выбрано фото: {shootFiles.length}</p>
            </div>

            {shootError && <span style={{ fontSize: '12px', color: '#8A3B33', lineHeight: 1.5 }}>{shootError}</span>}
            <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
              <button onClick={handleCreateShoot} disabled={isUploading} className="badge solid" style={{ flex: 1, padding: '14px', border: 'none', cursor: isUploading ? 'wait' : 'pointer' }}>
                {isUploading ? `Загружаю ${uploadStep}${upPct > 0 && upPct < 100 ? ` · ${upPct}%` : ''} — не закрывай окно` : 'Опубликовать на сайте'}
              </button>
              <button onClick={() => setShowAddShoot(false)} disabled={isUploading} className="badge" style={{ padding: '14px', border: '1px solid var(--ink)', background: 'transparent', cursor: 'pointer' }}>Отмена</button>
            </div>
          </div>
        </div>
      )}

      {/* 2. Модалка "Новый ползунок До/После" */}
      {showAddBA && (
        <div onClick={() => !isUploadingBA && setShowAddBA(false)} style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
          <div onClick={(e) => e.stopPropagation()} className="modal-card">
            <h2 style={{ margin: '0 0 8px', fontFamily: 'Archivo', fontSize: '24px' }}>Новый ползунок</h2>
            
            <input type="text" placeholder="Заголовок (например: Бьюти-макро)" value={baTitle} onChange={e => setBaTitle(e.target.value)} style={{ padding: '12px', border: '1px solid var(--ink)', background: 'transparent', outline: 'none', fontFamily: 'inherit' }} />
            <input type="text" placeholder="Описание (например: Dodge & Burn, Цвет)" value={baNote} onChange={e => setBaNote(e.target.value)} style={{ padding: '12px', border: '1px solid var(--ink)', background: 'transparent', outline: 'none', fontFamily: 'inherit' }} />
            
            <div className="cms-2col tight">
              <div style={{ border: '1px dashed var(--ink)', padding: '16px', textAlign: 'center', background: 'var(--paper-2)', minWidth: 0 }}>
                 <span style={{ fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '8px' }}>ФОТО ДО (RAW)</span>
                 <input type="file" accept="image/*" onChange={(e) => setBaBefore(e.target.files?.[0] || null)} style={{ width: '100%', fontSize: '11px' }} />
              </div>
              <div style={{ border: '1px dashed var(--ink)', padding: '16px', textAlign: 'center', background: 'var(--paper-2)', minWidth: 0 }}>
                 <span style={{ fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '8px' }}>ФОТО ПОСЛЕ</span>
                 <input type="file" accept="image/*" onChange={(e) => setBaAfter(e.target.files?.[0] || null)} style={{ width: '100%', fontSize: '11px' }} />
              </div>
            </div>

            {baError && <span style={{ fontSize: '12px', color: '#8A3B33', lineHeight: 1.5 }}>{baError}</span>}
            <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
              <button onClick={handleCreateBA} disabled={isUploadingBA} className="badge solid" style={{ flex: 1, padding: '14px', border: 'none', cursor: isUploadingBA ? 'wait' : 'pointer' }}>
                {isUploadingBA ? ((baStep || 'Загрузка') + (upPct > 0 && upPct < 100 ? ` ${upPct}%` : '…')) : 'Добавить'}
              </button>
              <button onClick={() => setShowAddBA(false)} disabled={isUploadingBA} className="badge" style={{ padding: '14px', border: '1px solid var(--ink)', background: 'transparent', cursor: 'pointer' }}>Отмена</button>
            </div>
          </div>
        </div>
      )}

      {/* 3. Модалка Предпросмотра ИИ */}
      {activePreviewData && (
        <div onClick={() => setActivePreviewData(null)} style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', width: '90%', maxWidth: '800px', height: '70vh', borderRadius: '12px', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)' }}>
            
            <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--line-soft)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--paper-2)' }}>
              <div>
                 <h2 style={{ margin: 0, fontSize: '20px', fontFamily: 'Archivo' }}>{activePreviewData.username}</h2>
                 <span style={{ fontSize: '13px', color: 'var(--mute)' }}>{activePreviewData.followers} подписчиков • Контакт: {activePreviewData.email}</span>
              </div>
              <button onClick={() => setActivePreviewData(null)} style={{ background: 'none', border: 'none', fontSize: '24px', cursor: 'pointer', color: 'var(--mute)' }}>✕</button>
            </div>
            
            <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
               <div style={{ width: '300px', padding: '24px', borderRight: '1px solid var(--line-soft)', overflowY: 'auto', background: '#fff' }}>
                  <div style={{ marginBottom: '24px' }}>
                     <span className="mono-label">Описание профиля (BIO)</span>
                     <p style={{ fontSize: '14px', lineHeight: '1.6', marginTop: '8px' }}>{activePreviewData.bio}</p>
                  </div>
                  <div style={{ background: 'var(--paper)', padding: '16px', borderRadius: '8px' }}>
                     <span className="mono-label">Мнение ИИ</span>
                     <p style={{ fontSize: '13px', fontWeight: 'bold', marginTop: '8px', marginBottom: '4px' }}>{activePreviewData.status} · {activePreviewData.matchScore ?? 0}%</p>
                     <p style={{ fontSize: '13px', margin: 0 }}><strong>Направление:</strong> {activePreviewData.direction || 'Не указано'}</p>
                     <p style={{ fontSize: '13px', margin: '8px 0 0 0', color: 'var(--mute)' }}>{activePreviewData.opinion}</p>
                     <p style={{ fontSize: '11px', margin: '8px 0 0 0', color: 'var(--mute)' }}>
                       {activePreviewData.photoAnalyzed ? '📷 Оценено по фото + био' : '📝 Оценено только по био'}
                     </p>
                  </div>
                  <a href={`https://instagram.com/${activePreviewData.username.replace('@', '')}`} target="_blank" rel="noopener noreferrer" style={{ display: 'block', textAlign: 'center', background: 'var(--ink)', color: 'var(--paper)', padding: '12px', borderRadius: '8px', textDecoration: 'none', fontSize: '14px', marginTop: '24px' }}>
                    Открыть сам Instagram ↗
                  </a>
               </div>
               
               <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#e5e5e5', padding: '24px' }}>
                  {activePreviewData.photoUrls && activePreviewData.photoUrls.length > 0 ? (
                    <div style={{ 
                        display: 'grid', 
                        gridTemplateColumns: activePreviewData.photoUrls.length > 1 ? '1fr 1fr' : '1fr', 
                        gap: '12px', width: '100%', height: '100%', maxHeight: '100%'
                    }}>
                        {activePreviewData.photoUrls.map((url, idx) => (
                            <div key={idx} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', borderRadius: '8px', boxShadow: '0 10px 25px rgba(0,0,0,0.1)' }}>
                                <img
                                    src={`${API_BASE}/api/image-proxy?url=${encodeURIComponent(url)}`}
                                    alt={`Preview ${idx + 1}`}
                                    style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', top: 0, left: 0 }}
                                />
                            </div>
                        ))}
                    </div>
                  ) : (
                    <span style={{ color: 'var(--mute)' }}>Фото скрыто настройками приватности Instagram</span>
                  )}
               </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

/* ═════════════════ СТИЛИ ПУБЛИЧНОГО САЙТА ═════════════════ */
const SITE_CSS = `:root{
  --ink:#0B0B0A;
  --paper:#F4F2EF;
  --paper-2:#EAE7E2;
  --line:#D6D2CB;
  --line-soft:#E2DFD9;
  --mute:#7C776E;
  --accent:#A79E90;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--paper);color:var(--ink);font-family:'Inter',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
img{display:block;max-width:100%}
button{font-family:inherit}

.label{font-family:'Archivo',sans-serif;font-size:10px;font-weight:500;letter-spacing:.22em;text-transform:uppercase;color:var(--mute)}
.display{font-family:'Archivo',sans-serif;font-weight:800;letter-spacing:-.035em;line-height:.86;text-transform:lowercase}
.wrap{padding:0 24px}
@media (min-width:900px){.wrap{padding:0 56px}}

/* ── инверсия: тёмные секции. Переопределяем переменные — всё внутри подстраивается ── */
.inv{
  --ink:#F4F2EF;
  --paper:#0B0B0A;
  --paper-2:#151412;
  --line:#3B3833;
  --line-soft:#2A2825;
  --mute:#9A958C;
  --accent:#A79E90;
  background:#0B0B0A;
  color:#F4F2EF;
}
.inv ::placeholder{color:#6F6A63}
.inv select option{background:#151412;color:#F4F2EF}

/* ── бегущая строка ── */
.ticker{background:var(--ink);overflow:hidden;white-space:nowrap}
.ticker-track{display:flex;width:max-content;animation:tick 38s linear infinite}
.ticker-row{display:flex}
.ticker-row span{display:inline-flex;align-items:center;padding:10px 0;font-family:'Archivo',sans-serif;font-size:10px;font-weight:500;letter-spacing:.22em;text-transform:uppercase;color:#EDEBE6}
.ticker-row i{font-style:normal;color:var(--accent);padding:0 20px}
.ticker:hover .ticker-track{animation-play-state:paused}
@keyframes tick{from{transform:translateX(0)}to{transform:translateX(-50%)}}
@media (prefers-reduced-motion:reduce){.ticker-track{animation:none}}

/* ── верхняя панель: уезжает вместе со страницей ── */
.topnav{position:relative;z-index:40;background:var(--paper);border-bottom:1px solid var(--ink);display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 24px}
@media (min-width:900px){.topnav{padding:16px 56px}}
.brand{display:flex;align-items:center;gap:11px}
.brand-word{font-family:'Archivo',sans-serif;font-weight:800;font-size:17px;letter-spacing:.16em;text-transform:uppercase}
.brand-sub{font-family:'Archivo',sans-serif;font-weight:400;font-size:17px;letter-spacing:.16em;text-transform:uppercase;color:var(--mute)}
.navlinks{display:flex;gap:28px;align-items:center}
.navlinks a{font-family:'Archivo',sans-serif;font-size:10px;font-weight:500;letter-spacing:.2em;text-transform:uppercase;color:var(--mute);text-decoration:none;transition:color .2s}
.navlinks a:hover{color:var(--ink)}
.admin{background:none;border:0;cursor:pointer;font-family:'Archivo',sans-serif;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#C9C5BE}
.admin:hover{color:var(--mute)}
.nav-burger{display:none}

/* ── плавающая кнопка меню ── */
.menu-btn{position:fixed;top:16px;right:16px;z-index:90;width:48px;height:48px;border:0;background:var(--ink);cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;opacity:0;transform:translateY(-14px);pointer-events:none;transition:opacity .3s,transform .3s}
.menu-btn.on{opacity:1;transform:translateY(0);pointer-events:auto}
.menu-btn span{display:block;width:18px;height:1px;background:#F4F2EF;transition:width .25s}
.menu-btn:hover span:nth-child(2){width:11px}

/* ── боковое меню ── */
.drawer-bg{position:fixed;inset:0;z-index:95;background:rgba(11,11,10,.5);opacity:0;pointer-events:none;transition:opacity .3s}
.drawer-bg.on{opacity:1;pointer-events:auto}
.drawer{position:fixed;top:0;right:0;bottom:0;z-index:96;width:min(88vw,360px);background:#0B0B0A;color:#F4F2EF;display:flex;flex-direction:column;justify-content:space-between;padding:22px 26px 28px;transform:translateX(102%);transition:transform .38s cubic-bezier(.2,.7,.2,1)}
.drawer.on{transform:translateX(0)}
.drawer-top{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #2A2825;padding-bottom:16px}
.drawer-top .label{color:#8E8981}
.drawer-x{background:none;border:0;color:#F4F2EF;font-size:17px;cursor:pointer;line-height:1}
.drawer-nav{display:flex;flex-direction:column;margin-top:8px}
.drawer-nav a{display:flex;align-items:baseline;gap:14px;padding:18px 0;border-bottom:1px solid #1F1E1B;text-decoration:none;color:#F4F2EF;font-family:'Archivo',sans-serif;font-weight:600;font-size:22px;letter-spacing:-.02em;transition:padding-left .25s,color .25s}
.drawer-nav a:hover{padding-left:8px;color:#C9C5BE}
.drawer-nav .d-num{font-family:'Archivo',sans-serif;font-weight:500;font-size:10px;letter-spacing:.2em;color:var(--accent)}
.drawer-foot{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
.drawer-foot .btn{background:#F4F2EF;color:#0B0B0A;border-color:#F4F2EF}
.drawer-foot .btn:hover{background:transparent;color:#F4F2EF}
.drawer-admin{background:none;border:0;cursor:pointer;font-family:'Archivo',sans-serif;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#9A958C;text-decoration:underline;text-underline-offset:4px;padding:6px 0}
.drawer-admin:hover{color:#F4F2EF}

/* ── hero ── */
.hero{display:grid;grid-template-columns:1.05fr .95fr;gap:40px;align-items:start;padding:40px 24px 64px}
@media (min-width:900px){.hero{padding:44px 56px 84px}}
.hero-l{display:flex;flex-direction:column}
.hero-l h1{margin:0}
.hero-over{font-family:'Archivo',sans-serif;font-weight:800;text-transform:lowercase;letter-spacing:-.03em;color:rgba(11,11,10,.10);font-size:clamp(26px,4.4vw,58px);line-height:.9;margin-bottom:-1.4vw}
.hero-main{font-size:clamp(54px,10.6vw,148px)}
.hero-meta{margin-top:26px;display:flex;flex-direction:column;gap:10px;max-width:38ch}
.hero-meta .label{line-height:1.7}
.hero-meta p{margin:0;font-size:15px;line-height:1.6;color:#4A463F}
.hero-cta{margin-top:28px;display:flex;gap:12px;flex-wrap:wrap}
.hero-hint{margin:16px 0 0;font-size:12px;line-height:1.55;color:var(--mute);max-width:36ch}
.btn{display:inline-flex;align-items:center;gap:10px;font-family:'Archivo',sans-serif;font-size:10px;font-weight:500;letter-spacing:.2em;text-transform:uppercase;padding:15px 26px;border:1px solid var(--ink);background:var(--ink);color:var(--paper);cursor:pointer;text-decoration:none;transition:background .25s,color .25s}
.btn:hover{background:transparent;color:var(--ink)}
.btn.ghost{background:transparent;color:var(--ink)}
.btn.ghost:hover{background:var(--ink);color:var(--paper)}
.hero-img{position:relative;margin:0}
.hero-img img{width:100%;height:clamp(360px,52vw,660px);object-fit:cover;object-position:center 22%}
.hero-img figcaption{display:flex;justify-content:space-between;gap:12px;padding-top:10px}

/* ── секции ── */
.sec{padding:64px 24px 72px;scroll-margin-top:12px}
@media (min-width:900px){.sec{padding:88px 56px 96px}}
.sec.tone{background:var(--paper-2)}
.sec-head{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;flex-wrap:wrap;padding:0 0 36px}
.sec-num{font-family:'Archivo',sans-serif;font-size:10px;letter-spacing:.2em;color:var(--accent)}
.sec-title{margin:8px 0 0;font-size:clamp(34px,5.6vw,64px)}
.sec-note{max-width:40ch;margin:0;font-size:14px;line-height:1.6;color:var(--mute)}

/* ── обо мне ── */
.about{display:grid;grid-template-columns:.8fr 1.2fr;gap:48px;align-items:start}
.about img{width:100%;aspect-ratio:4/5;object-fit:cover}
.about-body p{margin:0 0 18px;font-size:16px;line-height:1.7;color:#3C3932;max-width:56ch}
.factband{display:grid;grid-template-columns:repeat(3,1fr);background:var(--ink);color:#F4F2EF;margin-top:44px}
.factband .fact{padding:26px 26px 30px;border-right:1px solid #2A2825}
.factband .fact:last-child{border-right:0}
.factband .label{color:#8E8981}
.fact-v{font-family:'Archivo',sans-serif;font-weight:800;letter-spacing:-.04em;font-size:clamp(30px,3.6vw,46px);line-height:1;margin:14px 0 8px}
.fact-d{font-size:12px;color:#9A958C}

/* ── категории ── */
.cats{display:flex;gap:0;overflow-x:auto;border-top:1px solid var(--ink);border-bottom:1px solid var(--line);scrollbar-width:none}
.cats::-webkit-scrollbar{display:none}
.cat{background:none;border:0;cursor:pointer;padding:18px 0;margin-right:32px;white-space:nowrap;font-family:'Archivo',sans-serif;font-size:11px;font-weight:500;letter-spacing:.18em;text-transform:uppercase;color:var(--mute);border-bottom:1px solid transparent;transition:color .25s,border-color .25s}
.cat:last-child{margin-right:0}
.cat:hover{color:var(--ink)}
.cat[aria-selected="true"]{color:var(--ink);border-bottom-color:var(--ink)}
.cat .c-num{color:var(--accent);margin-right:8px}
.cat .c-count{color:var(--accent);margin-left:7px;font-size:9px;vertical-align:super}

/* ── съёмки ── */
.shoot{padding:44px 0 8px;border-bottom:1px solid var(--line-soft)}
.shoot:last-child{border-bottom:0}
.shoot-head{display:flex;align-items:baseline;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:22px}
.shoot-name{font-family:'Archivo',sans-serif;font-weight:600;font-size:clamp(19px,2.2vw,26px);letter-spacing:-.02em;margin:0}
.shoot-meta{display:flex;gap:20px;align-items:baseline}
.mosaic{display:flex;flex-direction:column;gap:14px}
.mrow{display:flex;gap:14px;align-items:flex-start}
.cell{position:relative;overflow:hidden;cursor:zoom-in;background:var(--paper-2);min-width:0;margin:0}
.cell img{width:100%;height:100%;object-fit:cover;object-position:center 30%;transition:transform .8s cubic-bezier(.2,.7,.2,1),filter .4s}
.cell:hover img{transform:scale(1.03)}
.cell::after{content:attr(data-n);position:absolute;left:10px;bottom:8px;font-family:'Archivo',sans-serif;font-size:9px;letter-spacing:.2em;color:#fff;opacity:0;transition:opacity .3s;text-shadow:0 1px 6px rgba(0,0,0,.5)}
.cell:hover::after{opacity:1}

/* ── до / после ── */
.ba-grid{display:grid;grid-template-columns:1fr 1fr;gap:32px}
.ba{border:1px solid var(--line);background:var(--paper-2)}
.ba-stage{position:relative;user-select:none;touch-action:none;overflow:hidden;aspect-ratio:3/4}
.ba-stage img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.ba-after{clip-path:inset(0 0 0 50%)}
.ba-line{position:absolute;top:0;bottom:0;left:50%;width:1px;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.25)}
.ba-knob{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:46px;height:46px;border-radius:50%;background:rgba(255,255,255,.92);color:#0B0B0A;display:flex;align-items:center;justify-content:center;font-family:'Archivo',sans-serif;font-size:12px;letter-spacing:.1em;cursor:ew-resize;box-shadow:0 6px 20px rgba(0,0,0,.2)}
.ba-tag{position:absolute;bottom:12px;font-family:'Archivo',sans-serif;font-size:9px;font-weight:500;letter-spacing:.2em;text-transform:uppercase;background:rgba(11,11,10,.75);color:#fff;padding:6px 10px}
.ba-tag.l{left:12px}
.ba-tag.r{right:12px}
.ba-cap{display:flex;justify-content:space-between;gap:12px;padding:14px 16px;border-top:1px solid var(--line)}

/* ── контакты: карточки ── */
.chgrid{display:grid;grid-template-columns:repeat(2,1fr);gap:1px;background:var(--line);border:1px solid var(--line)}
.chgrid a{position:relative;background:var(--paper-2);padding:28px 26px 30px;text-decoration:none;color:var(--ink);display:block;transition:background .25s}
.chgrid a:hover{background:var(--paper)}
.ch-name{display:block;font-family:'Archivo',sans-serif;font-weight:600;font-size:19px;letter-spacing:-.01em}
.ch-sub{display:block;font-size:12px;color:var(--mute);margin-top:7px}
.ch-arrow{position:absolute;top:24px;right:24px;font-family:'Archivo',sans-serif;font-size:15px;color:var(--accent)}

/* ── тест-ретушь ── */
.testgrid{display:grid;grid-template-columns:.85fr 1.15fr;gap:52px;align-items:start}
.steps{border-top:1px solid var(--line)}
/* белая карточка формы внутри чёрной секции: переопределяем переменные обратно на светлые */
.testform{background:#F4F2EF;color:#0B0B0A;padding:30px 28px 32px;--ink:#0B0B0A;--paper:#F4F2EF;--paper-2:#EAE7E2;--line:#D6D2CB;--line-soft:#E2DFD9;--mute:#7C776E;--accent:#A79E90}
.testform ::placeholder{color:#9A958C}
.testform select option{background:#F4F2EF;color:#0B0B0A}
@media (max-width:760px){.testform{padding:22px 18px 24px}}
.shoot-t{min-width:0}
.shoot-team{margin-top:8px;font-size:12px;line-height:1.6;color:var(--mute);max-width:80ch}
.step{display:flex;gap:16px;padding:20px 0;border-bottom:1px solid var(--line-soft)}
.step:last-child{border-bottom:0}
.step-t{font-family:'Archivo',sans-serif;font-weight:600;font-size:16px;letter-spacing:-.01em}
.step-d{font-size:13px;line-height:1.6;color:var(--mute);margin-top:6px;max-width:34ch}

/* ── форма ── */
.form{display:flex;flex-direction:column;gap:14px}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.field{display:flex;flex-direction:column;gap:7px}
.field > span{font-family:'Archivo',sans-serif;font-size:9px;font-weight:500;letter-spacing:.2em;text-transform:uppercase;color:var(--mute)}
input,select,textarea{font-family:'Inter',sans-serif;font-size:14px;color:var(--ink);background:transparent;border:0;border-bottom:1px solid var(--line);padding:11px 2px;outline:none;transition:border-color .25s;border-radius:0;-webkit-appearance:none;appearance:none}
input:focus,select:focus,textarea:focus{border-color:var(--ink)}
select{cursor:pointer}
textarea{resize:vertical;min-height:88px;line-height:1.55}
.drop{border:1px dashed var(--line);padding:16px;display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;font-size:13px;color:var(--mute);transition:border-color .25s,background .25s}
.drop.hot{border-color:var(--ink);background:var(--paper-2)}
.pick{font-family:'Archivo',sans-serif;font-size:9px;font-weight:500;letter-spacing:.2em;text-transform:uppercase;border:1px solid var(--ink);padding:9px 14px;cursor:pointer;color:var(--ink)}
.thumbs{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;width:100%}
.thumb{position:relative;width:62px;height:62px}
.thumb img{width:100%;height:100%;object-fit:cover}
.thumb button{position:absolute;top:-7px;right:-7px;width:20px;height:20px;border-radius:50%;border:0;background:var(--ink);color:var(--paper);font-size:10px;cursor:pointer;line-height:1}
.note{font-size:12px;color:var(--mute);line-height:1.55}
.ok{border:1px solid var(--ink);padding:22px;font-size:14px;line-height:1.6}

/* ── подвал ── */
footer,.site-footer{border-top:1px solid #2A2825;padding:26px 24px 34px;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
@media (min-width:900px){footer,.site-footer{padding:26px 56px 40px}}

/* ── мобильная кнопка тест-ретуши ── */
.mob-cta{display:none}

/* ── просмотр фото ── */
.lb{position:fixed;inset:0;z-index:100;background:rgba(11,11,10,.94);display:none;align-items:center;justify-content:center;padding:28px}
.lb.on{display:flex}
.lb img{max-width:92vw;max-height:82vh;object-fit:contain}
.lb-x,.lb-p,.lb-n{position:absolute;background:none;border:0;color:#EDEBE6;cursor:pointer;font-family:'Archivo',sans-serif;letter-spacing:.2em;font-size:13px}
.lb-x{top:22px;right:26px;font-size:20px}
.lb-p{left:18px;top:50%;transform:translateY(-50%);font-size:26px}
.lb-n{right:18px;top:50%;transform:translateY(-50%);font-size:26px}
.lb-cap{position:absolute;bottom:24px;left:0;right:0;text-align:center;font-family:'Archivo',sans-serif;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#9A958C}

/* заглушки, пока фото не загружены */
.hero-empty{width:100%;height:100%;min-height:340px;background:var(--paper-2);border:1px solid var(--line-soft);display:flex;align-items:center;justify-content:center;text-align:center;padding:24px}
.about-empty{background:var(--paper-2);border:1px solid var(--line-soft);min-height:420px}

/* ── планшет ── */
@media (max-width:860px){
  .hero{grid-template-columns:1fr;gap:28px}
  .about{grid-template-columns:1fr;gap:26px}
  .ba-grid{grid-template-columns:1fr;gap:20px}
  .chgrid{grid-template-columns:1fr}
  .testgrid{grid-template-columns:1fr;gap:34px}
  .form-row{grid-template-columns:1fr}
  .factband{grid-template-columns:1fr}
  .factband .fact{border-right:0;border-bottom:1px solid #2A2825;padding:20px 22px 24px}
  .factband .fact:last-child{border-bottom:0}
}

/* ── телефон ── */
@media (max-width:760px){
  .navlinks{display:none}
  .nav-burger{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;width:40px;height:40px;border:1px solid var(--ink);background:transparent;cursor:pointer}
  .nav-burger span{display:block;width:16px;height:1px;background:var(--ink)}
  .hero{padding-top:36px;padding-bottom:44px}
  .hero-img{display:none}          /* большое фото на телефоне убрано */
  .hero-cta{gap:10px}
  .hero-cta .btn{flex:1 1 100%;justify-content:center}
  .sec{padding:52px 20px 58px}
  .sec-head{padding-bottom:26px}
  .mrow{flex-wrap:wrap;gap:10px}
  .cell{flex:1 1 calc(50% - 5px) !important;height:56vw !important}
  .mrow.single .cell{flex:1 1 100% !important;height:118vw !important;max-height:560px;max-width:100% !important}
  .site-footer{padding-bottom:96px}
  .mob-cta{display:flex;position:fixed;left:14px;right:14px;bottom:14px;z-index:88;align-items:center;justify-content:center;gap:10px;padding:16px;background:#0B0B0A;color:#F4F2EF;text-decoration:none;font-family:'Archivo',sans-serif;font-size:10px;font-weight:500;letter-spacing:.2em;text-transform:uppercase;box-shadow:0 10px 30px rgba(11,11,10,.25);transform:translateY(140%);transition:transform .35s cubic-bezier(.2,.7,.2,1)}
  .mob-cta.on{transform:translateY(0)}
}
`;

/* ═════════════════ СТИЛИ CRM ═════════════════ */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;800&family=Inter:wght@300;400;500&display=swap');

:root{
  --ink:#0B0B0A;
  --paper:#EDEBE6;
  --paper-2:#F6F5F2;
  --line:#CFCBC2;
  --line-soft:#DEDBD4;
  --mute:#7C776E;
  --accent:#A79E90;
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:'Inter',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.app{min-height:100vh;background:var(--paper);color:var(--ink);overflow-x:hidden}
img{max-width:100%}
input,select,textarea{max-width:100%}

.mono-label{font-family:'Archivo',sans-serif;font-size:10px;font-weight:500;letter-spacing:.22em;text-transform:uppercase;color:var(--mute)}
.display{font-family:'Archivo',sans-serif;font-weight:800;letter-spacing:-.035em;line-height:.86;text-transform:lowercase}

.strip{background:var(--ink);color:var(--paper);display:flex;justify-content:space-between;gap:24px;padding:9px 24px;overflow:hidden;white-space:nowrap}
.strip span{font-family:'Archivo',sans-serif;font-size:10px;font-weight:500;letter-spacing:.22em;text-transform:uppercase;color:#B9B4AA}
.strip span:first-child{color:var(--paper)}

header { display:flex; align-items:center; justify-content:space-between; gap:24px; padding:12px 24px; border-bottom:1px solid var(--ink); }
.logo{display:flex;align-items:center;gap:12px}
.logo svg{display:block}
.logo-word{font-family:'Archivo',sans-serif;font-weight:800;font-size:19px;letter-spacing:.16em;text-transform:uppercase}
.logo-sub{font-family:'Archivo',sans-serif;font-weight:400;font-size:19px;letter-spacing:.16em;text-transform:uppercase;color:var(--mute)}
.header-meta{display:flex;gap:28px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
.logout{appearance:none;background:none;border:1px solid var(--ink);cursor:pointer;color:var(--ink);font-family:'Archivo',sans-serif;font-size:10px;font-weight:500;letter-spacing:.18em;text-transform:uppercase;padding:8px 12px;white-space:nowrap}
.logout:hover{background:var(--ink);color:var(--paper)}

.hero{padding:30px 24px 20px}
.hero-over{font-family:'Archivo',sans-serif;font-weight:800;text-transform:lowercase;letter-spacing:-.01em;color:rgba(11,11,10,.08);font-size:clamp(32px, 6vw, 56px);line-height:.9;margin:0 0 -1.8vw 2px;position:relative;z-index:1}
.hero-main{margin:0;font-size:clamp(40px, 8vw, 76px);position:relative;z-index:2}
.hero-rule{display:flex;justify-content:space-between;align-items:baseline;gap:16px;border-top:1px solid var(--ink);margin-top:20px;padding-top:12px}

.sec-title{margin:0;font-size:clamp(28px, 4.5vw, 42px)}
.sec-note{max-width:40ch;margin:8px 0 0 0;font-size:13px;line-height:1.55;color:var(--mute)}

nav.tabs{display:flex;overflow-x:auto;border-bottom:1px solid var(--line);padding:0 24px;scrollbar-width:none}
nav.tabs::-webkit-scrollbar{display:none}
.tab{appearance:none;background:none;border:0;cursor:pointer;font-family:'Archivo',sans-serif;font-size:11px;font-weight:500;letter-spacing:.18em;text-transform:uppercase;color:var(--mute);white-space:nowrap;padding:16px 0;margin-right:34px;border-bottom:1px solid transparent;transition:color .25s ease,border-color .25s ease}
.tab:last-child{margin-right:0}
.tab:hover{color:var(--ink)}
.tab[aria-selected="true"]{color:var(--ink);border-bottom-color:var(--ink)}
.tab .num{color:var(--accent);margin-right:8px}

.cms-tabs{display:flex;flex-wrap:wrap;gap:10px;border-bottom:1px solid var(--line-soft);padding-bottom:16px;margin-bottom:32px}
.cms-tabs .badge{white-space:nowrap}
.cms-2col{display:grid;grid-template-columns:1fr 1fr;gap:40px}
.cms-2col.tight{gap:16px}
.cms-search{display:grid;grid-template-columns:1fr 2fr;gap:24px}
.cms-2col>*,.cms-search>*{min-width:0}
.shoot-row{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
.ph-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:12px}
.ph{position:relative;border:1px solid var(--line-soft);background:var(--paper);min-width:0}
.ph.is-cover{border-color:var(--ink)}
.ph img{display:block;width:100%;aspect-ratio:3/4;object-fit:cover}
.ph-acts{display:flex;justify-content:space-between;gap:8px;padding:6px 8px;border-top:1px solid var(--line-soft)}
.ph-acts button{appearance:none;background:none;border:0;cursor:pointer;color:var(--mute);font-family:'Archivo',sans-serif;font-size:9px;letter-spacing:.14em;text-transform:uppercase;padding:2px 0;text-decoration:underline}
.ph-acts button:hover{color:var(--ink)}
.ph-tag{font-family:'Archivo',sans-serif;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink)}
.modal-card{background:var(--paper);width:min(500px,calc(100vw - 28px));max-height:88vh;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:32px;display:flex;flex-direction:column;gap:16px;border:1px solid var(--line-soft)}

main{padding:0 24px 96px}
.sheet{background:var(--paper-2);border:1px solid var(--line-soft);border-top:0;padding:44px 32px 40px}
.sec-head{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:34px}

.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;min-width:640px}
thead th{font-family:'Archivo',sans-serif;font-size:10px;font-weight:500;letter-spacing:.2em;text-transform:uppercase;color:var(--mute);text-align:left;padding:0 12px 12px 0;border-bottom:1px solid var(--ink)}
thead th:last-child,td:last-child{text-align:right;padding-right:0}
tbody tr{border-bottom:1px solid var(--line-soft);transition:background .2s ease}
tbody tr:hover{background:#EFEDE8}
td{padding:22px 12px 22px 0;font-size:14px;vertical-align:middle}
.idx{font-family:'Archivo',sans-serif;font-size:11px;letter-spacing:.1em;color:var(--accent);width:44px}
.handle{font-family:'Archivo',sans-serif;font-weight:600;font-size:15px;letter-spacing:-.01em}
.niche{color:var(--mute)}
.badge{display:inline-block;font-family:'Archivo',sans-serif;font-size:10px;font-weight:500;letter-spacing:.18em;text-transform:uppercase;padding:6px 12px;border:1px solid var(--ink)}
.badge.solid{background:var(--ink);color:var(--paper)}
.open{appearance:none;background:none;border:0;cursor:pointer;padding:0 0 2px;font-family:'Archivo',sans-serif;font-size:10px;font-weight:500;letter-spacing:.18em;text-transform:uppercase;border-bottom:1px solid var(--ink);color:var(--ink)}
.open:hover{color:var(--mute);border-color:var(--mute)}

.stats{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid var(--ink)}
.stat{padding:28px 24px 30px;border-right:1px solid var(--line-soft)}
.stat:first-child{padding-left:0}
.stat:last-child{border-right:0}
.stat-val{font-family:'Archivo',sans-serif;font-weight:800;letter-spacing:-.04em;font-size:clamp(32px, 4vw, 48px);line-height:1;margin:18px 0 10px}
.stat-delta{font-size:12px;color:var(--mute)}

.module{display:grid;grid-template-columns:1.1fr .9fr;gap:40px;align-items:start}
.module p{margin:0;font-size:15px;line-height:1.65;color:#4A463F;max-width:52ch}
.spec{border-top:1px solid var(--ink)}
.spec div{display:flex;justify-content:space-between;gap:16px;padding:13px 0;border-bottom:1px solid var(--line-soft);font-size:12px}
.spec b{font-family:'Archivo',sans-serif;font-weight:500;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--mute)}

footer{display:flex;justify-content:space-between;gap:16px;padding:16px 24px;border-top:1px solid var(--ink)}

@media (min-width:900px){
  .strip,header,.hero,nav.tabs,main,footer{padding-left:56px;padding-right:56px}
  .sheet{padding:64px 56px 56px}
  .stat{padding-left:32px}
}
@media (max-width:980px){
  .cms-2col,.cms-search{grid-template-columns:1fr;gap:22px}
}
@media (max-width:768px){
  header{flex-wrap:wrap;gap:12px;padding:12px 20px}
  .header-meta .mono-label{display:none}
  .strip span:nth-child(2){display:none}
  .modal-card{padding:22px 18px;max-height:92vh}
  .ph-grid{grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:10px}
  nav.tabs{padding:0 20px}
  main{padding:0 20px 80px}
  .module{grid-template-columns:1fr;gap:28px}
  .stats{grid-template-columns:1fr}
  .stat{border-right:0;border-bottom:1px solid var(--line-soft);padding:22px 0}
  .stat:last-child{border-bottom:0}
  .sheet{padding:32px 20px}
}

/* --- СТИЛИ ЖУРНАЛЬНОЙ СЕТКИ И МОБИЛОК --- */
.shoot{padding:20px 0 8px;}
.shoot-head{display:flex;align-items:baseline;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:22px}
.shoot-name{font-family:'Archivo',sans-serif;font-weight:600;font-size:clamp(19px,2.2vw,26px);letter-spacing:-.02em;margin:0; text-transform:uppercase;}
.shoot-meta{display:flex;gap:20px;align-items:baseline}
.mosaic{display:flex;flex-direction:column;gap:14px}
.mrow{display:flex;gap:14px;align-items:flex-start}
.cell{position:relative;overflow:hidden;cursor:zoom-in;background:var(--paper-2);min-width:0; margin:0;}
.cell img{width:100%;height:100%;object-fit:cover;object-position:center 30%;transition:transform .8s cubic-bezier(.2,.7,.2,1),filter .4s}
.cell:hover img{transform:scale(1.03)}
.cell::after{content:attr(data-n);position:absolute;left:10px;bottom:8px;font-family:'Archivo',sans-serif;font-size:9px;letter-spacing:.2em;color:#fff;opacity:0;transition:opacity .3s;text-shadow:0 1px 6px rgba(0,0,0,.5)}
.cell:hover::after{opacity:1}

/* --- СТИЛИ ЛАЙТБОКСА --- */
.lb{position:fixed;inset:0;z-index:9999;background:rgba(11,11,10,.94);display:none;align-items:center;justify-content:center;padding:28px}
.lb.on{display:flex}
.lb img{max-width:92vw;max-height:82vh;object-fit:contain; user-select: none;}
.lb-x,.lb-p,.lb-n{position:absolute;background:none;border:0;color:#EDEBE6;cursor:pointer;font-family:'Archivo',sans-serif;letter-spacing:.2em;font-size:13px; padding:20px;}
.lb-x{top:10px;right:10px;font-size:24px}
.lb-p{left:10px;top:50%;transform:translateY(-50%);font-size:32px}
.lb-n{right:10px;top:50%;transform:translateY(-50%);font-size:32px}
.lb-cap{position:absolute;bottom:24px;left:0;right:0;text-align:center;font-family:'Archivo',sans-serif;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#9A958C}

/* --- МОБИЛЬНАЯ АДАПТАЦИЯ --- */
@media (max-width:760px){
  .sec-portfolio { padding: 40px 24px !important; }
  .mrow{flex-wrap:wrap;gap:10px}
  .cell{flex:1 1 calc(50% - 5px) !important;height:56vw !important}
  .mrow.single .cell{flex:1 1 100% !important;height:118vw !important;max-height:560px;max-width:100% !important}
  .hero-main { font-size: 14vw !important; }
}
  
`;
