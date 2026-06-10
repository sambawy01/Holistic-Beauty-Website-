'use client';

import { useId, useState } from 'react';
import { Control, Path } from 'react-hook-form';
import { ChevronDown } from 'lucide-react';
import {
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from '@/components/ui/form';
import type { BookingFormData, BookingLang } from './schemas';

const COPY = {
  en: {
    label: 'I have read and agree to the reservation policy',
    toggle: 'View policy',
    rules: [
      'Confirmed sessions are payable in full even in case of lateness or no-show, unless rescheduled or cancelled in advance.',
      'Your session ends at the booked time regardless of arrival time.',
      'Rescheduling or cancellation is free up to 24 hours before the session; later changes are charged in full.',
    ],
  },
  ru: {
    label: 'Я ознакомилась и согласна с правилами записи',
    toggle: 'Посмотреть правила',
    rules: [
      'Подтверждённая сессия оплачивается полностью даже при опоздании или неявке, если запись не была перенесена или отменена заранее.',
      'Сессия заканчивается в забронированное время независимо от времени начала.',
      'Перенос или отмена возможны не позднее чем за 24 часа до сессии; более поздние изменения оплачиваются полностью.',
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
  const [expanded, setExpanded] = useState(false);
  const rulesId = useId();
  const copy = COPY[lang];

  return (
    <FormField
      control={control}
      name={'agreedToPolicy' as Path<BookingFormData>}
      render={({ field }) => (
        <FormItem>
          <div className="rounded-xl border border-border bg-muted/40 p-4">
            <label className="flex cursor-pointer items-start gap-3">
              <FormControl>
                <input
                  type="checkbox"
                  checked={field.value === true}
                  onChange={(e) => field.onChange(e.target.checked)}
                  onBlur={field.onBlur}
                  name={field.name}
                  ref={field.ref}
                  className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
                />
              </FormControl>
              <span className="text-sm leading-snug text-foreground">
                {copy.label}
              </span>
            </label>

            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              aria-controls={rulesId}
              className="mt-2 ml-7 inline-flex cursor-pointer items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
            >
              {copy.toggle}
              <ChevronDown
                aria-hidden="true"
                className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`}
              />
            </button>

            {expanded && (
              <ul
                id={rulesId}
                className="mt-3 ml-7 list-disc space-y-2 pl-4 text-sm leading-relaxed text-muted-foreground"
              >
                {copy.rules.map((rule) => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>
            )}
          </div>
          <FormMessage />
        </FormItem>
      )}
    />
  );
};
