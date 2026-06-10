"use client";

import React from "react";
import type { CalcomSlot } from "@/types/booking";
import { formatTime } from "@/lib/booking-calendar/utils/date-utils";

interface TimeSlotButtonProps {
  slot: CalcomSlot;
  timeFormat: "12h" | "24h";
  timezone: string;
  onSlotSelect: (slotTime: string) => void;
}

export const TimeSlotButton: React.FC<TimeSlotButtonProps> = ({
  slot,
  timeFormat,
  timezone,
  onSlotSelect,
}) => {
  return (
    <button
      onClick={() => onSlotSelect(slot.time)}
      className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-center text-sm font-medium text-foreground transition-all hover:border-primary/50 hover:bg-secondary">
      {formatTime(slot.time, timeFormat, timezone)}
    </button>
  );
};
