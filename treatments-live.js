/* Live treatments menu — progressive enhancement over the server-rendered
   treatment rows on index.html / ru.html.

   Fetches GET <API_BASE>/api/treatments (Victoria edits prices, durations,
   names and visibility from /admin) and reconciles the static rows in place:
   - a row whose treatment no longer exists or was deactivated is hidden;
   - a row whose name/duration/price differs from the EMBEDDED seed below is
     rewritten with the live values (rows still matching the seed keep their
     richer server-rendered text, e.g. multi-duration price ranges);
   - treatments that have no row yet are appended to the first list, with the
     same markup (t-link to /book?service=slug, lang preserved).

   If this script or the fetch fails, the server-rendered rows stay as-is —
   exactly like shop.js's embedded-fallback pattern. */
(function () {
  "use strict";

  var IS_LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  var API_BASE = IS_LOCAL
    ? "http://localhost:3000"
    : "https://book.victoriaholisticbeauty.com";
  var TREATMENTS_URL = API_BASE + "/api/treatments";
  var BOOK_BASE = "https://book.victoriaholisticbeauty.com/book";

  /* ===================================================================
     EMBEDDED SEED — mirrors SEED in vercel-app/src/lib/treatments.ts.
     Used only for change detection: while the API returns these exact
     values for a slug, its server-rendered row is left untouched.
     n = canonical names (EN/RU), d = minutes, e = EGP, r = RUB.
     =================================================================== */
  var SEED = {
    "facial-massage": { n: { en: "Facial Massage", ru: "Массаж лица" }, d: 90, e: 3350, r: 4700 },
    "body-massage": { n: { en: "Medical Body Massage", ru: "Медицинский массаж тела" }, d: 60, e: 3350, r: 4700 },
    "microcurrent-rf": { n: { en: "Microcurrent / RF Therapy", ru: "Микротоки · RF-терапия" }, d: 20, e: 1100, r: 1600 },
    "hydrofacial": { n: { en: "HydroFacial + Ultrasonic Cleaning", ru: "HydroFacial + ультразвуковая чистка" }, d: 90, e: 3700, r: 5200 },
    "clear-skin-holy-land": { n: { en: "Clear Skin with HOLY LAND", ru: "Чистая кожа с HOLY LAND" }, d: 60, e: 1800, r: 2500 },
    "carboxytherapy": { n: { en: "Non-Invasive Carboxytherapy", ru: "Неинвазивная карбокситерапия" }, d: 30, e: 1300, r: 1800 },
    "mandelic-peel": { n: { en: "Mandelic Onmacabim Peel", ru: "Миндальный пилинг Onmacabim" }, d: 20, e: 1700, r: 2300 },
    "alginate-mask": { n: { en: "Alginate Mask", ru: "Альгинатная маска" }, d: 30, e: 1100, r: 1600 },
    "dermapen-face-neck-decollete": { n: { en: "Derma Pen — Full Face + Neck + Décolletage", ru: "Дермапен — лицо + шея + декольте" }, d: 90, e: 4550, r: 6400 },
    "dermapen-face-neck": { n: { en: "Derma Pen — Full Face + Neck", ru: "Дермапен — лицо + шея" }, d: 60, e: 3350, r: 4700 },
    "dermapen-single-area": { n: { en: "Derma Pen — Single Area", ru: "Дермапен — одна зона" }, d: 30, e: 2500, r: 3500 }
  };
  /* ========================= end SEED ================================ */

  var LANG = (document.documentElement.lang || "en").toLowerCase().indexOf("ru") === 0 ? "ru" : "en";
  var NBSP = "\u00A0";

  /* "£2,300" — the EN pages' price format (comma thousands). */
  function formatEgp(n) {
    return "£" + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  /* "3 100 ₽" with non-breaking spaces — the RU pages' price format. */
  function formatRub(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP) + NBSP + "₽";
  }

  /* Render the .t-price contents: "£3,350 <small>90m</small>" /
     "4 700 ₽ <small>90 мин</small>" — copied from the existing rows. */
  function renderPrice(priceEl, t) {
    while (priceEl.firstChild) priceEl.removeChild(priceEl.firstChild);
    priceEl.appendChild(
      document.createTextNode(
        (LANG === "ru" ? formatRub(t.priceRub) : formatEgp(t.priceEgp)) + " "
      )
    );
    var small = document.createElement("small");
    small.textContent =
      LANG === "ru" ? t.durationMinutes + " мин" : t.durationMinutes + "m";
    priceEl.appendChild(small);
  }

  function slugFromLink(a) {
    try {
      return new URL(a.href).searchParams.get("service");
    } catch (_) {
      return null;
    }
  }

  function bookHref(slug) {
    return BOOK_BASE + "?service=" + encodeURIComponent(slug) + (LANG === "ru" ? "&lang=ru" : "");
  }

  function buildRow(t) {
    var li = document.createElement("li");
    li.className = "t-row";

    var name = document.createElement("span");
    name.className = "t-name";
    var link = document.createElement("a");
    link.className = "t-link";
    link.href = bookHref(t.slug);
    link.textContent = t.name[LANG] || t.name.en;
    name.appendChild(link);
    var descText = t.description && (t.description[LANG] || t.description.en);
    if (descText) {
      name.appendChild(document.createTextNode(" "));
      var sub = document.createElement("span");
      sub.className = "t-sub";
      sub.textContent = descText;
      name.appendChild(sub);
    }

    var price = document.createElement("span");
    price.className = "t-price";
    renderPrice(price, t);

    var arrow = document.createElement("span");
    arrow.className = "t-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "→";

    li.appendChild(name);
    li.appendChild(price);
    li.appendChild(arrow);
    return li;
  }

  /* Structural check on one API entry — everything apply()/buildRow() reads.
     A malformed entry must never reach the reconciler: hiding rows for a
     garbled payload would blank the whole public menu. */
  function isValidTreatment(t) {
    return Boolean(
      t &&
        typeof t === "object" &&
        typeof t.slug === "string" &&
        t.slug &&
        t.name &&
        typeof t.name === "object" &&
        typeof t.name.en === "string" &&
        t.name.en &&
        (t.name.ru === undefined || typeof t.name.ru === "string") &&
        (t.description === undefined ||
          t.description === null ||
          typeof t.description === "object") &&
        typeof t.durationMinutes === "number" &&
        isFinite(t.durationMinutes) &&
        typeof t.priceEgp === "number" &&
        isFinite(t.priceEgp) &&
        typeof t.priceRub === "number" &&
        isFinite(t.priceRub)
    );
  }

  function apply(rawTreatments) {
    /* Skip invalid entries; if NOTHING valid remains, bail out entirely and
       leave the server-rendered rows untouched — a corrupt API response must
       degrade to the static menu, never hide it. */
    var treatments = [];
    for (var v = 0; v < rawTreatments.length; v++) {
      if (isValidTreatment(rawTreatments[v])) treatments.push(rawTreatments[v]);
    }
    if (treatments.length === 0) return;

    var bySlug = {};
    for (var i = 0; i < treatments.length; i++) bySlug[treatments[i].slug] = treatments[i];

    var seen = {};
    var links = document.querySelectorAll('.t-row .t-link[href*="service="]');
    for (var j = 0; j < links.length; j++) {
      var a = links[j];
      var row = a.closest ? a.closest(".t-row") : null;
      if (!row) continue;
      var slug = slugFromLink(a);
      if (!slug) continue;
      seen[slug] = true;

      var t = bySlug[slug];
      if (!t) {
        // Deactivated or removed — hide the server-rendered row.
        row.style.display = "none";
        continue;
      }
      row.style.display = "";

      var s = SEED[slug];
      var liveName = t.name[LANG] || t.name.en;
      if (!s || liveName !== (s.n[LANG] || s.n.en)) {
        a.textContent = liveName;
      }
      if (!s || t.priceEgp !== s.e || t.priceRub !== s.r || t.durationMinutes !== s.d) {
        var priceEl = row.querySelector(".t-price");
        if (priceEl) renderPrice(priceEl, t);
      }
    }

    // New treatments (no server-rendered row yet) → append to the first list.
    var firstList = document.querySelector(".treatments .t-list");
    if (!firstList) return;
    for (var k = 0; k < treatments.length; k++) {
      var nt = treatments[k];
      if (!seen[nt.slug]) firstList.appendChild(buildRow(nt));
    }
  }

  function init() {
    fetch(TREATMENTS_URL)
      .then(function (res) {
        if (!res.ok) throw new Error("treatments fetch failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        if (data && Array.isArray(data.treatments)) apply(data.treatments);
      })
      .catch(function () {
        /* offline / API down — the server-rendered menu stays as-is */
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
