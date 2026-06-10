'use client';

import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { CalcomBookingResponse } from '@/types/booking';

interface RescheduleConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isLoading: boolean;
  booking: CalcomBookingResponse | null;
  newSlot: string | null;
  userTimezone: string;
}

export const RescheduleConfirmationModal: React.FC<
  RescheduleConfirmationModalProps
> = ({
  isOpen,
  onClose,
  onConfirm,
  isLoading,
  booking,
  newSlot,
  userTimezone,
}) => {
  const handleClose = () => {
    onClose();
  };

  return (
    <AlertDialog open={isOpen} onOpenChange={onClose}>
      <AlertDialogContent
        className="border-border bg-card"
        aria-describedby="reschedule-description"
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="text-foreground">
            Confirm Reschedule
          </AlertDialogTitle>
        </AlertDialogHeader>

        <div className="space-y-4 px-6 pb-2">
          <div id="reschedule-description" className="text-muted-foreground">
            Are you sure you want to reschedule your meeting?
          </div>

          {booking && newSlot && (
            <div className="space-y-2 rounded-lg bg-muted/50 p-4">
              <div className="flex items-center gap-3">
                <div className="w-12 rounded bg-destructive/10 px-2 py-1 text-center">
                  <span className="text-xs font-medium text-destructive">FROM</span>
                </div>
                <div className="flex-1 text-sm">
                  <span className="font-medium text-foreground">
                    {new Date(
                      booking.start || booking.startTime || ''
                    ).toLocaleDateString('en-US', {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                      timeZone: userTimezone,
                    })}
                  </span>
                  <span className="mx-2 text-muted-foreground">•</span>
                  <span className="text-muted-foreground">
                    {new Date(
                      booking.start || booking.startTime || ''
                    ).toLocaleTimeString('en-US', {
                      hour: 'numeric',
                      minute: '2-digit',
                      timeZone: userTimezone,
                    })}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="w-12 rounded bg-green-600/10 px-2 py-1 text-center">
                  <span className="text-xs font-medium text-green-700">TO</span>
                </div>
                <div className="flex-1 text-sm">
                  <span className="font-medium text-foreground">
                    {new Date(newSlot).toLocaleDateString('en-US', {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                      timeZone: userTimezone,
                    })}
                  </span>
                  <span className="mx-2 text-muted-foreground">•</span>
                  <span className="text-muted-foreground">
                    {new Date(newSlot).toLocaleTimeString('en-US', {
                      hour: 'numeric',
                      minute: '2-digit',
                      timeZone: userTimezone,
                    })}
                  </span>
                </div>
              </div>
            </div>
          )}

          <div className="text-sm text-muted-foreground">
            Your original meeting time will be replaced and you&apos;ll receive
            a new confirmation email.
          </div>
        </div>

        <AlertDialogFooter>
          <div className="flex w-full gap-3">
            <Button
              onClick={handleClose}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              onClick={onConfirm}
              className="flex-1"
              disabled={isLoading}
            >
              {isLoading ? 'Rescheduling...' : 'Confirm Reschedule'}
            </Button>
          </div>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
