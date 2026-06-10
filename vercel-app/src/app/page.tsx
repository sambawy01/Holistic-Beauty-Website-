import Link from "next/link";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-10 px-6 py-24 text-center">
      <div>
        <p className="mb-3 text-sm uppercase tracking-[0.3em] text-[#C98E4A]">
          Holistic Beauty
        </p>
        <h1 className="font-serif text-4xl font-medium sm:text-5xl">
          Victoria Vasilyeva
        </h1>
      </div>
      <div className="flex flex-col items-center gap-4 sm:flex-row">
        <Link
          href="/book"
          className="rounded-full bg-[#C98E4A] px-8 py-3 font-medium text-[#100D0B] transition-opacity hover:opacity-90"
        >
          Book an appointment
        </Link>
        <a
          href="https://sambawy01.github.io/Holistic-Beauty-Website-/"
          className="rounded-full border border-[#C98E4A]/50 px-8 py-3 text-[#F2E7D8] transition-colors hover:border-[#C98E4A]"
        >
          Back to main site
        </a>
      </div>
    </main>
  );
}
