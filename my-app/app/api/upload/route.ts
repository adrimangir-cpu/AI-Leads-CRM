import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    // Получаем файл от твоего браузера
    const formData = await req.formData();
    
    // Достаем ключ ImgBB из переменных окружения Vercel
    const apiKey = process.env.NEXT_PUBLIC_IMGBB_KEY;

    // Vercel (из США/Европы) отправляет запрос в ImgBB
    const res = await fetch(`https://api.imgbb.com/1/upload?key=${apiKey}`, {
      method: 'POST',
      body: formData,
    });

    const data = await res.json();
    
    if (!data.success) {
      return NextResponse.json({ error: data.error?.message }, { status: 400 });
    }

    // Возвращаем готовую ссылку обратно в браузер
    return NextResponse.json({ url: data.data.url });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}