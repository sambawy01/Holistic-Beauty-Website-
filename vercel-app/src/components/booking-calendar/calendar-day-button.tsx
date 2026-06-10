"use client";

import React from "react";
import type { CalendarDay } from "@/lib/booking-calendar/utils/date-utils";

interface CalendarDayButtonProps {
  day: CalendarDay;
  onDateSelect: (date: Date) => void;
}

export const CalendarDayButton: React.FC<CalendarDayButtonProps> = ({
  day,
  onDateSelect,
}) => {
  return (
    <button
      onClick={() => !day.disabled && onDateSelect(day.date)}
      disabled={day.disabled}
      className={`relative aspect-square rounded-lg p-2 text-sm font-medium transition-all ${
        day.isSelected
          ? "bg-primary text-primary-foreground"
          : day.isToday
          ? "bg-secondary text-foreground ring-1 ring-ring/50"
          : day.disabled
          ? "cursor-not-allowed text-muted-foreground/60"
          : day.hasSlots
          ? "text-foreground hover:bg-secondary"
          : "text-muted-foreground hover:bg-muted"
      } ${!day.isCurrentMonth ? "opacity-40" : ""}`}>
      {day.day}
      {day.hasSlots && day.isCurrentMonth && !day.disabled && (
        <div className="absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-primary" />
      )}
    </button>
  );
};
