import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { isValidAdminKey, isValidBasicAuth } from "@/lib/admin/auth";
import { listOwnerBookings, type CalBooking } from "@/lib/admin/cal";
import { listOrders, type StoredOrder } from "@/lib/orders";
import { getCatalog, type Product } from "@/lib/catalog";
import AdminInbox from "./admin-inbox";
import OrdersSection from "./orders-section";
import ProductsSection from "./products-section";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Admin — Victoria Vasilyeva Holistic Beauty",
  robots: { index: false, follow: false },
};

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // Auth happens in the proxy (which answers 401 + WWW-Authenticate so the
  // browser shows its native Basic login prompt). This re-check is defense
  // in depth: Basic credentials OR the legacy ?key= link from old emails.
  const { key } = await searchParams;
  const legacyKey =
    typeof key === "string" && isValidAdminKey(key) ? key : "";
  const requestHeaders = await headers();
  const basicOk = isValidBasicAuth(requestHeaders.get("authorization"));
  if (!basicOk && !legacyKey) notFound();

  // When authenticated via Basic, the browser re-attaches the Authorization
  // header to every same-origin fetch, so client components can send an
  // empty x-admin-key — the API routes accept either credential.
  const clientKey = legacyKey;

  let bookings: CalBooking[] = [];
  let loadError: string | null = null;
  let orders: StoredOrder[] = [];
  let ordersError: string | null = null;
  let products: Product[] = [];
  let productsError: string | null = null;
  // Bookings (Cal.com), shop orders and the catalog (Vercel Blob) load
  // independently — one backend being down must not blank the others.
  const [bookingsResult, ordersResult, catalogResult] =
    await Promise.allSettled([
      listOwnerBookings(),
      listOrders({ limit: 100 }),
      getCatalog(),
    ]);
  if (bookingsResult.status === "fulfilled") {
    bookings = bookingsResult.value;
  } else {
    console.error("Admin inbox load error:", bookingsResult.reason);
    loadError = "Couldn't load bookings from Cal.com. Pull down to refresh or try again shortly.";
  }
  if (ordersResult.status === "fulfilled") {
    orders = ordersResult.value;
  } else {
    console.error("Admin orders load error:", ordersResult.reason);
    ordersError = "Couldn't load shop orders. Pull down to refresh or try again shortly.";
  }
  if (catalogResult.status === "fulfilled") {
    products = catalogResult.value;
  } else {
    console.error("Admin catalog load error:", catalogResult.reason);
    productsError = "Couldn't load the product catalog. Pull down to refresh or try again shortly.";
  }

  const now = Date.now();
  const pending = bookings.filter((b) => b.status === "pending");
  const confirmed = bookings.filter(
    (b) => b.status === "accepted" && new Date(b.start).getTime() > now
  );

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6">
      <header className="mb-8">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-[#847866]">
          Victoria Vasilyeva Holistic Beauty
        </p>
        <h1 className="mt-2 font-serif text-4xl text-[#3A332C]">Booking inbox</h1>
        <p className="mt-2 text-sm text-[#847866]">
          Times shown in Cairo time (Africa/Cairo).
        </p>
      </header>

      {loadError ? (
        <div className="rounded-2xl border border-[#B5483A]/30 bg-[#FFFDF9] px-6 py-5 text-sm text-[#B5483A]">
          {loadError}
        </div>
      ) : (
        <AdminInbox pending={pending} confirmed={confirmed} adminKey={clientKey} />
      )}

      <div className="mt-10">
        <OrdersSection
          orders={orders}
          adminKey={clientKey}
          loadError={ordersError}
        />
      </div>

      <div className="mt-10">
        <ProductsSection
          initialProducts={products}
          adminKey={clientKey}
          loadError={productsError}
        />
      </div>
    </main>
  );
}
