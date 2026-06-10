import { formatDateTime } from '@/lib/booking-calendar/utils/form-utils';

interface MeetingDetailsProps {
  selectedSlot: string;
  eventLength: number;
  userTimezone: string;
}

export const MeetingDetails: React.FC<MeetingDetailsProps> = ({
  selectedSlot,
  eventLength,
  userTimezone,
}) => {
  const { dateStr, timeStr } = formatDateTime(selectedSlot, userTimezone);

  return (
    <div className="border border-border bg-muted p-4 rounded-md">
      <div>
        <div className="text-lg pb-2 font-medium text-foreground">Meeting details</div>
      </div>
      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Date:</span>
          <span className="text-foreground">{dateStr}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Time:</span>
          <span className="text-foreground">{timeStr}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Duration:</span>
          <span className="text-foreground">{eventLength} minutes</span>
        </div>
      </div>
    </div>
  );
};