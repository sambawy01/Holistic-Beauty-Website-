import { Control, FieldValues, Path } from 'react-hook-form';
import {
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';

interface ContactSectionProps<T extends FieldValues> {
  control: Control<T>;
  lang?: "en" | "ru";
}

const CONTACT_STRINGS = {
  en: {
    label: "Contact Information",
    name: "Full name",
    email: "Email",
    notes: "Anything Victoria should know before your session? (optional)",
  },
  ru: {
    label: "Контактные данные",
    name: "Имя и фамилия",
    email: "Эл. почта",
    notes: "Что Виктории стоит знать перед сеансом? (необязательно)",
  },
} as const;

export const ContactSection = <T extends FieldValues>({ control, lang = "en" }: ContactSectionProps<T>) => {
  const t = CONTACT_STRINGS[lang];
  return (
    <div className="space-y-4">
      <Label className="font-medium text-foreground uppercase">
        {t.label}
      </Label>
      
      <div className="flex flex-col gap-4 sm:flex-row">
        {/* Name Field */}
        <FormField
          control={control}
          name={'name' as Path<T>}
          render={({ field }) => (
            <FormItem className="w-full">
              <FormControl>
                <Input
                  type="text"
                  placeholder={t.name}
                  {...field}
                  className="h-12 bg-muted text-foreground border-border focus-visible:border-primary focus-visible:ring-primary/50"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Email Field */}
        <FormField
          control={control}
          name={'email' as Path<T>}
          render={({ field }) => (
            <FormItem className="w-full">
              <FormControl>
                <Input
                  type="email"
                  placeholder={t.email}
                  {...field}
                  className="h-12 bg-muted text-foreground border-border focus-visible:border-primary focus-visible:ring-primary/50"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      {/* Message/Notes Field */}
      <FormField
        control={control}
        name={'notes' as Path<T>}
        render={({ field }) => (
          <FormItem>
            <FormControl>
              <Textarea
                placeholder={t.notes}
                {...field}
                rows={5}
                className="h-36 resize-none bg-muted text-foreground border-border focus-visible:border-primary focus-visible:ring-primary/50"
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
};