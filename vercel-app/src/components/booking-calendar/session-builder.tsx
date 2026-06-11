"use client";

/**
 * Multi-treatment session builder for /book?service=<slug>.
 *
 * - 1 treatment selected → exact current behaviour: the service's own Cal.com
 *   event type, duration toggle for multi-duration services.
 * - 2+ treatments → slots and booking go to the shared COMBINED_SESSION event
 *   type with duration = sum of each chosen service's LONGEST duration, and a
 *   "Treatments: …" line is appended to the booking notes for Victoria.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { Plus, X } from "lucide-react";
import BookingWidget from "@/components/booking-calendar/booking-widget";
import {
  COMBINED_DURATION_OPTIONS,
  COMBINED_SESSION,
  SERVICES,
  longestDuration,
  type Service,
} from "@/lib/services";

type Lang = "en" | "ru";

const STRINGS = {
  en: {
    addTreatment: "Add another treatment to this session",
    pickerHeading: "Add treatments",
    done: "Done",
    minTotal: "min total",
    min: "min",
    overLimit: "Please contact us for sessions over 4 hours.",
    removeTreatment: "Remove treatment",
    changeTreatment: "← Change treatment",
    calendarTitle: "Choose a time that suits you",
    calendarDescription:
      "Victoria will confirm your appointment after you send the request.",
  },
  ru: {
    addTreatment: "Добавить ещё одну процедуру к сессии",
    pickerHeading: "Добавить процедуры",
    done: "Готово",
    minTotal: "мин всего",
    min: "мин",
    overLimit:
      "Для сессий длительностью более 4 часов, пожалуйста, свяжитесь с нами.",
    removeTreatment: "Убрать процедуру",
    changeTreatment: "← Выбрать другую процедуру",
    calendarTitle: "Выберите удобное время",
    calendarDescription: "Виктория подтвердит вашу запись после отправки заявки.",
  },
} as const;

function withLang(path: string, lang: Lang) {
  if (lang !== "ru") return path;
  return path.includes("?") ? `${path}&lang=ru` : `${path}?lang=ru`;
}

function durationLabel(durations: number[], lang: Lang) {
  const unit = lang === "ru" ? "мин" : "min";
  return `${durations.join(" / ")} ${unit}`;
}

/** "E£3,700" */
function formatEgp(n: number) {
  return `E£${n.toLocaleString("en-US")}`;
}

/** "5 200 ₽" (regular spaces as thousands separators) */
function formatRub(n: number) {
  return `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} ₽`;
}

interface SessionBuilderProps {
  serviceSlug: string;
  /** Resolved single-service duration from the URL (longest by default). */
  duration: number;
  lang: Lang;
}

