import { NextRequest, NextResponse } from "next/server";
import { applyRateLimit } from "@/lib/booking-calendar/utils/rate-limiting";

interface BookingRequestV2 {
  start: string;
  attendee: {
    name: string;
    email: string;
    /** Verified: lands on attendees[].phoneNumber and is auto-mirrored to bookingFieldsResponses.attendeePhoneNumber */
    phoneNumber?: string;
    timeZone: string;
    language?: string;
  };
  eventTypeId: number;
  lengthInMinutes?: number;
  metadata?: Record<string, string | number | boolean>;
  bookingFieldsResponses?: Record<string, string | string[]>;
}

export async function POST(request: NextRequest) {
  // Apply rate limiting (disabled in development)
  const rateLimitCheck = await applyRateLimit("cal-booking");
  if (!rateLimitCheck.allowed) {
    return (
      rateLimitCheck.response ||
      NextResponse.json(
        { error: "Too many booking requests. Please try again later." },
        { status: 429 }
      )
    );
  }

  if (!process.env.CALCOM_API_KEY) {
    return NextResponse.json(
      { error: "Cal.com API key not configured" },
      { status: 500 }
    );
  }

  if (!process.env.CALCOM_API_URL) {
    return NextResponse.json(
      { error: "Cal.com API URL not configured" },
      { status: 500 }
    );
  }

  try {
    const bookingData = await request.json();

    // Validate required fields
    if (
      !bookingData.eventTypeId ||
      !bookingData.start ||
      !bookingData.attendee
    ) {
      return NextResponse.json(
        { error: "Missing required booking data" },
        { status: 400 }
      );
    }

    // Validate and parse eventTypeId
    const eventTypeId = parseInt(bookingData.eventTypeId);
    if (isNaN(eventTypeId) || eventTypeId <= 0) {
      return NextResponse.json(
        { error: "Invalid eventTypeId: must be a valid positive number" },
        { status: 400 }
      );
    }

    // Ensure notes is always a string
    let notes = String(
      bookingData.metadata?.notes || "No additional notes provided"
    );

    // Sanitize phone: strip spaces/dashes/parens, then require E.164-ish shape.
    // If it doesn't pass Cal-safe validation, surface it via notes instead so
    // Victoria still sees it and the booking never fails because of the phone.
    let phoneNumber: string | undefined;
    if (typeof bookingData.attendee.phoneNumber === "string") {
      const normalized = bookingData.attendee.phoneNumber
        .replace(/[\s\-()]/g, "")
        .slice(0, 32);
      if (/^\+?[0-9]{8,17}$/.test(normalized)) {
        phoneNumber = normalized;
      } else if (normalized.length > 0) {
        notes = `Phone: ${normalized}\n${notes}`;
      }
    }

    // Format the booking data for Cal.com v2 API
    const calcomBookingData: BookingRequestV2 = {
      start: bookingData.start,
      attendee: {
        name: bookingData.attendee.name,
        email: bookingData.attendee.email,
        ...(phoneNumber && { phoneNumber }),
        timeZone: bookingData.attendee.timeZone,
        language: "en",
      },
      eventTypeId,
      // Optional: explicit duration for multi-duration event types
      ...(bookingData.lengthInMinutes &&
        !isNaN(parseInt(bookingData.lengthInMinutes)) && {
          lengthInMinutes: parseInt(bookingData.lengthInMinutes),
        }),
      // ALL form fields must go in bookingFieldsResponses for v2 API
      bookingFieldsResponses: {
        name: bookingData.attendee.name,
        email: bookingData.attendee.email,
        notes,
        "discovery-method": bookingData.metadata?.referralSource,
      },
    };

    const apiUrl = `${process.env.CALCOM_API_URL}/bookings`;

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.CALCOM_API_KEY}`,
        "cal-api-version": "2024-08-13",
      },
      body: JSON.stringify(calcomBookingData),
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error("Cal.com booking error:", {
        status: response.status,
        statusText: response.statusText,
        errorData: errorData,
        requestData: calcomBookingData,
      });
      return NextResponse.json(
        {
          error: "Failed to create booking with Cal.com",
          details: errorData,
          status: response.status,
        },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("Error creating Cal.com booking:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
