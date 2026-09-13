"use client";
import { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, setDoc } from 'firebase/firestore';
import { db, auth, storage } from '../firebase'; 
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'; 
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';

const TABS = [
  { id: 'base', num: '01', label: 'База клиентов' },
  { id: 'search', num: '02', label: 'Умный поиск' },
  { id: 'portfolio', num: '03', label: 'Портфолио 🌟' },
  { id: 'orders', num: '04', label: 'Учет заказов' },
  { id: 'mail', num: '05', label: 'Рассылка' },
];

const API_BASE = 'http://localhost:5000';

// === УМНАЯ СЕТКА ФОТОГРАФИЙ (ЖУРНАЛЬНАЯ ВЕРСТКА) ===
const ROWS: Record<number, number[]> = {1:[1],2:[2],3:[1,2],4:[2,2],5:[2,3],6:[3,3],7:[2,2,3],8:[3,2,3],9:[3,3,3]};
function rowsFor(n: number) {
  if (ROWS[n]) return ROWS[n];
  const r = []; let left = n;
  while(left > 0) { 
    if(left === 4) { r.push(2,2); left = 0; } 
    else if(left === 1 && r.length) { r[r.length-1] += 1; left = 0; } 
    else { const t = Math.min(3, left); r.push(t); left -= t; } 
  }
  return r;
}
const W: any = {1:[1], 2:[[1.32,1],[1,1.32]], 3:[[1,1.24,1],[1.24,1,1.1]]};
const H: any = {1:['100%'], 2:[['100%','87%'],['88%','100%']], 3:[['93%','100%','85%'],['100%','86%','96%']]};
const ROWH: any = {1:'clamp(400px,46vw,600px)', 2:'clamp(300px,32vw,500px)', 3:'clamp(230px,23vw,370px)'};

function buildRows(photos: any[]) {
  if (!photos || photos.length === 0) return [];
  const sizes = rowsFor(photos.length);
  const out: any[] = []; 
  let i = 0;
  sizes.forEach((size, ri) => {
    const items = photos.slice(i, i+size).map((p, k) => ({
      photo: p, idx: i+k,
      flex: size === 1 ? 1 : W[size][ri%2][k],
      h: size === 1 ? '100%' : H[size][ri%2][k],
    }));
    out.push({ size, h: ROWH[size], items, single: size===1 });
    i += size;
  });
  return out;
}

// Функция сжатия картинки в легкую Base64 строку (формат JPEG, качество 70%)
function compressImageToBase64(file: File, maxWidth = 800): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target?.result as string;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }

        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, width, height);

        // Конвертируем в JPEG с качеством 70%
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        resolve(dataUrl);
      };
      img.onerror = (error) => reject(error);
    };
    reader.onerror = (error) => reject(error);
  });
}

