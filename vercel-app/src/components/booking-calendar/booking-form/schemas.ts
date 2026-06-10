import { z } from 'zod';

export type BookingLang = 'en' | 'ru';

export const createBookingSchema = (lang: BookingLang = 'en') =>
  z.object({
    name: z
      .string()
      .min(1, 'Name is required')
      .min(2, 'Name must be at least 2 characters'),
    email: z.string().min(1, 'Email is required').email('Invalid email address'),
    notes: z
      .string()
      .min(1, 'Please tell us about your project')
      .min(10, 'Message must be at least 10 characters'),
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
