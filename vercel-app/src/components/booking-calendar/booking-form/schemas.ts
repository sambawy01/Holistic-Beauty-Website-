import { z } from 'zod';

export type BookingLang = 'en' | 'ru';

export const createBookingSchema = (lang: BookingLang = 'en') =>
  z.object({
    name: z
      .string()
      .min(1, lang === 'ru' ? 'Укажите имя' : 'Name is required')
      .min(2, lang === 'ru' ? 'Имя слишком короткое' : 'Name must be at least 2 characters'),
    email: z
      .string()
      .min(1, lang === 'ru' ? 'Укажите эл. почту' : 'Email is required')
      .email(lang === 'ru' ? 'Неверный адрес эл. почты' : 'Invalid email address'),
    notes: z.string().optional().or(z.literal('')),
    guests: z
      .array(z.string().email('Please enter valid email addresses'))
      .optional(),
    referralSource: z
      .enum(['google', 'twitter', 'instagram', 'facebook'])
      .optional(),
    agreedToPolicy: z.boolean().refine((value) => value === true, {
      message:
        lang === 'ru'
          ? 'Пожалуйста, подтвердите согласие с правилами записи.'
          : 'Please confirm you agree to the reservation policy.',
    }),
  });

export const bookingSchema = createBookingSchema('en');

export type BookingFormData = z.infer<typeof bookingSchema>;
