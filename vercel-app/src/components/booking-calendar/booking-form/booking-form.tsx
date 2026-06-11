"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type {
  CalcomBookingRequest,
  CalcomBookingResponse,
} from "@/types/booking";
import { calculateEndTime } from "@/lib/booking-calendar/utils/form-utils";
import { createBookingSchema, BookingFormData, BookingLang } from "./schemas";
import { MeetingDetails } from "./meeting-details";
import { ContactSection } from "./contact-section";
import { ReferralSection } from "./referral-section";
import { PolicyAgreementSection } from "./policy-agreement-section";
import Link from "next/link";

interface BookingFormProps {
  selectedSlot: string;
  eventTypeId: string;
  eventLength: number; // in minutes
  userTimezone: string; // User's selected timezone
  /** Send the explicit length to Cal.com (multi-duration event types) */
  sendLengthInMinutes?: boolean;
  /** Multi-treatment sessions: appended to the booking notes for Victoria. */
  treatmentsNote?: string;
  lang?: BookingLang;
  onSuccess: (booking: CalcomBookingResponse) => void;
  onBack: () => void;
}


const FORM_STRINGS = {
  en: {
    back: "Back",
    confirm: "Confirm",
    confirming: "Confirming...",
    privacyPre: "By sending, you agree to our",
    privacyLink: "Privacy policy",
    privacyPost: "and the processing of your data.",
  },
  ru: {
    back: "Назад",
    confirm: "Подтвердить",
    confirming: "Подтверждаем...",
    privacyPre: "Отправляя форму, вы соглашаетесь с",
    privacyLink: "политикой конфиденциальности",
    privacyPost: "и обработкой ваших данных.",
  },
} as const;

export const BookingForm: React.FC<BookingFormProps> = ({
  selectedSlot,
  eventTypeId,
  eventLength,
  userTimezone,
  sendLengthInMinutes,
  treatmentsNote,
  lang = "en",
  onSuccess,
  onBack,
}) => {
  const [loading, setLoading] = useState(false);

  const ft = FORM_STRINGS[lang] ?? FORM_STRINGS.en;
  const form = useForm<BookingFormData>({
    resolver: zodResolver(createBookingSchema(lang)),
    defaultValues: {
      name: "",
      email: "",
      phone: "",
      notes: "",
      referralSource: undefined,
      agreedToPolicy: false,
    },
  });

  const handleSubmit = async (data: BookingFormData) => {
    setLoading(true);

    try {
      const endTime = calculateEndTime(selectedSlot, eventLength);

      // Normalize phone: strip spaces, dashes and parentheses (keep leading +)
      const normalizedPhone = data.phone.replace(/[\s\-()]/g, "");

      // Multi-treatment sessions: the treatments line must reach Victoria, so
      // it is appended to whatever the client wrote in the notes field.
      const notes = [data.notes?.trim(), treatmentsNote]
        .filter(Boolean)
        .join("\n\n");

      const bookingData: CalcomBookingRequest = {
        eventTypeId,
        start: selectedSlot,
        end: endTime,
        ...(sendLengthInMinutes && { lengthInMinutes: eventLength }),
        attendee: {
          name: data.name,
          email: data.email,
          phoneNumber: normalizedPhone,
          timeZone: userTimezone,
        },
        metadata: {
          ...(data.referralSource && { referralSource: data.referralSource }),
          ...(notes && { notes }),
        },
        bookingFieldsResponses: {
          ...(data.referralSource && { referral_source: data.referralSource }),
          ...(notes && { notes }),
        },
      };

      const response = await fetch("/api/booking-calendar/book", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(bookingData),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to create booking");
      }

      const result = await response.json();
      const booking = result.data || result;
      onSuccess(booking);
    } catch (error) {
      console.error("Booking error:", error);
      form.setError("root", {
        message:
          error instanceof Error
            ? error.message
            : "Failed to book meeting. Please try again.",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-card overflow-hidden rounded-2xl border border-border shadow p-6">
      {/* Meeting Details */}
      <div className="mb-8">
        <MeetingDetails
          selectedSlot={selectedSlot}
          eventLength={eventLength}
          userTimezone={userTimezone}
        />
      </div>

      {/* Booking Form */}
      <Form {...form}>
        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
          {/* Contact Information */}
          <ContactSection control={form.control} lang={lang} />

          {/* Referral Source */}
          <ReferralSection watch={form.watch} setValue={form.setValue} />

          {/* Reservation Policy Agreement */}
          <PolicyAgreementSection control={form.control} lang={lang} />

          {/* Error Display */}
          {form.formState.errors.root && (
            <Alert className="border-destructive/20 bg-destructive/10">
              <AlertDescription className="text-destructive">
                {form.formState.errors.root.message}
              </AlertDescription>
            </Alert>
          )}

          {/* Form Actions */}
          <div className="flex gap-3">
            <Button
              variant="outline"
              size='lg'
              onClick={onBack}
              className="flex-1 cursor-pointer h-12"
              >
              {ft.back}
            </Button>
            <Button
              disabled={loading}
              size='lg'
              className="flex-1 cursor-pointer h-12">
              {loading ? ft.confirming : ft.confirm}
            </Button>
          </div>

          {/* Privacy Policy Text */}
          <p className="text-center text-sm text-muted-foreground">
            {ft.privacyPre}{" "}
            <Link
              href={lang === "ru" ? "/privacy-policy?lang=ru" : "/privacy-policy"}
              className="font-medium text-foreground underline hover:text-primary transition-colors">
              {ft.privacyLink}
            </Link>{" "}
            {ft.privacyPost}
          </p>
        </form>
      </Form>
    </div>
  );
};
