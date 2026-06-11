import Image from "next/image";
import Link from "next/link";
import SessionBuilder from "@/components/booking-calendar/session-builder";
import { SERVICES, getServiceBySlug } from "@/lib/services";

export const metadata = {
  title: "Book — Victoria Vasilyeva Holistic Beauty",
};

const WHATSAPP_LINK = "https://wa.me/79388883431";
const MAIN_SITE_EN = "https://victoriaholisticbeauty.com/";
const MAIN_SITE_RU = "https://victoriaholisticbeauty.com/ru.html";

type Lang = "en" | "ru";

function withLang(path: string, lang: Lang) {
  if (lang !== "ru") return path;
  return path.includes("?") ? `${path}&lang=ru` : `${path}?lang=ru`;
}

function durationLabel(durations: number[], lang: Lang) {
  const unit = lang === "ru" ? "мин" : "min";
  return `${durations.join(" / ")} ${unit}`;
}

function MissingConfigNotice({ lang }: { lang: Lang }) {
  const text =
    lang === "ru"
      ? "Онлайн-календарь скоро появится — запишитесь в WhatsApp"
      : "Online calendar coming soon — book instantly on WhatsApp";
  const cta = lang === "ru" ? "Написать в WhatsApp" : "Open WhatsApp";
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-8 rounded-2xl border border-[#A9745A]/30 bg-[#FFFDF9] px-8 py-16 text-center shadow-sm">
      <p className="font-serif text-2xl leading-snug text-[#3A332C]">{text}</p>
      <a
        href={WHATSAPP_LINK}
        className="rounded-full bg-[#A9745A] px-8 py-3 font-medium text-[#FDF9F3] transition-opacity hover:opacity-90"
      >
        {cta}
      </a>
    </div>
  );
}

function ServicePicker({ lang }: { lang: Lang }) {
  return (
    <div className="mx-auto max-w-2xl">
      <p className="mb-8 text-center text-[#847866]">
        {lang === "ru"
          ? "Выберите процедуру, чтобы посмотреть свободное время."
          : "Choose a treatment to see available times."}
      </p>
      <ul className="flex flex-col gap-3">
        {SERVICES.map((service) => (
          <li key={service.slug}>
            <Link
              href={withLang(`/book?service=${service.slug}`, lang)}
              className="group flex items-baseline justify-between gap-4 rounded-xl border border-[#3A332C]/10 bg-[#FFFDF9] px-6 py-5 shadow-sm transition-colors hover:border-[#A9745A]/50"
            >
              <span>
                <span className="block font-serif text-lg text-[#3A332C] transition-colors group-hover:text-[#A9745A]">
                  {service[lang].title}
                </span>
                <span className="mt-1 block text-sm text-[#847866]">
                  {service.priceLine[lang]}
                </span>
              </span>
              <span className="shrink-0 text-sm text-[#A9745A]">
                {durationLabel(service.durations, lang)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default async function BookPage({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string; service?: string; duration?: string }>;
}) {
  const {
    lang: langParam,
    service: serviceParam,
    duration: durationParam,
  } = await searchParams;
  const lang: Lang = langParam === "ru" ? "ru" : "en";

  const service = getServiceBySlug(serviceParam);
  const calcomConfigured = Boolean(process.env.CALCOM_API_KEY);
  const mainSite = lang === "ru" ? MAIN_SITE_RU : MAIN_SITE_EN;

  // Resolve requested duration; fall back to the longest available.
  const requestedDuration = durationParam ? parseInt(durationParam, 10) : NaN;
  const duration =
    service && service.durations.includes(requestedDuration)
      ? requestedDuration
      : service
        ? Math.max(...service.durations)
        : 60;

  return (
    <main className="flex flex-1 flex-col px-6 py-12">
      <div className="mx-auto w-full max-w-3xl">
        <header className="mb-10 text-center">
          <a
            href={mainSite}
            className="mb-6 inline-block"
            aria-label="Victoria Vasilyeva Holistic Beauty — main site"
          >
            {/* logo asset is white-on-transparent; recolor to deep warm brown */}
            <Image
              src="/logo-white.png"
              alt="Victoria Vasilyeva Holistic Beauty"
              width={152}
              height={77}
              priority
              className="mx-auto h-auto w-36 opacity-85 [filter:brightness(0)_sepia(0.25)]"
            />
          </a>
          <p className="mb-3 text-sm uppercase tracking-[0.3em] text-[#A9745A]">
            Holistic Beauty
          </p>
          <h1 className="font-serif text-3xl font-medium text-[#3A332C] sm:text-4xl">
            {lang === "ru" ? "Запись на приём" : "Book an Appointment"}
          </h1>
          <p className="mt-3 text-sm text-[#847866]">
            {lang === "ru"
              ? "Обратите внимание: Виктория принимает только женщин."
              : "Please note: Victoria works with female clients only."}
          </p>
        </header>

        {!calcomConfigured ? (
          <MissingConfigNotice lang={lang} />
        ) : service ? (
          <SessionBuilder
            serviceSlug={service.slug}
            lang={lang}
            duration={duration}
          />
        ) : (
          <ServicePicker lang={lang} />
        )}

        <p className="mt-12 text-center text-sm text-[#847866]">
          <a href={mainSite} className="underline-offset-4 hover:underline">
            ← Victoria Vasilyeva Holistic Beauty
          </a>
        </p>
      </div>
    </main>
  );
}