export default function SessionBuilder({
  serviceSlug,
  duration,
  lang,
}: SessionBuilderProps) {
  const t = STRINGS[lang];
  const [extraSlugs, setExtraSlugs] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  const baseService = SERVICES.find((s) => s.slug === serviceSlug);

  const extras = useMemo(
    () =>
      extraSlugs
        .map((slug) => SERVICES.find((s) => s.slug === slug))
        .filter((s): s is Service => Boolean(s)),
    [extraSlugs]
  );

  if (!baseService) return null;

  const isMulti = extras.length > 0;
  const selected: Service[] = [baseService, ...extras];

  // Combined sessions always use the longest duration of every treatment.
  const totalMinutes = selected.reduce((sum, s) => sum + longestDuration(s), 0);
  const totalEgp = selected.reduce((sum, s) => sum + s.price.egp, 0);
  const totalRub = selected.reduce((sum, s) => sum + s.price.rub, 0);

  // 4 treatments max per session (matches the Cal event type's options set).
  const atMaxTreatments = selected.length >= 4;

  const canAdd = (candidate: Service) =>
    !atMaxTreatments &&
    COMBINED_DURATION_OPTIONS.includes(
      // When adding the first extra, the base switches to its longest duration.
      (isMulti ? totalMinutes : longestDuration(baseService)) +
        longestDuration(candidate)
    );

  const toggleExtra = (slug: string) => {
    setExtraSlugs((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]
    );
  };

  const candidates = SERVICES.filter((s) => s.slug !== baseService.slug);
  const anyBlocked = candidates.some(
    (s) => !extraSlugs.includes(s.slug) && !canAdd(s)
  );

  const multiDuration = baseService.durations.length > 1;
  const unit = t.min;

  // Treatment list for Victoria — appended to the booking notes (EN titles so
  // the line is consistent in the admin inbox and emails regardless of lang).
  const treatmentsNote = isMulti
    ? `Treatments: ${selected
        .map((s) => `${s.en.title} (${longestDuration(s)})`)
        .join(" + ")} — total ${totalMinutes} min`
    : undefined;

  const summaryLine = `${selected
    .map((s) => `${s[lang].title} ${longestDuration(s)}`)
    .join(" + ")} — ${totalMinutes} ${t.minTotal} · ${formatEgp(totalEgp)} / ${formatRub(totalRub)}`;

  return (
    <div>
      <div className="mb-8 text-center">
        <h2 className="font-serif text-2xl text-[#3A332C]">
          {baseService[lang].title}
        </h2>
        <p className="mt-2 text-sm text-[#847866]">
          {baseService.priceLine[lang]} ·{" "}
          {durationLabel(baseService.durations, lang)}
        </p>

        {/* Duration toggle — single-treatment mode only; combined sessions
            always use each treatment's longest duration. */}
        {multiDuration && !isMulti && (
          <div className="mt-4 inline-flex gap-2 rounded-full border border-[#3A332C]/10 bg-[#FFFDF9] p-1">
            {baseService.durations.map((d) => (
              <Link
                key={d}
                href={withLang(
                  `/book?service=${baseService.slug}&duration=${d}`,
                  lang
                )}
                className={
                  d === duration
                    ? "rounded-full bg-[#A9745A] px-4 py-1.5 text-sm font-medium text-[#FDF9F3]"
                    : "rounded-full px-4 py-1.5 text-sm text-[#847866] transition-colors hover:text-[#A9745A]"
                }
              >
                {d} {unit}
              </Link>
            ))}
          </div>
        )}

        {/* Add-another-treatment affordance */}
        <div className="mt-5">
          <button
            type="button"
            onClick={() => setPickerOpen((open) => !open)}
            aria-expanded={pickerOpen}
            className="inline-flex items-center gap-2 rounded-full border border-[#A9745A]/40 bg-[#FFFDF9] px-5 py-2 text-sm text-[#A9745A] transition-colors hover:border-[#A9745A] hover:bg-[#A9745A]/5"
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            {t.addTreatment}
          </button>
        </div>

        {pickerOpen && (
          <div className="mx-auto mt-4 max-w-xl rounded-2xl border border-[#3A332C]/10 bg-[#FFFDF9] p-4 text-left shadow-sm">
            <p className="mb-3 px-1 text-xs font-medium uppercase tracking-[0.15em] text-[#847866]">
              {t.pickerHeading}
            </p>
            <ul className="flex flex-col gap-1">
              {candidates.map((service) => {
                const checked = extraSlugs.includes(service.slug);
                const blocked = !checked && !canAdd(service);
                return (
                  <li key={service.slug}>
                    <label
                      className={`flex items-baseline gap-3 rounded-xl px-3 py-2.5 transition-colors ${
                        blocked
                          ? "cursor-not-allowed opacity-40"
                          : "cursor-pointer hover:bg-[#A9745A]/5"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={blocked}
                        onChange={() => toggleExtra(service.slug)}
                        className="relative top-0.5 size-4 shrink-0 cursor-pointer accent-[#A9745A] disabled:cursor-not-allowed"
                      />
                      <span className="flex-1">
                        <span className="block text-[15px] text-[#3A332C]">
                          {service[lang].title}
                        </span>
                        <span className="mt-0.5 block text-xs text-[#847866]">
                          {service.priceLine[lang]}
                        </span>
                      </span>
                      <span className="shrink-0 text-sm text-[#A9745A]">
                        {longestDuration(service)} {unit}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            {anyBlocked && (
              <p className="mt-3 rounded-xl bg-[#A9745A]/10 px-3 py-2 text-sm text-[#8A5238]">
                {t.overLimit}
              </p>
            )}
            <div className="mt-3 text-right">
              <button
                type="button"
                onClick={() => setPickerOpen(false)}
                className="rounded-full bg-[#A9745A] px-5 py-1.5 text-sm font-medium text-[#FDF9F3] transition-opacity hover:opacity-90"
              >
                {t.done}
              </button>
            </div>
          </div>
        )}

        {/* Session summary — chips + totals */}
        {isMulti && (
          <div className="mx-auto mt-4 max-w-xl">
            <div className="flex flex-wrap items-center justify-center gap-2">
              {selected.map((service, i) => (
                <span
                  key={service.slug}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[#A9745A]/30 bg-[#A9745A]/10 py-1.5 pl-3.5 pr-2.5 text-sm text-[#8A5238]"
                >
                  {service[lang].title} {longestDuration(service)}
                  {i === 0 ? (
                    <span className="w-1" aria-hidden="true" />
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggleExtra(service.slug)}
                      aria-label={`${t.removeTreatment}: ${service[lang].title}`}
                      className="rounded-full p-0.5 transition-colors hover:bg-[#A9745A]/20"
                    >
                      <X aria-hidden="true" className="h-3.5 w-3.5" />
                    </button>
                  )}
                </span>
              ))}
            </div>
            <p className="mt-3 text-sm font-medium text-[#3A332C]">
              {summaryLine}
            </p>
          </div>
        )}

        <p className="mt-4 text-sm">
          <Link
            href={withLang("/book", lang)}
            className="text-[#A9745A] underline-offset-4 hover:underline"
          >
            {t.changeTreatment}
          </Link>
        </p>
      </div>

      <BookingWidget
        // Reset widget state (selected slot/form) whenever the session changes.
        key={isMulti ? `combined-${totalMinutes}-${extraSlugs.join("+")}` : `single-${duration}`}
        eventTypeId={String(
          isMulti ? COMBINED_SESSION.eventTypeId : baseService.eventTypeId
        )}
        eventLength={isMulti ? totalMinutes : duration}
        multiDuration={isMulti ? true : multiDuration}
        treatmentsNote={treatmentsNote}
        lang={lang}
        title={t.calendarTitle}
        description={t.calendarDescription}
        showHeader
      />
    </div>
  );
}
