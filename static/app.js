// PaperApp: 선택 → 질문 시트의 중심. 기능들은 여기 훅(프리셋·선택 버튼·탭·질문 훅·답변 슬롯·TTS)으로 붙음.
// 계약은 docs/FEATURES.md. 이 파일은 홈 화면에서도 로드되며 시트가 없으면 조용히 아무것도 안 함.
(function () {
  "use strict";

  // ---------- 순수 부분 (node 테스트) ----------
  const BASE_PRESETS = [
    { id: "easy", label: "쉽게 설명", q: "이 부분을 쉽게 설명해줘", order: 10, match: s => (s ? 40 : false) },
    { id: "equation", label: "수식 풀이", q: "이 수식의 각 기호와 의미를 풀어줘", order: 20, match: s => (s ? (s.isMath ? 90 : 30) : false) },
    { id: "translate", label: "번역", q: "한국어로 번역해줘", order: 30, match: s => (s ? 20 : false) },
    { id: "why", label: "왜 중요?", q: "논문 전체 맥락에서 이 부분이 왜 중요한지 알려줘", order: 40, match: s => (s ? 10 : false) },
  ];
  // 답변 아래 도구 줄의 자리 순서 (docs/FEATURES.md 표와 같게)
  const SLOTS = { "evidence-chips": 10, "answer-actions": 20, "highlights-notes": 30, "vocab": 40, "ask-paper": 50 };
  const ERROR_TAIL = /\n\n\[오류\][^\n]*$/;

  // 프리셋 순위: match(selInfo) 점수 내림차순, 같으면 order. false/null이면 숨김. match 없으면 0점
  function rankPresets(presets, selInfo) {
    return presets
      .map(p => ({ p, score: typeof p.match === "function" ? p.match(selInfo) : 0 }))
      .filter(x => typeof x.score === "number" && !Number.isNaN(x.score))
      .sort((a, b) => b.score - a.score || (a.p.order ?? 500) - (b.p.order ?? 500))
      .map(x => x.p);
  }

  // 선택 정보 없이 텍스트만 있을 때 (다른 기능이 openSheet에 selection 문자열만 줄 때)
  function selInfoFromText(text) {
    const t = String(text || "").trim();
    const latex = [...t.matchAll(/\$\$?([^$]+)\$\$?/g)].map(m => m[1].trim());
    const prose = t.replace(/\$[^$]*\$/g, " ").trim();
    const words = s => s.split(/\s+/).filter(Boolean).length;
    return { text: t, wordCount: words(t), isMath: latex.length > 0 && words(prose) <= 2, latex, context: "", sectionTitle: "" };
  }

  // 질문 payload: 훅은 question만 바꿀 수 있음. 선택·문맥·기록·extra는 세션 시작 때 값으로 고정 (캐시 앞부분 보존)
  function buildPayload(s, question, hooks = [], meta = {}) {
    const frozen = {
      arxiv_id: s.arxivId, selection: s.selection, context: s.context, section: s.section,
      history: s.history.map(t => ({ role: t.role, content: t.content })),
    };
    let p = { ...s.extra, ...frozen, question };
    for (const hook of hooks) {
      try {
        const r = hook(p, { ...meta, endpoint: s.endpoint, turn: s.history.length / 2, session: s });
        if (r && typeof r === "object") p = r;
      } catch (e) { if (typeof console !== "undefined") console.error("[ask hook]", e); }
    }
    return { ...s.extra, ...frozen, question: String(p.question ?? question) };
  }

  function splitSentences(text) {
    return String(text || "").split(/(?<=[.!?。！？])\s+|\n+/).map(x => x.trim()).filter(Boolean);
  }

  // 시트 세션 만들기. 세션 훅은 새 세션(history 없음)에서만 실행: 저장된 대화를 그때의 고정 필드
  // (selection·context·section·extra·endpoint)로 이어가면 훅이 덧붙인 것이 이미 들어 있으므로 다시 붙이지 않음
  // → 첫 user 턴이 바이트까지 같아 캐시 적중
  function makeSession(opts = {}, arxivId = null, hooks = [], onErr = () => {}) {
    const selection = opts.selection || "";
    const history = (opts.history || []).map(t => ({ role: t.role, content: String(t.content) }));
    const s = {
      id: Math.random().toString(36).slice(2), arxivId,
      quote: opts.quote ?? selection, selection,
      context: opts.context || "", section: opts.section || "",
      endpoint: opts.endpoint || "/api/ask", extra: { ...(opts.extra || {}) },
      presets: opts.presets || null, title: opts.title || "질문",
      selInfo: opts.selInfo || (selection ? selInfoFromText(selection) : null),
      history, shown: (opts.shown || []).slice(),
      meta: (opts.meta || []).map(m => ({ label: (m && m.label) || null, presetId: (m && m.presetId) || null, via: (m && m.via) || null })),
      origin: opts.origin || null, continued: history.length > 0,
    };
    if (!s.continued) for (const hook of hooks) { try { hook(s); } catch (e) { onErr(e); } }
    return s;
  }

  const api = { BASE_PRESETS, SLOTS, ERROR_TAIL, rankPresets, selInfoFromText, buildPayload, splitSentences, makeSession };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;

  // ---------- DOM ----------
  const $ = id => document.getElementById(id);
  const UI = window.PaperUI, A = window.PaperAnchor, store = window.PaperStore;
  const h = UI.h;
  const body = document.body;
  const page = body.dataset.page || "home";
  const arxivId = body.dataset.arxivId || (typeof ARXIV_ID !== "undefined" ? ARXIV_ID : null);
  const baseId = arxivId ? arxivId.replace(/v\d+$/, "") : null;
  const paperEl = $("paper");
  const sheet = $("sheet"), quoteEl = $("quote"), answerEl = $("answer"), presetsEl = $("presets");
  const form = $("ask-form"), qInput = $("q"), pill = $("sheet-pill"), selBar = $("sel-bar");
  const toolsEl = $("sheet-tools"), live = $("sr-live"), titleEl = $("sheet-title");
  const emit = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail }));
  const err = (...a) => console.error("[PaperApp]", ...a);

  // ---------- 프리웜·유휴 작업 큐 ----------
  // 프리웜이 실패해도(오프라인·404) idle 작업은 돌아감
  const warm = Promise.resolve(window.PREWARM).catch(() => null);
  const ric = window.requestIdleCallback ? fn => requestIdleCallback(fn, { timeout: 2000 }) : fn => setTimeout(fn, 200);
  const idleQ = [];
  let idleBusy = false, isStreaming = false;
  function pump() {
    if (idleBusy || isStreaming || !idleQ.length) return;
    idleBusy = true;
    warm.then(() => ric(async () => {
      const job = idleQ.shift();
      try { job.resolve(await job.fn()); } catch (e) { job.reject(e); }
      idleBusy = false;
      pump();
    }));
  }
  // 백그라운드 준비 작업: 한 번에 하나씩, 답변 스트리밍 중에는 대기 (연결 수 6개 제한에서 질문이 밀리지 않게)
  const idle = fn => new Promise((resolve, reject) => { idleQ.push({ fn, resolve, reject }); pump(); });
  function setStreaming(on) {
    isStreaming = on;
    pill && pill.classList.toggle("streaming", on);
    if (!on) pump();
  }

  // ---------- 기능 목록 ----------
  const features = new Map();
  const registerFeature = (id, featureApi = true) => void features.set(id, featureApi);

  // ---------- 선택 ----------
  let lastSel = null, hadSel = false, collapsedAt = 0, downHadSel = false, selTimer, selHideTimer;
  const liveSel = () => {
    const s = document.getSelection();
    return s && s.rangeCount && !s.isCollapsed && s.toString().trim() ? s : null;
  };
  const inPaper = s => paperEl && paperEl.contains(s.anchorNode) && paperEl.contains(s.focusNode);
  const justSelected = () => Date.now() - collapsedAt < 400;

  function sectionTitleOf(sec, startEl) {
    const t = sec && [...sec.children].find(c => c.classList.contains("ltx_title"));
    if (t) return A.textOf(t);
    return startEl && startEl.closest(".ltx_abstract") ? "Abstract" : "";
  }
  function mathsIn(range) {
    let r = range.commonAncestorContainer;
    if (r.nodeType !== 1) r = r.parentElement;
    const m = r && r.closest("math");
    if (m) return [m];
    return r ? [...r.querySelectorAll("math")].filter(x => range.intersectsNode(x)) : [];
  }
  function selInfoFromRange(range) {
    const q = A.rangeToQuote(range);
    const raw = range.toString();
    const base = selInfoFromText((q && q.quote) || raw.replace(/\s+/g, " "));
    const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    let para = startEl && startEl.closest(".ltx_para, .ltx_abstract, figcaption, .ltx_listing, td, li, p");
    const outer = para && para.parentElement && para.parentElement.closest(".ltx_para");
    if (para && outer && A.textOf(para).length < 200) para = outer; // 짧은 목록 항목이면 바깥 문단까지
    const sectionEl = startEl && startEl.closest("section");
    const latex = mathsIn(range).map(m => m.getAttribute("alttext") || "").filter(Boolean);
    const prose = base.text.replace(/\$[^$]*\$/g, " ").trim();
    const anchored = !!(q && q.quote); // 번역(.tr-ko)만 고른 선택은 색인 밖이라 저장할 위치가 없음
    return {
      ...base, raw, range,
      start: anchored ? q.start : null, end: anchored ? q.end : null, prefix: anchored ? q.prefix : "", suffix: anchored ? q.suffix : "",
      inTranslation: !!(startEl && startEl.closest(".tr-ko")),
      latex, isMath: latex.length > 0 && prose.split(/\s+/).filter(Boolean).length <= 2,
      paragraphEl: para || null, paraId: para ? para.id || para.closest("[id]")?.id || null : null,
      sectionEl: sectionEl || null, sectionId: sectionEl ? sectionEl.id : null,
      sectionTitle: sectionTitleOf(sectionEl, startEl),
      context: para ? A.clipAround(A.textOf(para), base.text, 1500) : "",
    };
  }
  function sel() {
    const s = liveSel();
    if (s && inPaper(s)) return selInfoFromRange(s.getRangeAt(0).cloneRange());
    return lastSel;
  }

  function onSelection() {
    const s = liveSel();
    if (s && inPaper(s)) {
      lastSel = selInfoFromRange(s.getRangeAt(0).cloneRange());
      showSelBar();
      emit("paper:selection", lastSel);
    } else if (!s) {
      clearTimeout(selHideTimer);
      // 버튼을 누르는 순간 선택이 풀려도(iOS) 스냅샷으로 동작하도록 잠깐 기다림
      selHideTimer = setTimeout(() => {
        if (liveSel()) return;
        hideSelBar();
        if (lastSel) { lastSel = null; emit("paper:selection", null); }
      }, 300);
    }
  }
  if (paperEl) {
    document.addEventListener("selectionchange", () => {
      const has = !!liveSel();
      if (hadSel && !has) collapsedAt = Date.now();
      hadSel = has;
      clearTimeout(selTimer);
      selTimer = setTimeout(onSelection, 150);
    });
    document.addEventListener("pointerdown", () => { downHadSel = !!liveSel() || justSelected(); }, true);
  }
  function selectRange(range) {
    const s = document.getSelection();
    s.removeAllRanges();
    s.addRange(range);
    lastSel = selInfoFromRange(range.cloneRange());
    showSelBar();
    emit("paper:selection", lastSel);
  }

  // 선택 버튼 줄 (#sel-bar): 화면 아래에 고정 → iOS/안드로이드 기본 선택 메뉴와 겹치지 않음
  const selActions = [];
  const selBarEnabled = () => (store ? store.get("app:selbar", true) !== false : true);
  function addSelectionAction(a) {
    UI.upsert(selActions, { order: 500, ...a });
    if (lastSel && selBar && !selBar.hidden) showSelBar();
  }
  function showSelBar() {
    if (!selBar || !lastSel || !selBarEnabled()) return;
    clearTimeout(selHideTimer);
    const s = lastSel;
    selBar.replaceChildren(...selActions.filter(a => { try { return !a.when || a.when(s); } catch { return false; } }).map(a => {
      const b = h("button", { type: "button", class: a.primary ? "primary" : "", text: a.label, dataset: { id: a.id } });
      b.addEventListener("pointerdown", e => e.preventDefault()); // 버튼을 눌러도 선택·포커스 유지
      b.addEventListener("mousedown", e => e.preventDefault());
      b.addEventListener("click", () => {
        const snap = lastSel || s;
        hideSelBar();
        try { a.onClick(snap); } catch (e) { err(e); }
      });
      return b;
    }));
    selBar.hidden = false;
    body.classList.add("pr-sel-active");
  }
  function hideSelBar() {
    if (selBar) selBar.hidden = true;
    body.classList.remove("pr-sel-active");
  }
  // 선택 버튼 줄 켜기/끄기 (reading-settings도 이것을 부름 — pr:app:selbar를 직접 쓰지 말 것: 헤더 버튼 이름이 안 바뀜)
  let selBarBtn = null;
  function setSelBar(on) {
    on = !!on;
    if (store) store.set("app:selbar", on);
    if (selBarBtn) selBarBtn.setLabel(on ? "선택 버튼 끄기" : "선택 버튼 켜기");
    if (!on) hideSelBar(); else if (lastSel) showSelBar();
  }

  // ---------- 본문 탭 처리기 (우선순위 높은 것부터 하나만) ----------
  // 규칙: e.defaultPrevented면 무시, 기능 UI(.pr-ui) 안의 조작 요소(버튼·입력·링크…)는 무시 (자기 리스너만 실행 →
  // 그 버튼이 연 시트를 '내려두기'가 바로 닫지 않음). 선택이 있거나 방금 해제한 탭은 allowWithSelection 처리기만.
  // 번역문 안에 복제된 본문 링크(a.ltx_ref)는 본문 링크처럼 처리기로 감 (ref-peek, cite-cards). 처리하면 preventDefault
  const CONTROL = "button, input, select, textarea, label, summary, [role=button], a:not(.ltx_ref)";
  const isFeatureControl = el => { const c = el.closest(CONTROL); return !!(c && c.closest(".pr-ui")); };
  const taps = [];
  function addTapHandler(t) {
    const i = taps.findIndex(x => x.id === t.id);
    if (i >= 0) taps[i] = t; else taps.push(t);
    taps.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }
  document.addEventListener("click", e => {
    const target = e.target;
    if (e.defaultPrevented || e.button || !paperEl || !(target instanceof Element) || !paperEl.contains(target)) return;
    if (isFeatureControl(target)) return;
    const withSel = downHadSel || !!liveSel() || justSelected();
    for (const t of taps) {
      if (withSel && !t.allowWithSelection) continue;
      let hit;
      try { hit = t.test(e); } catch (x) { err(t.id, x); continue; }
      if (hit) {
        e.preventDefault();
        try { t.handle(e, hit); } catch (x) { err(t.id, x); }
        return;
      }
    }
  });

  // ---------- 프리셋·훅·슬롯 레지스트리 ----------
  const presets = BASE_PRESETS.map(p => ({ ...p }));
  const askHooks = [], sessionHooks = [], answerActions = [], sheetTools = [];
  function addPreset(p) { UI.upsert(presets, { order: 500, ...p }); if (session && sheet && !sheet.hidden) renderPresets(); }
  function removePreset(id) { const i = presets.findIndex(p => p.id === id); if (i >= 0) presets.splice(i, 1); if (session) renderPresets(); }

  // ---------- 질문 시트 ----------
  let session = null, current = null, sheetClose = null, restoreFocus = null;
  const threadKey = () => `app:thread:${baseId}`;

  function persist() {
    if (!session || !store || !baseId) return;
    const { selInfo, ...rest } = session;
    const si = selInfo ? { text: selInfo.text, wordCount: selInfo.wordCount, isMath: selInfo.isMath, latex: selInfo.latex, sectionTitle: selInfo.sectionTitle, paraId: selInfo.paraId || null } : null;
    store.session.set(threadKey(), { ...rest, selInfo: si });
  }

  function renderPresets() {
    if (!presetsEl || !session) return;
    const s = session;
    const list = s.presets
      ? s.presets.map((p, i) => (typeof p === "string" ? { id: `s${i}`, label: p, q: p } : { id: p.id || `s${i}`, ...p }))
      : rankPresets(presets, s.selInfo);
    presetsEl.replaceChildren(...list.map(p => h("button", {
      type: "button", text: p.label, dataset: { id: p.id },
      onclick: () => {
        // run(session)이 있으면 질문 대신 실행 (예: 섹션 퀴즈 peek 열기)
        if (typeof p.run === "function") { try { p.run(s); } catch (e) { err(e); } return; }
        let q = p.q || p.label;
        try { if (typeof q === "function") q = q(s.selInfo, s); } catch (e) { err(e); return; }
        ask(q, { label: p.label, presetId: p.id });
      },
    })));
    presetsEl.hidden = !list.length;
  }
  function renderSheetTools() {
    if (!toolsEl || !session) return;
    const nodes = [];
    for (const t of sheetTools) {
      try { const n = t.render(session); if (n) nodes.push(n); } catch (e) { err(t.id, e); }
    }
    toolsEl.replaceChildren(...nodes);
    toolsEl.hidden = !nodes.length;
  }

  function slot(tools, id) {
    let el = tools.querySelector(`:scope > [data-slot="${CSS.escape(id)}"]`);
    if (el) return el;
    const order = SLOTS[id] ?? answerActions.find(a => a.id === id)?.order ?? 500;
    el = h("div", { class: "turn-slot", dataset: { slot: id, order } });
    tools.insertBefore(el, [...tools.children].find(c => Number(c.dataset.order) > order) || null);
    return el;
  }

  function addTurn(shown) {
    const turn = h("div", { class: "turn" });
    const a = h("div", { class: "a" });
    const tools = h("div", { class: "turn-tools pr-ui" });
    turn.append(h("div", { class: "q", text: shown }), a, tools);
    answerEl.append(turn);
    turn.scrollIntoView({ block: "nearest" });
    return { turn, a, tools };
  }

  // 답변 표시: 스트리밍 중엔 rAF로 묶어서, 끝나면 즉시(동기) 그림 (render.js 실패 시 일반 텍스트)
  const setAnswer = (el, text) => (window.renderAnswer ? renderAnswer(el, text) : (el.textContent = text));
  const renderNow = (el, text) => (window.renderAnswerNow ? renderAnswerNow(el, text) : (el.textContent = text));

  let liveTimer;
  function announce(msg) {
    if (!live) return;
    clearTimeout(liveTimer);
    live.textContent = "";
    liveTimer = setTimeout(() => { live.textContent = msg; }, 100);
  }

  function makeDetail(s, t, i, opts, extra) {
    return {
      turnEl: t.turn, answerEl: t.a, toolsEl: t.tools, turn: i,
      question: s.history[i * 2]?.content ?? "", shown: s.shown[i] ?? "", text: s.history[i * 2 + 1]?.content ?? "",
      label: opts.label || null, presetId: opts.presetId || null, via: opts.via || null,
      endpoint: s.endpoint, session: s, slot: id => slot(t.tools, id), ...extra,
    };
  }
  function finishTurn(detail) {
    for (const a of answerActions) {
      const el = detail.slot(a.id);
      try {
        const n = a.render(detail);
        if (n && typeof n.then === "function") n.then(x => x && el.append(x)).catch(e => err(a.id, e));
        else if (n) el.append(n);
      } catch (e) { err(a.id, e); }
    }
    emit("paper:answer-done", detail);
  }

  function abortCurrent() {
    if (current) { current.ctrl.abort(); current = null; setStreaming(false); }
  }

  async function runTurn(s, payload, t, opts) {
    const ctrl = new AbortController();
    current = { ctrl, s, t };
    setStreaming(true);
    t.turn.querySelector(".pr-retry")?.remove();
    // '이어서 받기'는 마지막 턴에서만: 새 턴이 시작되면 이전 실패 턴의 버튼은 없앰 (기록 순서·동시 스트림 방지)
    answerEl.querySelectorAll(".pr-retry button").forEach(b => b.remove());
    setAnswer(t.a, "…");
    announce("답변을 생성하는 중입니다");
    emit("paper:ask", { payload, session: s, endpoint: s.endpoint });
    let text = "", failed = null;
    try {
      const res = await fetch(s.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        let msg = "";
        try { msg = (await res.json()).detail; } catch { /* 무시 */ }
        throw Object.assign(new Error(typeof msg === "string" && msg ? msg : `HTTP ${res.status}`), { http: res.status });
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      setAnswer(t.a, "");
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
        setAnswer(t.a, text);
      }
      text += dec.decode();
      const m = text.match(ERROR_TAIL);
      if (m) failed = m[0].trim();
      else if (!text.trim()) failed = "[오류] 빈 답변";
    } catch (e) {
      if (ctrl.signal.aborted) { t.turn.remove(); return; } // 새 질문·닫기로 중단 → 기록에도 화면에도 없음
      failed = e.http ? `[오류] ${e.message}` : "[연결 끊김] 네트워크가 끊겼거나 앱이 백그라운드로 갔습니다.";
    }
    if (current && current.ctrl === ctrl) { current = null; setStreaming(false); }
    if (failed) {
      renderNow(t.a, text.replace(ERROR_TAIL, ""));
      // 같은 payload를 다시 보냄 → 앞부분은 캐시라 빠름. 진행 중인 스트림이 있으면 먼저 중단 (ask와 같은 규칙)
      t.a.after(h("div", { class: "pr-retry pr-ui" }, h("span", { text: failed }),
        h("button", { type: "button", text: "이어서 받기", onclick: () => { abortCurrent(); runTurn(s, payload, t, opts); } })));
      announce("답변이 끊겼습니다");
      emit("paper:answer-error", { session: s, payload, error: failed, turnEl: t.turn });
      return;
    }
    renderNow(t.a, text);
    s.history.push({ role: "user", content: payload.question }, { role: "assistant", content: text });
    s.shown.push(opts.shown);
    s.meta.push({ label: opts.label || null, presetId: opts.presetId || null, via: opts.via || null });
    if (session === s) persist();
    finishTurn(makeDetail(s, t, s.history.length / 2 - 1, opts, { payload, restored: false }));
    announce("답변 완료. " + t.a.textContent.slice(0, 140));
  }

  async function ask(question, opts = {}) {
    const s = session;
    question = String(question || "").trim();
    if (!s || !question) return;
    if (sheet.hidden) restoreSheet();
    abortCurrent();
    const meta = { presetId: opts.presetId || null, label: opts.label || null, via: opts.via || null };
    const payload = buildPayload(s, question, askHooks, meta);
    const shown = opts.shown || question;
    await runTurn(s, payload, addTurn(shown), { ...meta, shown });
  }

  function discardSession(clearSelection) {
    abortCurrent();
    session = null;
    if (answerEl) answerEl.replaceChildren();
    if (pill) pill.hidden = true;
    if (store && baseId) store.session.del(threadKey());
    if (clearSelection) document.getSelection()?.removeAllRanges();
  }

  function onSheetHidden(reason) {
    sheetClose = null;
    sheet.hidden = true;
    sheet.classList.remove("full");
    body.classList.remove("pr-sheet-open");
    restoreFocus && restoreFocus();
    const s = session;
    if (reason === "close" || reason === "escape" || !s || (!s.history.length && !current)) {
      discardSession(true);
      emit("paper:sheet-close", { session: s, reason: "close" });
    } else {
      pill.hidden = false; // 내려두기: '답변 보기'로 다시 열기
      emit("paper:sheet-close", { session: s, reason: "minimize" });
    }
  }
  function showSheet() {
    pill.hidden = true;
    // 시트(z 20)보다 위에 뜨는 오버레이(peek z 25, 그림 뷰어 z 30, 목차 서랍 …)는 먼저 닫음 (reason "sheet") —
    // 시트가 그 밑에 깔리지 않게. 점프('↩ 돌아가기')와 keepOnSheet 레이어(화면 위쪽 찾기 줄 등)는 그대로
    UI.closeLayers(l => l.kind !== "jump" && l.kind !== "sheet" && !l.keepOnSheet, "sheet");
    if (!sheet.hidden) return;
    const prev = document.activeElement;
    restoreFocus = () => { if (prev && prev.isConnected) try { prev.focus({ preventScroll: true }); } catch { /* 무시 */ } };
    sheet.hidden = false;
    body.classList.add("pr-sheet-open");
    hideSelBar();
    sheetClose = UI.layer(onSheetHidden, { kind: "sheet" });
    fitViewport();
    sheet.focus({ preventScroll: true });
  }

  function renderSession(s) {
    quoteEl.textContent = s.quote || "";
    quoteEl.hidden = !s.quote;
    if (titleEl) titleEl.textContent = s.title || "질문";
    renderPresets();
    renderSheetTools();
    answerEl.replaceChildren();
  }

  // 이미 끝난 턴들을 다시 그림 (이어서 질문·새로고침 복원). 기능에는 restored: true로 알림
  function renderPastTurns(s) {
    for (let i = 0; i * 2 + 1 < s.history.length; i++) {
      const t = addTurn(s.shown[i] || s.history[i * 2].content);
      renderNow(t.a, s.history[i * 2 + 1].content);
      finishTurn(makeDetail(s, t, i, s.meta[i] || {}, { payload: null, restored: true }));
    }
  }

  function openSheet(opts = {}) {
    if (!sheet) { console.warn("[PaperApp] openSheet: 이 페이지에는 질문 시트가 없습니다"); return null; }
    const s = makeSession(opts, arxivId, sessionHooks, err);
    discardSession(false);
    session = s;
    renderSession(s);
    showSheet();
    renderPastTurns(s);
    persist();
    emit("paper:sheet-open", { session: s, restored: false });
    if (opts.autoAsk) {
      const a = typeof opts.autoAsk === "string" ? { q: opts.autoAsk } : opts.autoAsk;
      ask(a.q, { label: a.label, presetId: a.id });
    }
    return s;
  }
  function closeSheet() {
    if (sheetClose) sheetClose("close");
    else if (session) { const s = session; discardSession(true); emit("paper:sheet-close", { session: s, reason: "close" }); }
  }
  function minimizeSheet() { if (sheetClose) sheetClose("minimize"); }
  function restoreSheet() {
    if (!session || !sheet) return;
    showSheet();
    emit("paper:sheet-open", { session, restored: true });
  }

  // 새로고침·탭 폐기 후에도 열려 있던 대화를 '답변 보기'로 복원
  function restoreThread() {
    const saved = store && baseId ? store.session.get(threadKey()) : null;
    if (!saved || !Array.isArray(saved.history) || saved.history.length < 2) return;
    session = { shown: [], meta: [], extra: {}, ...saved, arxivId };
    renderSession(session);
    renderPastTurns(session);
    pill.hidden = false;
  }

  // ---------- 시트 조작: 손잡이 끌기(반/전체), 바깥 탭·스와이프는 내려두기, 키보드 위로 올리기 ----------
  // --kb(키보드 높이), --vvh(보이는 높이)는 :root에 → 시트와 peek(입력칸이 있는 메모·찾기 등) 모두 키보드 위로 (iOS)
  function fitViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    const root = document.documentElement.style;
    root.setProperty("--kb", `${Math.round(kb)}px`);
    root.setProperty("--vvh", `${Math.round(vv.height)}px`);
  }
  window.visualViewport?.addEventListener("resize", fitViewport);
  window.visualViewport?.addEventListener("scroll", fitViewport);

  if (sheet) {
    const handle = sheet.querySelector(".sheet-grab");
    if (handle) {
      UI.dragDown(handle, sheet, () => {
        if (sheet.classList.contains("full")) sheet.classList.remove("full");
        else minimizeSheet();
      }, { allowUp: true, onUp: () => sheet.classList.add("full"), onTap: () => sheet.classList.toggle("full") });
    }
    $("close")?.addEventListener("click", closeSheet);
    $("sheet-min")?.addEventListener("click", minimizeSheet);
    $("pill-open")?.addEventListener("click", restoreSheet);
    $("pill-x")?.addEventListener("click", closeSheet);
    form?.addEventListener("submit", e => {
      e.preventDefault();
      const v = qInput.value.trim();
      const via = form.dataset.via || null; // voice.js가 표시 (음성 질문)
      delete form.dataset.via;
      qInput.value = "";
      if (v) ask(v, { via });
    });
    // 본문 빈 곳을 탭하면 시트를 내려둠 (가장 낮은 우선순위, 링크·기능 UI(.pr-ui) 위는 제외)
    addTapHandler({
      id: "app:minimize", priority: -1000,
      test: e => !sheet.hidden && !e.target.closest("a[href], .pr-ui"),
      handle: () => minimizeSheet(),
    });
    addSelectionAction({
      id: "ask", label: "질문하기", order: 0, primary: true,
      onClick: s => openSheet({ quote: s.text, selection: s.text, context: s.context, section: s.sectionTitle, selInfo: s }),
    });
    if (page === "paper") {
      selBarBtn = UI.addBarButton({
        id: "app:selbar", label: selBarEnabled() ? "선택 버튼 끄기" : "선택 버튼 켜기",
        onClick: () => {
          const on = !selBarEnabled();
          setSelBar(on);
          UI.toast(on ? "텍스트를 선택하면 버튼이 나타납니다" : "선택 버튼을 껐습니다");
        },
      });
    }
    document.addEventListener("DOMContentLoaded", restoreThread);
  }

  // ---------- 읽어주기 (speechSynthesis는 앱 전체에서 여기 하나만 사용) ----------
  const tts = (() => {
    const synth = window.speechSynthesis;
    let cur = null;
    try { synth && synth.getVoices(); } catch { /* 목록 미리 불러오기 */ }
    const voiceFor = lang => {
      const vs = synth ? synth.getVoices() : [];
      const l = lang.toLowerCase();
      return vs.find(v => v.lang && v.lang.toLowerCase().replace("_", "-") === l) || vs.find(v => v.lang && v.lang.toLowerCase().startsWith(l.slice(0, 2))) || null;
    };
    const ttsEmit = (state, c) => emit("paper:tts", { state, owner: c ? c.owner : null, index: c ? c.i : 0 });
    function end(c, info) {
      if (cur === c) cur = null;
      try { c.opts.onEnd && c.opts.onEnd(info); } catch (e) { err(e); }
      ttsEmit("end", c);
    }
    function next(c) {
      if (cur !== c || c.paused) return;
      if (c.i >= c.chunks.length) { end(c, { done: true }); return; }
      const u = new SpeechSynthesisUtterance(c.chunks[c.i]);
      u.lang = c.opts.lang || "ko-KR";
      u.rate = c.opts.rate || 1;
      const v = c.opts.voice || voiceFor(u.lang);
      if (v) u.voice = v;
      const i = c.i;
      u.onstart = () => cur === c && c.opts.onBoundary && c.opts.onBoundary({ index: i, charIndex: 0, text: c.chunks[i] });
      u.onboundary = ev => cur === c && c.opts.onBoundary && c.opts.onBoundary({ index: i, charIndex: ev.charIndex, text: c.chunks[i] });
      u.onend = () => { if (cur === c && !c.paused && c.i === i) { c.i++; next(c); } };
      u.onerror = ev => { if (cur === c && !c.paused && !["interrupted", "canceled"].includes(ev.error)) end(c, { error: ev.error }); };
      synth.speak(u);
    }
    // iOS: 사용자 탭 안에서 한 번 말해야 그 뒤 자동 읽기(음성 질문의 답 등)가 소리 남. voice.js가 마이크 탭에서 부름
    let primed = false;
    function prime() {
      if (!synth || primed) return;
      primed = true;
      try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; synth.speak(u); } catch { /* 무시 */ }
    }
    // 첫 speak()는 탭 핸들러 안에서 동기로 불러야 iOS에서 소리가 남
    function speak(text, opts = {}) {
      if (!synth) { opts.onEnd && opts.onEnd({ error: "unsupported" }); return false; }
      stop("replaced");
      const chunks = Array.isArray(text) ? text.filter(Boolean) : splitSentences(text);
      cur = { owner: opts.owner || "app", chunks, i: opts.start || 0, opts, paused: false };
      ttsEmit("start", cur);
      next(cur);
      return true;
    }
    function stop(reason = "stop") {
      const c = cur;
      cur = null;
      try { synth && synth.cancel(); } catch { /* 무시 */ }
      if (c) {
        try { c.opts.onEnd && c.opts.onEnd({ interrupted: true, reason }); } catch (e) { err(e); }
        ttsEmit("end", c);
      }
    }
    function pause() { if (!cur || cur.paused) return; cur.paused = true; try { synth.cancel(); } catch { /* 무시 */ } ttsEmit("pause", cur); }
    // 일시정지 후 재개는 지금 문장 처음부터 (브라우저 pause/resume은 모바일에서 불안정)
    function resume() { if (!cur || !cur.paused) return; cur.paused = false; ttsEmit("resume", cur); next(cur); }
    function seek(i) { if (!cur) return; cur.i = Math.max(0, Math.min(i, cur.chunks.length - 1)); const p = cur.paused; cur.paused = true; try { synth.cancel(); } catch { /* 무시 */ } cur.paused = p; if (!p) next(cur); }
    window.addEventListener("pagehide", () => stop("pagehide"));
    return {
      speak, stop, pause, resume, seek, prime, splitSentences, voiceFor,
      get supported() { return !!synth; },
      get speaking() { return !!cur && !cur.paused; },
      get paused() { return !!cur && cur.paused; },
      get owner() { return cur ? cur.owner : null; },
    };
  })();

  // 오프라인 저장 대상 목록: 기능이 이미 받아 둔(생성이 끝난) 캐시 가능 GET 주소를 알림.
  // offline-save는 이것만 다시 받아 API 캐시에 넣음 (사용자가 안 연 기능의 생성·과금을 일으키지 않게)
  const offlineUrls = new Set();

  window.PaperApp = Object.assign(api, {
    page, arxivId, baseId, warm, idle,
    registerFeature, has: id => features.has(id), feature: id => features.get(id),
    addOfflineUrl: url => void offlineUrls.add(String(url)), offlineUrls: () => [...offlineUrls],
    sel, selectRange, justSelected, addSelectionAction, addTapHandler, setSelBar,
    addPreset, removePreset, presets: () => presets.slice(),
    addAskHook: fn => void askHooks.push(fn),
    addSessionHook: fn => void sessionHooks.push(fn),
    addAnswerAction: a => void UI.upsert(answerActions, { order: SLOTS[a.id] ?? 500, ...a }),
    addSheetTool: t => void UI.upsert(sheetTools, { order: 500, ...t }),
    openSheet, ask, closeSheet, minimizeSheet, restoreSheet,
    isSheetOpen: () => !!sheet && !sheet.hidden,
    tts,
    on: (name, fn) => document.addEventListener(`paper:${name}`, e => fn(e.detail, e)),
  });
  // Object.assign은 getter 값을 복사해 버리므로 따로 정의
  Object.defineProperties(window.PaperApp, {
    session: { get: () => session, enumerable: true },
    streaming: { get: () => isStreaming, enumerable: true },
  });
})();
