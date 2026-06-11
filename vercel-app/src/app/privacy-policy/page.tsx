import Link from "next/link";

export const metadata = {
  title: "Privacy Policy — Victoria Vasilyeva Holistic Beauty",
  robots: { index: false },
};

const COPY = {
  en: {
    title: "Privacy Policy",
    back: "← Back to booking",
    body: [
      "We collect your name, email address and mobile number solely to manage your booking: to confirm, reschedule or cancel your appointment and to contact you about it.",
      "Bookings are processed through Cal.com, our scheduling provider, which stores your booking details on our behalf. We do not sell or share your information with anyone else.",
      "Messages you send to Vassili, our AI assistant, are processed to generate a reply and are not used to identify you.",
      "To ask about or delete your data, write to victoria@victoriaholisticbeauty.com.",
    ],
  },
  ru: {
    title: "Политика конфиденциальности",
    back: "← Назад к записи",
    body: [
      "Мы собираем ваше имя, адрес электронной почты и номер телефона исключительно для управления записью: подтверждения, переноса или отмены визита и связи с вами по этому поводу.",
      "Записи обрабатываются через Cal.com — наш сервис планирования, который хранит данные бронирования от нашего имени. Мы не продаём и не передаём ваши данные третьим лицам.",
      "Сообщения, которые вы отправляете Василию, нашему AI-ассистенту, обрабатываются только для формирования ответа и не используются для вашей идентификации.",
      "По вопросам о ваших данных или для их удаления напишите на victoria@victoriaholisticbeauty.com.",
    ],
  },
} as const;

export default async function PrivacyPolicy({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string }>;
}) {
  const { lang } = await searchParams;
  const t = COPY[lang === "ru" ? "ru" : "en"];
  const backHref = lang === "ru" ? "/book?lang=ru" : "/book";

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="font-serif text-3xl text-foreground">{t.title}</h1>
      <div className="mt-6 space-y-4 text-[15px] leading-relaxed text-muted-foreground">
        {t.body.map((p) => (
          <p key={p}>{p}</p>
        ))}
      </div>
      <p className="mt-10">
        <Link href={backHref} className="text-primary underline underline-offset-4">
          {t.back}
        </Link>
      </p>
    </main>
  );
}
