const { initializeApp, cert } = require("firebase-admin/app");
const { getStorage } = require("firebase-admin/storage");
const serviceAccount = require("./firebase-key.json"); // твой ключ

initializeApp({
  credential: cert(serviceAccount),
  storageBucket: "ai-leads-crm-4c6ef.appspot.com",
});

const bucket = getStorage().bucket();

/*  responseHeader в правилах Google Cloud Storage отвечает сразу за два
    заголовка ответа: Access-Control-Allow-Headers и Access-Control-Expose-Headers.
    Пока там был только Content-Type, браузер не имел права отправлять
    служебные заголовки x-goog-upload-*, поэтому загрузка с прогрессом
    (uploadBytesResumable) молча зависала. "*" разрешает их все.            */
bucket
  .setCorsConfiguration([
    {
      origin: ["*"],
      method: ["GET", "HEAD", "DELETE", "PUT", "POST", "OPTIONS"],
      responseHeader: ["*"],
      maxAgeSeconds: 3600,
    },
  ])
  .then(() => bucket.getMetadata())
  .then(([meta]) => {
    console.log("Настройки CORS применены:");
    console.log(JSON.stringify(meta.cors, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error("Ошибка:", err);
    process.exit(1);
  });
