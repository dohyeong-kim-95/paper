// vocab: 단어장 — 선택한 용어를 문장·논문과 함께 저장(pr:vocab), 홈에서 간격 반복 복습 (1·3·7·14·30일)
(function () {
  "use strict";
  // ---------- 순수 함수 (node 테스트 대상) ----------
  const DAY = 864e5;
  const INTERVALS = [1, 3, 7, 14, 30]; // step n(≥1)의 다음 복습 = INTERVALS[n-1]일 뒤. '몰라요'는 step 0 + 1일 뒤
  const MASTERED = INTERVALS.length;    // 이 단계면 '익힘' (계속 30일 간격)
  const MAX_CARDS = 1000;
  const SENTENCE_MAX = 300, MEANING_MAX = 400;
  const MEANING_LABEL = "뜻 (이 논문에서)";
  // smart-presets의 'meaning' 프리셋이 없을 때 쓰는 질문 (첫 줄이 이 논문에서의 뜻 → 단어장 뜻으로 그대로 쓰기 좋게)
  const MEANING_Q = "선택한 표현의 한국어 뜻을 알려줘: 첫 줄에 이 논문에서 쓰인 뜻을 **굵게** 한 줄로, 그다음 짧은 설명과 다른 뜻 1~2개. 5줄 이내.";
  const ERROR_TAIL = /\n\n\[오류\][^\n]*$/;

  const clean = s => String(s ?? "").replace(/\s+/g, " ").trim();
  const countWords = s => clean(s).split(" ").filter(Boolean).length;
  // 저장할 용어: 앞뒤 따옴표·끝 구두점·감싼 괄호 제거 ("(KD)" → "KD", "experts." → "experts")
  function cleanTerm(t) {
    let s = clean(t).replace(/^["'“‘]+/, "").replace(/["'”’.,;:!?]+$/, "").trim();
    if (/^\(.*\)$/.test(s) || /^\[.*\]$/.test(s)) s = s.slice(1, -1).trim();
    return s.slice(0, 80);
  }
  // 같은 단어 판정 (= 카드 id): 대소문자·공백 무시. 기기 사이 가져오기(id 기준 병합)에서도 한 장으로 합쳐짐
  const termKey = t => cleanTerm(t).toLowerCase();

  // context 안에서 term 위치 (selInfo.prefix로 선택한 바로 그 자리를 먼저, 없으면 첫 등장)
  function findTerm(text, term, prefix = "") {
    const low = text.toLowerCase(), t = clean(term).toLowerCase();
    if (!t) return -1;
    const pre = clean(prefix).toLowerCase().slice(-24);
    if (pre) {
      for (const p of [`${pre} ${t}`, pre + t]) {
        const i = low.indexOf(p);
        if (i >= 0) return i + p.length - t.length;
      }
    }
    return low.indexOf(t);
  }

  // 문장 경계: . ! ? (닫는 따옴표·괄호, 각주 번호 "cheap.1" 허용) + 공백 + 대문자·숫자·수식·여는 괄호.
  // 약어(e.g. Fig. et al.)·소수("3.1 We") 뒤는 경계 아님
  const ABBR = /\b(?:e\.g|i\.e|cf|vs|al|fig|figs|eq|eqs|sec|secs|tab|no|approx|resp|ref|refs|vol|pp|dr|prof)\.$/i;
  function sentenceBounds(text, from, to) {
    const re = /([.!?])(["'”’)\]]*)(\d{0,2})\s+(?=["“'‘([]?[A-Z0-9$])/g;
    let start = 0, end = text.length, m;
    while ((m = re.exec(text))) {
      if (m[1] === "." && ABBR.test(text.slice(Math.max(0, m.index - 8), m.index + 1))) continue;
      if (m[3] && /\d/.test(text[m.index - 1] || "")) continue;
      const next = m.index + m[0].length;
      if (next <= from) start = next;
      else if (m.index >= to) { end = m.index + m[1].length + m[2].length; break; } // 각주 번호는 뺌
    }
    return { start, end };
  }
  // 긴 문장은 용어 주변 max자만 (단어 경계에서 자르고 …)
  function clipAroundTerm(s, at, len, max = SENTENCE_MAX) {
    if (s.length <= max) return s;
    let a = Math.max(0, Math.min(at - Math.floor((max - len) / 2), s.length - max)), b = a + max;
    if (a > 0) { const i = s.indexOf(" ", a); if (i >= 0 && i < at) a = i + 1; }
    if (b < s.length) { const j = s.lastIndexOf(" ", b); if (j > at + len) b = j; }
    return (a > 0 ? "…" : "") + s.slice(a, b).trim() + (b < s.length ? "…" : "");
  }
  // 선택한 용어가 들어 있는 문장 (selInfo.context = 문단 텍스트, 수식은 $alttext$). 못 찾으면 ""
  function sentenceAround(context, term, prefix = "") {
    const text = clean(context);
    const t = clean(term);
    const at = findTerm(text, t, prefix);
    if (!t || at < 0) return "";
    const { start, end } = sentenceBounds(text, at, at + t.length);
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    return clipAroundTerm(raw.trim(), at - start - lead, t.length);
  }

  // '뜻' 답변 → 단어장 뜻: 앞 2줄 (용어만 있는 머리줄·제목 기호·근거 줄 이후는 뺌).
  // 앞 2줄에 이 논문의 뜻(**굵게**, 용어 자체 말고)이 없으면 그 줄을 하나 더
  function meaningFromAnswer(text, term = "") {
    const key = termKey(term);
    let lines = String(text || "").replace(ERROR_TAIL, "").split("\n")
      .map(l => l.trim().replace(/^#{1,6}\s+/, ""))
      .filter(l => l && !/^([-*_]\s*){3,}$/.test(l) && !/^(```|~~~)/.test(l));
    const ev = lines.findIndex(l => /^[\s>*_\-•·([]*(?:📍\s*)?근거(?:\s*문장)?[\s*_]*[:：]/.test(l));
    if (ev >= 0) lines = lines.slice(0, ev);
    const bare = l => termKey(l.replace(/[*_`>]/g, "").replace(/[:：]\s*$/, ""));
    if (lines.length && key && bare(lines[0]) === key) lines.shift();
    const hasMeaning = l => [...l.matchAll(/\*\*([^*]+)\*\*/g)].some(m => termKey(m[1]) !== key);
    const out = lines.slice(0, 2);
    if (!out.some(hasMeaning)) { const b = lines.slice(2).find(hasMeaning); if (b) out.push(b); }
    return out.join("\n").slice(0, MEANING_MAX).trim();
  }

  // 새 카드: 바로 복습 대상 (due = now, step 0)
  function makeCard({ term, sentence = "", paperId = "", title = "", prefix = "", meaning = "" } = {}, now = Date.now()) {
    const t = cleanTerm(term);
    return {
      id: termKey(t), term: t, sentence: clean(sentence).slice(0, SENTENCE_MAX + 2), paperId: String(paperId || ""),
      title: clean(title).slice(0, 200), prefix: clean(prefix).slice(-32), meaning: String(meaning || "").trim().slice(0, MEANING_MAX),
      due: now, step: 0, ts: now, added: now,
    };
  }
  // 목록에 넣기: 이미 있으면 복습 단계·처음 문장은 그대로, 비어 있던 칸만 채우고 새 뜻은 덮어씀 → {list, card, existed}
  function upsertCard(list, card) {
    const arr = Array.isArray(list) ? list.filter(c => c && typeof c === "object" && c.id) : [];
    const i = arr.findIndex(c => c.id === card.id);
    if (i < 0) {
      let out = [...arr, card];
      if (out.length > MAX_CARDS) out = out.sort((a, b) => (b.added || b.ts || 0) - (a.added || a.ts || 0)).slice(0, MAX_CARDS);
      return { list: out, card, existed: false };
    }
    const old = arr[i];
    const merged = { ...old, ts: card.ts };
    if (!old.sentence && card.sentence) Object.assign(merged, { sentence: card.sentence, paperId: card.paperId, title: card.title, prefix: card.prefix });
    if (card.meaning) merged.meaning = card.meaning;
    const out = arr.slice();
    out[i] = merged;
    return { list: out, card: merged, existed: true };
  }

  // 복습 결과: 'got' → 한 단계 올리고 그 단계 간격 뒤, 'forgot' → step 0, 1일 뒤. ts 갱신 (가져오기 병합은 큰 ts가 이김)
  function review(card, grade, now = Date.now()) {
    const step = grade === "got" ? Math.min((card.step || 0) + 1, MASTERED) : 0;
    const days = INTERVALS[Math.max(0, step - 1)];
    return { ...card, step, due: now + days * DAY, ts: now, reviews: (card.reviews || 0) + 1 };
  }
  const intervalDays = (card, grade) => Math.round(review(card, grade, 0).due / DAY);
  // now까지 복습할 카드: 오래 밀린 것부터 (같으면 낮은 단계 → 먼저 넣은 것)
  function dueCards(list, now = Date.now()) {
    return (Array.isArray(list) ? list : [])
      .filter(c => c && c.term && (Number(c.due) || 0) <= now)
      .sort((a, b) => (Number(a.due) || 0) - (Number(b.due) || 0) || (a.step || 0) - (b.step || 0) || (a.added || a.ts || 0) - (b.added || b.ts || 0));
  }
  // 오늘 끝 (지역 시간). 홈은 dueCards(list, dayEnd(now)): 오늘 안에 돌아오는 카드는 아침에 열어도 복습 대상
  const dayEnd = now => { const d = new Date(now); d.setHours(23, 59, 59, 999); return d.getTime(); };
  const daysUntil = (due, now = Date.now()) => Math.max(0, Math.ceil(((Number(due) || 0) - dayEnd(now)) / DAY));

  // 논문의 그 단어로 돌아가는 링크 (entry-routes의 #q= 딥링크 형식: 인용 + 앞 문맥 p). 기능이 없으면 논문만 열림
  const enc = s => encodeURIComponent(s).replace(/[!'()*~]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  function deepLink(card) {
    if (!card || !card.paperId) return "";
    const base = `/paper/${enc(card.paperId)}`;
    return card.term ? `${base}#q=${enc(card.term)}${card.prefix ? `&p=${enc(card.prefix)}` : ""}` : base;
  }

  // Anki로 가져오기용 TSV (앞면 용어, 뒷면 뜻·문장·논문). 칸 안의 줄바꿈은 <br>, **굵게**는 <b>
  function toTSV(list) {
    const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const cell = s => esc(s).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/[\t\r]/g, " ").replace(/\n/g, "<br>");
    const rows = (Array.isArray(list) ? list : []).filter(c => c && c.term)
      .map(c => [c.term, c.meaning, c.sentence, c.title, c.paperId].map(cell).join("\t"));
    return `#separator:tab\n#html:true\n${rows.join("\n")}\n`;
  }

  const api = {
    DAY, INTERVALS, MEANING_Q, cleanTerm, termKey, findTerm, sentenceBounds, sentenceAround, meaningFromAnswer,
    makeCard, upsertCard, review, intervalDays, dueCards, dayEnd, daysUntil, deepLink, toTSV,
  };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;
  const page = document.body.dataset.page;
  if (page !== "paper" && page !== "home") return; // 논문(저장)과 홈(복습)에서만
  PaperApp.registerFeature("vocab", api);

  // ---------- 저장 (pr:vocab, 전역) ----------
  const UI = window.PaperUI, store = window.PaperStore, h = UI.h;
  const KEY = "vocab";
  const load = () => { const v = store.get(KEY, []); return Array.isArray(v) ? v.filter(c => c && typeof c === "object" && c.id && c.term) : []; };
  function put(info) {
    const card = makeCard(info);
    if (!card.id) return null;
    const res = upsertCard(load(), card);
    return store.set(KEY, res.list) ? res : null; // 용량 초과 토스트는 PaperStore가 띄움
  }
  const md = (el, text) => (window.renderAnswerNow ? window.renderAnswerNow(el, text) : (el.textContent = text));
  // 용어·문장 속 $수식$ (KaTeX auto-render가 와 있으면)
  const math = el => {
    try { window.renderMathInElement && window.renderMathInElement(el, { delimiters: [{ left: "$", right: "$", display: false }], throwOnError: false }); } catch { /* 무시 */ }
    return el;
  };

  // ---------- 논문 페이지: 선택 버튼 '단어장' + '뜻' 답변 아래 '단어장에 추가' ----------
  if (page === "paper") {
    const paperTitle = () => clean(document.title) || PaperApp.arxivId || "";
    // '뜻 (이 논문에서)' 프리셋으로 바로 묻기 (smart-presets가 없으면 같은 id의 기본 질문)
    function askMeaning(s) {
      const p = PaperApp.presets().find(x => x.id === "meaning");
      let q = p && p.q;
      try { if (typeof q === "function") q = q(s, null); } catch { q = null; }
      PaperApp.openSheet({
        quote: s.text, selection: s.text, context: s.context, section: s.sectionTitle, selInfo: s,
        autoAsk: { q: q || MEANING_Q, label: (p && p.label) || MEANING_LABEL, id: "meaning" },
      });
    }

    PaperApp.addSelectionAction({
      id: "vocab", label: "단어장", order: 50,
      when: s => s.wordCount <= 4 && s.anchored,
      onClick: s => {
        const term = cleanTerm(s.text);
        if (!term) return;
        const res = put({ term, sentence: sentenceAround(s.context, s.text, s.prefix), paperId: PaperApp.arxivId, title: paperTitle(), prefix: s.prefix });
        if (!res) return;
        const msg = res.existed ? `이미 단어장에 있어요: ${term}` : `단어장에 추가: ${term}`;
        UI.toast(msg, res.card.meaning ? {} : { actionLabel: "뜻 묻기", onAction: () => askMeaning(s) });
      },
    });

    // 세션의 문맥에서 다른 기능이 덧붙인 <reader>·<my-notes> 같은 태그 블록은 빼고 문장 찾기
    const stripTags = s => String(s || "").replace(/<([a-z][\w-]*)>[\s\S]*?<\/\1>/gi, " ");
    PaperApp.addAnswerAction({
      id: "vocab", order: 40,
      render(d) {
        if (d.presetId !== "meaning") return null; // 라벨 글자가 아니라 프리셋 id로 (복원된 턴도 meta로 유지)
        const s = d.session || {}, si = s.selInfo || {};
        const raw = si.text || s.selection || "";
        const term = cleanTerm(raw);
        if (!term || countWords(term) > 6) return null;
        const meaning = meaningFromAnswer(d.text, term);
        if (!meaning) return null;
        const existing = load().find(c => c.id === termKey(term));
        const btn = h("button", { type: "button", class: "vo-add", text: existing && existing.meaning && existing.meaning !== meaning ? "단어장 뜻 바꾸기" : "단어장에 추가" });
        const done = label => { btn.textContent = label; btn.disabled = true; btn.classList.add("vo-done"); };
        const save = () => !!put({
          term, meaning, paperId: PaperApp.arxivId, title: paperTitle(), prefix: si.prefix || "",
          sentence: sentenceAround(si.context || stripTags(s.context), raw, si.prefix || ""),
        });
        btn.addEventListener("click", () => { if (save()) done("✓ 단어장에 저장됨"); });
        if (existing && existing.meaning === meaning) done("✓ 단어장에 있음");
        // 단어장에 넣어 두고 뜻을 물은 경우: 뜻 칸을 바로 채움 (복원된 턴은 저장하지 않음)
        else if (existing && !existing.meaning && !d.restored && save()) done("✓ 단어장 뜻 저장됨");
        return btn;
      },
    });
    return;
  }

  // ---------- 홈: 단어장 복습 (N) ----------
  const sec = UI.homeSection({ id: "vocab", title: "단어장 복습" });
  if (!sec) return;
  sec.classList.add("vo-home");
  const head = sec.querySelector("h2");
  const box = h("div", { class: "vo-box" });
  sec.append(box);
  let revealedId = null, showAll = false;

  const dayText = (due, now) => { const n = daysUntil(due, now); return n ? `${n}일 뒤` : "오늘"; };
  const firstLine = m => clean(String(m || "").split("\n")[0].replace(/\*\*|__|[`#>]/g, "").replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""));
  // 문장 안의 용어를 굵게 (대소문자 무시, 첫 등장)
  function sentenceEl(sentence, term) {
    const p = h("p", { class: "vo-sentence" });
    const i = sentence.toLowerCase().indexOf(term.toLowerCase());
    if (i < 0) p.textContent = sentence;
    else p.append(sentence.slice(0, i), h("b", { text: sentence.slice(i, i + term.length) }), sentence.slice(i + term.length));
    return math(p);
  }

  function grade(card, g) {
    const now = Date.now();
    const list = load();
    const i = list.findIndex(c => c.id === card.id);
    if (i < 0) { render(); return; }
    list[i] = review(list[i], g, now);
    store.set(KEY, list);
    revealedId = null;
    render();
    box.querySelector(".vo-card button, .vo-done-msg")?.focus?.({ preventScroll: true });
  }

  function remove(card) {
    const list = load();
    const i = list.findIndex(c => c.id === card.id);
    if (i < 0) return;
    const [old] = list.splice(i, 1);
    store.set(KEY, list);
    render();
    UI.toast("삭제됨", {
      actionLabel: "실행 취소",
      onAction: () => {
        const cur = load();
        if (!cur.some(c => c.id === old.id)) { cur.splice(Math.min(i, cur.length), 0, old); store.set(KEY, cur); }
        render();
      },
    });
  }

  function cardEl(card, left) {
    const revealed = revealedId === card.id;
    const term = math(h("div", { class: "vo-term", text: card.term }));
    const meta = h("div", { class: "vo-meta" },
      h("span", { text: `남은 단어 ${left}` }),
      h("span", { text: (card.step || 0) >= MASTERED ? "익힘" : card.reviews ? `${card.step || 0}/${MASTERED}단계` : "새 단어" }));
    const el = h("div", { class: "vo-card", role: "group", "aria-label": "복습 카드" }, meta, term);
    const actions = h("div", { class: "vo-actions" });
    if (!revealed) {
      actions.append(h("button", {
        type: "button", class: "vo-btn vo-reveal", text: "뜻 보기",
        onclick: () => { revealedId = card.id; render(); box.querySelector(".vo-got")?.focus?.({ preventScroll: true }); },
      }));
    } else {
      const meaning = h("div", { class: "vo-meaning" });
      if (card.meaning) md(meaning, card.meaning);
      else meaning.append(h("p", { class: "vo-hint", text: "아직 뜻이 없어요 · 논문에서 이 단어를 선택해 '뜻 (이 논문에서)'를 물으면 채워져요" }));
      el.append(meaning);
      if (card.sentence) el.append(sentenceEl(card.sentence, card.term));
      const link = deepLink(card);
      if (link) el.append(h("a", { class: "vo-src", href: link, text: card.title || card.paperId }));
      const btn = (cls, label, g) => h("button", { type: "button", class: `vo-btn ${cls}`, onclick: () => grade(card, g) },
        label, " ", h("small", { text: `${intervalDays(card, g)}일` }));
      actions.append(btn("vo-forgot", "몰라요", "forgot"), btn("vo-got", "알아요", "got"));
    }
    el.append(actions);
    return el;
  }

  function listEl(list, now) {
    const rows = list.slice().sort((a, b) => (b.added || b.ts || 0) - (a.added || a.ts || 0)).map(c => {
      const link = deepLink(c);
      const name = math(h(link ? "a" : "span", { class: "vo-row-term", href: link || null, text: c.term }));
      const status = (c.step || 0) >= MASTERED ? "익힘" : dayText(c.due, now);
      return h("li", { class: "vo-row" },
        h("div", { class: "vo-row-main" }, name,
          h("div", { class: "vo-row-sub", text: `${firstLine(c.meaning) || "뜻 없음"} · ${status}` }),
          c.title ? h("div", { class: "vo-row-sub", text: c.title }) : null),
        h("button", { type: "button", class: "vo-del", "aria-label": `${c.term} 삭제`, text: "✕", onclick: () => remove(c) }));
    });
    const stamp = new Date(now).toISOString().slice(0, 10);
    return h("div", { class: "vo-all" }, h("ul", { class: "vo-list" }, rows),
      h("button", { type: "button", class: "vo-link", text: "Anki로 내보내기 (TSV)", onclick: () => UI.download(`vocab-${stamp}.tsv`, toTSV(list), "text/tab-separated-values") }));
  }

  function render() {
    const now = Date.now(), list = load(), due = dueCards(list, dayEnd(now));
    if (head) head.textContent = due.length ? `단어장 복습 (${due.length})` : "단어장 복습";
    const kids = [];
    if (!list.length) {
      kids.push(h("p", { class: "vo-empty", text: "논문에서 단어를 선택하고 '단어장'을 누르면 문장과 함께 모여요. 1·3·7·14·30일 간격으로 복습합니다." }));
    } else if (due.length) {
      kids.push(cardEl(due[0], due.length));
    } else {
      const next = Math.min(...list.map(c => Number(c.due) || 0));
      kids.push(h("p", { class: "vo-done-msg", tabindex: "-1", text: `오늘 복습 끝! 다음 복습은 ${dayText(next, now)}` }));
    }
    if (list.length) {
      kids.push(h("button", {
        type: "button", class: "vo-link", "aria-expanded": String(showAll),
        text: showAll ? "전체 단어 접기" : `전체 단어 ${list.length}개`,
        onclick: () => { showAll = !showAll; render(); },
      }));
      if (showAll) kids.push(listEl(list, now));
    }
    box.replaceChildren(...kids);
  }
  render();
  // 논문에서 단어를 넣고 뒤로 왔을 때(bfcache)·다른 탭에서 바뀌었을 때·날짜가 바뀐 뒤 다시 열 때
  window.addEventListener("pageshow", e => { if (e.persisted) render(); });
  window.addEventListener("storage", e => { if (e.key === store.key(KEY)) render(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") render(); });
})();
