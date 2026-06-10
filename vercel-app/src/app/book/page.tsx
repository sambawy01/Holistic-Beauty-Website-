import Link from "next/link";
import BookingWidget from "@/components/booking-calendar/booking-widget";

export const metadata = {
  title: "Book — Victoria Vasilyeva Holistic Beauty",
};

const WHATSAPP_LINK = "https://wa.me/79388883431";

function MissingConfigNotice({ lang }: { lang: "en" | "ru" }) {
  const text =
    lang === "ru"
      ? "Онлайн-календарь скоро появится — запишитесь в WhatsApp"
      : "Online calendar coming soon — book instantly on WhatsApp";
  const cta = lang === "ru" ? "Написать в WhatsApp" : "Open WhatsApp";
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-8 rounded-2xl border border-[#C98E4A]/30 bg-[#1A1512] px-8 py-16 text-center">
      <p className="font-serif text-2xl leading-snug text-[#F2E7D8]">{text}</p>
      <a
        href={WHATSAPP_LINK}
        className="rounded-full bg-[#C98E4A] px-8 py-3 font-medium text-[#100D0B] transition-opacity hover:opacity-90"
      >
        {cta}
      </a>
    </div>
  );
}

export default async function BookPage({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string }>;
}) {
  const { lang: langParam } = await searchParams;
  const lang: "en" | "ru" = langParam === "ru" ? "ru" : "en";

  const eventTypeId = process.env.NEXT_PUBLIC_CALCOM_EVENT_TYPE_ID;
  const calcomConfigured = Boolean(process.env.CALCOM_API_KEY && eventTypeId);

  return (
    <main className="flex flex-1 flex-col px-6 py-16">
      <div className="mx-auto w-full max-w-3xl">
        <header className="mb-12 text-center">
          <p className="mb-3 text-sm uppercase tracking-[0.3em] text-[#C98E4A]">
            Holistic Beauty
          </p>
          <h1 className="font-serif text-3xl font-medium sm:text-4xl">
            {lang === "ru" ? "Запись на приём" : "Book an Appointment"}
          </h1>
        </header>

        {calcomConfigured ? (
          <BookingWidget
            eventTypeId={eventTypeId!}
            eventLength={60}
            title={
              lang === "ru" ? "Выберите удобное время" : "Choose a time that suits you"
            }
            description={
              lang === "ru"
                ? "Подтверждение придёт на вашу электронную почту."
                : "You will receive a confirmation by email."
            }
            showHeader
          />
        ) : (
          <MissingConfigNotice lang={lang} />
        )}

        <p className="mt-12 text-center text-sm text-[#B3A392]">
          <Link href="/" className="underline-offset-4 hover:underline">
            ← Victoria Vasilyeva Holistic Beauty
          </Link>
        </p>
      </div>
    </main>
  );
}