// === КОМПОНЕНТ ПОЛЗУНКА ДО/ПОСЛЕ ===
function BeforeAfterSlider({ beforeUrl, afterUrl }: { beforeUrl: string, afterUrl: string }) {
  const [sliderPos, setSliderPos] = useState(50);
  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '4/5', background: '#e5e5e5', overflow: 'hidden' }}>
      <img src={afterUrl} alt="After" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
      <div style={{ position: 'absolute', inset: 0, clipPath: `inset(0 ${100 - sliderPos}% 0 0)` }}>
        <img src={beforeUrl} alt="Before" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
      </div>
      <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${sliderPos}%`, width: '2px', background: '#fff', transform: 'translateX(-50%)', pointerEvents: 'none' }} />
      <input 
        type="range" min="0" max="100" value={sliderPos} onChange={(e) => setSliderPos(Number(e.target.value))}
        style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'ew-resize', width: '100%', height: '100%' }}
      />
    </div>
  );
}

export default function Home() {
  const [activeTab, setActiveTab] = useState('search');
  
  // --- БАЗА КЛИЕНТОВ ---
  const [leads, setLeads] = useState<any[]>([]);
  const [newName, setNewName] = useState('');
  const [newNiche, setNewNiche] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [selectedLeadIds, setSelectedLeadIds] = useState<string[]>([]);
  const [isDeletingLeads, setIsDeletingLeads] = useState(false);
  const [editingLeadId, setEditingLeadId] = useState<string | null>(null);
  const [editEmailValue, setEditEmailValue] = useState('');

  // --- УМНЫЙ ПОИСК ---
  const [visualPrompt, setVisualPrompt] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [isTransferring, setIsTransferring] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [selectedForBase, setSelectedForBase] = useState<number[]>([]);
  const [referenceProfile, setReferenceProfile] = useState('');
  const [referencePhotoDataUris, setReferencePhotoDataUris] = useState<string[]>([]);
  const [referencePhotoUrlInput, setReferencePhotoUrlInput] = useState('');
  const [selectedStyle, setSelectedStyle] = useState('Beauty');
  const [activePreviewData, setActivePreviewData] = useState<any>(null);
  const [imgFailed, setImgFailed] = useState(false);

  // --- АВТОРИЗАЦИЯ И РАЗДЕЛЕНИЕ САЙТА ---
  const [user, setUser] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showAdminLogin, setShowAdminLogin] = useState(false);

  // --- СОСТОЯНИЯ ЛАЙТБОКСА (УВЕЛИЧЕНИЕ ФОТО) ---
  const [lbOpen, setLbOpen] = useState(false);
  const [lbList, setLbList] = useState<any[]>([]);
  const [lbIdx, setLbIdx] = useState(0);

  // Управление лайтбоксом с клавиатуры (стрелки и Esc)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!lbOpen) return;
      if (e.key === 'Escape') setLbOpen(false);
      if (e.key === 'ArrowLeft') setLbIdx((prev) => (prev - 1 + lbList.length) % lbList.length);
      if (e.key === 'ArrowRight') setLbIdx((prev) => (prev + 1) % lbList.length);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [lbOpen, lbList.length]);

  const openLightbox = (shoot: any, photoIndex: number) => {
    setLbList(shoot.photos.map((p: any, i: number) => ({
      url: p.url, 
      cap: `${shoot.title} — ${i + 1} /${shoot.photos.length}`
    })));
    setLbIdx(photoIndex);
    setLbOpen(true);
  };

  // --- ДАННЫЕ ПУБЛИЧНОГО САЙТА ---
  const [publicSettings, setPublicSettings] = useState<any>(null);
  const [publicShoots, setPublicShoots] = useState<any[]>([]);
  const [publicBeforeAfter, setPublicBeforeAfter] = useState<any[]>([]);

  // --- СОСТОЯНИЯ CMS (АДМИНКА) ---
  const [cmsTab, setCmsTab] = useState('requests'); 
  const [siteRequests, setSiteRequests] = useState<any[]>([]);

  // --- НАСТРОЙКИ (ТЕКСТЫ И КОНТАКТЫ) ---
  const [editTagline, setEditTagline] = useState('');
  const [editAbout, setEditAbout] = useState('');
  const [editTg, setEditTg] = useState('');
  const [editIg, setEditIg] = useState('');
  const [editEmail, setEditEmail] = useState('');

  // --- СОСТОЯНИЯ ЗАГРУЗОК (СЪЕМКИ И ДО/ПОСЛЕ) ---
  const [showAddShoot, setShowAddShoot] = useState(false);
  const [shootTitle, setShootTitle] = useState('');
  const [shootCategory, setShootCategory] = useState('beauty');
  const [shootYear, setShootYear] = useState('');
  const [shootFiles, setShootFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);

  const [showAddBA, setShowAddBA] = useState(false);
  const [baTitle, setBaTitle] = useState('');
  const [baNote, setBaNote] = useState('');
  const [baBefore, setBaBefore] = useState<File | null>(null);
  const [baAfter, setBaAfter] = useState<File | null>(null);
  const [isUploadingBA, setIsUploadingBA] = useState(false);

  // --- ФОРМА ЗАЯВКИ (ПУБЛИЧНЫЙ САЙТ) ---
  const [reqName, setReqName] = useState('');
  const [reqContact, setReqContact] = useState('');
  const [reqTask, setReqTask] = useState('');
  const [reqFiles, setReqFiles] = useState<File[]>([]);
  const [isSendingReq, setIsSendingReq] = useState(false);
  const [reqSent, setReqSent] = useState(false);

  const fileToDataUri = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  // Эффект: загрузка входящих заявок
  useEffect(() => {
    if (user) {
      getDocs(collection(db, 'leads_portfolio')).then(snap => {
        setSiteRequests(snap.docs.map(d => ({ id: d.id, ...d.data() }))
          .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
      });
    }
  }, [user, cmsTab]);

  // Эффект: загрузка публичного контента
  useEffect(() => {
    async function fetchPublic() {
      try {
        const snapSettings = await getDocs(collection(db, 'site_settings'));
        snapSettings.forEach(d => { if (d.id === 'public') setPublicSettings(d.data()); });

        const snapShoots = await getDocs(collection(db, 'portfolio_shoots'));
        setPublicShoots(snapShoots.docs.map(d => ({ id: d.id, ...d.data() })).sort((a: any, b: any) => (a.order || 0) - (b.order || 0)));

        const snapBA = await getDocs(collection(db, 'before_after'));
        setPublicBeforeAfter(snapBA.docs.map(d => ({ id: d.id, ...d.data() })).sort((a: any, b: any) => (a.order || 0) - (b.order || 0)));
      } catch (e) {
        console.error("Ошибка загрузки публичных данных:", e);
      }
    }
    fetchPublic();
  }, []);

  // Эффект: подтягивание настроек в поля админки
  useEffect(() => {
    if (publicSettings) {
      setEditTagline(publicSettings.tagline || '');
      setEditAbout((publicSettings.about || []).join('\n\n'));
      setEditTg(publicSettings.contacts?.telegram?.url || '');
      setEditIg(publicSettings.contacts?.instagram?.url || '');
      setEditEmail(publicSettings.contacts?.email?.url?.replace('mailto:', '') || '');
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
    fetchLeads();
  }, []);

  async function fetchLeads() {
    const querySnapshot = await getDocs(collection(db, 'leads'));
    const leadsArray: any[] = [];
    querySnapshot.forEach((docSnap) => {
      leadsArray.push({ id: docSnap.id, ...docSnap.data() });
    });
    setLeads(leadsArray);
  }

  // --- ХЭНДЛЕРЫ АВТОРИЗАЦИИ ---
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await signInWithEmailAndPassword(auth, loginEmail, loginPassword);
    } catch (error: any) {
      alert("Ошибка входа: неверный email или пароль.");
    }
  };

  const handleLogout = () => signOut(auth);

  // --- ХЭНДЛЕРЫ CMS И ПОРТФОЛИО ---
  const handleSaveSettings = async () => {
    const newSettings = {
      ...publicSettings,
      tagline: editTagline,
      about: editAbout.split('\n\n').filter(Boolean),
      contacts: {
        ...publicSettings?.contacts,
        telegram: { handle: "@telegram", url: editTg, sub: "отвечаю быстрее всего" },
        instagram: { handle: "@instagram", url: editIg, sub: "свежие работы" },
        email: { handle: "email", url: `mailto:${editEmail}`, sub: "для брифов" }
      },
      facts: publicSettings?.facts || [
        { label: "Опыт", value: "06", note: "лет в постобработке" },
        { label: "Съёмок", value: "240+", note: "обработано с 2020" },
        { label: "Тест-ретушь", value: "Free", note: "одно фото бесплатно" }
      ]
    };
    await setDoc(doc(db, 'site_settings', 'public'), newSettings, { merge: true });
    setPublicSettings(newSettings);
    alert('Настройки сайта обновлены!');
  };

const handleCreateShoot = async () => {
    if (!shootTitle || shootFiles.length === 0) return alert('Укажи название и выбери фото!');
    setIsUploading(true);

    try {
      const uploadedPhotos = [];
      
      for (let i = 0; i < shootFiles.length; i++) {
        const file = shootFiles[i];
        
        // 1. Сжимаем картинку в легкую Base64 строку прямо в браузере
        const base64Url = await compressImageToBase64(file, 900);
        
        // 2. Узнаем реальные пропорции для журнальной сетки
        const img = new window.Image();
        img.src = base64Url;
        await new Promise((resolve) => { img.onload = resolve; });

        uploadedPhotos.push({ 
          url: base64Url, 
          w: img.width, 
          h: img.height 
        });
      }

      // 3. Сохраняем съёмку в Firestore через привычный addDoc
      const newShoot = {
        title: shootTitle,
        category: shootCategory,
        year: shootYear,
        order: Date.now(),
        photos: uploadedPhotos,
        cover: uploadedPhotos[0]?.url || ''
      };
      
      const docRef = await addDoc(collection(db, 'portfolio_shoots'), newShoot);

      setPublicShoots(prev => [...prev, { id: docRef.id, ...newShoot }]);
      alert('Съёмка успешно сохранена в базу!');
      setShowAddShoot(false);
      setShootTitle(''); setShootFiles([]); setShootYear('');

    } catch (error: any) {
      alert('Ошибка: ' + error.message);
    } finally {
      setIsUploading(false);
    }
  };

  const handleCreateBA = async () => {
    if (!baTitle || !baBefore || !baAfter) return alert('Заполните название и прикрепите оба фото!');
    setIsUploadingBA(true);
    try {
      const refB = ref(storage, `before_after/${Date.now()}_before_${baBefore.name}`);
      await uploadBytes(refB, baBefore);
      const beforeUrl = await getDownloadURL(refB);

      const refA = ref(storage, `before_after/${Date.now()}_after_${baAfter.name}`);
      await uploadBytes(refA, baAfter);
      const afterUrl = await getDownloadURL(refA);

      const newBA = { title: baTitle, note: baNote, beforeUrl, afterUrl, order: Date.now() };
      const docRef = await addDoc(collection(db, 'before_after'), newBA);
      
      setPublicBeforeAfter(prev => [...prev, { id: docRef.id, ...newBA }]);
      setShowAddBA(false);
      setBaTitle(''); setBaNote(''); setBaBefore(null); setBaAfter(null);
      alert('Интерактивный ползунок успешно создан!');
    } catch (e: any) {
      alert('Ошибка: ' + e.message);
    } finally {
      setIsUploadingBA(false);
    }
  };

  const handleSendRequest = async () => {
    if (!reqName || !reqContact) return alert('Пожалуйста, укажите имя и контакт для связи!');
    setIsSendingReq(true);
    try {
      const photosBase64 = await Promise.all(reqFiles.map(async f => ({
        name: f.name, dataUrl: await fileToDataUri(f)
      })));

      const res = await fetch(`${API_BASE}/api/lead-photo`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: reqName, contact: reqContact, task: reqTask, photos: photosBase64, source: 'Сайт-портфолио' })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);

      await addDoc(collection(db, 'leads_portfolio'), {
        name: reqName, contact: reqContact, task: reqTask,
        photosCount: reqFiles.length, status: 'New', createdAt: new Date().toISOString()
      });

      setReqSent(true);
      setReqName(''); setReqContact(''); setReqTask(''); setReqFiles([]);
    } catch (e: any) {
      alert('Ошибка при отправке: ' + e.message);
    } finally {
      setIsSendingReq(false);
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

  const handleStatusChange = async (leadId: string, newStatus: string) => {
    await updateDoc(doc(db, 'leads', leadId), { status: newStatus });
    setLeads(leads.map(lead => lead.id === leadId ? { ...lead, status: newStatus } : lead));
  };

  const handleSaveLeadEmail = async (leadId: string) => {
    await updateDoc(doc(db, 'leads', leadId), { email: editEmailValue });
    setLeads(leads.map(lead => lead.id === leadId ? { ...lead, email: editEmailValue } : lead));
    setEditingLeadId(null);
  };

  const toggleLeadSelection = (id: string) => {
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
  const addReferencePhotoFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (arr.length === 0) return;
    const dataUris = await Promise.all(arr.map(fileToDataUri));
    setReferencePhotoDataUris(prev => [...prev, ...dataUris]);
  };

  const handleReferencePhotoFileInput = (e: any) => {
    if (e.target.files) addReferencePhotoFiles(e.target.files);
    e.target.value = '';
  };

  const handleReferencePhotoPaste = (e: any) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
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

  const handleReferencePhotoDrop = (e: any) => {
    e.preventDefault();
    if (e.dataTransfer.files) addReferencePhotoFiles(e.dataTransfer.files);
  };

  const removeReferencePhoto = (idx: number) => {
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
    } catch (err: any) {
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

  const toggleSelection = (id: number) => {
    setSelectedForBase(prev => prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]);
  };

  const openPreview = (result: any) => {
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

  if (authLoading) return <div style={{ padding: '50px', textAlign: 'center', fontFamily: 'Archivo' }}>Загрузка...</div>;

  // ================= ПУБЛИЧНЫЙ САЙТ ================= //
  if (!user) {
    const settings = publicSettings || {
      tagline: "Сохраняю текстуру кожи и характер кадра. High-end ретушь для брендов и глянца.",
      facts: [
        { label: "Опыт", value: "06", note: "лет в постобработке" },
        { label: "Съёмок", value: "240+", note: "обработано с 2020" },
        { label: "Тест-ретушь", value: "Free", note: "одно фото бесплатно" }
      ]
    };

    return (
      <div style={{ background: 'var(--paper)', minHeight: '100vh', color: 'var(--ink)' }}>
         <style dangerouslySetInnerHTML={{ __html: CSS }} />
         <header style={{ padding: '24px 56px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--line-soft)' }}>
           <h2 style={{ fontFamily: 'Archivo', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.16em', margin: 0, fontSize: '18px' }}>Adriana Studio</h2>
           <button onClick={() => setShowAdminLogin(!showAdminLogin)} style={{ background: 'none', border: 'none', color: 'var(--line)', cursor: 'pointer', fontFamily: 'Archivo', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.2em' }}>Admin</button>
         </header>

         {showAdminLogin ? (
           <form onSubmit={handleLogin} style={{ maxWidth: '300px', margin: '150px auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <h3 style={{ fontFamily: 'Archivo', textAlign: 'center', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Вход в CRM</h3>
              <input type="email" placeholder="Email" value={loginEmail} onChange={e => setLoginEmail(e.target.value)} style={{ padding: '14px', border: '1px solid var(--ink)', background: 'transparent', fontFamily: 'inherit', outline: 'none' }} />
              <input type="password" placeholder="Пароль" value={loginPassword} onChange={e => setLoginPassword(e.target.value)} style={{ padding: '14px', border: '1px solid var(--ink)', background: 'transparent', fontFamily: 'inherit', outline: 'none' }} />
              <button type="submit" className="badge solid" style={{ padding: '16px', border: 'none', cursor: 'pointer', fontSize: '12px' }}>Войти</button>
           </form>
         ) : (
           <main>
             {/* СЕКЦИЯ 1: HERO И ФАКТЫ */}
             <section style={{ padding: '80px 56px', borderBottom: '1px solid var(--ink)' }}>
               <h1 className="display" style={{ fontSize: 'clamp(48px, 8vw, 120px)', maxWidth: '14ch', margin: '0 0 40px 0' }}>
                 post-production & retouching
               </h1>
               <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '40px', borderTop: '1px solid var(--line-soft)', paddingTop: '40px' }}>
                 <div style={{ gridColumn: '1 / -1', maxWidth: '600px', marginBottom: '20px' }}>
                   <p style={{ fontSize: '20px', lineHeight: '1.6', margin: 0 }}>{settings.tagline}</p>
                 </div>
                 {settings.facts.map((fact: any, idx: number) => (
                   <div key={idx}>
                     <div className="mono-label" style={{ marginBottom: '8px' }}>{fact.label}</div>
                     <div style={{ fontFamily: 'Archivo', fontSize: '48px', fontWeight: 800, lineHeight: 1, marginBottom: '8px' }}>{fact.value}</div>
                     <div style={{ fontSize: '13px', color: 'var(--mute)' }}>{fact.note}</div>
                   </div>
                 ))}
               </div>
             </section>

             {/* СЕКЦИЯ 2: ПОЛЗУНКИ ДО/ПОСЛЕ */}
             {publicBeforeAfter.length > 0 && (
               <section style={{ padding: '80px 56px', borderBottom: '1px solid var(--ink)' }}>
                 <h2 className="display" style={{ fontSize: '48px', marginBottom: '40px' }}>before & after</h2>
                 <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '40px' }}>
                   {publicBeforeAfter.map(item => (
                     <div key={item.id}>
                       <BeforeAfterSlider beforeUrl={item.beforeUrl} afterUrl={item.afterUrl} />
                       <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                         <h4 style={{ margin: 0, fontFamily: 'Archivo', fontSize: '14px', textTransform: 'uppercase' }}>{item.title}</h4>
                         <span style={{ fontSize: '11px', color: 'var(--mute)' }}>{item.note}</span>
                       </div>
                     </div>
                   ))}
                 </div>
               </section>
             )}

             {/* СЕКЦИЯ 3: ЖУРНАЛЬНОЕ ПОРТФОЛИО */}
             <section style={{ padding: '80px 56px' }} className="sec-portfolio">
               <h2 className="display" style={{ fontSize: '48px', marginBottom: '60px' }}>selected works</h2>
               {publicShoots.length === 0 ? (
                 <p style={{ color: 'var(--mute)' }}>Портфолио пока пусто. Загрузи съёмки через базу данных.</p>
               ) : (
                 <div style={{ display: 'flex', flexDirection: 'column', gap: '80px' }}>
                   {publicShoots.map((shoot, si) => {
                     const rows = buildRows(shoot.photos || []);
                     return (
                       <article className="shoot" key={shoot.id}>
                         <header className="shoot-head">
                           <h3 className="shoot-name">{shoot.title}</h3>
                           <div className="shoot-meta">
                             <span className="mono-label">{shoot.photos?.length} кадров</span>
                             <span className="mono-label">{shoot.year}</span>
                           </div>
                         </header>
                         <div className="mosaic">
                           {rows.map((row, rowIdx) => (
                             <div key={rowIdx} className={`mrow ${row.single ? 'single' : ''}`} style={{ height: row.h }}>
                               {row.items.map((it: any) => (
                                 <figure 
                                   key={it.idx} 
                                   className="cell" 
                                   data-n={String(it.idx + 1).padStart(2, '0')}
                                   style={{ flex: `${it.flex} 1 0`, height: it.h }}
                                   onClick={() => openLightbox(shoot, it.idx)}
                                 >
                                   <img src={it.photo.url} alt={`${shoot.title} - photo${it.idx}`} loading="lazy" />
                                 </figure>
                               ))}
                             </div>
                           ))}
                         </div>
                       </article>
                     );
                   })}
                 </div>
               )}
             </section>
             
             {/* САМ ЛАЙТБОКС (ПОПАП С ФОТО) */}
             <div className={`lb ${lbOpen ? 'on' : ''}`} onClick={(e) => { if (e.target === e.currentTarget) setLbOpen(false) }}>
               <button className="lb-x" onClick={() => setLbOpen(false)} aria-label="Закрыть">✕</button>
               <button className="lb-p" onClick={() => setLbIdx((prev) => (prev - 1 + lbList.length) % lbList.length)} aria-label="Назад">‹</button>
               {lbList.length > 0 && <img src={lbList[lbIdx].url} alt="Увеличенное фото" />}
               <button className="lb-n" onClick={() => setLbIdx((prev) => (prev + 1) % lbList.length)} aria-label="Вперёд">›</button>
               <div className="lb-cap">{lbList.length > 0 ? lbList[lbIdx].cap : ''}</div>
             </div>

             {/* СЕКЦИЯ 4: ФОРМА ЗАЯВКИ */}
             <section style={{ padding: '80px 56px', background: 'var(--ink)', color: 'var(--paper)' }}>
               <div style={{ maxWidth: '600px', margin: '0 auto' }}>
                 <h2 className="display" style={{ fontSize: '48px', marginBottom: '16px', color: 'var(--paper)' }}>send test task</h2>
                 <p style={{ color: 'var(--mute)', marginBottom: '40px' }}>Прикрепи 1-2 RAW файла и опиши задачу. Я сделаю тестовую ретушь бесплатно, чтобы мы могли оценить мэтч.</p>
                 
                 {reqSent ? (
                   <div style={{ padding: '40px', border: '1px solid var(--paper)', textAlign: 'center' }}>
                     <h3 style={{ fontFamily: 'Archivo', fontSize: '24px', margin: '0 0 8px' }}>Заявка отправлена! 🤍</h3>
                     <p style={{ color: 'var(--mute)', margin: 0 }}>Я посмотрю исходники и напишу тебе в ближайшее время.</p>
                     <button onClick={() => setReqSent(false)} className="badge" style={{ marginTop: '24px', border: '1px solid var(--paper)', color: 'var(--paper)', background: 'transparent', padding: '10px 20px', cursor: 'pointer' }}>Отправить еще</button>
                   </div>
                 ) : (
                   <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                     <input value={reqName} onChange={e => setReqName(e.target.value)} type="text" placeholder="Имя / Бренд *" style={{ padding: '16px', border: '1px solid #333', background: 'transparent', color: 'var(--paper)', outline: 'none', fontFamily: 'inherit' }} />
                     <input value={reqContact} onChange={e => setReqContact(e.target.value)} type="text" placeholder="Telegram / Instagram / Email *" style={{ padding: '16px', border: '1px solid #333', background: 'transparent', color: 'var(--paper)', outline: 'none', fontFamily: 'inherit' }} />
                     <textarea value={reqTask} onChange={e => setReqTask(e.target.value)} placeholder="Опиши задачу (референсы, стиль, сроки)" rows={4} style={{ padding: '16px', border: '1px solid #333', background: 'transparent', color: 'var(--paper)', outline: 'none', fontFamily: 'inherit', resize: 'vertical' }} />
                     
                     <div style={{ border: '1px dashed #333', padding: '24px', textAlign: 'center', position: 'relative' }}>
                       <input type="file" multiple accept="image/*,.cr2,.nef,.arw,.dng" onChange={e => setReqFiles(Array.from(e.target.files || []))} style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }} />
                       <div className="badge" style={{ border: '1px solid #333', padding: '8px 16px', color: 'var(--paper)' }}>Выбрать файлы</div>
                       <p style={{ fontSize: '12px', color: 'var(--mute)', margin: '12px 0 0 0' }}>Файлы для ретуши (до 6 шт). Выбрано: {reqFiles.length}</p>
                     </div>

                     <button onClick={handleSendRequest} disabled={isSendingReq} className="badge solid" style={{ padding: '18px', border: 'none', background: 'var(--paper)', color: 'var(--ink)', cursor: isSendingReq ? 'wait' : 'pointer', fontSize: '14px', marginTop: '12px' }}>
                       {isSendingReq ? 'Отправляем... (может занять минуту)' : 'Отправить заявку ➔'}
                     </button>
                   </div>
                 )}
               </div>
             </section>
           </main>
         )}
      </div>
    );
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
          <button onClick={handleLogout} style={{background:'none', border:'none', cursor:'pointer', color:'var(--mute)', textDecoration:'underline'}}>Выйти</button>
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

              <div style={{ display: 'flex', gap: '12px', borderBottom: '1px solid var(--line-soft)', paddingBottom: '16px', marginBottom: '32px' }}>
                {[
                  { id: 'requests', label: 'Заявки с сайта 📥' },
                  { id: 'settings', label: 'Обо мне и Контакты 📝' },
                  { id: 'shoots', label: 'Галерея съёмок 📸' },
                  { id: 'beforeAfter', label: 'До / После 🌗' }
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
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '40px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <h3 style={{ fontFamily: 'Archivo', fontSize: '18px', margin: 0 }}>Главный экран</h3>
                    <textarea value={editTagline} onChange={e => setEditTagline(e.target.value)} placeholder="Слоган (Tagline)" rows={3} style={{ padding: '12px', border: '1px solid var(--line-soft)', background: 'transparent', outline: 'none', fontFamily: 'inherit' }} />
                    <textarea value={editAbout} onChange={e => setEditAbout(e.target.value)} placeholder="Обо мне (каждый абзац с новой строки)" rows={6} style={{ padding: '12px', border: '1px solid var(--line-soft)', background: 'transparent', outline: 'none', fontFamily: 'inherit' }} />
                    <button onClick={handleSaveSettings} className="badge solid" style={{ padding: '12px', cursor: 'pointer', border: 'none', width: 'fit-content' }}>Сохранить тексты и контакты</button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <h3 style={{ fontFamily: 'Archivo', fontSize: '18px', margin: 0 }}>Контакты (Ссылки)</h3>
                    <input value={editTg} onChange={e => setEditTg(e.target.value)} type="text" placeholder="Telegram URL (https://t.me/...)" style={{ padding: '12px', border: '1px solid var(--line-soft)', background: 'transparent', outline: 'none' }} />
                    <input value={editIg} onChange={e => setEditIg(e.target.value)} type="text" placeholder="Instagram URL (https://instagram.com/...)" style={{ padding: '12px', border: '1px solid var(--line-soft)', background: 'transparent', outline: 'none' }} />
                    <input value={editEmail} onChange={e => setEditEmail(e.target.value)} type="text" placeholder="Email (почта@домен.com)" style={{ padding: '12px', border: '1px solid var(--line-soft)', background: 'transparent', outline: 'none' }} />
                  </div>
                </div>
              )}

              {cmsTab === 'shoots' && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
                    <h3 style={{ fontFamily: 'Archivo', fontSize: '18px', margin: 0 }}>Управление съёмками</h3>
                    <button onClick={() => setShowAddShoot(true)} className="badge solid" style={{ cursor: 'pointer', border: 'none', padding: '10px 20px' }}>+ Добавить съёмку</button>
                  </div>
                  <div style={{ display: 'grid', gap: '16px' }}>
                    {publicShoots.map(s => (
                       <div key={s.id} style={{ padding: '16px', border: '1px solid var(--line-soft)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--paper-2)' }}>
                         <div>
                           <strong style={{ fontFamily: 'Archivo' }}>{s.title}</strong> <span style={{color: 'var(--mute)', fontSize: '13px'}}>({s.category}, {s.photos?.length || 0} фото)</span>
                         </div>
                         <button onClick={async () => {
                           if(confirm('Точно удалить съемку?')) {
                             await deleteDoc(doc(db, 'portfolio_shoots', s.id));
                             setPublicShoots(prev => prev.filter(x => x.id !== s.id));
                           }
                         }} style={{ background: 'none', border: 'none', color: 'var(--mute)', cursor: 'pointer', fontSize: '12px', textDecoration: 'underline' }}>Удалить</button>
                       </div>
                    ))}
                  </div>
                </div>
              )}

              {cmsTab === 'beforeAfter' && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
                    <h3 style={{ fontFamily: 'Archivo', fontSize: '18px', margin: 0 }}>Интерактивные ползунки</h3>
                    <button onClick={() => setShowAddBA(true)} className="badge solid" style={{ cursor: 'pointer', border: 'none', padding: '10px 20px' }}>+ Добавить пару фото</button>
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
                <div style={{ display: 'flex', gap: '16px' }}>
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

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '24px' }}>
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
          <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--paper)', width: '90%', maxWidth: '500px', padding: '32px', borderRadius: '4px', display: 'flex', flexDirection: 'column', gap: '16px', border: '1px solid var(--line-soft)' }}>
            <h2 style={{ margin: '0 0 8px', fontFamily: 'Archivo', fontSize: '24px' }}>Новая съёмка</h2>
            
            <input type="text" placeholder="Название (например: Украшения — золото)" value={shootTitle} onChange={e => setShootTitle(e.target.value)} style={{ padding: '12px', border: '1px solid var(--ink)', background: 'transparent', outline: 'none', fontFamily: 'inherit' }} />
            
            <select value={shootCategory} onChange={e => setShootCategory(e.target.value)} style={{ padding: '12px', border: '1px solid var(--ink)', background: 'transparent', outline: 'none', fontFamily: 'inherit' }}>
              <option value="beauty">Beauty</option>
              <option value="lookbook">Lookbook</option>
              <option value="fashion">Fashion</option>
              <option value="art">Art</option>
              <option value="still">Still</option>
            </select>

            <input type="text" placeholder="Год (необязательно, например: 2026)" value={shootYear} onChange={e => setShootYear(e.target.value)} style={{ padding: '12px', border: '1px solid var(--ink)', background: 'transparent', outline: 'none', fontFamily: 'inherit' }} />
            
            <div style={{ border: '1px dashed var(--ink)', padding: '24px', textAlign: 'center', background: 'var(--paper-2)' }}>
               <input type="file" multiple accept="image/*" onChange={(e) => setShootFiles(Array.from(e.target.files || []))} style={{ width: '100%' }} />
               <p style={{ fontSize: '12px', color: 'var(--mute)', marginTop: '12px' }}>Выбрано фото: {shootFiles.length}</p>
            </div>

            <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
              <button onClick={handleCreateShoot} disabled={isUploading} className="badge solid" style={{ flex: 1, padding: '14px', border: 'none', cursor: isUploading ? 'wait' : 'pointer' }}>
                {isUploading ? 'Загрузка... Не закрывай окно' : 'Загрузить в базу 🚀'}
              </button>
              <button onClick={() => setShowAddShoot(false)} disabled={isUploading} className="badge" style={{ padding: '14px', border: '1px solid var(--ink)', background: 'transparent', cursor: 'pointer' }}>Отмена</button>
            </div>
          </div>
        </div>
      )}

      {/* 2. Модалка "Новый ползунок До/После" */}
      {showAddBA && (
        <div onClick={() => !isUploadingBA && setShowAddBA(false)} style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--paper)', width: '90%', maxWidth: '500px', padding: '32px', borderRadius: '4px', display: 'flex', flexDirection: 'column', gap: '16px', border: '1px solid var(--line-soft)' }}>
            <h2 style={{ margin: '0 0 8px', fontFamily: 'Archivo', fontSize: '24px' }}>Новый ползунок</h2>
            
            <input type="text" placeholder="Заголовок (например: Бьюти-макро)" value={baTitle} onChange={e => setBaTitle(e.target.value)} style={{ padding: '12px', border: '1px solid var(--ink)', background: 'transparent', outline: 'none', fontFamily: 'inherit' }} />
            <input type="text" placeholder="Описание (например: Dodge & Burn, Цвет)" value={baNote} onChange={e => setBaNote(e.target.value)} style={{ padding: '12px', border: '1px solid var(--ink)', background: 'transparent', outline: 'none', fontFamily: 'inherit' }} />
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
              <div style={{ border: '1px dashed var(--ink)', padding: '16px', textAlign: 'center', background: 'var(--paper-2)' }}>
                 <span style={{ fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '8px' }}>ФОТО ДО (RAW)</span>
                 <input type="file" accept="image/*" onChange={(e) => setBaBefore(e.target.files?.[0] || null)} style={{ width: '100%', fontSize: '11px' }} />
              </div>
              <div style={{ border: '1px dashed var(--ink)', padding: '16px', textAlign: 'center', background: 'var(--paper-2)' }}>
                 <span style={{ fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '8px' }}>ФОТО ПОСЛЕ</span>
                 <input type="file" accept="image/*" onChange={(e) => setBaAfter(e.target.files?.[0] || null)} style={{ width: '100%', fontSize: '11px' }} />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
              <button onClick={handleCreateBA} disabled={isUploadingBA} className="badge solid" style={{ flex: 1, padding: '14px', border: 'none', cursor: isUploadingBA ? 'wait' : 'pointer' }}>
                {isUploadingBA ? 'Загрузка...' : 'Добавить 🚀'}
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
                        {activePreviewData.photoUrls.map((url: string, idx: number) => (
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
.app{min-height:100vh;background:var(--paper);color:var(--ink)}

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
.header-meta{display:flex;gap:28px}

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
@media (max-width:768px){
  .header-meta{display:none}
  .strip span:nth-child(2){display:none}
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