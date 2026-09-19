require('dotenv').config();

// ГЛОБАЛЬНЫЙ ПРОКСИ (ПОРТ 10809)
process.env.HTTP_PROXY = 'http://127.0.0.1:10809';
process.env.HTTPS_PROXY = 'http://127.0.0.1:10809';

const express = require('express');
const cors = require('cors');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const OpenAI = require('openai');
const { ApifyClient } = require('apify-client');
const { ProxyAgent, fetch: undiciFetch } = require('undici');

const localProxy = new ProxyAgent('http://127.0.0.1:10809');
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); // ДОБАВЛЕНО: без этого base64-фото из загрузки/вставки будут падать с 413 (лимит по умолчанию — 100kb)
// Увеличиваем лимит, так как фото приходят в base64 (до 6 шт по ~4 МБ)[cite: 3, 5]
app.use(express.json({ limit: '40mb' })); 
app.use(cors());

// Подключаем маршрут для Telegram-бота
app.use(require('./telegram-lead-endpoint'));
const PORT = 5000;

const serviceAccount = require('./firebase-key.json');
initializeApp({
    credential: cert(serviceAccount)
});
const db = getFirestore();

// Провайдер ИИ переключается переменной AI_PROVIDER в .env: proxyapi | openai | gemini.
// proxyapi — как было раньше (нужен баланс на api.proxyapi.ru);
// openai — напрямую в OpenAI по ключу sk-... ;
// gemini — Google AI Studio, есть бесплатный тариф, тоже умеет смотреть фото.
const AI_PROVIDER = (process.env.AI_PROVIDER || 'proxyapi').toLowerCase();
const AI_PROVIDERS = {
    proxyapi: { baseURL: "https://api.proxyapi.ru/openai/v1", key: 'OPENAI_API_KEY', model: "gpt-4o" },
    openai:   { baseURL: undefined,                            key: 'OPENAI_API_KEY', model: "gpt-4o" },
    gemini:   { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", key: 'GEMINI_API_KEY', model: "gemini-2.5-flash" }
};
const AI_CONF = AI_PROVIDERS[AI_PROVIDER] || AI_PROVIDERS.proxyapi;
const AI_MODEL = process.env.AI_MODEL || AI_CONF.model;

const openai = new OpenAI({
    apiKey: process.env[AI_CONF.key],
    baseURL: AI_CONF.baseURL,
});
console.log(`[⚙] ИИ: провайдер ${AI_PROVIDER}, модель ${AI_MODEL}${process.env[AI_CONF.key] ? '' : ' — ВНИМАНИЕ: ключ ' + AI_CONF.key + ' не найден в .env'}`);

// Превращает техническую ошибку ИИ в понятную фразу для интерфейса
function aiErrorText(err) {
    const msg = err?.message || 'неизвестная ошибка';
    if (/insufficient balance|insufficient_quota|402/i.test(msg)) {
        return AI_PROVIDER === 'proxyapi'
            ? 'Закончился баланс на api.proxyapi.ru — пополни счёт или переключи AI_PROVIDER на gemini в файле .env'
            : `У провайдера ${AI_PROVIDER} закончился баланс или квота — пополни счёт либо смени AI_PROVIDER в .env`;
    }
    if (/401|invalid api key|api key not valid/i.test(msg)) return `Провайдер ${AI_PROVIDER} не принял ключ — проверь ${AI_CONF.key} в .env`;
    if (/429|rate limit|quota/i.test(msg)) return `Провайдер ${AI_PROVIDER} просит подождать: превышен лимит запросов в минуту`;
    if (/model|not found|404/i.test(msg)) return `Модель ${AI_MODEL} недоступна у провайдера ${AI_PROVIDER} — поправь AI_MODEL в .env`;
    return `Сбой ИИ: ${msg}`;
}

const apifyClient = new ApifyClient({
    token: process.env.APIFY_TOKEN,     
});

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Таймаут: "${label}" не ответил за ${Math.round(ms / 1000)} сек.`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function withRetries(fn, { attempts = 3, timeoutMs = 30000, delayMs = 5000, label = '' } = {}) {
    let lastError;
    for (let i = 1; i <= attempts; i++) {
        try {
            return await withTimeout(fn(), timeoutMs, label);
        } catch (e) {
            lastError = e;
            console.log(`[!] Попытка ${i}/${attempts} не удалась (${label}): ${e.message}`);
            if (i < attempts) await new Promise(r => setTimeout(r, delayMs));
        }
    }
    throw lastError;
}

async function runActorSafe(actorName, input, maxWaitSecs) {
    console.log(`[⏳] Запускаем актор ${actorName}...`);
    const run = await withRetries(
        () => apifyClient.actor(actorName).start(input),
        { attempts: 3, timeoutMs: 60000, delayMs: 5000, label: `запуск ${actorName}` }
    );
    console.log(`[⏳] ${actorName} запущен, runId: ${run.id}. Опрашиваем статус...`);

    let elapsed = 0;
    while (elapsed < maxWaitSecs) {
        const runInfo = await withRetries(
            () => apifyClient.run(run.id).get(),
            { attempts: 3, timeoutMs: 30000, delayMs: 3000, label: `опрос статуса ${actorName}` }
        );

        if (runInfo.status === 'SUCCEEDED') {
            console.log(`[✅] ${actorName} завершён успешно.`);
            return runInfo;
        }
        if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(runInfo.status)) {
            throw new Error(`Apify прервал работу актора ${actorName} со статусом: ${runInfo.status}`);
        }

        await new Promise(r => setTimeout(r, 5000));
        elapsed += 5;
    }
    throw new Error(`Превышен лимит времени ожидания (${maxWaitSecs} сек) для актора ${actorName}.`);
}

async function getDatasetItemsSafe(datasetId, label) {
    console.log(`[⏳] Забираем результаты датасета (${label})...`);
    const items = await withRetries(
        async () => (await apifyClient.dataset(datasetId).listItems()).items,
        { attempts: 3, timeoutMs: 120000, delayMs: 5000, label: `получение датасета (${label})` }
    );
    console.log(`[✅] Датасет получен (${label}): ${items.length} записей`);
    return items;
}

// ДОБАВЛЕНО: общий хелпер скачивания фото (используется и для эталонов, и для фото-референсов, и для кандидатов)
async function downloadImageAsDataUri(url) {
    try {
        const response = await undiciFetch(url, {
            dispatcher: localProxy,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
                'Referer': 'https://www.instagram.com/',
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
            }
        });
        if (response.ok) {
            const buffer = await response.arrayBuffer();
            return `data:image/jpeg;base64,${Buffer.from(buffer).toString('base64')}`;
        }
        console.log(`[-] Не удалось скачать фото: ${url} (${response.status})`);
        return null;
    } catch (e) {
        console.log(`[!] Ошибка сети при скачивании фото: ${url}`);
        return null;
    }
}

app.post('/api/analyze', async (req, res) => {
    try {
        const { username, bio } = req.body;
        const prompt = `Ты ассистент ретушера. Проанализируй шапку профиля фотографа: "${bio}".
        1. Определи его нишу.
        2. Напиши короткое холодное письмо.`;

        const completion = await openai.chat.completions.create({
            messages: [{ role: "user", content: prompt }],
            model: AI_MODEL,
        });

        const aiResponse = completion.choices[0].message.content;
        await db.collection('leads').add({ username, niche: 'AI Analyzed', status: 'New', ai_analysis: aiResponse, date: new Date().toISOString() });

        res.json({ success: true, message: 'Профиль проанализирован!', data: aiResponse });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/add-lead', async (req, res) => res.send('Ок'));
app.get('/test-scraper', async (req, res) => res.send('Ок'));

app.post('/api/smart-search', async (req, res) => {
    try {
        // ИСПРАВЛЕНИЕ: searchQuery (хештеги) убраны полностью. Добавлено referencePhotos.
        const { visualPrompt, selectedStyle, referenceProfile, referencePhotos, rejectedBios, existingUsernames = [] } = req.body;

        const refProfilesArray = (referenceProfile || '').split(',').map(p => p.replace('@', '').trim()).filter(p => p.length > 0);

        // referencePhotos может прийти и массивом, и текстом (строка с переносами/запятыми) — поддерживаем оба варианта
        const refPhotoUrlsInput = Array.isArray(referencePhotos)
            ? referencePhotos.map(u => (u || '').trim()).filter(Boolean)
            : (referencePhotos || '').split(/[\n,]/).map(u => u.trim()).filter(Boolean);

        // ИСПРАВЛЕНИЕ: хештегов больше нет вообще — без профиля-примера искать не из чего
        if (refProfilesArray.length === 0) {
            return res.json({ success: false, error: "Укажи хотя бы один профиль-пример — без него не из чего искать похожих кандидатов" });
        }

        console.log(`\n========================================`);
        console.log(`[🚀 ШАГ 1] Ищем профили, похожие на: ${refProfilesArray.join(', ')}...`);

        const candidateUsernames = new Set();

        // Ищем похожие профили. Основной актор — memo23; у thenetaji исчерпан бесплатный лимит
        // в 100 результатов (запуск завершается успешно, но датасет пустой), поэтому он теперь запасной.
        const SIMILAR_SOURCES = [
            {
                actor: "memo23/instagram-similar-profiles-scraper",
                input: {
                    usernames: refProfilesArray,
                    maxSimilarPerAccount: 40,
                    enrichProfiles: false,
                    // глубина 2: берём и похожих на похожих — иначе пул слишком мал и после отсева
                    // журналов и пабликов остаётся всего несколько живых фотографов
                    depth: 2,
                    maxTotalProfiles: 120
                }
            },
            {
                actor: "thenetaji/instagram-related-user-scraper",
                input: {
                    username: refProfilesArray,
                    enrichProfile: false,
                    maxItem: 80
                }
            }
        ];

        for (const src of SIMILAR_SOURCES) {
            try {
                const runSimilar = await runActorSafe(src.actor, src.input, 240);
                const similarItems = await getDatasetItemsSafe(runSimilar.defaultDatasetId, 'похожие профили');
                similarItems.forEach(it => {
                    const uname = it.username || it.inputs;
                    // исключаем сами профили-примеры: они и так есть у неё
                    if (uname && !refProfilesArray.some(r => r.toLowerCase() === String(uname).toLowerCase())) {
                        candidateUsernames.add(uname);
                    }
                });
                console.log(`[🚀 ШАГ 1] ${src.actor}: похожих профилей ${candidateUsernames.size}`);
                if (candidateUsernames.size > 0) break;
                console.log(`[!] ${src.actor} вернул пустой список — возможно, исчерпан бесплатный лимит актора. Пробую следующий источник.`);
            } catch (e) {
                console.log(`[!] ${src.actor} не ответил: ${e.message}`);
            }
        }

        if (candidateUsernames.size === 0) {
            return res.json({
                success: false,
                error: "Сервисы поиска похожих профилей вернули пустой список. Обычно это исчерпанный бесплатный лимит актора в Apify: открой Apify → Billing и посмотри остаток, либо смени актор поиска."
            });
        }

        const allUsernames = [...candidateUsernames];
        const existingClean = existingUsernames.map(u => u.replace('@', '').toLowerCase());
        const uniqueNewUsernames = allUsernames.filter(u => !existingClean.includes(u.toLowerCase()));
        const usernamesToScrape = uniqueNewUsernames.slice(0, 80);

        if (usernamesToScrape.length === 0) return res.json({ success: true, data: [] });

        console.log(`[🚀 ШАГ 2] Отправляем на скрапинг ${usernamesToScrape.length} новых профилей...`);
        const runProfiles = await runActorSafe("apify/instagram-profile-scraper", {
            "usernames": usernamesToScrape,
            "resultsLimit": usernamesToScrape.length
        }, 400);
        const profiles = await getDatasetItemsSafe(runProfiles.defaultDatasetId, 'профили кандидатов');

        let antiPatternText = "";
        if (rejectedBios && Array.isArray(rejectedBios) && rejectedBios.length > 0) {
            antiPatternText = `\nЧЕРНЫЙ СПИСОК (Анти-примеры, не предлагай похожих): ${rejectedBios.join(' | ')}\n`;
        }

        // === Собираем эталонный визуальный сигнал из ДВУХ источников: аккаунты-примеры + прямые фото-референсы ===
        let referenceBios = [];
        let referenceImageDataUris = [];

        console.log(`[📸] Скачиваем визуал эталонных аккаунтов: ${refProfilesArray.join(', ')}...`);
        try {
            const runRef = await runActorSafe("apify/instagram-profile-scraper", {
                "usernames": refProfilesArray,
                "resultsLimit": refProfilesArray.length
            }, 180);
            const refItems = await getDatasetItemsSafe(runRef.defaultDatasetId, 'данные эталонов');

            for (const refProfile of refItems) {
                if (!refProfile) continue;
                if (refProfile.biography) referenceBios.push(`@${refProfile.username}: "${refProfile.biography}"`);

                const refPosts = (refProfile.latestPosts || []).slice(0, 3);
                let refUrls = refPosts.map(p => p.displayUrl).filter(Boolean);
                if (refUrls.length === 0 && refProfile.profilePicUrlHD) refUrls = [refProfile.profilePicUrlHD];

                for (const url of refUrls) {
                    const dataUri = await downloadImageAsDataUri(url);
                    if (dataUri) referenceImageDataUris.push(dataUri);
                }
            }
            console.log(`[+] Собрано ${referenceImageDataUris.length} фото из ${refItems.length} эталонных аккаунтов`);
        } catch (e) {
            console.log('Не удалось получить эталонные профили:', e.message);
        }

        // ДОБАВЛЕНО: прямые фото-референсы — теперь могут прийти либо как готовый base64
        // (загружено через файл/Ctrl+V на фронте — используем как есть, ничего не качаем),
        // либо как обычная ссылка (резервный вариант — тогда качаем как раньше)
        if (refPhotoUrlsInput.length > 0) {
            console.log(`[📸] Обрабатываем ${refPhotoUrlsInput.length} фото-референсов (загруженные + ссылки)...`);
            for (const item of refPhotoUrlsInput) {
                if (item.startsWith('data:image')) {
                    referenceImageDataUris.push(item);
                } else {
                    const dataUri = await downloadImageAsDataUri(item);
                    if (dataUri) referenceImageDataUris.push(dataUri);
                }
            }
            console.log(`[+] Итого эталонных фото (аккаунты + референсы): ${referenceImageDataUris.length}`);
        }

        const referenceBlock = `\nЭТАЛОН ДЛЯ СРАВНЕНИЯ: заказчик ориентируется на стиль аккаунтов ${refProfilesArray.join(', ')}${referenceBios.length ? ` (${referenceBios.join('; ')})` : ''}${refPhotoUrlsInput.length ? ` и на ${refPhotoUrlsInput.length} загруженных фото-референса(ов)` : ''}. Ниже прикреплены ${referenceImageDataUris.length} реальных эталонных фото — это и есть целевой уровень света, ретуши и композиции. Сравнивай кандидата ИМЕННО С НИМИ, а не с общими представлениями о "красивом фото".\n`;

        const resultsList = [];
        console.log(`[🚀 ШАГ 3] Начинаем параллельное скачивание и анализ ИИ...`);

        const batchSize = 10;
        for (let i = 0; i < profiles.length; i += batchSize) {
            const batch = profiles.slice(i, i + batchSize);
            console.log(`[⚡] Обрабатываем пачку ${Math.floor(i / batchSize) + 1} (профили с ${i + 1} по ${Math.min(i + batchSize, profiles.length)})...`);

            const batchResults = await Promise.all(batch.map(async (profile) => {
                const username = profile.username;
                const bio = profile.biography || 'Нет описания';
                const followers = profile.followersCount || 0;
                if (followers < 1000) return null;

                const followersFormatted = followers.toLocaleString('ru-RU');
                const emailMatch = bio.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
                const email = emailMatch ? emailMatch[0] : (profile.businessEmail ? profile.businessEmail : 'Нет почты');

                const photoUrlsToDownload = [];
                if (profile.latestPosts && profile.latestPosts.length > 0) {
                    for (const post of profile.latestPosts.slice(0, 4)) {
                        if (post.displayUrl) photoUrlsToDownload.push(post.displayUrl);
                    }
                } else if (profile.profilePicUrlHD) {
                    photoUrlsToDownload.push(profile.profilePicUrlHD);
                }

                let aiResult = { status: "⚪ ОШИБКА", matchScore: 0, direction: "Не определено", opinion: "Не удалось проверить" };
                let downloadedBase64Images = [];

                const excludedRoleRegex = /(retouch|ретуш|editor|make[\s-]?up|\bmua\b|визажист|визаж|мейкап|hair\s?stylist|hairstylist|magazine|vogue|bazaar|elle|agency|publication|journal|mag\b)/i;

                // Паблики и подборки чужих работ: в шапке зовут присылать кадры или отмечать аккаунт.
                // Раньше они проходили фильтр, потому что слова "magazine" в шапке у них нет.
                const aggregatorRegex = /(submission|submit your|send us|dm (us )?(for|to) (feature|share)|tag us|use #|hashtag|feature your|we feature|curat|community|daily (dose|inspo|feed)|inspo|showcase|best of|selection of|repost|credit to|all rights to|photo(graphy)? (page|account|archive)|архив|подборк)/i;

                // У бизнес-аккаунтов Instagram сам хранит категорию — журналы и медиа видно по ней
                const category = `${profile.businessCategoryName || ''} ${profile.categoryName || ''} ${profile.categoryEnum || ''}`;
                const excludedCategoryRegex = /(magazine|media|news|publisher|blog|community|arts? ?& ?entertainment|clothing|brand|retail|shopping|model|agency)/i;

                let autoRejectReason = null;
                if (excludedRoleRegex.test(bio)) autoRejectReason = 'Авто-отсев: журнал, агентство, ретушёр или визажист.';
                else if (aggregatorRegex.test(bio)) autoRejectReason = 'Авто-отсев: паблик-подборка чужих работ, а не снимающий фотограф.';
                else if (category.trim() && excludedCategoryRegex.test(category)) autoRejectReason = `Авто-отсев по категории аккаунта: ${category.trim()}.`;

                if (autoRejectReason) {
                    aiResult = { status: "🔴 МУСОР", matchScore: 0, direction: "Не целевой профиль", opinion: autoRejectReason };
                } else {
                    for (const url of photoUrlsToDownload) {
                        const dataUri = await downloadImageAsDataUri(url);
                        if (dataUri) downloadedBase64Images.push(dataUri);
                    }

                    const photoAnalyzed = downloadedBase64Images.length > 0;
                    if (photoAnalyzed) console.log(`[+] Фото скачаны для @${username}`);

                    // ДОБАВЛЕНО: тематика съёмки (selectedStyle) теперь реально доходит до ИИ, раньше нигде не использовалась
                    const basePrompt = `Ты элитный арт-директор глянцевого журнала. Нам нужны ТОЛЬКО живые fashion/beauty ФОТОГРАФЫ, которые ДЕЙСТВИТЕЛЬНО попадают в заданную тематику, ТЗ и стиль эталонов — а не просто "красивые фото вообще".
Данные:
- Тематика съёмки (выбрана заказчиком): "${selectedStyle}"
- BIO: "${bio}"
- ТЗ (что именно мы ищем): "${visualPrompt}"
${antiPatternText}${referenceBlock}
ПРАВИЛА ОЦЕНКИ (СТРОГО, БЕЗ СКИДОК НА "ПРИБЛИЗИТЕЛЬНО ПОДХОДИТ"):
1. Сначала оцени ДОЛЮ фото кандидата, которая реально попадает в тематику и ТЗ и близка к эталонам — а не просто "тоже фотография людей". Если доля меньше 70% — это МУСОР, независимо от красоты отдельных кадров.
2. Затем — техническое качество: свет (студийный/плоский "в лоб"), сохранена ли текстура кожи или "пластик", композиция.
3. 🔴 "МУСОР" — доля жанра < 70%, ИЛИ качество явно ниже эталонов, ИЛИ это модель/визажист/журнал/предметник/свадебщик.
3а. ОБЯЗАТЕЛЬНО отсеивай аккаунты, которые НЕ СНИМАЮТ САМИ: журналы, медиа, паблики-подборки, архивы вдохновения, агентства, бренды одежды, магазины. Признаки: в ленте работы разных авторов с разным почерком и обработкой, кадры подписаны чужими именами или отметками, в шапке просят присылать работы или отмечать аккаунт, лента выглядит как витрина чужого творчества. Такому кандидату ставь matchScore 0 и в opinion прямо пиши, что это не снимающий фотограф.
3б. Нам нужен ЧЕЛОВЕК ИЛИ СТУДИЯ, снимающая сама: узнаваемый единый почерк, повторяющиеся модели и локации, съёмки одной серии.
4. 🟡 "ПОТЕНЦИАЛ" — доля жанра ≥ 70%, но качество или консистентность заметно уступают эталонам.
5. 🟢 "ПРОФИ" — доля жанра ~100%, качество и стиль на уровне эталонов или выше.

Верни ответ СТРОГО в формате JSON:
{
  "status": "🔴 МУСОР, 🟡 ПОТЕНЦИАЛ или 🟢 ПРОФИ",
  "matchScore": <целое число 0-100 — насколько кандидат соответствует ИМЕННО тематике, ТЗ и эталонам, а не общая оценка "красиво/некрасиво">,
  "direction": "Основное направление (например: Fashion, Commercial Beauty)",
  "opinion": "Рентген-анализ: доля нужного жанра в ленте, качество света и ретуши, почему такой matchScore"
}`;

                    try {
                        const contentBlocks = [{
                            type: "text",
                            text: photoAnalyzed ? basePrompt : `ВНИМАНИЕ: Фото недоступно (скрыто). Оцени кандидата ИСКЛЮЧИТЕЛЬНО по тексту BIO.\n\n${basePrompt}`
                        }];

                        if (photoAnalyzed) {
                            contentBlocks.push({ type: "text", text: "Последние фото кандидата (оцени долю жанра и качество):" });
                            for (const b64 of downloadedBase64Images) {
                                contentBlocks.push({ type: "image_url", image_url: { url: b64, detail: "low" } });
                            }
                        }

                        // ИСПРАВЛЕНИЕ: ограничиваем число эталонных фото В ОДНОМ запросе — при куче
                        // загруженных референсов + 4 фото кандидата запрос мог раздуться и чаще падать
                        const referenceImagesForPrompt = referenceImageDataUris.slice(0, 6);
                        if (referenceImagesForPrompt.length > 0) {
                            contentBlocks.push({ type: "text", text: `Эталонные фото (${referenceImagesForPrompt.length} шт — ориентир по свету, ретуши и уровню):` });
                            for (const b64 of referenceImagesForPrompt) {
                                contentBlocks.push({ type: "image_url", image_url: { url: b64, detail: "low" } });
                            }
                        }

                        // ИСПРАВЛЕНИЕ: раньше единственный сбой ИИ (например, из-за параллельной нагрузки
                        // на пачку из 10 кандидатов разом) сразу списывал кандидата в "СБОЙ ИИ" без единой
                        // повторной попытки и без единого лога причины — теперь пробуем до 3 раз и видим текст ошибки
                        let completion = null;
                        let lastAiErr = null;
                        for (let attempt = 1; attempt <= 3; attempt++) {
                            try {
                                completion = await openai.chat.completions.create({
                                    model: AI_MODEL,
                                    response_format: { type: "json_object" },
                                    messages: [{ role: "user", content: contentBlocks }]
                                });
                                break;
                            } catch (aiErr) {
                                lastAiErr = aiErr;
                                console.log(`[!] ИИ-анализ @${username}, попытка ${attempt}/3 не удалась: ${aiErr.message}`);
                                if (attempt < 3) await new Promise(r => setTimeout(r, 3000 * attempt));
                            }
                        }

                        if (completion) {
                            aiResult = JSON.parse(completion.choices[0].message.content.trim());
                        } else {
                            aiResult = { status: "⚪ СБОЙ ИИ", matchScore: 0, direction: "-", opinion: aiErrorText(lastAiErr) };
                        }
                    } catch (aiErr) {
                        console.log(`[!] Неожиданная ошибка при оценке @${username}: ${aiErr.message}`);
                        aiResult = { status: "⚪ СБОЙ ИИ", matchScore: 0, direction: "-", opinion: aiErrorText(aiErr) };
                    }
                }

                return {
                    id: profile.id || Date.now() + Math.random(),
                    username: `@${username}`,
                    bio: bio,
                    status: aiResult.status,
                    matchScore: typeof aiResult.matchScore === 'number' ? aiResult.matchScore : 0,
                    direction: aiResult.direction,
                    opinion: aiResult.opinion,
                    followers: followersFormatted,
                    email: email,
                    photoUrls: photoUrlsToDownload,
                    photoUrl: photoUrlsToDownload.length > 0 ? photoUrlsToDownload[0] : null,
                    photoAnalyzed: downloadedBase64Images.length > 0
                };
            }));

            resultsList.push(...batchResults.filter(r => r !== null));
        }

        // ДОБАВЛЕНО: сортируем по убыванию совпадения — лучшие кандидаты идут первыми в списке
        resultsList.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));

        console.log(`[✅] Сбор завершен! Отправляем ${resultsList.length} результатов на сайт.`);
        res.json({ success: true, data: resultsList });
    } catch (error) {
        console.error('Ошибка умного поиска:', error.message);
        res.status(500).json({ success: false, error: error.message || "Ошибка сбора данных." });
    }
});

app.get('/api/image-proxy', async (req, res) => {
    try {
        const { url } = req.query;
        if (!url) return res.status(400).send('Missing url');

        const imgResponse = await undiciFetch(url, {
            dispatcher: localProxy,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
                'Referer': 'https://www.instagram.com/',
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
            }
        });

        if (!imgResponse.ok) return res.status(404).send('Image unavailable');

        res.set('Content-Type', imgResponse.headers.get('content-type') || 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=3600');
        const buffer = Buffer.from(await imgResponse.arrayBuffer());
        res.send(buffer);
    } catch (e) {
        res.status(500).send('Proxy error');
    }
});

app.listen(PORT, () => console.log(`ИИ-Сервер запущен на порту ${PORT}`));