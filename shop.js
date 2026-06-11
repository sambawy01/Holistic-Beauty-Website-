/* ===== Studio Shop — products, cart, cash-on-delivery order flow =====
   Vanilla IIFE, no dependencies. Cart persists in localStorage ("vv-cart").
   Order POSTs { items:[{slug, qty}], name, phone, email?, address, note, lang }
   to /api/order on the booking host. `email` is optional — when provided the
   server sends the buyer an order-confirmation email. */
(function () {
  "use strict";

  /* =====================================================================
     PRODUCT DATA — the single source of truth for the shop.
     Real Onmacabim retail products carried by the studio (onmacabim-prof.com).
     Slugs and prices MUST stay identical to
     vercel-app/src/lib/shop-products.ts — the server recomputes totals
     from its own copy, so any drift breaks orders.
     `photo` points at a 900×900 JPEG in assets/img/shop/.
     `alt` is the per-language image description. If `photo` is null the
     card falls back to the tinted-gradient-and-initial placeholder art.
     `desc` is short marketing copy, rendered in the product detail modal.
     Prices: `egp` in Egyptian pounds, `rub` in roubles.
     ===================================================================== */
  var PRODUCTS = [
    {
      slug: "tohar-hamidbar-concentrate",
      name: { en: "Tohar Hamidbar No.2 Herbal Concentrate", ru: "Травяной концентрат Tohar Hamidbar №2" },
      sub: { en: "DM line · 150 ml", ru: "линия DM · 150 мл" },
      egp: 1450, rub: 2000,
      initial: { en: "T", ru: "Т" }, tintA: "#F0DAD4", tintB: "#DBB0A4",
      photo: "assets/img/shop/tohar-hamidbar-concentrate.jpg",
      alt: {
        en: "Onmacabim DM Tohar Hamidbar No.2 — white pump bottle with a green leaf motif",
        ru: "Onmacabim DM Tohar Hamidbar №2 — белый флакон с помпой и зелёным листом"
      },
      desc: {
        en: "Highly concentrated herbal formula for oily, porous and blemish-prone skin. Plant extracts and acids cleanse and tighten pores, mattify, and calm the skin with a strong antioxidant effect.",
        ru: "Высококонцентрированное растительное средство для жирной, пористой и проблемной кожи. Экстракты растений и кислоты очищают и сужают поры, матируют и успокаивают кожу, обладая мощным антиоксидантным действием."
      }
    },
    {
      slug: "nd-neck-decollete-cream",
      name: { en: "N.D Cream for Neck & Décolleté", ru: "Крем для шеи и декольте N.D" },
      sub: { en: "Vivant line · 50 ml", ru: "линия Vivant · 50 мл" },
      egp: 1250, rub: 1750,
      initial: { en: "N", ru: "Н" }, tintA: "#E3E4D4", tintB: "#C9CCB0",
      photo: "assets/img/shop/nd-neck-decollete-cream.jpg",
      alt: {
        en: "Onmacabim Vivant N.D Cream — white jar beside its olive-green box",
        ru: "Onmacabim Vivant N.D Cream — белая банка рядом с оливковой коробкой"
      },
      desc: {
        en: "A complex care cream for the delicate neck and décolleté zone combining natural and biotechnological components. Enzymes and lipopeptides support cell renewal and collagen synthesis for a natural firming effect.",
        ru: "Комплексный крем для деликатной зоны шеи и декольте, сочетающий природные и биотехнологичные компоненты. Энзимы и липопептиды поддерживают обновление клеток и синтез коллагена, создавая естественный эффект лифтинга."
      }
    },
    {
      slug: "vitamin-c-mask",
      name: { en: "Nourishing Skin Mask Vitamin C", ru: "Питательная маска с витамином C" },
      sub: { en: "VC line · 50 ml", ru: "линия VC · 50 мл" },
      egp: 2300, rub: 3200,
      initial: { en: "C", ru: "С" }, tintA: "#F4E6C4", tintB: "#E2CC98",
      photo: "assets/img/shop/vitamin-c-mask.jpg",
      alt: {
        en: "Onmacabim Nourishing Skin Mask Vitamin C — white tube beside its box",
        ru: "Onmacabim питательная маска с витамином C — белая туба рядом с коробкой"
      },
      desc: {
        en: "Rich, antioxidant-packed nourishing mask with a brightening effect. Helps reduce hyperpigmentation and supports collagen production — well suited to dehydrated skin with signs of photoaging.",
        ru: "Насыщенная питательная маска с антиоксидантами и осветляющим эффектом. Помогает уменьшить гиперпигментацию и поддерживает выработку коллагена — подходит обезвоженной коже с признаками фотостарения."
      }
    },
    {
      slug: "vitality-spf15-moisturizer",
      name: { en: "Vitality Moisturizer SPF 15", ru: "Увлажняющий крем Vitality SPF 15" },
      sub: { en: "Oxygen line · 50 ml", ru: "линия Oxygen · 50 мл" },
      egp: 1150, rub: 1600,
      initial: { en: "V", ru: "В" }, tintA: "#DCE4EC", tintB: "#B7C6D6",
      photo: "assets/img/shop/vitality-spf15-moisturizer.jpg",
      alt: {
        en: "Onmacabim Oxygen Vitality Moisturizing Lotion SPF 15 — white pump bottle beside its box",
        ru: "Onmacabim Oxygen Vitality увлажняющий лосьон SPF 15 — белый флакон с помпой рядом с коробкой"
      },
      desc: {
        en: "A light, quickly absorbed cream-fluid with a delicate fresh scent. Restores the skin's natural moisture balance, improves elasticity and complexion, and protects against UV with SPF 15.",
        ru: "Лёгкий, быстро впитывающийся крем-флюид с нежным свежим ароматом. Восстанавливает естественный баланс влаги, повышает упругость, улучшает цвет лица и защищает от ультрафиолета с SPF 15."
      }
    },
    {
      slug: "nomela-serum",
      name: { en: "NoMela Facial Serum", ru: "Сыворотка для лица NoMela" },
      sub: { en: "Luna whitening series · 50 ml", ru: "осветляющая серия Luna · 50 мл" },
      egp: 1350, rub: 1900,
      initial: { en: "L", ru: "Л" }, tintA: "#EFE0C8", tintB: "#DCC29B",
      photo: "assets/img/shop/nomela-serum.jpg",
      alt: {
        en: "Onmacabim Luna NoMela facial serum — white dropper bottle with a gold collar beside its box",
        ru: "Onmacabim Luna NoMela сыворотка для лица — белый флакон с пипеткой и золотым ободком рядом с коробкой"
      },
      desc: {
        en: "A delicate brightening serum that balances skin tone and helps prevent new pigmentation. Moisturizing polysaccharides and lightening extracts reduce melanin synthesis. For all skin types, year-round.",
        ru: "Деликатная осветляющая сыворотка выравнивает тон кожи и помогает предотвратить появление новой пигментации. Увлажняющие полисахариды и осветляющие экстракты снижают синтез меланина. Для всех типов кожи, круглый год."
      }
    },
    {
      slug: "moisturizer-normal-dry",
      name: { en: "Moisturizer for Normal to Dry Skin", ru: "Увлажняющий крем для нормальной и сухой кожи" },
      sub: { en: "ST Cells line · 50 ml", ru: "линия ST Cells · 50 мл" },
      egp: 4850, rub: 6700,
      initial: { en: "M", ru: "М" }, tintA: "#E0D8CE", tintB: "#BFB1A2",
      photo: "assets/img/shop/moisturizer-normal-dry.jpg",
      alt: {
        en: "Onmacabim ST Cells moisturizer for normal to dry skin — white pump bottle beside its box",
        ru: "Onmacabim ST Cells увлажняющий крем для нормальной и сухой кожи — белый флакон с помпой рядом с коробкой"
      },
      desc: {
        en: "A stem-cell moisturizer that supports collagen production and hyaluronic acid renewal. Skin looks smoother, firmer and more rested, with better resistance to outside stressors.",
        ru: "Увлажняющий крем с фитостволовыми клетками поддерживает выработку коллагена и обновление гиалуроновой кислоты. Кожа выглядит более гладкой, упругой и отдохнувшей, лучше противостоит внешним воздействиям."
      }
    }
  ];
  /* ========================= end PRODUCT DATA ========================= */

  var LANG = (document.documentElement.lang || "en").toLowerCase().indexOf("ru") === 0 ? "ru" : "en";
  var STORAGE_KEY = "vv-cart";
  var PHONE_RE = /^\+?[0-9\s\-()]{8,17}$/;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var IS_LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  var API_URL = IS_LOCAL
    ? "http://localhost:3000/api/order"
    : "https://book.victoriaholisticbeauty.com/api/order";
  var MAIL_TO = "victoria@victoriaholisticbeauty.com";

  var T = {
    en: {
      add: "Add to order",
      view: "View details",
      decrease: "Decrease quantity",
      increase: "Increase quantity",
      qtyOf: "Quantity of",
      inCart: "in cart",
      itemOne: "item",
      reviewOrder: "Review order",
      panelTitle: "Your order",
      close: "Close",
      total: "Total",
      cod: "Payment: cash on delivery. Victoria will contact you to confirm your order, delivery time and address.",
      delivery: "Delivery within 24–72 hours across Egypt.",
      name: "Your name",
      namePh: "Anna",
      nameErr: "Please tell us your name.",
      phone: "Mobile",
      phonePh: "+20 100 123 4567",
      phoneErr: "Please enter a valid phone number with country code, e.g. +20 100 123 4567.",
      email: "Email (for order confirmation)",
      emailPh: "anna@example.com",
      emailErr: "Please enter a valid email address, e.g. anna@example.com.",
      address: "City & address",
      addressPh: "City, street, building…",
      addressErr: "Please tell us where to deliver.",
      note: "Note (optional)",
      notePh: "Anything Victoria should know",
      submit: "Place order",
      sending: "Sending…",
      successTitle: "Thank you — order placed!",
      orderNumberLabel: "Order number: ",
      successLine: "Our team will get in touch via WhatsApp to confirm your delivery time. Payment on delivery.",
      done: "Done",
      failLead: "We couldn't send your order right now.",
      failLink: "Email it to Victoria instead",
      failTail: "— your cart is kept safe on this device.",
      mailSubject: "Order request — Studio Shop",
      mailOrder: "Order:",
      mailName: "Name:",
      mailPhone: "Phone:",
      mailEmail: "Email:",
      mailAddress: "Address:",
      mailNote: "Note:",
      mailTotal: "Total:"
    },
    ru: {
      add: "Добавить в заказ",
      view: "Подробнее",
      decrease: "Уменьшить количество",
      increase: "Увеличить количество",
      qtyOf: "Количество:",
      inCart: "в корзине",
      itemOne: "товар",
      reviewOrder: "Оформить",
      panelTitle: "Ваш заказ",
      close: "Закрыть",
      total: "Итого",
      cod: "Оплата при получении. Виктория свяжется с вами для подтверждения заказа, времени и адреса доставки.",
      delivery: "Доставка по Египту в течение 24–72 часов.",
      name: "Ваше имя",
      namePh: "Анна",
      nameErr: "Пожалуйста, представьтесь.",
      phone: "Телефон",
      phonePh: "+7 900 123-45-67",
      phoneErr: "Введите корректный номер с кодом страны, например +7 900 123-45-67.",
      email: "Эл. почта (для подтверждения заказа)",
      emailPh: "anna@example.com",
      emailErr: "Введите корректный адрес эл. почты, например anna@example.com.",
      address: "Город и адрес",
      addressPh: "Город, улица, дом…",
      addressErr: "Укажите, куда доставить заказ.",
      note: "Комментарий (необязательно)",
      notePh: "Что Виктории стоит знать",
      submit: "Оформить заказ",
      sending: "Отправляем…",
      successTitle: "Спасибо — заказ оформлен!",
      orderNumberLabel: "Номер заказа: ",
      successLine: "Наша команда свяжется с вами в WhatsApp, чтобы подтвердить время доставки. Оплата при получении.",
      done: "Готово",
      failLead: "Не получилось отправить заказ прямо сейчас.",
      failLink: "Отправьте его Виктории по почте",
      failTail: "— корзина сохранена на этом устройстве.",
      mailSubject: "Заказ — Магазин студии",
      mailOrder: "Заказ:",
      mailName: "Имя:",
      mailPhone: "Телефон:",
      mailEmail: "Эл. почта:",
      mailAddress: "Адрес:",
      mailNote: "Комментарий:",
      mailTotal: "Итого:"
    }
  }[LANG];

  /* ---------- helpers ---------- */
  function bySlug(slug) {
    for (var i = 0; i < PRODUCTS.length; i++) if (PRODUCTS[i].slug === slug) return PRODUCTS[i];
    return null;
  }
  function fmtEgp(n) { return "E£" + n.toLocaleString("en-US"); }
  function fmtRub(n) { return n.toLocaleString("ru-RU").replace(/ |\s/g, " ") + " ₽"; }
  function itemsWord(n) {
    if (LANG === "ru") {
      var m10 = n % 10, m100 = n % 100;
      if (m10 === 1 && m100 !== 11) return "товар";
      if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "товара";
      return "товаров";
    }
    return n === 1 ? "item" : "items";
  }
  /* ---------- cart state ---------- */
  var cart = {}; // slug -> qty
  function loadCart() {
    try {
      var raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      for (var slug in raw) {
        if (bySlug(slug) && typeof raw[slug] === "number") {
          var q = Math.floor(raw[slug]);
          if (q >= 1) cart[slug] = Math.min(q, 99);
        }
      }
    } catch (e) { cart = {}; }
  }
  function saveCart() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cart)); } catch (e) { /* private mode */ }
  }
  function cartCount() { var n = 0; for (var s in cart) n += cart[s]; return n; }
  function cartTotals() {
    var egp = 0, rub = 0;
    for (var s in cart) { var p = bySlug(s); egp += p.egp * cart[s]; rub += p.rub * cart[s]; }
    return { egp: egp, rub: rub };
  }
  function setQty(slug, qty) {
    if (qty <= 0) delete cart[slug]; else cart[slug] = Math.min(qty, 99);
    saveCart();
    renderAction(slug);
    renderBar();
    announce(slug);
  }

  /* ---------- screen-reader announcements ---------- */
  var live = document.createElement("div");
  live.className = "sr-only";
  live.setAttribute("aria-live", "polite");
  document.body.appendChild(live);
  function announce(slug) {
    var p = bySlug(slug);
    var q = cart[slug] || 0;
    live.textContent = p.name[LANG] + " — " + q + " " + T.inCart;
  }

  /* ---------- product grid ---------- */
  var grid = document.getElementById("shop-grid");
  var actionEls = {}; // slug -> .shop-action element

  /* Fills any holder (card action area or product-modal action area) with the
     Add button / qty stepper pair for a product. */
  function fillAction(holder, slug) {
    var p = bySlug(slug);
    holder.textContent = "";
    if (!cart[slug]) {
      var add = document.createElement("button");
      add.type = "button";
      add.className = "shop-add";
      add.textContent = T.add;
      add.setAttribute("aria-label", T.add + " — " + p.name[LANG]);
      add.addEventListener("click", function () { setQty(slug, 1); });
      holder.appendChild(add);
    } else {
      var stepper = document.createElement("div");
      stepper.className = "shop-stepper";
      stepper.setAttribute("role", "group");
      stepper.setAttribute("aria-label", T.qtyOf + " " + p.name[LANG]);
      var minus = document.createElement("button");
      minus.type = "button";
      minus.className = "shop-step";
      minus.textContent = "−";
      minus.setAttribute("aria-label", T.decrease + " — " + p.name[LANG]);
      minus.addEventListener("click", function () { setQty(slug, (cart[slug] || 0) - 1); });
      var qty = document.createElement("span");
      qty.className = "shop-qty";
      qty.textContent = String(cart[slug]);
      var plus = document.createElement("button");
      plus.type = "button";
      plus.className = "shop-step";
      plus.textContent = "+";
      plus.setAttribute("aria-label", T.increase + " — " + p.name[LANG]);
      plus.addEventListener("click", function () { setQty(slug, (cart[slug] || 0) + 1); });
      stepper.appendChild(minus);
      stepper.appendChild(qty);
      stepper.appendChild(plus);
      holder.appendChild(stepper);
    }
  }

  /* Re-render the action area for a product on its card AND, when the product
     detail modal is open on the same product, inside the modal — both views
     stay in sync as quantities change. */
  function renderAction(slug) {
    if (actionEls[slug]) fillAction(actionEls[slug], slug);
    if (pActionHolder && pSlug === slug) {
      fillAction(pActionHolder, slug);
      /* The re-render swaps Add ↔ stepper; if focus was on the removed
         control, restore it inside the modal so the trap keeps working. */
      if (pPanel && !pPanel.contains(document.activeElement)) {
        var next = pActionHolder.querySelector("button");
        if (next) next.focus();
      }
    }
  }

  /* Shared art builder — product photo over its tinted gradient (or the
     serif-initial placeholder when no photo exists). */
  function buildArt(p, cls, eager) {
    var art = document.createElement("div");
    art.className = cls;
    art.style.setProperty("--tint-a", p.tintA);
    art.style.setProperty("--tint-b", p.tintB);
    if (p.photo) {
      var img = document.createElement("img");
      img.src = p.photo;
      img.alt = (p.alt && p.alt[LANG]) || p.name[LANG];
      img.width = 900;
      img.height = 900;
      if (!eager) img.loading = "lazy";
      img.decoding = "async";
      art.appendChild(img);
    } else {
      var ini = document.createElement("span");
      ini.className = "shop-initial";
      ini.setAttribute("aria-hidden", "true");
      ini.textContent = p.initial[LANG];
      art.appendChild(ini);
    }
    return art;
  }

  function renderGrid() {
    if (!grid) return;
    PRODUCTS.forEach(function (p) {
      var card = document.createElement("article");
      card.className = "shop-card";
      /* Whole card opens the product detail modal; the Add button / stepper
         stays independently clickable (its holder stops propagation). */
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-haspopup", "dialog");
      card.setAttribute("aria-label", p.name[LANG] + " — " + T.view);
      card.addEventListener("click", function () { openProduct(p.slug); });
      card.addEventListener("keydown", function (ev) {
        if (ev.target !== card) return;
        if (ev.key === "Enter" || ev.key === " " || ev.key === "Spacebar") {
          ev.preventDefault();
          openProduct(p.slug);
        }
      });

      var art = buildArt(p, "shop-art");

      var body = document.createElement("div");
      body.className = "shop-body";
      var name = document.createElement("h2");
      name.className = "shop-name";
      name.textContent = p.name[LANG];
      var sub = document.createElement("p");
      sub.className = "shop-sub";
      sub.textContent = p.sub[LANG];
      var price = document.createElement("p");
      price.className = "shop-price";
      price.appendChild(document.createTextNode(fmtEgp(p.egp) + " "));
      var small = document.createElement("small");
      small.textContent = "· " + fmtRub(p.rub);
      price.appendChild(small);
      var action = document.createElement("div");
      action.className = "shop-action";
      /* Cart controls must not bubble up into the card's open-modal click. */
      action.addEventListener("click", function (ev) { ev.stopPropagation(); });
      actionEls[p.slug] = action;

      body.appendChild(name);
      body.appendChild(sub);
      body.appendChild(price);
      body.appendChild(action);
      card.appendChild(art);
      card.appendChild(body);
      grid.appendChild(card);
      renderAction(p.slug);
    });
  }

  /* ---------- product detail modal ----------
     Opened by clicking/keying a product card. Reuses the treatment-modal
     visual language (scrim + blur overlay, --card sheet) and the shop-add /
     shop-stepper controls, kept in sync with the card via renderAction. */
  var pOverlay = null, pPanel = null, pActionHolder = null, pSlug = null, pLastFocus = null;

  function pTrapKeydown(ev) {
    if (ev.key === "Escape") { ev.preventDefault(); closeProduct(); return; }
    if (ev.key !== "Tab") return;
    var focusables = pPanel.querySelectorAll(
      'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (!focusables.length) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    var active = document.activeElement;
    if (!pPanel.contains(active) || active === pPanel) {
      ev.preventDefault();
      (ev.shiftKey ? last : first).focus();
      return;
    }
    if (ev.shiftKey && active === first) {
      ev.preventDefault(); last.focus();
    } else if (!ev.shiftKey && active === last) {
      ev.preventDefault(); first.focus();
    }
  }

  function openProduct(slug) {
    var p = bySlug(slug);
    if (!p) return;
    if (pOverlay) closeProduct();
    pLastFocus = document.activeElement;
    pSlug = slug;

    pOverlay = el("div", "pmodal-overlay");
    pPanel = el("div", "pmodal");
    pPanel.setAttribute("role", "dialog");
    pPanel.setAttribute("aria-modal", "true");
    pPanel.setAttribute("aria-labelledby", "pmodal-title");
    pPanel.tabIndex = -1;

    var close = el("button", "pmodal-close");
    close.type = "button";
    close.setAttribute("aria-label", T.close);
    close.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 2l12 12M14 2L2 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    close.addEventListener("click", closeProduct);

    var art = buildArt(p, "pmodal-art", true);

    var body = el("div", "pmodal-body");
    var name = el("h2", "pmodal-title", p.name[LANG]);
    name.id = "pmodal-title";
    var sub = el("p", "pmodal-sub", p.sub[LANG]);
    var desc = el("p", "pmodal-desc", (p.desc && p.desc[LANG]) || "");
    var price = el("p", "pmodal-price", fmtEgp(p.egp) + " ");
    price.appendChild(el("small", null, "· " + fmtRub(p.rub)));
    pActionHolder = el("div", "pmodal-action");
    fillAction(pActionHolder, slug);

    body.appendChild(name);
    body.appendChild(sub);
    body.appendChild(desc);
    body.appendChild(price);
    body.appendChild(pActionHolder);
    pPanel.appendChild(close);
    pPanel.appendChild(art);
    pPanel.appendChild(body);
    pOverlay.appendChild(pPanel);

    pOverlay.addEventListener("mousedown", function (ev) {
      if (ev.target === pOverlay) closeProduct();
    });
    document.body.appendChild(pOverlay);
    document.documentElement.classList.add("pmodal-open");
    document.addEventListener("keydown", pTrapKeydown, true);
    pPanel.focus();
  }

  function closeProduct() {
    if (!pOverlay) return;
    pOverlay.remove();
    pOverlay = null;
    pPanel = null;
    pActionHolder = null;
    pSlug = null;
    document.documentElement.classList.remove("pmodal-open");
    document.removeEventListener("keydown", pTrapKeydown, true);
    if (pLastFocus && document.contains(pLastFocus)) pLastFocus.focus();
  }

  /* ---------- floating cart bar ---------- */
  var bar = document.createElement("button");
  bar.type = "button";
  bar.className = "cart-bar";
  bar.hidden = true;
  var barSum = document.createElement("span");
  barSum.className = "cart-bar-sum";
  var barCta = document.createElement("span");
  barCta.className = "cart-bar-cta";
  barCta.textContent = T.reviewOrder + " →";
  bar.appendChild(barSum);
  bar.appendChild(barCta);
  bar.addEventListener("click", openPanel);
  document.body.appendChild(bar);

  function renderBar() {
    var n = cartCount();
    if (n === 0) { bar.hidden = true; return; }
    var totals = cartTotals();
    barSum.textContent = n + " " + itemsWord(n) + " · " + fmtEgp(totals.egp);
    bar.hidden = false;
  }

  /* ---------- order panel ---------- */
  var overlay = null, panel = null, lastFocus = null;

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function field(id, labelText, errText, control) {
    var wrap = el("div", "order-field");
    var label = el("label", null, labelText);
    label.setAttribute("for", id);
    control.id = id;
    var err = el("p", "field-error", errText || "");
    err.id = id + "-error";
    if (errText) control.setAttribute("aria-describedby", err.id);
    wrap.appendChild(label);
    wrap.appendChild(control);
    if (errText) wrap.appendChild(err);
    return wrap;
  }

  function markInvalid(control, invalid) {
    control.parentNode.classList.toggle("invalid", !!invalid);
    control.setAttribute("aria-invalid", invalid ? "true" : "false");
  }

  function mailtoHref() {
    var totals = cartTotals();
    var lines = [T.mailOrder];
    for (var s in cart) {
      var p = bySlug(s);
      lines.push("· " + p.name[LANG] + " (" + p.sub[LANG] + ") × " + cart[s] + " — " + fmtEgp(p.egp * cart[s]));
    }
    lines.push(T.mailTotal + " " + fmtEgp(totals.egp) + " · " + fmtRub(totals.rub));
    var f = panel ? panel.querySelector("form") : null;
    if (f) {
      lines.push("");
      lines.push(T.mailName + " " + (f.elements["order-name"].value || "—"));
      lines.push(T.mailPhone + " " + (f.elements["order-phone"].value || "—"));
      if (f.elements["order-email"].value) lines.push(T.mailEmail + " " + f.elements["order-email"].value);
      lines.push(T.mailAddress + " " + (f.elements["order-address"].value || "—"));
      if (f.elements["order-note"].value) lines.push(T.mailNote + " " + f.elements["order-note"].value);
    }
    return "mailto:" + MAIL_TO +
      "?subject=" + encodeURIComponent(T.mailSubject) +
      "&body=" + encodeURIComponent(lines.join("\n"));
  }

  function buildPanel() {
    overlay = el("div", "order-overlay");
    panel = el("div", "order-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "order-title");
    panel.tabIndex = -1;

    var close = el("button", "order-close");
    close.type = "button";
    close.setAttribute("aria-label", T.close);
    close.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 2l12 12M14 2L2 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    close.addEventListener("click", closePanel);

    var title = el("h2", "order-title", T.panelTitle);
    title.id = "order-title";

    var list = el("ul", "order-items");
    var total = el("p", "order-total");
    var cod = el("p", "cod-note", T.cod);
    cod.appendChild(document.createElement("br"));
    cod.appendChild(document.createTextNode(T.delivery));

    var form = el("form", "order-form");
    form.noValidate = true;

    var nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.name = "order-name";
    nameInput.placeholder = T.namePh;
    nameInput.autocomplete = "name";

    var phoneInput = document.createElement("input");
    phoneInput.type = "tel";
    phoneInput.name = "order-phone";
    phoneInput.placeholder = T.phonePh;
    phoneInput.autocomplete = "tel";
    phoneInput.inputMode = "tel";

    var emailInput = document.createElement("input");
    emailInput.type = "email";
    emailInput.name = "order-email";
    emailInput.placeholder = T.emailPh;
    emailInput.autocomplete = "email";
    emailInput.inputMode = "email";

    var addressInput = document.createElement("textarea");
    addressInput.name = "order-address";
    addressInput.rows = 2;
    addressInput.placeholder = T.addressPh;
    addressInput.autocomplete = "street-address";

    var noteInput = document.createElement("textarea");
    noteInput.name = "order-note";
    noteInput.rows = 2;
    noteInput.placeholder = T.notePh;

    var fail = el("div", "order-fail");
    fail.hidden = true;

    var submit = el("button", "order-submit", T.submit);
    submit.type = "submit";

    form.appendChild(field("order-name", T.name, T.nameErr, nameInput));
    form.appendChild(field("order-phone", T.phone, T.phoneErr, phoneInput));
    form.appendChild(field("order-email", T.email, T.emailErr, emailInput));
    form.appendChild(field("order-address", T.address, T.addressErr, addressInput));
    form.appendChild(field("order-note", T.note, null, noteInput));
    form.appendChild(fail);
    form.appendChild(submit);

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var ok = true;
      var nameOk = nameInput.value.trim().length >= 2;
      markInvalid(nameInput, !nameOk); ok = ok && nameOk;
      var phoneOk = PHONE_RE.test(phoneInput.value.trim());
      markInvalid(phoneInput, !phoneOk); ok = ok && phoneOk;
      var emailVal = emailInput.value.trim();
      var emailOk = emailVal === "" || (emailVal.length <= 120 && EMAIL_RE.test(emailVal));
      markInvalid(emailInput, !emailOk); ok = ok && emailOk;
      var addrOk = addressInput.value.trim().length >= 5;
      markInvalid(addressInput, !addrOk); ok = ok && addrOk;
      if (!ok) {
        var firstBad = panel.querySelector(".order-field.invalid input, .order-field.invalid textarea");
        if (firstBad) firstBad.focus();
        return;
      }
      fail.hidden = true;
      submit.disabled = true;
      submit.textContent = T.sending;

      var items = [];
      for (var s in cart) items.push({ slug: s, qty: cart[s] });
      var payload = {
        items: items,
        name: nameInput.value.trim(),
        phone: phoneInput.value.trim(),
        address: addressInput.value.trim(),
        note: noteInput.value.trim(),
        lang: LANG
      };
      if (emailVal) payload.email = emailVal;

      fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        /* Body parse failures must not turn a placed order into an error —
           degrade to a success modal without the order number. */
        return res.json().catch(function () { return {}; });
      }).then(function (data) {
        showSuccess(data && typeof data.orderNumber === "string" ? data.orderNumber : "");
      }).catch(function () {
        submit.disabled = false;
        submit.textContent = T.submit;
        fail.textContent = "";
        fail.appendChild(document.createTextNode(T.failLead + " "));
        var a = document.createElement("a");
        a.href = mailtoHref();
        a.textContent = T.failLink;
        fail.appendChild(a);
        fail.appendChild(document.createTextNode(" " + T.failTail));
        fail.hidden = false;
      });
    });

    panel.appendChild(close);
    panel.appendChild(title);
    panel.appendChild(list);
    panel.appendChild(total);
    panel.appendChild(cod);
    panel.appendChild(form);
    overlay.appendChild(panel);

    overlay.addEventListener("mousedown", function (ev) {
      if (ev.target === overlay) closePanel();
    });
    document.body.appendChild(overlay);
  }

  function renderPanelItems() {
    var list = panel.querySelector(".order-items");
    var total = panel.querySelector(".order-total");
    list.textContent = "";
    for (var s in cart) {
      var p = bySlug(s);
      var li = document.createElement("li");
      var name = el("span", "order-item-name", p.name[LANG] + " ");
      name.appendChild(el("span", "order-item-qty", "× " + cart[s]));
      li.appendChild(name);
      li.appendChild(el("span", "order-item-price", fmtEgp(p.egp * cart[s])));
      list.appendChild(li);
    }
    var totals = cartTotals();
    total.textContent = "";
    total.appendChild(el("span", null, T.total));
    var sum = el("span", "order-total-sum", fmtEgp(totals.egp) + " ");
    sum.appendChild(el("small", null, "· " + fmtRub(totals.rub)));
    total.appendChild(sum);
  }

  function showSuccess(orderNumber) {
    panel.textContent = "";
    var box = el("div", "order-success");
    var mark = el("div", "order-success-mark");
    mark.setAttribute("aria-hidden", "true");
    mark.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true"><path d="M4 11.5l5 5L18 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var title = el("h2", "order-success-title", T.successTitle);
    title.id = "order-title";
    var line = el("p", "order-success-line", T.successLine);
    var deliveryLine = el("p", "order-success-line", T.delivery);
    var done = el("button", "order-submit", T.done);
    done.type = "button";
    done.addEventListener("click", closePanel);
    box.appendChild(mark);
    box.appendChild(title);
    if (orderNumber) {
      /* Server-issued order number — omitted gracefully when absent. */
      var numLine = el("p", "order-success-line order-success-num");
      numLine.appendChild(el("strong", null, T.orderNumberLabel + orderNumber));
      box.appendChild(numLine);
    }
    box.appendChild(line);
    box.appendChild(deliveryLine);
    box.appendChild(done);
    panel.appendChild(box);
    done.focus();
    cart = {};
    saveCart();
    PRODUCTS.forEach(function (p) { renderAction(p.slug); });
    renderBar();
  }

  function trapKeydown(ev) {
    if (ev.key === "Escape") { ev.preventDefault(); closePanel(); return; }
    if (ev.key !== "Tab") return;
    var focusables = panel.querySelectorAll(
      'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (!focusables.length) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    var active = document.activeElement;
    if (!panel.contains(active) || active === panel) {
      /* focus is on the panel container or escaped it — pull it back in */
      ev.preventDefault();
      (ev.shiftKey ? last : first).focus();
      return;
    }
    if (ev.shiftKey && active === first) {
      ev.preventDefault(); last.focus();
    } else if (!ev.shiftKey && active === last) {
      ev.preventDefault(); first.focus();
    }
  }

  function openPanel() {
    if (cartCount() === 0) return;
    lastFocus = document.activeElement;
    if (overlay) { overlay.remove(); overlay = null; panel = null; }
    buildPanel();
    renderPanelItems();
    document.documentElement.classList.add("order-open");
    document.addEventListener("keydown", trapKeydown, true);
    panel.focus();
  }

  function closePanel() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    panel = null;
    document.documentElement.classList.remove("order-open");
    document.removeEventListener("keydown", trapKeydown, true);
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    else if (!bar.hidden) bar.focus();
  }

  /* ---------- init ---------- */
  loadCart();
  renderGrid();
  renderBar();
})();
