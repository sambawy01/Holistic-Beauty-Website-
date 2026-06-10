"use client";

import { useState, useEffect } from "react";
import { CalendarGrid } from "./calendar-grid";
import { TimeSlotsPanel } from "./time-slots-panel";
import { useCalendarSlots } from "@/lib/booking-calendar/hooks/use-calendar-slots";
import { useIntersectionObserver } from "@/lib/booking-calendar/hooks/use-intersection-observer";

interface CalendarProps {
  eventTypeId: string;
  onSlotSelect: (slot: string) => void;
  title?: string;
  description?: string;
  showHeader?: boolean;
  userTimezone: string;
  onTimezoneChange: (timezone: string) => void;
  /** Explicit duration (minutes) for multi-duration event types */
  duration?: number;
}

export const Calendar: React.FC<CalendarProps> = ({
  eventTypeId,
  onSlotSelect,
  title,
  description,
  showHeader,
  userTimezone,
  onTimezoneChange,
  duration,
}) => {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [timeFormat, setTimeFormat] = useState<"12h" | "24h">("12h");

  // Intersection observer to detect when calendar becomes visible
  const [calendarRef, isIntersecting, hasIntersected] = useIntersectionObserver(
    {
      rootMargin: "500px",
      triggerOnce: true,
    }
  );

  // Use custom hook for slots data - only enabled when visible
  const { monthSlots, availableSlots, loading, fetchMonthSlots, fetchSlots } =
    useCalendarSlots(eventTypeId, hasIntersected, duration);

  // Auto-select today's date (regardless of availability)
  const autoSelectToday = () => {
    // Only auto-select if no date is currently selected
    if (!selectedDate) {
      const today = new Date();
      setSelectedDate(today);
      fetchSlots(today);
    }
  };

  // Handle date selection
  const handleDateSelect = (date: Date) => {
    setSelectedDate(date);
    fetchSlots(date);
  };

  // Navigation
  const goToPreviousMonth = () => {
    setCurrentDate(
      new Date(currentDate.getFullYear(), currentDate.getMonth() - 1)
    );
  };

  const goToNextMonth = () => {
    setCurrentDate(
      new Date(currentDate.getFullYear(), currentDate.getMonth() + 1)
    );
  };

  // Fetch month slots when calendar becomes visible or month changes
  useEffect(() => {
    if (hasIntersected) {
      fetchMonthSlots(currentDate);
    }
  }, [
    hasIntersected,
    currentDate.getFullYear(),
    currentDate.getMonth(),
    eventTypeId,
    fetchMonthSlots,
  ]);

  // Auto-select today's date when month slots are loaded; if a date is already
  // selected (e.g. after a duration/timezone refresh), re-derive its slot list
  // from the freshly-fetched monthSlots so the panel always shows current data.
  useEffect(() => {
    if (Object.keys(monthSlots).length > 0) {
      if (selectedDate) {
        fetchSlots(selectedDate);
      } else {
        autoSelectToday();
      }
    }
  }, [monthSlots]);

  // Refresh data when timezone or duration changes
  useEffect(() => {
    if (userTimezone) {
      // Fetch fresh data for the current month (this will update monthSlots,
      // which the effect above will then use to refresh the selected date's slots)
      fetchMonthSlots(currentDate);
    }
  }, [userTimezone, duration]);

  return (
    <div
      ref={calendarRef}
      className="bg-card overflow-hidden rounded-2xl border border-border shadow">
      {/* Optional Header */}
      {showHeader && (
        <div className="border-b border-border p-6 text-center">
          <h1 className="mb-2 text-2xl font-bold text-foreground">{title}</h1>
          <p className="text-muted-foreground">{description}</p>
        </div>
      )}

      {/* Calendar and Time Slots */}
      <div className="flex flex-col lg:flex-row">
        {/* Calendar Grid */}
        <CalendarGrid
          currentDate={currentDate}
          selectedDate={selectedDate}
          monthSlots={monthSlots}
          onDateSelect={handleDateSelect}
          onPreviousMonth={goToPreviousMonth}
          onNextMonth={goToNextMonth}
        />

        {/* Time Slots Panel */}
        <TimeSlotsPanel
          selectedDate={selectedDate}
          availableSlots={availableSlots}
          loading={loading}
          timeFormat={timeFormat}
          onTimeFormatChange={setTimeFormat}
          userTimezone={userTimezone}
          onTimezoneChange={onTimezoneChange}
          onSlotSelect={onSlotSelect}
        />
      </div>
    </div>
  );
};
