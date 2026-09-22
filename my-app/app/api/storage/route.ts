/* ──────────────────────────────────────────────────────────────────────────
   Облачное хранилище съёмок: my-app/app/api/storage/route.ts
   Адаптировано для Yandex Cloud Object Storage
   ────────────────────────────────────────────────────────────────────────── */

export const runtime = 'edge';

const ACCESS_KEY = process.env.R2_ACCESS_KEY_ID || '';
const SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const BUCKET = process.env.R2_BUCKET || '';
const OWNER_EMAIL = (process.env.STORAGE_OWNER_EMAIL || '').toLowerCase();
const FIREBASE_KEY = process.env.FIREBASE_WEB_API_KEY || '';

const HOST = 'storage.yandexcloud.net';
const REGION = 'ru-central1';
const SERVICE = 's3';

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(data)));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
}

function uriEncode(str: string, encodeSlash = true): string {
  let out = '';
  for (const ch of str) {
    const isUnreserved = /[A-Za-z0-9\-._~]/.test(ch);
    if (isUnreserved) out += ch;
    else if (ch === '/') out += encodeSlash ? '%2F' : '/';
    else {
      for (const byte of enc.encode(ch)) out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

async function presign(
  method: 'GET' | 'PUT' | 'DELETE',
  key: string,
  opts: { expires?: number; query?: Record<string, string> } = {}
): Promise<string> {
  const expires = opts.expires || 900;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

  const canonicalUri = '/' + uriEncode(BUCKET, false) + (key ? '/' + uriEncode(key, false) : '');

  const params: Record<string, string> = {
    ...(opts.query || {}),
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${ACCESS_KEY}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
  };

  const canonicalQuery = Object.keys(params)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(params[k])}`)
    .join('&');

  const canonicalRequest = [method, canonicalUri, canonicalQuery, `host:${HOST}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');

  let signingKey: ArrayBuffer | Uint8Array = enc.encode('AWS4' + SECRET_KEY);
  for (const part of [dateStamp, REGION, SERVICE, 'aws4_request']) signingKey = await hmac(signingKey, part);
  const signature = hex(await hmac(signingKey, stringToSign));

  return `https://${HOST}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

async function checkOwner(req: Request): Promise<string | null> {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return 'Нужно войти в дашборд';
  if (!FIREBASE_KEY || !OWNER_EMAIL) return 'На сервере не заданы FIREBASE_WEB_API_KEY и STORAGE_OWNER_EMAIL';
  try {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
    });
    const data = await r.json();
    const email = (data?.users?.[0]?.email || '').toLowerCase();
    if (!email) return 'Сессия истекла — зайди в дашборд заново';
    if (email !== OWNER_EMAIL) return 'Этот аккаунт не владелец хранилища';
    return null;
  } catch {
    return 'Не удалось проверить вход';
  }
}

function missingConfig(): string | null {
  const miss = [
    !ACCESS_KEY && 'R2_ACCESS_KEY_ID',
    !SECRET_KEY && 'R2_SECRET_ACCESS_KEY',
    !BUCKET && 'R2_BUCKET',
  ].filter(Boolean);
  return miss.length ? `В настройках Vercel не заданы: ${miss.join(', ')}` : null;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

function parseList(xml: string) {
  const folders: string[] = [];
  for (const m of xml.matchAll(/<CommonPrefixes><Prefix>([^<]*)<\/Prefix><\/CommonPrefixes>/g)) folders.push(decodeXml(m[1]));

  const files: { key: string; size: number; modified: string }[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const chunk = m[1];
    const key = decodeXml((chunk.match(/<Key>([^<]*)<\/Key>/) || [, ''])[1]);
    const size = Number((chunk.match(/<Size>(\d+)<\/Size>/) || [, '0'])[1]);
    const modified = (chunk.match(/<LastModified>([^<]*)<\/LastModified>/) || [, ''])[1];
    if (key && !key.endsWith('/.keep')) files.push({ key, size, modified });
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  return { folders, files, truncated };
}

function decodeXml(s: string) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

export async function GET(req: Request) {
  const cfg = missingConfig();
  if (cfg) return json({ error: cfg }, 500);
  const deny = await checkOwner(req);
  if (deny) return json({ error: deny }, 401);

  const url = new URL(req.url);
  const prefix = url.searchParams.get('prefix') || '';

  const listUrl = await presign('GET', '', {
    expires: 120,
    query: { 'list-type': '2', prefix, delimiter: '/', 'max-keys': '1000' },
  });
  const r = await fetch(listUrl);
  const xml = await r.text();
  if (!r.ok) return json({ error: `Yandex ответил ${r.status}. ${xml.slice(0, 200)}` }, 502);

  const { folders, files, truncated } = parseList(xml);
  return json({ prefix, folders, files, truncated });
}

export async function POST(req: Request) {
  const cfg = missingConfig();
  if (cfg) return json({ error: cfg }, 500);
  const deny = await checkOwner(req);
  if (deny) return json({ error: deny }, 401);

  let body: { action?: string; key?: string; name?: string } = {};
  try { body = await req.json(); } catch { return json({ error: 'Некорректный запрос' }, 400); }

  const action = body.action || '';
  const key = (body.key || '').replace(/^\/+/, '');

  if (action === 'upload-url') {
    if (!key) return json({ error: 'Не указано имя файла' }, 400);
    return json({ url: await presign('PUT', key, { expires: 3600 }) });
  }

  if (action === 'download-url') {
    if (!key) return json({ error: 'Не указан файл' }, 400);
    const name = (body.name || key.split('/').pop() || 'file').replace(/["\\]/g, '');
    return json({
      url: await presign('GET', key, {
        expires: 900,
        query: { 'response-content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` },
      }),
    });
  }

  if (action === 'view-url') {
    if (!key) return json({ error: 'Не указан файл' }, 400);
    return json({ url: await presign('GET', key, { expires: 900 }) });
  }

  if (action === 'delete') {
    if (!key) return json({ error: 'Не указан файл' }, 400);
    const r = await fetch(await presign('DELETE', key, { expires: 120 }), { method: 'DELETE' });
    if (!r.ok && r.status !== 204) return json({ error: `Yandex ответил ${r.status}` }, 502);
    return json({ ok: true });
  }

  if (action === 'make-folder') {
    const folder = key.endsWith('/') ? key : key + '/';
    const r = await fetch(await presign('PUT', folder + '.keep', { expires: 120 }), { method: 'PUT', body: '' });
    if (!r.ok) return json({ error: `Yandex ответил ${r.status}` }, 502);
    return json({ ok: true });
  }

  return json({ error: 'Неизвестное действие' }, 400);
}

