// Импортируем нужные функции из установленной библиотеки
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth } from "firebase/auth";
import { getStorage } from "firebase/storage";

// Твои публичные ключи для подключения к Firebase
const firebaseConfig = {
  apiKey: "AIzaSyDjDx5VypBaGxSncB-mgLjewlRJdcwBz8s",
  authDomain: "ai-leads-crm-4c6ef.firebaseapp.com",
  databaseURL: "https://ai-leads-crm-4c6ef-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "ai-leads-crm-4c6ef",
  storageBucket: "ai-leads-crm-4c6ef.appspot.com",
  messagingSenderId: "493737243093",
  appId: "1:493737243093:web:a5856288b211dc66554d5c"
};

// Запускаем подключение к облаку
const app = initializeApp(firebaseConfig);

// Экспортируем базу данных, чтобы наша таблица могла брать оттуда контакты
const db = getFirestore(app);
const auth = getAuth(app);
const storage = getStorage(app);

export { app, db, auth, storage };