const { initializeApp, cert } = require("firebase-admin/app");
const { getStorage } = require("firebase-admin/storage");
const serviceAccount = require("./firebase-key.json"); // твой ключ

// Подключаемся к Firebase (Новый синтаксис)
initializeApp({
  credential: cert(serviceAccount),
  storageBucket: "ai-leads-crm-4c6ef.appspot.com"
});

// Отправляем правила CORS напрямую
const bucket = getStorage().bucket();

bucket.setCorsConfiguration([
  {
    origin: ["*"],
    method: ["GET", "HEAD", "DELETE", "PUT", "POST", "OPTIONS"],
    responseHeader: ["Content-Type"],
    maxAgeSeconds: 3600
  }
]).then(() => {
  console.log("✅ УРА! Настройки CORS успешно применены к хранилищу!");
  process.exit(0);
}).catch((err) => {
  console.error("❌ Ошибка:", err);
  process.exit(1);
});