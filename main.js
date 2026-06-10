/* Desert Lagoon — motion choreography
   Progressive enhancement: page is fully readable with JS off or reduced motion. */
(() => {
  // CSS gates the nav's hidden state behind .has-js so no-JS users always see it.
  document.documentElement.classList.add("has-js");

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const nav = document.getElementById("nav");

  // Nav visibility works in all modes
  const hero = document.getElementById("hero");
  const navObserver = new IntersectionObserver(
    ([e]) => nav.classList.toggle("visible", !e.isIntersecting),
    { threshold: 0.08 }
  );
  navObserver.observe(hero);

  if (reduced || !window.gsap || !window.ScrollTrigger || !window.Lenis) return; // static experience

  document.documentElement.classList.add("js");
  gsap.registerPlugin(ScrollTrigger);

  // ---- Smooth scroll (Lenis) ----
  const lenis = new Lenis({ lerp: 0.09 });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);

  // ---- Hero load sequence ----
  const name = document.getElementById("heroName");
  name.setAttribute("aria-label", name.textContent);
  name.innerHTML = `<span aria-hidden="true">` + name.textContent
    .split("")
    .map((c) => (c.trim() === "" ? " " : `<span class="ch">${c}</span>`))
    .join("") + `</span>`;
  gsap.set(name, { opacity: 1 });
  gsap.timeline()
    .from(".hero-name .ch", { yPercent: 60, opacity: 0, duration: 0.9, stagger: 0.035, ease: "power3.out" }, 0.15)
    .to(".hero .reveal-soft", { opacity: 1, y: 0, duration: 0.8, stagger: 0.12, ease: "power2.out" }, "-=0.45");

  // ---- Hero parallax scroll-out ----
  gsap.to(".hero-media", {
    yPercent: 18, ease: "none",
    scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: true },
  });
  gsap.to(".hero-content", {
    yPercent: -28, opacity: 0, ease: "none",
    scrollTrigger: { trigger: ".hero", start: "top top", end: "70% top", scrub: true },
  });

  // ---- Generic reveals ----
  document.querySelectorAll("main .reveal").forEach((el) => {
    gsap.to(el, {
      opacity: 1, y: 0, duration: 1, ease: "power3.out",
      scrollTrigger: { trigger: el, start: "top 84%" },
    });
  });

  // ---- Image entrances ----
  document.querySelectorAll(".img-reveal img").forEach((img) => {
    gsap.to(img, {
      scale: 1, duration: 1.4, ease: "power2.out",
      scrollTrigger: { trigger: img, start: "top 85%" },
    });
  });

  // ---- Treatments cascade ----
  gsap.utils.toArray(".t-list").forEach((list) => {
    gsap.from(list.querySelectorAll(".t-row"), {
      opacity: 0, y: 24, duration: 0.7, stagger: 0.07, ease: "power2.out",
      scrollTrigger: { trigger: list, start: "top 82%" },
    });
  });

  // ---- Treatment hover photo (desktop pointer only) ----
  const tPhoto = document.getElementById("tPhoto");
  if (tPhoto && window.matchMedia("(hover: hover) and (min-width: 900px)").matches) {
    const img = tPhoto.querySelector("img");
    document.querySelectorAll(".t-row").forEach((row) => {
      row.addEventListener("mouseenter", () => {
        img.src = row.dataset.photo;
        tPhoto.style.opacity = "1";
        tPhoto.style.clipPath = "inset(0 0 0% 0)";
      });
      row.addEventListener("mouseleave", () => {
        tPhoto.style.opacity = "0";
        tPhoto.style.clipPath = "inset(0 0 100% 0)";
      });
      row.addEventListener("mousemove", (e) => {
        tPhoto.style.left = Math.min(e.clientX + 28, window.innerWidth - 260) + "px";
        tPhoto.style.top = Math.max(16, Math.min(e.clientY - 140, window.innerHeight - 304)) + "px";
      });
    });
  }

  // ---- Setting parallax (water rising) ----
  gsap.fromTo(".setting-media img",
    { yPercent: -10 }, {
      yPercent: 10, ease: "none",
      scrollTrigger: { trigger: ".setting", start: "top bottom", end: "bottom top", scrub: true },
    });

  // ---- Anchor links through Lenis ----
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener("click", (e) => {
      const href = a.getAttribute("href");
      if (!href || href.length < 2) return;
      const target = document.getElementById(href.slice(1));
      if (target) { e.preventDefault(); lenis.scrollTo(target, { offset: 0 }); }
    });
  });
})();
