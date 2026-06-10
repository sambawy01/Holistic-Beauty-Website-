import { UseFormSetValue, UseFormWatch } from 'react-hook-form';
import { Label } from '@/components/ui/label';
import { BookingFormData } from './schemas';

const referralOptions = [
  { value: 'google', label: 'Google' },
  { value: 'twitter', label: 'Twitter' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'facebook', label: 'Facebook' },
] as const;

interface ReferralSectionProps {
  watch: UseFormWatch<BookingFormData>;
  setValue: UseFormSetValue<BookingFormData>;
}

export const ReferralSection: React.FC<ReferralSectionProps> = ({
  watch,
  setValue,
}) => {
  const selectedReferralSource = watch('referralSource');

  return (
    <div className="space-y-4">
      <Label className="font-medium text-foreground uppercase">
        How did you find us?
      </Label>
      
      <div className="grid grid-cols-2 gap-3">
        {referralOptions.map((option) => (
          <label
            key={option.value}
            className={`group relative cursor-pointer rounded-lg border p-4 transition-all duration-200 ${
              selectedReferralSource === option.value
                ? 'border-primary bg-primary/10'
                : 'border-border bg-muted/50 hover:border-primary/50'
            }`}
          >
            <input
              type="radio"
              value={option.value}
              checked={selectedReferralSource === option.value}
              onChange={() => setValue('referralSource', option.value)}
              className="absolute opacity-0"
            />
            <div className="flex items-center gap-3">
              <span
                className={`text-sm font-medium ${
                  selectedReferralSource === option.value
                    ? 'text-primary'
                    : 'text-foreground/80 group-hover:text-foreground'
                }`}
              >
                {option.label}
              </span>
            </div>
            {selectedReferralSource === option.value && (
              <div className="absolute top-3 right-3">
                <div className="h-2 w-2 rounded-full bg-primary"></div>
              </div>
            )}
          </label>
        ))}
      </div>
    </div>
  );
};