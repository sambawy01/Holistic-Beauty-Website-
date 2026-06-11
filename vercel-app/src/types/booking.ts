export interface TimeSlot {
  time: string;
  available: boolean;
}

export interface BookingFormData {
  name: string;
  email: string;
  phone: string;
  notes: string;
  referralSource?: 'google' | 'twitter' | 'instagram' | 'facebook';
}

export interface CalcomSlot {
  time: string;
  attendees: number;
  bookingUid?: string;
}

export interface CalcomBookingRequest {
  eventTypeId: string | number;
  start: string;
  end: string;
  /** Explicit duration for multi-duration event types */
  lengthInMinutes?: number;
  attendee: {
    name: string;
    email: string;
    /** E.164-ish, normalized client-side (no spaces/dashes/parens) */
    phoneNumber?: string;
    timeZone: string;
  };
  metadata?: {
    notes?: string;
    referralSource?: string;
    [key: string]: string | undefined;
  };
  bookingFieldsResponses?: {
    [key: string]: string;
  };
}

export interface CalcomBookingResponse {
  id: string;
  uid: string;
  title: string;
  start: string;
  end: string;
  duration?: number;
  status?: string; // "pending" when owner confirmation is required
  attendees: Array<{
    email: string;
    name: string;
  }>;
  // Keep backward compatibility
  startTime?: string;
  endTime?: string;
}

export interface CalcomEventType {
  id: string;
  title: string;
  slug: string;
  length: number;
  description?: string;
}

// New interfaces for reschedule and cancel operations
export interface RescheduleRequest {
  bookingUid: string;
  start: string;
  rescheduledBy?: string;
  reschedulingReason?: string;
}

export interface CancelRequest {
  bookingUid: string;
  cancellationReason?: string;
}

export interface RescheduleResponse {
  success: boolean;
  booking?: CalcomBookingResponse;
  message?: string;
}

export interface CancelResponse {
  success: boolean;
  message?: string;
}
