// daily-feed: 홈 화면 '오늘의 새 논문' — 관심 분야·팔로우 저자 arXiv 피드, 한국어 제목·한 줄 요약, AND/OR 키워드 필터
(function () {
  "use strict";

  // ---------- 순수 함수 (node 테스트 대상) ----------
  const CAT_RE = /^[a-z-]+(\.[A-Za-z-]+)?$/; // 서버와 같은 규칙
  const DEFAULT_CATS = ["cs.CL", "cs.LG", "cs.AI"];
  const POPULAR = ["cs.CL", "cs.LG", "cs.AI", "cs.CV", "cs.IR", "cs.RO", "cs.SE", "cs.CR", "cs.HC", "stat.ML", "eess.AS", "eess.IV", "q-bio.NC", "math.OC"];
  const MAX_CATS = 8, MAX_AUTHORS = 12;
  const AUTHOR_RE = /^\p{L}[\p{L} .'-]*$/u; // 글자로 시작, 글자·공백·. ' - 만 (서버 검증과 같게)

  const validCat = c => typeof c === "string" && c.length <= 40 && CAT_RE.test(c);
  // "CS.lg" → "cs.LG" (두 글자 세부 분야는 대문자: cs.LG, math.OC / 그 외는 그대로: physics.comp-ph, cond-mat.mes-hall)
  function normCat(s) {
    const m = /^([A-Za-z-]+)(?:\.([A-Za-z-]+))?$/.exec(String(s || "").trim());
    if (!m) return null;
    const c = m[1].toLowerCase() + (m[2] ? "." + (m[2].length === 2 ? m[2].toUpperCase() : m[2]) : "");
    return validCat(c) ? c : null;
  }
  // "cs.CL, cs.lg; stat.ML  x;y" → ["cs.CL", "cs.LG", "stat.ML"] (중복·잘못된 것 제외)
  function parseCats(text, max = MAX_CATS) {
    const out = [];
    for (const t of String(text || "").split(/[\s,;]+/)) {
      const c = normCat(t);
      if (c && !out.includes(c)) out.push(c);
    }
    return out.slice(0, max);
  }
  function normAuthor(s) {
    const n = String(s || "").normalize("NFC").replace(/\s+/g, " ").trim();
    return n.length >= 2 && n.length <= 60 && AUTHOR_RE.test(n) ? n : null;
  }

  // 피드 출처: {type: "cat"|"au", value} ↔ 키 "cat:cs.CL" / "au:Alice Kim"
  const srcKey = s => `${s.type}:${s.value}`;
  function parseSrc(key) {
    const m = /^(cat|au):(.+)$/.exec(String(key || ""));
    if (!m) return null;
    const value = m[1] === "cat" ? normCat(m[2]) : normAuthor(m[2]);
    return value ? { type: m[1], value } : null;
  }
  const feedUrl = (src, ko = false, retry = false) =>
    `/api/daily-feed${ko ? "/ko" : ""}?${src.type === "au" ? "author" : "cat"}=${encodeURIComponent(src.value)}${retry ? "&retry=1" : ""}`;

  // 키워드: 'LLM "in-context learning" -survey' → {inc: ["llm", "in-context learning"], exc: ["survey"]}
  function parseQuery(q) {
    const inc = [], exc = [];
    String(q || "").replace(/(-?)"([^"]+)"|(\S+)/g, (_, neg, phrase, word) => {
      let t = (phrase || word || "").replace(/"/g, "").trim().toLowerCase(), not = !!neg;
      if (!phrase && t.startsWith("-") && t.length > 1) { not = true; t = t.slice(1); }
      const list = not ? exc : inc;
      if (t && t !== "-" && !list.includes(t)) list.push(t);
      return "";
    });
    return { inc, exc };
  }
  const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 영문 단어는 단어 시작에서만 (rl이 world에 걸리지 않게, agent는 agents에 걸림). 한글 등은 부분 문자열
  function hasTerm(text, t) {
    if (/^[\x20-\x7e]+$/.test(t) && /^[a-z0-9]/.test(t)) return new RegExp(`(^|[^a-z0-9])${reEsc(t)}`).test(text);
    return text.includes(t);
  }
  const haystack = (it, ko) =>
    [it.title, it.summary, (it.authors || []).join(" "), it.cat, ko && ko.t, ko && ko.b].filter(Boolean).join("\n").toLowerCase();
  // mode: "and"(모두 포함) | "or"(하나라도). 제외어(-x)는 언제나 제외
  function matchItem(it, query, mode = "and", ko = null) {
    const { inc, exc } = typeof query === "string" ? parseQuery(query) : query;
    if (!inc.length && !exc.length) return true;
    const text = haystack(it, ko);
    if (exc.some(t => hasTerm(text, t))) return false;
    if (!inc.length) return true;
    return mode === "or" ? inc.some(t => hasTerm(text, t)) : inc.every(t => hasTerm(text, t));
  }

  // 날짜 묶음 (arXiv는 하루 단위로 발표): 오늘 / 어제 / 10월 21일 (수)
  const pad = n => String(n).padStart(2, "0");
  const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const WEEK = "일월화수목금토";
  function dayLabel(iso, now = new Date()) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "날짜 없음";
    const k = dayKey(d), y = new Date(now);
    y.setDate(y.getDate() - 1);
    if (k === dayKey(now)) return "오늘";
    if (k === dayKey(y)) return "어제";
    return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEK[d.getDay()]})`;
  }
  function groupByDay(items, now = new Date()) {
    const out = [];
    for (const it of items) {
      const label = dayLabel(it.published, now);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(it);
      else out.push({ label, items: [it] });
    }
    return out;
  }
  // 지난 방문 이후 새로 올라온 논문 (첫 방문엔 표시 없음)
  const isNew = (it, since) => !!since && Date.parse(it.published) > Date.parse(since);
  function newest(items) {
    let best = "", bt = -Infinity;
    for (const it of items) { const t = Date.parse(it.published); if (t > bt) { bt = t; best = it.published; } }
    return best;
  }
  // 서재 기록 → 최근 연 순 base id 목록
  function libraryIds(lib, max = 20) {
    if (!lib || typeof lib !== "object") return [];
    return Object.values(lib).filter(r => r && typeof r === "object" && /^\d{4}\.\d{4,5}$/.test(String(r.id || "")))
      .sort((a, b) => (b.opened || 0) - (a.opened || 0)).slice(0, max).map(r => r.id);
  }
  // 추천 분야 + 기본값으로 3개 이상 채움
  const withDefaults = (sug, min = 3) => {
    const out = parseCats((sug || []).join(" "));
    for (const c of DEFAULT_CATS) if (out.length < min && !out.includes(c)) out.push(c);
    return out;
  };

  const api = {
    DEFAULT_CATS, validCat, normCat, parseCats, normAuthor, srcKey, parseSrc, feedUrl, parseQuery, hasTerm, matchItem,
    dayLabel, groupByDay, isNew, newest, libraryIds, withDefaults,
  };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;
  if (document.body.dataset.page !== "home") return;
  PaperApp.registerFeature("daily-feed", api);

  // ---------- DOM ----------
  const UI = window.PaperUI, store = window.PaperStore, h = UI.h;
  const sec = UI.homeSection({ id: "daily-feed", title: "오늘의 새 논문" });
  if (!sec) return;

  const PREFS = { active: "", ko: true, view: "list", q: "", mode: "and" };
  const prefs = { ...PREFS, ...(store.get("daily-feed:prefs", {}) || {}) };
  const savePrefs = () => store.set("daily-feed:prefs", prefs);
  const savedCats = store.get("daily-feed:cats", null);
  let cats = Array.isArray(savedCats) ? parseCats(savedCats.join(" ")) : DEFAULT_CATS.slice();
  let authors = (store.get("daily-feed:authors", []) || []).map(normAuthor).filter(Boolean);
  let items = [], ko = {}, seq = 0, since = "";
  const cards = new Map(); // id -> {card, titleEl, enEl, blurbEl}

  const sources = () => [...cats.map(value => ({ type: "cat", value })), ...authors.map(value => ({ type: "au", value }))];
  const activeSrc = () => {
    const all = sources(), s = parseSrc(prefs.active);
    return (s && all.find(x => srcKey(x) === srcKey(s))) || all[0] || null;
  };

  // ---------- 뼈대 ----------
  const chipsEl = h("div", { class: "df-chips", role: "group", "aria-label": "피드 분야·저자" });
  const qInput = h("input", {
    class: "df-q", type: "search", enterkeyhint: "search", "aria-label": "키워드 필터",
    placeholder: "키워드 필터 (예: agent)", title: '띄어 쓴 단어 모두(AND)/하나라도(OR), "구절", -제외어',
  });
  qInput.value = prefs.q;
  const modeBtn = h("button", { class: "df-tool df-mode", type: "button" });
  const koBtn = h("button", { class: "df-tool", type: "button", text: "한글", title: "한국어 제목·한 줄 요약" });
  const viewBtn = h("button", { class: "df-tool", type: "button", text: "카드", title: "한 장씩 넘겨 보기" });
  const countEl = h("span", { class: "df-count", "aria-live": "polite" });
  const statusEl = h("div", { class: "df-status", role: "status", hidden: true });
  const listEl = h("div", { class: "df-list" });
  sec.classList.add("df-root");
  sec.append(chipsEl, h("div", { class: "df-tools" }, qInput, modeBtn, koBtn, viewBtn, countEl), statusEl, listEl);

  function syncTools() {
    modeBtn.textContent = prefs.mode === "or" ? "OR" : "AND";
    modeBtn.setAttribute("aria-label", prefs.mode === "or" ? "키워드 조건: 하나라도 포함 (바꾸기)" : "키워드 조건: 모두 포함 (바꾸기)");
    koBtn.setAttribute("aria-pressed", String(!!prefs.ko));
    viewBtn.setAttribute("aria-pressed", String(prefs.view === "brief"));
    listEl.classList.toggle("df-brief", prefs.view === "brief");
  }

  // 상태 줄 (홈에는 헤더 상태 칩 자리가 없음): status(text, "loading"|"error"|null, onRetry)
  function status(text, state, onRetry) {
    statusEl.hidden = !text;
    statusEl.dataset.state = state || "";
    statusEl.replaceChildren(text ? h("span", { text }) : "");
    if (text && onRetry) statusEl.append(h("button", { class: "df-retry", type: "button", text: "다시", onclick: onRetry }));
  }

  function renderChips() {
    const cur = activeSrc();
    chipsEl.replaceChildren(
      ...sources().map(s => h("button", {
        class: `df-chip${s.type === "au" ? " df-chip-au" : ""}`, type: "button",
        "aria-pressed": String(!!cur && srcKey(s) === srcKey(cur)),
        text: s.type === "au" ? `👤 ${s.value}` : s.value,
        onclick: () => select(s),
      })),
      h("button", { class: "df-chip df-chip-edit", type: "button", text: "＋ 편집", "aria-label": "분야·저자 편집", onclick: openEditor }),
    );
  }

  function select(s) {
    prefs.active = srcKey(s);
    savePrefs();
    renderChips();
    load();
  }

  // ---------- 카드 ----------
  const libraryAdd = () => window.PaperApp.feature("library")?.add;
  function card(it) {
    const titleEl = h("a", { class: "df-title", href: `/paper/${it.id}` });
    const enEl = h("div", { class: "df-en-title", lang: "en", text: it.title });
    const blurbEl = h("p", { class: "df-blurb" });
    const more = it.n_authors > it.authors.length ? ` 외 ${it.n_authors - it.authors.length}명` : "";
    const abs = h("details", { class: "df-abs" }, h("summary", { text: "초록" }), h("p", { lang: "en", text: it.summary }));
    if (prefs.view === "brief") abs.open = true;
    const actions = h("div", { class: "df-actions" },
      h("a", { class: "df-open", href: `/paper/${it.id}`, text: "열기" }),
      h("a", { class: "df-link", href: `https://arxiv.org/abs/${it.id}`, target: "_blank", rel: "noopener", text: "arXiv" }));
    if (libraryAdd()) {
      actions.append(h("button", {
        class: "df-link", type: "button", text: "나중에 읽기",
        onclick: () => {
          const add = libraryAdd();
          if (!add) return;
          add({ id: it.id, title: it.title, authors: it.authors, status: "to-read" });
          UI.toast("나중에 읽기에 추가했습니다");
        },
      }));
    }
    const el = h("article", { class: "df-card", dataset: { id: it.id } },
      h("div", { class: "df-meta" },
        it.cat ? h("span", { class: "df-cat", text: it.cat }) : null,
        isNew(it, since) ? h("span", { class: "df-new", text: "새 논문" }) : null,
        h("span", { class: "df-day", text: dayLabel(it.published) })),
      titleEl, enEl, blurbEl,
      h("div", { class: "df-authors" }, it.authors.map(a => h("button", {
        class: "df-au", type: "button", text: a, "aria-label": `${a}: 저자 팔로우·논문 보기`, onclick: () => authorPeek(a),
      })), more ? h("span", { text: more }) : null),
      abs, actions);
    cards.set(it.id, { el, titleEl, enEl, blurbEl, it });
    fillCard(it.id);
    return el;
  }
  // 한국어가 있으면 한국어 제목 + 영어 원제(작게) + 한 줄 요약, 없으면 영어 제목만
  function fillCard(id) {
    const c = cards.get(id);
    if (!c) return;
    const k = prefs.ko ? ko[id] : null;
    c.titleEl.textContent = k ? k.t : c.it.title;
    c.titleEl.lang = k ? "ko" : "en";
    c.enEl.hidden = !k;
    c.blurbEl.textContent = k ? k.b : "";
    c.blurbEl.hidden = !k;
  }

  function render() {
    cards.clear();
    listEl.replaceChildren();
    for (const g of groupByDay(items)) {
      listEl.append(h("h3", { class: "df-group", text: `${g.label} · ${g.items.length}편` }), ...g.items.map(card));
    }
    applyFilter();
  }

  function applyFilter() {
    const query = parseQuery(qInput.value);
    let shown = 0;
    for (const c of cards.values()) {
      const ok = matchItem(c.it, query, prefs.mode, prefs.ko ? ko[c.it.id] : null);
      c.el.hidden = !ok;
      if (ok) shown++;
    }
    // 묶음 제목: 그 아래 카드가 모두 숨으면 같이 숨김
    for (const g of listEl.querySelectorAll(".df-group")) {
      let n = g.nextElementSibling, any = false;
      for (; n && !n.classList.contains("df-group"); n = n.nextElementSibling) if (!n.hidden) any = true;
      g.hidden = !any;
    }
    const filtering = query.inc.length || query.exc.length;
    countEl.textContent = filtering && items.length ? `${shown}/${items.length}` : "";
    listEl.querySelector(".df-empty")?.remove();
    if (filtering && items.length && !shown) listEl.append(h("p", { class: "df-empty", text: "키워드에 맞는 논문이 없습니다" }));
  }

  // ---------- 불러오기 ----------
  async function errText(r) {
    try { return (await r.json()).detail || `HTTP ${r.status}`; } catch { return `HTTP ${r.status}`; }
  }
  // 지난 방문 기준 시각: 이 탭에서는 첫 로드 때 값으로 고정 (새로고침해도 '새 논문' 표시 유지)
  function baseline(key, list) {
    const sk = `daily-feed:base:${key}`;
    let b = store.session.get(sk, null);
    if (b === null) {
      b = (store.get("daily-feed:seen", {}) || {})[key] || "";
      store.session.set(sk, b);
    }
    const top = newest(list);
    if (top) store.update("daily-feed:seen", m => ({ ...(m && typeof m === "object" ? m : {}), [key]: top }), {});
    return b;
  }

  async function load() {
    const src = activeSrc(), my = ++seq;
    if (!src) { items = []; render(); status("편집에서 분야나 저자를 추가하세요", null); return; }
    prefs.active = srcKey(src); // 지금 보이는 출처 (편집 뒤 afterChange가 비교)
    status("불러오는 중…", "loading");
    listEl.setAttribute("aria-busy", "true");
    try {
      const r = await fetch(feedUrl(src));
      if (!r.ok) throw new Error(await errText(r));
      const list = await r.json();
      if (my !== seq) return;
      items = Array.isArray(list) ? list : [];
      ko = {};
      since = baseline(srcKey(src), items);
      render();
      status(items.length ? null : "새 논문이 없습니다", null);
      if (prefs.ko && items.length) window.PaperApp.idle(() => { loadKo(my); }); // 시작만 유휴 큐에서 (기다리지 않음)
    } catch (e) {
      if (my !== seq) return;
      status(`불러오지 못했습니다 · ${e.message || e}`, "error", load);
    } finally {
      if (my === seq) listEl.removeAttribute("aria-busy");
    }
  }

  async function loadKo(my = seq, retry = false) {
    const src = activeSrc();
    if (my !== seq || !src || !prefs.ko || !items.length) return;
    const n = items.length;
    status("한국어 제목·요약 만드는 중…", "loading");
    try {
      const r = await fetch(feedUrl(src, true, retry));
      if (!r.ok) throw new Error(await errText(r));
      const map = await r.json();
      if (my !== seq) return;
      ko = map && typeof map === "object" ? map : {};
      if (!prefs.ko) return; // 기다리는 동안 한글을 끔: 받아만 둠
      for (const id of cards.keys()) fillCard(id);
      applyFilter();
      const done = items.filter(it => ko[it.id]).length;
      if (done < n) status(`한국어 요약 ${done}/${n}`, "error", () => loadKo(seq, true));
      else status(null);
    } catch (e) {
      if (my !== seq) return;
      status("한국어 요약을 만들지 못했습니다", "error", () => loadKo(seq, true));
    }
  }

  // ---------- 편집 (분야·팔로우 저자) ----------
  function saveCats() { store.set("daily-feed:cats", cats); }
  function saveAuthors() { store.set("daily-feed:authors", authors); }
  function afterChange() {
    renderChips();
    const cur = activeSrc();
    if (!cur || srcKey(cur) !== prefs.active) {
      prefs.active = cur ? srcKey(cur) : "";
      savePrefs();
      load();
    }
  }
  function removeWithUndo(kind, value, redraw) {
    const list = kind === "cat" ? cats : authors;
    const i = list.indexOf(value);
    if (i < 0) return;
    list.splice(i, 1);
    kind === "cat" ? saveCats() : saveAuthors();
    redraw();
    afterChange();
    UI.toast(`${value} 삭제됨`, {
      actionLabel: "실행 취소",
      onAction: () => {
        const l = kind === "cat" ? cats : authors;
        if (!l.includes(value)) l.splice(Math.min(i, l.length), 0, value);
        kind === "cat" ? saveCats() : saveAuthors();
        redraw();
        afterChange();
      },
    });
  }
  function follow(name) {
    const n = normAuthor(name);
    if (!n) { UI.toast("저자 이름은 글자·공백·.'- 만 쓸 수 있습니다"); return false; }
    if (authors.includes(n)) return true;
    if (authors.length >= MAX_AUTHORS) { UI.toast(`저자는 ${MAX_AUTHORS}명까지 팔로우할 수 있습니다`); return false; }
    authors.push(n);
    saveAuthors();
    afterChange();
    return true;
  }

  function openEditor() {
    const body = h("div", { class: "df-edit" });
    const close = UI.peek({ title: "분야·저자 편집", body, className: "df-peek", onClose: () => renderChips() });
    const tag = (text, label, onRemove) => h("span", { class: "df-tag" }, h("span", { text }),
      h("button", { type: "button", class: "df-x", "aria-label": `${label} 삭제`, text: "✕", onclick: onRemove }));
    function addForm(placeholder, label, onAdd) {
      const input = h("input", { class: "df-input", placeholder, "aria-label": label, autocomplete: "off" });
      return h("form", {
        class: "df-add", onsubmit: e => { e.preventDefault(); if (onAdd(input.value)) { input.value = ""; draw(); } },
      }, input, h("button", { type: "submit", class: "df-btn", text: "추가" }));
    }
    function draw() {
      const libIds = libraryIds(store.get("library", {}));
      body.replaceChildren(
        h("h4", { text: "분야 (arXiv 카테고리)" }),
        h("div", { class: "df-tags" }, cats.length ? cats.map(c => tag(c, c, () => removeWithUndo("cat", c, draw))) : h("span", { class: "df-muted", text: "없음" })),
        addForm("예: cs.CV, stat.ML", "분야 추가", v => {
          const add = parseCats(v).filter(c => !cats.includes(c));
          if (!add.length) { UI.toast("분야 이름을 확인하세요 (예: cs.CL)"); return false; }
          cats = parseCats([...cats, ...add].join(" "));
          saveCats();
          afterChange();
          return true;
        }),
        h("div", { class: "df-suggest" }, POPULAR.filter(c => !cats.includes(c)).map(c => h("button", {
          type: "button", class: "df-chip", text: `+ ${c}`,
          onclick: () => { if (cats.length < MAX_CATS) { cats.push(c); saveCats(); afterChange(); draw(); } else UI.toast(`분야는 ${MAX_CATS}개까지`); },
        }))),
        libIds.length ? h("button", {
          type: "button", class: "df-btn df-lib", text: "내 서재 논문으로 분야 추천받기",
          onclick: async e => {
            e.currentTarget.disabled = true;
            const sug = (await suggest(libIds)) || [];
            const add = sug.filter(c => !cats.includes(c));
            if (add.length) { cats = parseCats([...add, ...cats].join(" ")); saveCats(); afterChange(); UI.toast(`추가: ${add.join(" · ")}`); }
            else UI.toast(sug.length ? "이미 모두 들어 있습니다" : "추천할 분야를 찾지 못했습니다");
            draw();
          },
        }) : "",
        h("h4", { text: "팔로우 저자" }),
        h("div", { class: "df-tags" }, authors.length ? authors.map(a => tag(`👤 ${a}`, a, () => removeWithUndo("au", a, draw))) : h("span", { class: "df-muted", text: "카드의 저자 이름을 눌러 팔로우할 수도 있습니다" })),
        addForm("예: Yann LeCun", "저자 추가", v => follow(v)),
      );
    }
    draw();
    return close;
  }

  // 카드의 저자 이름 → 팔로우(피드 칩에 추가)·그 저자의 최신 논문 보기
  function authorPeek(name) {
    const n = normAuthor(name);
    if (!n) { UI.toast("이 이름은 검색할 수 없습니다"); return; }
    const show = () => select({ type: "au", value: n });
    UI.peek({
      title: n, className: "df-peek",
      body: authors.includes(n) ? "팔로우 중인 저자입니다." : "팔로우하면 피드 칩에 추가되어 이 저자의 새 논문을 바로 볼 수 있습니다.",
      actions: authors.includes(n)
        ? [{ label: "팔로우 취소", onClick: ({ close }) => { close(); removeWithUndo("au", n, () => {}); } },
          { label: "논문 보기", primary: true, onClick: ({ close }) => { close(); show(); } }]
        : [{ label: "팔로우하고 논문 보기", primary: true, onClick: ({ close }) => { close(); if (follow(n)) { UI.toast(`${n} 팔로우`); show(); } } }],
    });
  }

  // 서재 논문들의 주 카테고리. 요청 실패는 null (다음 방문에 다시)
  async function suggest(ids, ms = 8000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(`/api/daily-feed/suggest?ids=${encodeURIComponent(ids.join(","))}`, { signal: ctl.signal });
      const d = r.ok ? await r.json() : null;
      return d && Array.isArray(d.cats) ? parseCats(d.cats.join(" ")) : null;
    } catch { return null; } finally { clearTimeout(t); }
  }

  // ---------- 도구 ----------
  let qTimer;
  qInput.addEventListener("input", () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { prefs.q = qInput.value; savePrefs(); applyFilter(); }, 120);
  });
  modeBtn.addEventListener("click", () => { prefs.mode = prefs.mode === "or" ? "and" : "or"; savePrefs(); syncTools(); applyFilter(); });
  koBtn.addEventListener("click", () => {
    prefs.ko = !prefs.ko;
    savePrefs();
    syncTools();
    for (const id of cards.keys()) fillCard(id);
    applyFilter();
    if (prefs.ko && items.length && !Object.keys(ko).length) loadKo(seq);
    else if (!prefs.ko) status(null);
  });
  viewBtn.addEventListener("click", () => {
    prefs.view = prefs.view === "brief" ? "list" : "brief";
    savePrefs();
    syncTools();
    for (const d of listEl.querySelectorAll(".df-abs")) d.open = prefs.view === "brief";
    if (prefs.view === "brief") listEl.scrollTop = 0;
  });

  // ---------- 시작 ----------
  // 첫 방문(저장된 분야 없음)이고 서재에 논문이 있으면 그 주 카테고리로 기본 분야를 정한 뒤 불러옴 (한 번만)
  async function start() {
    syncTools();
    renderChips();
    const libIds = savedCats === null ? libraryIds(store.get("library", {})) : [];
    if (libIds.length) {
      status("내 서재로 분야 고르는 중…", "loading");
      const sug = await suggest(libIds, 4000);
      if (sug) { // 찾은 게 없어도 기본값으로 저장 → 다시 묻지 않음
        cats = withDefaults(sug);
        saveCats();
        if (!prefs.active) prefs.active = srcKey({ type: "cat", value: cats[0] });
        renderChips();
      }
    }
    load();
  }
  start();
})();
