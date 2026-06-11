/* Amber Noir — Beauty Concierge chat widget (vanilla JS, no dependencies) */
(() => {
  "use strict";

  // Update if the deployment URL changes.
  const CHAT_ENDPOINT =
    (location.hostname === "localhost" || location.hostname === "127.0.0.1")
      ? "http://localhost:3000/api/chat"
      : "https://book.victoriaholisticbeauty.com/api/chat";

  const RU = document.documentElement.lang === "ru";
  const CONTACT_EMAIL = "victoria@victoriaholisticbeauty.com";
  const BOOK_URL = RU
    ? "https://book.victoriaholisticbeauty.com/book?lang=ru"
    : "https://book.victoriaholisticbeauty.com/book";

  const T = RU
    ? {
        open: "Открыть чат с Василием — AI-ассистентом Виктории",
        close: "Закрыть чат",
        title: "Василий — AI-ассистент Виктории",
        placeholder: "Ваш вопрос…",
        send: "Отправить",
        greeting: "Здравствуйте! Я Василий, AI-ассистент Виктории. Спросите меня о процедурах, ценах или уходе за кожей.",
        teaserName: "Знакомьтесь: Василий",
        teaserLine: "AI-ассистент Виктории — спросите о процедурах, ценах и уходе",
        teaserDismiss: "Скрыть подсказку",
        fallbackPre: "Я сейчас офлайн — напишите на ",
        fallbackMid: " или ",
        fallbackBook: "запишитесь онлайн",
      }
    : {
        open: "Open chat with Vassili — Victoria's AI Assistant",
        close: "Close chat",
        title: "Vassili — Victoria's AI Assistant",
        placeholder: "Your question…",
        send: "Send",
        greeting: "Hello! I'm Vassili, Victoria's AI assistant. Ask me anything about our treatments, prices, or skincare.",
        teaserName: "Meet Vassili",
        teaserLine: "Victoria's AI assistant — ask about treatments, prices & skincare",
        teaserDismiss: "Dismiss",
        fallbackPre: "I'm offline right now — email ",
        fallbackMid: " or ",
        fallbackBook: "book directly online",
      };

  const STORE_KEY = "vv-chat-history";
  const MAX_HISTORY = 12;

  const loadHistory = () => {
    try { return JSON.parse(sessionStorage.getItem(STORE_KEY)) || []; }
    catch { return []; }
  };
  const saveHistory = (h) => {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify(h.slice(-MAX_HISTORY))); }
    catch { /* private mode — ignore */ }
  };

  let history = loadHistory();
  let open = false, greeted = false, waiting = false;

  // ---- DOM ----
  const el = (tag, cls, attrs) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };

  // Launcher: serif-italic "V" monogram with a clay-pale sparkle — Vassili's mark.
  const launcher = el("button", "chat-launcher", { type: "button", "aria-label": T.open, "aria-expanded": "false" });
  launcher.innerHTML =
    '<svg viewBox="0 0 64 64" width="38" height="38" aria-hidden="true" focusable="false">' +
      '<text x="29" y="48" text-anchor="middle" font-family="\'Cormorant Garamond\', Georgia, serif" font-style="italic" font-weight="500" font-size="46" fill="#FFFDF9">V</text>' +
      '<path d="M47 7.5c1.05 4.15 2.85 5.95 7 7-4.15 1.05-5.95 2.85-7 7-1.05-4.15-2.85-5.95-7-7 4.15-1.05 5.95-2.85 7-7z" fill="#E9CDAF"/>' +
      '<circle cx="40.5" cy="20" r="1.4" fill="#E9CDAF" opacity="0.85"/>' +
    '</svg>';

  const card = el("section", "chat-card", { role: "dialog", "aria-label": T.title, hidden: "" });

  const header = el("header", "chat-header");
  const title = el("h3", "chat-title");
  title.textContent = T.title;
  const closeBtn = el("button", "chat-close", { type: "button", "aria-label": T.close });
  closeBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  header.append(title, closeBtn);

  const list = el("div", "chat-messages", { "aria-live": "polite" });

  const form = el("form", "chat-input");
  const input = el("input", "", { type: "text", placeholder: T.placeholder, "aria-label": T.placeholder, autocomplete: "off" });
  const sendBtn = el("button", "chat-send", { type: "submit", "aria-label": T.send });
  sendBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>';
  form.append(input, sendBtn);

  card.append(header, list, form);

  // ---- Intro teaser: greets on every new visit; once dismissed or the chat is
  // opened it stays away for the rest of the browsing session (sessionStorage,
  // not localStorage — the owner wants Vassili hard to miss for returning visitors). ----
  const INTRO_KEY = "vv-vasili-intro-seen";
  const introSeen = () => {
    try { return sessionStorage.getItem(INTRO_KEY) === "1"; }
    catch { return true; } // storage unavailable — stay quiet rather than nag on every load
  };
  const markIntroSeen = () => {
    try { sessionStorage.setItem(INTRO_KEY, "1"); } catch { /* ignore */ }
  };

  const teaser = el("aside", "chat-teaser", { hidden: "" });
  const teaserBody = el("button", "chat-teaser-body", { type: "button", "aria-label": T.open });
  const teaserName = el("strong", "chat-teaser-name");
  teaserName.textContent = T.teaserName;
  const teaserLine = el("span", "chat-teaser-line");
  teaserLine.textContent = T.teaserLine;
  teaserBody.append(teaserName, teaserLine);
  const teaserClose = el("button", "chat-teaser-close", { type: "button", "aria-label": T.teaserDismiss });
  teaserClose.innerHTML =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  teaser.append(teaserBody, teaserClose);

  document.body.append(launcher, teaser, card);

  const hideTeaser = () => {
    if (teaser.hidden) return;
    teaser.classList.remove("show");
    teaser.hidden = true;
    markIntroSeen();
  };

  const REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!introSeen()) {
    setTimeout(() => {
      if (open) return; // chat already opened — no need to introduce
      teaser.hidden = false;
      requestAnimationFrame(() => requestAnimationFrame(() => teaser.classList.add("show")));
    }, REDUCED ? 0 : 1500);
  } else {
    launcher.classList.add("calm"); // returning visitor — no pulse ring
  }

  teaserClose.addEventListener("click", hideTeaser);

  // ---- Safe rendering: text nodes only, URLs linkified into real anchors ----
  const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
  const renderText = (node, text) => {
    let last = 0;
    for (const m of text.matchAll(URL_RE)) {
      if (m.index > last) node.append(text.slice(last, m.index));
      const a = el("a", "chat-link", { href: m[0], target: "_blank", rel: "noopener noreferrer" });
      a.textContent = m[0];
      node.append(a);
      last = m.index + m[0].length;
    }
    if (last < text.length) node.append(text.slice(last));
  };

  const addBubble = (role, text) => {
    const b = el("div", "chat-bubble chat-" + role);
    renderText(b, text);
    list.append(b);
    list.scrollTop = list.scrollHeight;
    return b;
  };

  // Offline fallback bubble: trusted local strings + labeled email/booking anchors.
  const addFallback = () => {
    const b = el("div", "chat-bubble chat-assistant");
    b.append(T.fallbackPre);
    const mail = el("a", "chat-link", { href: "mailto:" + CONTACT_EMAIL });
    mail.textContent = CONTACT_EMAIL;
    const book = el("a", "chat-link", { href: BOOK_URL, target: "_blank", rel: "noopener noreferrer" });
    book.textContent = T.fallbackBook;
    b.append(mail, T.fallbackMid, book, ".");
    list.append(b);
    list.scrollTop = list.scrollHeight;
  };

  let typingEl = null;
  const showTyping = (on) => {
    if (on && !typingEl) {
      typingEl = el("div", "chat-bubble chat-assistant chat-typing", { "aria-hidden": "true" });
      typingEl.innerHTML = "<span></span><span></span><span></span>";
      list.append(typingEl);
      list.scrollTop = list.scrollHeight;
    } else if (!on && typingEl) {
      typingEl.remove();
      typingEl = null;
    }
  };

  // ---- Open / close ----
  const setOpen = (v) => {
    open = v;
    card.hidden = !v;
    launcher.setAttribute("aria-expanded", String(v));
    if (v) {
      hideTeaser();
      markIntroSeen();
      launcher.classList.add("calm"); // pulse ring retires after the first open
      if (!greeted) {
        greeted = true;
        if (history.length) history.forEach((m) => addBubble(m.role, m.content));
        else addBubble("assistant", T.greeting); // greeting only — never sent to the API
      }
      input.focus();
      list.scrollTop = list.scrollHeight;
    } else {
      launcher.focus();
    }
  };

  launcher.addEventListener("click", () => setOpen(!open));
  teaserBody.addEventListener("click", () => setOpen(true));
  closeBtn.addEventListener("click", () => setOpen(false));
  card.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });

  // Public hook: any [data-open-chat] element opens the chat card.
  document.addEventListener("click", (e) => {
    const t = e.target.closest && e.target.closest("[data-open-chat]");
    if (!t) return;
    e.preventDefault();
    setOpen(true);
    card.scrollIntoView({ block: "nearest" });
  });

  // ---- Send ----
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || waiting) return;
    input.value = "";

    addBubble("user", text);
    history.push({ role: "user", content: text });
    saveHistory(history);

    waiting = true;
    sendBtn.disabled = true;
    showTyping(true);

    try {
      const res = await fetch(CHAT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.slice(-MAX_HISTORY), lang: RU ? "ru" : "en" }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const reply = (await res.json()).reply;
      if (typeof reply !== "string" || !reply) throw new Error("bad payload");
      history.push({ role: "assistant", content: reply });
      saveHistory(history);
      showTyping(false);
      addBubble("assistant", reply);
    } catch {
      showTyping(false);
      addFallback(); // graceful offline fallback — not stored in history
    }

    waiting = false;
    sendBtn.disabled = false;
    input.focus();
  });
})();
