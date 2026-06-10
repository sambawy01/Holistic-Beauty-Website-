/* Treatment info cards — Earthen Calm
   Progressive enhancement over the booking links: clicking a treatment row
   opens an info card; "Book Now" carries the row's original booking URL
   (service slug + lang intact). If this script fails, rows stay plain links. */
(() => {
  "use strict";

  const COPY = {
    "facial-massage": {
      "en": {
        "title": "Facial Massage",
        "sub": "Plastic · Myofascial · Buccal",
        "body": "A sculpting ritual that works where creams cannot — deep in the muscles that hold your expression. Victoria combines plastic, myofascial and intraoral buccal techniques to release accumulated tension, redefine the line of the jaw and cheekbones, and restore a naturally lifted look. You leave with softer features, lighter skin and a face that feels truly rested.",
        "detail": "60 or 90 min · E£1,900–2,800 · 2 600–3 900 ₽"
      },
      "ru": {
        "title": "Массаж лица",
        "sub": "Пластический · Миофасциальный · Буккальный",
        "body": "Скульптурный ритуал, который работает там, куда не добраться кремам, — в глубоких мышцах лица. Виктория сочетает пластические, миофасциальные и буккальные техники, включая интраоральную проработку, чтобы снять накопившееся напряжение, очертить линию скул и подбородка и вернуть лицу естественную подтянутость. После сеанса черты выглядят мягче, кожа — свежее, а лицо — по-настоящему отдохнувшим.",
        "detail": "60 или 90 мин · E£1,900–2,800 · 2 600–3 900 ₽"
      }
    },
    "body-massage": {
      "en": {
        "title": "Medical Body Massage",
        "sub": "Therapeutic · Physician-Informed",
        "body": "Bodywork shaped by a physician's understanding of anatomy. Victoria reads the body before working on it — easing tight shoulders, an overloaded back, legs heavy after long days. Each session balances therapeutic depth with genuine comfort, supporting circulation and recovery. Choose a focused 40 minutes or a full hour of unhurried, intelligent work.",
        "detail": "40 or 60 min · E£2,100–2,800 · 2 900–3 900 ₽"
      },
      "ru": {
        "title": "Медицинский массаж тела",
        "sub": "Терапевтический · С врачебным подходом",
        "body": "Массаж, в основе которого — врачебное понимание анатомии. Виктория сначала «читает» тело и только потом работает с ним: освобождает зажатые плечи, уставшую спину, тяжёлые после долгого дня ноги. Терапевтическая глубина здесь сочетается с настоящим комфортом, поддерживая кровообращение и восстановление. Выбирайте сфокусированные 40 минут или целый час неторопливой, осмысленной работы.",
        "detail": "40 или 60 мин · E£2,100–2,800 · 2 900–3 900 ₽"
      }
    },
    "microcurrent-rf": {
      "en": {
        "title": "Microcurrent / RF Therapy",
        "sub": "Tone · Firmness · Lymphatic Drainage",
        "body": "Twenty quiet minutes that fit into a lunch break. Gentle microcurrents work with the tone of the facial muscles while soft radiofrequency warmth supports firmness and lymphatic drainage, leaving the face looking refreshed and subtly defined. No downtime, no redness — just a composed, awake reflection before you return to your day.",
        "detail": "20 min · E£900 · 1 300 ₽"
      },
      "ru": {
        "title": "Микротоки · RF-терапия",
        "sub": "Тонус · Упругость · Лимфодренаж",
        "body": "Двадцать тихих минут, которые легко вписать в обеденный перерыв. Деликатные микротоки работают с тонусом лицевых мышц, а мягкое тепло радиочастот поддерживает упругость кожи и лимфодренаж — лицо выглядит посвежевшим и слегка подтянутым. Без покраснений и восстановительного периода: только собранное, отдохнувшее отражение в зеркале, прежде чем вы вернётесь к делам.",
        "detail": "20 мин · E£900 · 1 300 ₽"
      }
    },
    "hydrofacial": {
      "en": {
        "title": "HydroFacial + Ultrasonic Cleaning",
        "sub": "Onmacabim Cosmeceuticals",
        "body": "A deep, water-based cleanse that treats the skin gently while reaching what daily care cannot. Ultrasonic cleaning lifts away congestion, soft exfoliation refines the surface, and Onmacabim cosmeceuticals infuse hydration layer by layer. Skin emerges clean, comfortable and luminous — the kind of glow that needs no filter, and a quiet hour that feels like a reset.",
        "detail": "60–90 min · E£3,100 · 4 300 ₽"
      },
      "ru": {
        "title": "HydroFacial + ультразвуковая чистка",
        "sub": "Космецевтика Onmacabim",
        "body": "Глубокое очищение на водной основе — бережное к коже и при этом достающее то, с чем не справляется домашний уход. Ультразвук деликатно освобождает поры, мягкая эксфолиация выравнивает рельеф, а космецевтика Onmacabim послойно насыщает кожу влагой. В результате — чистая, спокойная, сияющая кожа: то самое свечение, которому не нужны фильтры.",
        "detail": "60–90 мин · E£3,100 · 4 300 ₽"
      }
    },
    "clear-skin-holy-land": {
      "en": {
        "title": "Clear Skin with HOLY LAND",
        "sub": "Fruit Peel & Hydro Mask",
        "body": "A clarifying ritual created for congested, blemish-prone skin. Professional Israeli cosmeceuticals from HOLY LAND pair a fruit-acid peel with a deeply quenching hydro mask: pores are gently purified, the skin's balance is supported, and the complexion is left calm rather than stripped. An honest hour of care for skin that asks for clarity.",
        "detail": "60 min · E£1,500 · 2 100 ₽"
      },
      "ru": {
        "title": "Чистая кожа с HOLY LAND",
        "sub": "Фруктовый пилинг и гидромаска",
        "body": "Очищающий ритуал для кожи, склонной к воспалениям и закупоренным порам. Профессиональная израильская космецевтика HOLY LAND соединяет фруктовый пилинг с насыщенной гидромаской: поры мягко очищаются, баланс кожи поддерживается, а сама она остаётся спокойной — без ощущения стянутости. Честный час ухода для кожи, которой нужна чистота.",
        "detail": "60 мин · E£1,500 · 2 100 ₽"
      }
    },
    "carboxytherapy": {
      "en": {
        "title": "Non-Invasive Carboxytherapy",
        "sub": "CO2 Mask Therapy",
        "body": "Oxygen for skin that looks tired. A non-invasive CO2 mask stimulates microcirculation, encouraging the skin to draw in oxygen and wake up from within. Thirty minutes later the face appears rested and quietly radiant — a favourite before events, after long flights, or whenever your reflection seems more tired than you actually feel.",
        "detail": "30 min · E£1,100 · 1 500 ₽"
      },
      "ru": {
        "title": "Неинвазивная карбокситерапия",
        "sub": "CO2-маска",
        "body": "Кислород для уставшей кожи. Неинвазивная маска с CO2 активизирует микроциркуляцию, помогая коже насыщаться кислородом и словно просыпаться изнутри. Через тридцать минут лицо выглядит отдохнувшим и мягко сияющим. Любимая процедура перед важными событиями, после долгих перелётов — и всякий раз, когда отражение в зеркале кажется более усталым, чем вы себя чувствуете.",
        "detail": "30 мин · E£1,100 · 1 500 ₽"
      }
    },
    "mandelic-peel": {
      "en": {
        "title": "Mandelic Onmacabim Peel",
        "sub": "All-Season Lifting",
        "body": "Renewal that does not wait for the right season. Mandelic acid, the gentlest of the AHAs, works in twenty minutes to soften texture, refine tone and lend the skin a polished, even look — and unlike classic peels, it suits the whole year, even under the Egyptian sun. Onmacabim's formula keeps the experience comfortable from first minute to last.",
        "detail": "20 min · E£1,400 · 1 900 ₽"
      },
      "ru": {
        "title": "Миндальный пилинг Onmacabim",
        "sub": "Всесезонный лифтинг",
        "body": "Обновление без оглядки на сезон. Миндальная кислота — самая деликатная из AHA-кислот — за двадцать минут смягчает рельеф, выравнивает тон и придаёт коже ухоженный, отполированный вид. В отличие от классических пилингов, она подходит круглый год, даже под египетским солнцем. Формула Onmacabim делает процедуру комфортной от первой до последней минуты.",
        "detail": "20 мин · E£1,400 · 1 900 ₽"
      }
    },
    "alginate-mask": {
      "en": {
        "title": "Alginate Mask",
        "sub": "Cooling · Sculpting · Soothing",
        "body": "A cool, sculpting veil that sets softly over the skin, sealing in actives and calming everything beneath. Alginate brings an instant surge of hydration and a pleasantly refreshed, gently tightened feeling — the perfect closing note after a peel, massage or cleansing, or simply thirty minutes of stillness that belong entirely to you.",
        "detail": "30 min · E£900 · 1 300 ₽"
      },
      "ru": {
        "title": "Альгинатная маска",
        "sub": "Прохлада · Моделирование · Комфорт",
        "body": "Прохладная моделирующая маска ложится на кожу мягким вторым слоем, запечатывая активные компоненты и успокаивая всё, что под ней. Альгинат дарит мгновенное увлажнение и приятное ощущение свежести и подтянутости. Идеальный финальный аккорд после пилинга, массажа или чистки — или просто тридцать минут тишины, которые принадлежат только вам.",
        "detail": "30 мин · E£900 · 1 300 ₽"
      }
    },
    "dermapen-face-neck-decollete": {
      "en": {
        "title": "Derma Pen — Full Face + Neck + Décolletage",
        "sub": "Microneedling · Collagen Induction",
        "body": "The most complete renewal in the studio. Precise microneedling across the face, neck and décolletage encourages the skin's own collagen production, working on texture, fine lines and firmness in the zones where time shows first. Performed by physician-trained hands, with medical attention to sterility and depth — ninety minutes invested in skin that carries itself differently.",
        "detail": "90 min · E£3,800 · 5 300 ₽"
      },
      "ru": {
        "title": "Дермапен — лицо + шея + декольте",
        "sub": "Микронидлинг · Стимуляция коллагена",
        "body": "Самое полное обновление в студии. Прицельный микронидлинг лица, шеи и зоны декольте побуждает кожу вырабатывать собственный коллаген, работая с текстурой, мелкими морщинами и упругостью именно там, где время заметно прежде всего. Процедуру проводят руки с врачебной подготовкой — с медицинским вниманием к стерильности и глубине. Девяносто минут, вложенные в кожу.",
        "detail": "90 мин · E£3,800 · 5 300 ₽"
      }
    },
    "dermapen-face-neck": {
      "en": {
        "title": "Derma Pen — Full Face + Neck",
        "sub": "Microneedling · Collagen Induction",
        "body": "Collagen induction for the face and neck — the duo that frames every first impression. Fine microneedles create controlled micro-stimulation, prompting the skin to renew itself: a smoother texture, softer lines, a firmer feel over time. An hour of precise, physician-trained work, with quiet attention given to every pass and every centimetre of skin.",
        "detail": "60 min · E£2,800 · 3 900 ₽"
      },
      "ru": {
        "title": "Дермапен — лицо + шея",
        "sub": "Микронидлинг · Стимуляция коллагена",
        "body": "Стимуляция коллагена для лица и шеи — дуэта, который первым встречает каждый взгляд. Тончайшие микроиглы создают контролируемую микростимуляцию, побуждая кожу обновляться самостоятельно: рельеф становится ровнее, линии — мягче, кожа со временем ощущается более плотной. Час точной работы рук с врачебной подготовкой — и внимание к каждому движению, к каждому сантиметру кожи.",
        "detail": "60 мин · E£2,800 · 3 900 ₽"
      }
    },
    "dermapen-single-area": {
      "en": {
        "title": "Derma Pen — Single Area",
        "sub": "Targeted Microneedling",
        "body": "Microneedling focused exactly where you want it — the forehead, the cheeks, the area around the eyes or lips, or another single zone of your choice. Thirty minutes of concentrated collagen stimulation help refine texture and support firmness in the place that matters most to you, with the same physician-trained precision as a full session.",
        "detail": "30 min · E£2,100 · 2 900 ₽"
      },
      "ru": {
        "title": "Дермапен — одна зона",
        "sub": "Точечный микронидлинг",
        "body": "Микронидлинг точно там, где это нужно вам: лоб, щёки, зона вокруг глаз или губ — одна область на ваш выбор. Тридцать минут концентрированной стимуляции коллагена помогают улучшить текстуру и поддержать упругость именно в той зоне, которая важна для вас, — с той же врачебной точностью, что и полный сеанс.",
        "detail": "30 мин · E£2,100 · 2 900 ₽"
      }
    }
  };

  const lang = (document.documentElement.lang || "en").toLowerCase().indexOf("ru") === 0 ? "ru" : "en";
  const T = lang === "ru"
    ? { book: "Записаться", ask: "или спросите Василия", close: "Закрыть" }
    : { book: "Book Now", ask: "or ask Vasili", close: "Close" };

  let overlay = null;
  let dialog = null;
  let lastFocus = null;

  function build() {
    overlay = document.createElement("div");
    overlay.className = "tmodal-overlay";
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="tmodal" role="dialog" aria-modal="true" aria-labelledby="tmodal-title" tabindex="-1">' +
        '<button class="tmodal-close" type="button" aria-label="' + T.close + '">' +
          '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">' +
            '<path d="M3 3l12 12M15 3L3 15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
          "</svg>" +
        "</button>" +
        '<h3 class="tmodal-title" id="tmodal-title"></h3>' +
        '<p class="tmodal-sub"></p>' +
        '<p class="tmodal-body"></p>' +
        '<p class="tmodal-detail"></p>' +
        '<div class="tmodal-actions">' +
          '<a class="tmodal-book"></a>' +
          '<button class="tmodal-wa" type="button" data-open-chat></button>' +
        "</div>" +
      "</div>";
    document.body.appendChild(overlay);
    dialog = overlay.querySelector(".tmodal");

    overlay.querySelector(".tmodal-wa").textContent = T.ask;
    overlay.querySelector(".tmodal-book").textContent = T.book;

    // "or ask Vasili": close the modal first; chat.js's delegated
    // [data-open-chat] listener then opens the chat card.
    overlay.querySelector(".tmodal-wa").addEventListener("click", close);

    // Backdrop click closes (but clicks inside the card don't).
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });

    overlay.querySelector(".tmodal-close").addEventListener("click", close);

    // Escape + focus trap (Tab cycles within the card).
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = overlay.querySelectorAll("button, a[href]");
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || active === dialog) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  function open(slug, trigger) {
    const entry = COPY[slug];
    if (!entry) return false;
    const c = entry[lang] || entry.en;
    if (!c) return false;
    if (!overlay) build();

    overlay.querySelector(".tmodal-title").textContent = c.title;
    overlay.querySelector(".tmodal-sub").textContent = c.sub;
    overlay.querySelector(".tmodal-body").textContent = c.body;
    overlay.querySelector(".tmodal-detail").textContent = c.detail;
    // Same href the row carried — slug and &lang=ru stay correct.
    overlay.querySelector(".tmodal-book").setAttribute("href", trigger.getAttribute("href"));

    lastFocus = trigger;
    overlay.hidden = false;
    document.documentElement.classList.add("tmodal-open");
    dialog.focus();
    return true;
  }

  function close() {
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    document.documentElement.classList.remove("tmodal-open");
    if (lastFocus) {
      lastFocus.focus();
      lastFocus = null;
    }
  }

  document.addEventListener("click", (e) => {
    // Let modified clicks (new tab, etc.) behave like normal links.
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest ? e.target.closest('.t-row a[href*="service="]') : null;
    if (!a) return;
    let slug = null;
    try {
      slug = new URL(a.href).searchParams.get("service");
    } catch (_) { /* malformed href — fall through to navigation */ }
    if (!slug || !COPY[slug]) return; // unknown service: plain navigation
    e.preventDefault();
    open(slug, a);
  });
})();
