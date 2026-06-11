/* ===== Studio Shop — products, cart, cash-on-delivery order flow =====
   Vanilla IIFE, no dependencies. Cart persists in localStorage ("vv-cart").
   Order POSTs { items:[{slug, qty}], name, phone, address, note, lang }
   to /api/order on the booking host. */
(function () {
  "use strict";

  /* =====================================================================
     PLACEHOLDER PRODUCT DATA — the single source of truth for the shop.
     Swap names / prices / tints here. To replace the gradient-and-initial
     placeholder art with a real photo, set `photo` to an image path
     (e.g. "assets/img/shop/hydrating-serum.jpg") — nothing else changes.
     Prices: `egp` in Egyptian pounds, `rub` in roubles.
     ===================================================================== */
  var PRODUCTS = [
    {
      slug: "hydrating-serum",
      name: { en: "Hydrating Serum", ru: "Увлажняющая сыворотка" },
      sub: { en: "Onmacabim · 30 ml", ru: "Onmacabim · 30 мл" },
      egp: 1450, rub: 2000,
      initial: { en: "S", ru: "С" }, tintA: "#EFE0C8", tintB: "#DCC29B",
      photo: null
    },
    {
      slug: "fruit-peel-mask",
      name: { en: "Fruit Peel Mask", ru: "Фруктовая маска-пилинг" },
      sub: { en: "HOLY LAND · 50 ml", ru: "HOLY LAND · 50 мл" },
      egp: 980, rub: 1400,
      initial: { en: "P", ru: "П" }, tintA: "#F0DAC4", tintB: "#DBB592",
      photo: null
    },
    {
      slug: "alginate-mask-kit",
      name: { en: "Alginate Modeling Mask", ru: "Альгинатная маска (набор)" },
      sub: { en: "home kit · 5 uses", ru: "набор · 5 применений" },
      egp: 750, rub: 1050,
      initial: { en: "A", ru: "А" }, tintA: "#E3E4D4", tintB: "#C9CCB0",
      photo: null
    },
    {
      slug: "mineral-sunscreen-spf50",
      name: { en: "Mineral Sunscreen SPF 50", ru: "Минеральный SPF 50" },
      sub: { en: "mineral filter · 50 ml", ru: "минеральный фильтр · 50 мл" },
      egp: 890, rub: 1250,
      initial: { en: "50", ru: "50" }, tintA: "#F4E6C4", tintB: "#E2CC98",
      photo: null
    },
    {
      slug: "mandelic-toner",
      name: { en: "Mandelic Renewal Toner", ru: "Миндальный тоник" },
      sub: { en: "100 ml", ru: "100 мл" },
      egp: 820, rub: 1150,
      initial: { en: "T", ru: "Т" }, tintA: "#EBE3D2", tintB: "#D3C4A6",
      photo: null
    },
    {
      slug: "collagen-eye-patches",
      name: { en: "Collagen Eye Patches", ru: "Коллагеновые патчи" },
      sub: { en: "60 pcs", ru: "60 шт" },
      egp: 640, rub: 900,
      initial: { en: "C", ru: "К" }, tintA: "#E6DDD6", tintB: "#CDBBAE",
      photo: null
    },
    {
      slug: "gua-sha-tool",
      name: { en: "Facial Sculpting Tool", ru: "Скульптурирующий гуаша" },
      sub: { en: "gua sha · stone", ru: "гуаша · камень" },
      egp: 560, rub: 800,
      initial: { en: "G", ru: "Г" }, tintA: "#E0D8CE", tintB: "#BFB1A2",
      photo: null
    },
    {
      slug: "recovery-night-cream",
      name: { en: "Recovery Night Cream", ru: "Восстанавливающий ночной крем" },
      sub: { en: "50 ml", ru: "50 мл" },
      egp: 1120, rub: 1600,
      initial: { en: "N", ru: "Н" }, tintA: "#DED4C9", tintB: "#BCA88F",
      photo: null
    }
  ];
  /* ===================== end PLACEHOLDER PRODUCT DATA ================= */

  var LANG = (document.documentElement.lang || "en").toLowerCase().indexOf("ru") === 0 ? "ru" : "en";
  var STORAGE_KEY = "vv-cart";
  var PHONE_RE = /^\+?[0-9\s\-()]{8,17}$/;
  var IS_LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  var API_URL = IS_LOCAL
    ? "http://localhost:3000/api/order"
    : "https://book.victoriaholisticbeauty.com/api/order";
  var MAIL_TO = "victoria@victoriaholisticbeauty.com";

  var T = {
    en: {
      add: "Add",
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
      name: "Your name",
      namePh: "Anna",
      nameErr: "Please tell us your name.",
      phone: "Mobile",
      phonePh: "+20 100 123 4567",
      phoneErr: "Please enter a valid phone number with country code, e.g. +20 100 123 4567.",
      address: "City & address",
      addressPh: "City, street, building…",
      addressErr: "Please tell us where to deliver.",
      note: "Note (optional)",
      notePh: "Anything Victoria should know",
      submit: "Request order",
      sending: "Sending…",
      successTitle: "Order received",
      successLine: "Victoria will call you to confirm. Payment on delivery.",
      done: "Done",
      failLead: "We couldn't send your order right now.",
      failLink: "Email it to Victoria instead",
      failTail: "— your cart is kept safe on this device.",
      mailSubject: "Order request — Studio Shop",
      mailOrder: "Order:",
      mailName: "Name:",
      mailPhone: "Phone:",
      mailAddress: "Address:",
      mailNote: "Note:",
      mailTotal: "Total:"
    },
    ru: {
      add: "Добавить",
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
      name: "Ваше имя",
      namePh: "Анна",
      nameErr: "Пожалуйста, представьтесь.",
      phone: "Телефон",
      phonePh: "+7 900 123-45-67",
      phoneErr: "Введите корректный номер с кодом страны, например +7 900 123-45-67.",
      address: "Город и адрес",
      addressPh: "Город, улица, дом…",
      addressErr: "Укажите, куда доставить заказ.",
      note: "Комментарий (необязательно)",
      notePh: "Что Виктории стоит знать",
      submit: "Отправить заказ",
      sending: "Отправляем…",
      successTitle: "Заказ принят",
      successLine: "Виктория позвонит вам для подтверждения. Оплата при получении.",
      done: "Готово",
      failLead: "Не получилось отправить заказ прямо сейчас.",
      failLink: "Отправьте его Виктории по почте",
      failTail: "— корзина сохранена на этом устройстве.",
      mailSubject: "Заказ — Магазин студии",
      mailOrder: "Заказ:",
      mailName: "Имя:",
      mailPhone: "Телефон:",
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

  function renderAction(slug) {
    var holder = actionEls[slug];
    if (!holder) return;
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

  function renderGrid() {
    if (!grid) return;
    PRODUCTS.forEach(function (p) {
      var card = document.createElement("article");
      card.className = "shop-card";

      var art = document.createElement("div");
      art.className = "shop-art";
      art.style.setProperty("--tint-a", p.tintA);
      art.style.setProperty("--tint-b", p.tintB);
      if (p.photo) {
        var img = document.createElement("img");
        img.src = p.photo;
        img.alt = p.name[LANG];
        img.loading = "lazy";
        art.appendChild(img);
      } else {
        var ini = document.createElement("span");
        ini.className = "shop-initial";
        ini.setAttribute("aria-hidden", "true");
        ini.textContent = p.initial[LANG];
        art.appendChild(ini);
      }

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

      fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        showSuccess();
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

  function showSuccess() {
    panel.textContent = "";
    var box = el("div", "order-success");
    var mark = el("div", "order-success-mark");
    mark.setAttribute("aria-hidden", "true");
    mark.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true"><path d="M4 11.5l5 5L18 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var title = el("h2", "order-success-title", T.successTitle);
    title.id = "order-title";
    var line = el("p", "order-success-line", T.successLine);
    var done = el("button", "order-submit", T.done);
    done.type = "button";
    done.addEventListener("click", closePanel);
    box.appendChild(mark);
    box.appendChild(title);
    box.appendChild(line);
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
