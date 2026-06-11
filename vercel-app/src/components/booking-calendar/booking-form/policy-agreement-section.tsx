'use client';

import { Control, Path } from 'react-hook-form';
import { ScrollText } from 'lucide-react';
import {
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from '@/components/ui/form';
import type { BookingFormData, BookingLang } from './schemas';

const COPY = {
  en: {
    heading: 'Reservation policy — please read before booking',
    label: 'I have read and agree to the reservation policy',
    rules: [
      'Confirmed sessions are payable in full even in case of lateness or no-show, unless rescheduled or cancelled at least 24 hours prior to the session.',
      'Your session ends at the booked time regardless of arrival time.',
    ],
  },
  ru: {
    heading: 'Правила записи — пожалуйста, прочитайте перед бронированием',
    label: 'Я ознакомилась и согласна с правилами записи',
    rules: [
      'Подтверждённая сессия оплачивается полностью даже при опоздании или неявке, если запись не была перенесена или отменена не позднее чем за 24 часа до сессии.',
      'Сессия заканчивается в забронированное время независимо от времени начала.',
    ],
  },
} as const;

interface PolicyAgreementSectionProps {
  control: Control<BookingFormData>;
  lang: BookingLang;
}

export const PolicyAgreementSection = ({
  control,
  lang,
}: PolicyAgreementSectionProps) => {
  const copy = COPY[lang];

  return (
    <FormField
      control={control}
      name={'agreedToPolicy' as Path<BookingFormData>}
      render={({ field }) => (
        <FormItem>
          {/* Rules are always expanded and visually prominent by design:
              clients must not be able to claim they agreed without seeing them. */}
          <div className="rounded-xl border-2 border-primary/50 bg-primary/[0.07] p-5">
            <p className="flex items-center gap-2 text-[13px] font-semibold tracking-[0.08em] uppercase text-primary">
              <ScrollText aria-hidden="true" className="h-4 w-4 shrink-0" />
              {copy.heading}
            </p>

            <ol className="mt-4 space-y-3">
              {copy.rules.map((rule, i) => (
                <li key={rule} className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[13px] font-semibold text-primary"
                  >
                    {i + 1}
                  </span>
                  <span className="text-[15px] leading-relaxed text-foreground">
                    {rule}
                  </span>
                </li>
              ))}
            </ol>

            <div className="mt-5 border-t border-primary/30 pt-4">
              <label className="flex cursor-pointer items-start gap-3">
                <FormControl>
                  <input
                    type="checkbox"
                    checked={field.value === true}
                    onChange={(e) => field.onChange(e.target.checked)}
                    onBlur={field.onBlur}
                    name={field.name}
                    ref={field.ref}
                    className="mt-0.5 size-5 shrink-0 cursor-pointer accent-primary"
                  />
                </FormControl>
                <span className="text-[15px] font-medium leading-snug text-foreground">
                  {copy.label}
                </span>
              </label>
            </div>
          </div>
          <FormMessage />
        </FormItem>
      )}
    />
  );
};
