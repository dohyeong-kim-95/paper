// in-paper-search: 본문 찾기 줄 (개수·↑↓·문장만) + 한국어 의미 검색 'AI로 찾기'
(function () {
  "use strict";
  // 정규화 규칙은 PaperAnchor와 같게. 불러올 때가 아니라 쓸 때 찾음 (node 테스트는 anchor.js를 직접, 번들 검사 환경에는 없음)
  const anchor = () => (typeof PaperAnchor !== "undefined" ? PaperAnchor : require("../anchor.js"));

  // ---------- 순수 함수 (node 테스트 대상) ----------
  const MAX_HITS = 1000;
  const MIN_CHARS = 2;
  const HANGUL = /[ㄱ-ㆎ가-힣]/;
  const hasHangul = s => HANGUL.test(String(s || ""));

  // text 안의 query 위치 전부 → [{start, end}] (원문 오프셋). 대소문자·따옴표·대시·공백 차이 무시, 겹치지 않게
  function findAll(text, query, { nm, limit = MAX_HITS } = {}) {
    const q = anchor().normalize(query);
    if (!q) return [];
    const m = nm || anchor().normMap(String(text || ""));
    const out = [];
    for (let i = m.norm.indexOf(q); i >= 0 && out.length < limit; i = m.norm.indexOf(q, i + q.length)) {
      out.push({ start: m.map[i], end: m.map[i + q.length - 1] + 1 });
    }
    return out;
  }

  // offset 이후 첫 결과의 번호 (없으면 처음으로 돌아가 0)
  function nearestIndex(hits, offset) {
    let lo = 0, hi = hits.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (hits[mid].start < offset) lo = mid + 1; else hi = mid; }
    return lo < hits.length ? lo : 0;
  }

  // Enter를 눌렀을 때 AI로 찾을지: 한글 질문이거나, 글자 일치가 없는 3글자 이상
  const wantsAI = (query, count) => hasHangul(query) || (count === 0 && anchor().normalize(query).length >= 3);

  // 서버 응답 방어: [{q, why}] ≤5
  function cleanResults(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(r => r && typeof r.q === "string" && r.q.trim())
      .map(r => ({ q: r.q.trim(), why: typeof r.why === "string" ? r.why.trim() : "" }))
      .slice(0, 5);
  }

  // 최근 검색어: 맨 앞에, 대소문자 무시 중복 제거, max개
  function pushRecent(list, q, max = 8) {
    q = String(q || "").trim();
    const arr = Array.isArray(list) ? list.filter(x => typeof x === "string") : [];
    if (!q) return arr.slice(0, max);
    return [q, ...arr.filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, max);
  }

  // '3/12', 결과 없음 '0/0', 상한을 넘으면 '3/1000+'
  const countLabel = (cur, total, capped = false) => (total ? `${cur + 1}/${total}${capped ? "+" : ""}` : "0/0");

  const api = { findAll, nearestIndex, hasHangul, wantsAI, cleanResults, pushRecent, countLabel, MAX_HITS };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;           // node: 여기서 끝
  if (document.body.dataset.page !== "paper") return;
  PaperApp.registerFeature("in-paper-search", api);

  const UI = PaperUI, A = PaperAnchor, h = UI.h, store = PaperStore;
  const paperEl = document.getElementById("paper");
  if (!paperEl) return;
  const RECENT = "in-paper-search:recent";
  // '문장만'에서 흐리게 할 단위 (결과가 든 단위와 그 바깥 단위에는 ps-hit)
  const UNIT = ".ltx_para, .ltx_p, figure, table.ltx_equation, table.ltx_equationgroup";

  // ---------- 상태 ----------
  let closeLayer = null, slot = null, timer = 0, ctrl = null;
  let mode = "text";            // "text" 글자 일치 | "ai" AI 결과
  let hits = [], capped = false, ai = [], cur = -1, listOpen = true, declutter = false;
  let aiState = "";             // AI 모드: "loading" | "offline" | "error" | "done"
  let lastQ = "";               // 마지막으로 그린 검색어 (디바운스 전 Enter 판별)
  const aiCache = new Map();    // 질문 → 결과 (이 페이지에서 같은 질문은 다시 부르지 않음)
  const list = () => (mode === "ai" ? ai : hits);

  // ---------- DOM (처음 열 때 한 번) ----------
  const input = h("input", {
    type: "search", class: "ps-input", placeholder: "본문 검색 · 한국어 질문은 AI로", "aria-label": "본문 검색",
    enterkeyhint: "search", autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false", maxlength: "200",
  });
  const count = h("span", { class: "ps-count", "aria-live": "polite" });
  const prevBtn = h("button", { type: "button", class: "ps-btn", "aria-label": "이전 결과", text: "↑", onclick: () => step(-1) });
  const nextBtn = h("button", { type: "button", class: "ps-btn", "aria-label": "다음 결과", text: "↓", onclick: () => step(1) });
  const closeBtn = h("button", { type: "button", class: "ps-btn", "aria-label": "검색 닫기", text: "✕", onclick: () => close() });
  const dimBtn = h("button", { type: "button", class: "ps-chip", "aria-pressed": "false", text: "문장만", onclick: toggleDeclutter });
  const aiBtn = h("button", { type: "button", class: "ps-chip ps-ai", text: "✨ AI로 찾기", onclick: () => runAI() });
  const recentEl = h("span", { class: "ps-recent" });
  const info = h("span", { class: "ps-info", hidden: true });
  // AI 결과 목록은 찾기 줄 아래로 펼쳐지는 덮개 (본문 흐름 밖): 열고 닫아도 #top-stack 높이가 그대로라 본문이 밀리지 않음
  const results = h("ol", { class: "ps-results", hidden: true, "aria-label": "AI가 찾은 위치" });
  const form = h("form", { class: "ps-row", action: "#", onsubmit: e => { e.preventDefault(); enter(false); } },
    input, count, prevBtn, nextBtn, closeBtn);
  const bar = h("div", { class: "ps-bar", role: "search" }, form, h("div", { class: "ps-chips" }, dimBtn, aiBtn, recentEl, info), results);

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => runText(input.value), 150);
  });
  input.addEventListener("keydown", e => {
    if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return; // 한글 조합 중 Enter는 글자 확정 (form submit이 처리)
    e.preventDefault();
    enter(e.shiftKey);
  });

  // ---------- 열기·닫기 (찾기 줄은 Back 레이어 하나, 질문 시트가 열려도 유지) ----------
  const barBtn = UI.addBarButton({ id: "in-paper-search", label: "검색", title: "본문 검색", onClick: () => (closeLayer ? close() : open()) });

  function open(prefill) {
    if (!closeLayer) {
      slot = slot || UI.topSlot("in-paper-search");
      if (!slot) return;
      keepScroll(() => slot.replaceChildren(bar));
      closeLayer = UI.layer(teardown, { kind: "find", keepOnSheet: true });
      barBtn.setActive(true);
      const s = prefill == null ? PaperApp.sel() : null; // 짧은 선택이 있으면 그 글자로 (데스크톱 Ctrl+F처럼)
      if (prefill != null) input.value = prefill;
      else if (s && s.anchored && s.wordCount <= 6 && s.text) input.value = s.text;
      runText(input.value, { keep: false });
    }
    input.focus();           // 탭 처리기 안에서 동기로 (iOS 키보드)
    input.select();
  }
  function close() { if (closeLayer) closeLayer("close"); }
  function teardown() {
    commit();
    closeLayer = null;
    clearTimeout(timer);
    abort();
    A.clear("ps-match");
    A.clear("ps-current");
    setHits(false);
    if (document.activeElement === input) input.blur();
    keepScroll(() => slot && slot.replaceChildren());
    barBtn.setActive(false);
  }
  const abort = () => { if (ctrl) { ctrl.abort(); ctrl = null; } };

  // #top-stack은 흐름 안의 sticky라 찾기 줄을 넣고 빼면 아래 본문이 그 높이만큼 밀림. Chrome은 스크롤 앵커링이 잡아 주지만
  // Safari는 없으므로 화면 가운데 요소가 움직인 만큼 되돌림 (맨 위에서는 그대로, 그사이 결과로 이동했으면 그대로)
  let jumps = 0;
  function keepScroll(change) {
    const ref = window.scrollY > 0 ? document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2) : null;
    const y0 = ref && ref !== paperEl && paperEl.contains(ref) ? ref.getBoundingClientRect().top : null;
    const j = jumps;
    change();
    if (y0 == null) return;
    requestAnimationFrame(() => {
      const d = ref.getBoundingClientRect().top - y0;
      if (jumps === j && ref.isConnected && Math.abs(d) > 1) window.scrollBy(0, d);
    });
  }

  // ---------- 글자 검색 ----------
  // 첫 결과: 직전 현재 결과(타이핑 중) 또는 지금 화면 맨 위 이후의 첫 일치
  function viewOffset() {
    const top = (document.getElementById("top-stack")?.getBoundingClientRect().bottom || 0) + 8;
    const pr = paperEl.getBoundingClientRect();
    const el = document.elementFromPoint(pr.left + pr.width / 2, Math.min(Math.max(top, 0), window.innerHeight - 1));
    return el && el !== paperEl && paperEl.contains(el) ? A.pointToOffset(el, 0, false) ?? 0 : 0;
  }

  function runText(q, { keep = true } = {}) {
    abort();
    const prev = keep && mode === "text" ? hits[cur] : null;
    mode = "text";
    ai = [];
    listOpen = true;
    let all = [];
    if (A.normalize(q).length >= MIN_CHARS) {
      const idx = A.index();
      const nm = idx.nm || (idx.nm = A.normMap(idx.text)); // anchor.js와 같은 캐시 칸 (같은 값)
      all = findAll(idx.text, q, { nm, limit: MAX_HITS + 1 });
    }
    capped = all.length > MAX_HITS;
    hits = all.slice(0, MAX_HITS);
    cur = hits.length ? nearestIndex(hits, prev ? prev.start : viewOffset()) : -1;
    paintAll();
    if (cur >= 0) show(cur);
    render();
  }

  function paintAll() {
    const l = list();
    A.paint("ps-match", l, { priority: 45, fallback: false });
    if (cur >= 0 && l[cur]) A.paint("ps-current", [l[cur]], { priority: 50 });
    else A.clear("ps-current");
    setHits(declutter);
  }

  // 현재 결과로 이동 (Back 항목은 찾기 줄 하나뿐 → back: false). AI 결과는 잠깐 강조까지
  function show(i) {
    const l = list();
    if (!l.length) return;
    cur = ((i % l.length) + l.length) % l.length;
    A.paint("ps-current", [l[cur]], { priority: 50 });
    jumps++;
    PaperNav.jumpTo(l[cur], { back: false, flash: mode === "ai" });
  }
  function step(d) {
    const l = list();
    if (!l.length) return;
    commit();
    if (mode === "ai") listOpen = false;
    show(cur < 0 ? (d > 0 ? 0 : l.length - 1) : cur + d);
    render();
  }
  function enter(back) {
    clearTimeout(timer);
    const q = input.value;
    if (A.normalize(q) !== lastQ) runText(q); // 디바운스 전에 Enter
    if (mode === "text" && wantsAI(q, hits.length)) runAI();
    else step(back ? -1 : 1);
  }

  // '문장만': 결과가 없는 문단을 흐리게 (#paper.ps-declutter, 결과가 든 단위와 바깥 단위에 ps-hit)
  function setHits(on) {
    paperEl.querySelectorAll(".ps-hit").forEach(el => el.classList.remove("ps-hit"));
    const l = list();
    on = on && l.length > 0;
    paperEl.classList.toggle("ps-declutter", on);
    if (!on) return;
    const idx = A.index();
    for (const m of l) {
      const r = A.rangeAt(m.start, m.end, idx);
      if (!r) continue;
      for (const n of [r.startContainer, r.endContainer]) {
        let el = n.nodeType === 1 ? n : n.parentElement;
        for (el = el && el.closest(UNIT); el && paperEl.contains(el); el = el.parentElement && el.parentElement.closest(UNIT)) {
          el.classList.add("ps-hit");
        }
      }
    }
  }
  function toggleDeclutter() {
    declutter = !declutter;
    setHits(declutter);
    render();
  }

  // ---------- AI로 찾기 ----------
  async function runAI() {
    const q = input.value.trim();
    if (!q) { input.focus(); return; }
    clearTimeout(timer);
    abort();
    mode = "ai";
    ai = [];
    cur = -1;
    listOpen = true;
    paintAll();
    store.update(RECENT, l => pushRecent(l, q), []);
    input.blur(); // 키보드를 내려 결과 목록이 보이게
    let res = aiCache.get(q);
    if (!res) {
      aiState = navigator.onLine === false ? "offline" : "loading";
      render();
      if (aiState === "offline") return;
      const c = (ctrl = new AbortController());
      try {
        const r = await fetch("/api/in-paper-search/locate", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ arxiv_id: PaperApp.arxivId, query: q }), signal: c.signal,
        });
        res = r.ok ? cleanResults(await r.json()) : null;
      } catch {
        if (c.signal.aborted) return;
        res = null;
      }
      if (ctrl === c) ctrl = null;
      if (mode !== "ai" || input.value.trim() !== q) return; // 그사이 검색어가 바뀜
      if (!res) { aiState = "error"; render(); return; }
      if (res.length) aiCache.set(q, res);
    }
    // 인용을 본문에서 다시 찾음: 못 찾은 것·같은 자리는 버림
    const seen = new Set();
    ai = [];
    for (const r of res) {
      const o = A.locate(r.q);
      if (!o || seen.has(o.start)) continue;
      seen.add(o.start);
      ai.push({ ...r, start: o.start, end: o.end, section: sectionOf(o) });
    }
    aiState = "done";
    paintAll();
    render();
  }

  function sectionOf(o) {
    const r = A.rangeAt(o.start, o.end);
    const el = r && (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement);
    const sec = el && el.closest("section");
    const t = sec && [...sec.children].find(c => c.classList.contains("ltx_title"));
    return t ? A.textOf(t) : el && el.closest(".ltx_abstract") ? "Abstract" : "";
  }

  function pick(i) {
    listOpen = false;
    commit();
    show(i);
    render();
  }
  // 목록 밖(본문)을 누르거나 스크롤을 시작하면 목록을 접음 (한 줄 요약 + '목록')
  document.addEventListener("pointerdown", e => {
    if (closeLayer && mode === "ai" && listOpen && ai.length && !bar.contains(e.target)) { listOpen = false; render(); }
  }, true);

  // ---------- 그리기 ----------
  // AI 상태 한 줄 (칩 줄 오른쪽): 글 + 선택 버튼
  function setInfo(text, action) {
    info.replaceChildren(...[h("span", { class: "ps-info-text", text }),
      action && h("button", { type: "button", class: "ps-link", text: action.label, onclick: action.onClick })].filter(Boolean));
    info.hidden = false;
    results.hidden = !(action && action.list);
  }

  function render() {
    lastQ = A.normalize(input.value);
    const l = list(), q = input.value.trim();
    count.textContent = mode !== "ai" ? countLabel(cur, hits.length, capped)
      : aiState !== "done" ? "…" : cur >= 0 ? `${cur + 1}/${l.length}` : `${l.length}곳`;
    prevBtn.disabled = nextBtn.disabled = !l.length;
    dimBtn.setAttribute("aria-pressed", String(declutter));
    aiBtn.disabled = !q;
    aiBtn.hidden = mode === "ai" && aiState !== "error"; // AI 결과 중에는 상태 줄에 자리 양보
    aiBtn.classList.toggle("ps-hot", mode === "text" && !!q && wantsAI(q, hits.length));
    recentEl.replaceChildren(...(q ? [] : pushRecent(store.get(RECENT, []), "").map(r =>
      h("button", { type: "button", class: "ps-chip ps-old", text: r, onclick: () => useRecent(r) }))));
    if (mode !== "ai") { info.hidden = results.hidden = true; return; }
    if (aiState === "loading") return setInfo("✨ AI가 위치를 찾는 중…");
    if (aiState === "offline") return setInfo("오프라인: AI로 찾기는 네트워크가 필요합니다");
    if (aiState === "error") return setInfo("AI 검색에 실패했습니다", { label: "다시", onClick: () => runAI() });
    if (!ai.length) return setInfo("관련 위치를 찾지 못했습니다");
    const toggle = { label: listOpen ? "접기" : "목록", list: listOpen, onClick: () => { listOpen = !listOpen; render(); } };
    setInfo(!listOpen && cur >= 0 ? `💡 ${ai[cur].why || ai[cur].q}` : `AI가 찾은 위치 ${ai.length}곳`, toggle);
    if (!listOpen) return;
    results.replaceChildren(...ai.map((r, i) => h("li", {}, h("button", {
      type: "button", class: `ps-result${i === cur ? " current" : ""}`, onclick: () => pick(i),
    }, h("b", { text: r.why || "관련 위치" }), r.section ? h("span", { class: "ps-sec", text: r.section }) : null,
    h("span", { class: "ps-quote", text: r.q })))),
    h("li", { class: "ps-fb" }, h("span", { text: "도움이 됐나요?" }), UI.feedback("in-paper-search", q, { question: q, answerLen: ai.length })));
  }

  function useRecent(q) {
    input.value = q;
    if (hasHangul(q)) runAI();
    else { runText(q, { keep: false }); input.focus(); }
  }

  // 최근 검색어: 실제로 써 본 검색만 (↑↓·Enter·결과 탭·결과가 있는 채로 닫기, AI 검색)
  function commit() {
    const q = input.value.trim();
    if (q && list().length) store.update(RECENT, l => pushRecent(l, q), []);
  }

  // Ctrl/⌘+F → 찾기 줄 (이미 입력 중이면 브라우저 기본 찾기), F3·Ctrl+G → 다음/이전
  document.addEventListener("keydown", e => {
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey, key = String(e.key || "").toLowerCase();
    if (mod && key === "f") {
      if (closeLayer && document.activeElement === input) return;
      e.preventDefault();
      open();
    } else if (closeLayer && (e.key === "F3" || (mod && key === "g"))) {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  });
})();
