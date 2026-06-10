# Victoria Vasilyeva — Holistic Beauty: Landing Page Redesign

**Date:** 2026-06-10
**Status:** Approved by user
**Replaces:** current `index.html` (dark bento layout, Tailwind CDN)

## Brief

Redesign the one-page site into a super-elegant, cinematic luxury experience. The hero must carry the brand message: **luxury & exclusivity**, anchored in El Gouna. Cutting-edge motion and effects, curated photography, class-leading hero.

Decisions made with the user:

| Dimension | Decision |
|---|---|
| Brand message | Luxury & exclusivity |
| Motion intensity | Cinematic & immersive |
| Photography | Curated stock (license-free), downloaded locally |
| Structure | One page, all current content retained |
| Booking CTA | WhatsApp deep link (number currently placeholder) |
| Visual direction | **Desert Lagoon** — warm sand, deep teal, bronze |
| Build approach | Static HTML + GSAP ScrollTrigger + Lenis (no build step) |

## Visual System

- **Palette:** warm sand `#EDE3D3`, deeper sand `#D9C4A0` (light canvas); deep teal `#16494E`, near-black teal `#0D2E31` (immersive sections); bronze `#B08D57` reserved for prices, CTAs, accents. Sections alternate light/dark — sunlight into water.
- **Typography:** display serif with true italic (Fraunces, fallback Cormorant Garamond) for headlines/wordmark; geometric sans (Jost) for body; labels in wide-tracked uppercase. Oversized headline scale.
- **Photography treatment:** uniform grade on all images — warm highlights, teal-shifted shadows, subtle film grain overlay — so stock reads as one commissioned shoot. ~6 images, WebP, compressed, in `assets/img/`. Hero preloaded, others lazy-loaded.

## Page Flow (single scroll)

1. **Hero — "Arrival."** Full viewport. Golden-hour Red Sea lagoon photo, slow Ken Burns drift (30s loop), deep-teal gradient wash + grain. Wordmark "Victoria Vasilyeva" in large italic serif revealed character-by-character on load (~1.2s); "HOLISTIC BEAUTY · EL GOUNA" in small caps fades beneath. One line of copy: "Medical-grade artistry. Red Sea calm." Single CTA "Reserve Your Treatment" (bronze outline, shimmer sweep on hover → WhatsApp). Scroll cue: thin vertical line that draws itself, breathing. No nav initially; minimal nav (Treatments · About · Reserve) fades in after the hero.
2. **Philosophy — "The Approach."** Two-three sentence manifesto (medical-grade techniques + mindful restoration) beside portrait-format texture photo. Line-by-line text reveal.
3. **Signature Treatments.** All 11 services and current prices, as full-width interactive rows: serif name, duration, bronze right-aligned price. Desktop hover reveals soft photo behind row (clip-path wipe); mobile rows expand on tap. Cascading stagger on scroll-in.
4. **The Setting.** Wide slow-parallax lagoon image; "Ten years of holistic skin & body care" stat; El Gouna location. Breathing-room section.
5. **In Her Words.** Single testimonial, large italic serif quote, minimal.
6. **Reserve — "Begin."** Dark teal closing field: wordmark, WhatsApp CTA, email + location. One-line footer.

## Motion System

- Lenis smooth scroll site-wide.
- GSAP + ScrollTrigger: upward-mask reveals for headlines/copy; image scale 1.08→1.0 on entry; pinned light→dark section transition (teal slides over sand like rising water).
- Micro-interactions: CTA shimmer, row hover photo wipe, nav fade, breathing scroll-line.
- Restraint rules: one shared easing family; durations 0.6–1.2s; only hero drift and scroll-line loop; full `prefers-reduced-motion` fallback (static layout, simple fades).

## Technical

- **Files:** `index.html`, `styles.css`, `main.js`, `assets/img/*` (WebP), existing `assets/logo-white.png` retained where it fits.
- **CDN:** GSAP + ScrollTrigger, Lenis, Google Fonts (Fraunces, Jost). Tailwind CDN removed.
- **Content:** all services/prices, testimonial, contact details carried over verbatim from current `index.html`. WhatsApp number remains placeholder `wa.me/200000000000` until the real number is provided; email placeholder likewise (see README to-do).
- **Performance budget:** total page < 1.5MB; hero paint < 1s on 4G; 60fps scroll on mobile. Verified empirically with the gstack browse tool (screenshots, console, perf) before completion.
- **Accessibility/SEO:** semantic landmarks, WCAG AA contrast within the palette, reduced-motion support, meta description + OG tags, single H1.
- **Deploy:** unchanged — GitHub Pages from `main` root.

## Out of Scope

- Real photography (stock structured for later swap-in)
- Multi-page expansion, blog, booking form/backend
- Replacing placeholder WhatsApp/email (content task, not design)

## Acceptance Criteria

1. Hero communicates luxury & exclusivity with cinematic load sequence and parallax scroll-out.
2. All 11 treatments with current prices present and legible on mobile and desktop.
3. Motion system runs at 60fps on a mid-range phone viewport; reduced-motion honored.
4. No console errors; no Tailwind CDN production warning; page weight under budget.
5. WhatsApp CTA opens chat with pre-filled message.
6. Site deploys on GitHub Pages with no build step.
