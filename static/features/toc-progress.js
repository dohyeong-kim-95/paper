// toc-progress: 목차 서랍 + 지금 섹션 표시 + 진행 막대(남은 시간) + 이어 읽기 + 논문 구조도
(function () {
  "use strict";

  // ---------- 순수 함수 (node 테스트 대상) ----------
  const WPM_DEFAULT = 160, WPM_MIN = 80, WPM_MAX = 400;
  const IDLE_MS = 90000;    // 이보다 오래 멈췄으면 그 사이는 읽은 시간에서 뺌
  const WINDOW_MS = 60000;  // 활동 1분마다 속도 표본 하나
  const JUMP_WORDS = 400;   // 한 번에 이보다 많이 움직이면 점프(목차·검색·빠른 넘기기): 구간을 새로 시작
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  // 제목 수준: 2 / "h2" / "H3" → 숫자
  const levelNum = l => {
    const n = typeof l === "number" ? l : parseInt(String(l ?? "").replace(/^h/i, ""), 10);
    return Number.isFinite(n) ? n : 2;
  };

  // 평평한 목록 [{id, level, title}] → 트리 [{..., children}]. 더 깊은 항목은 바로 앞의 더 얕은 항목 아래로
  function buildToc(list) {
    const root = [], stack = [];
    for (const it of list || []) {
      const node = { ...it, level: levelNum(it.level), children: [] };
      while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
      (stack.length ? stack[stack.length - 1].children : root).push(node);
      stack.push(node);
    }
    return root;
  }

  const wordCount = text => (String(text ?? "").match(/\S+/g) || []).length;
  // [3, 5] → [0, 3, 8]
  const prefixSums = arr => (arr || []).reduce((acc, x) => (acc.push(acc[acc.length - 1] + (Number(x) || 0)), acc), [0]);

  // 남은 단어 → 분 (반올림, 남은 게 있으면 최소 1분)
  function minutesLeft(words, wpm = WPM_DEFAULT) {
    if (!(words > 0)) return 0;
    return Math.max(1, Math.round(words / clamp(Number(wpm) || WPM_DEFAULT, WPM_MIN, WPM_MAX)));
  }
  function fmtMinutes(min) {
    if (!(min > 0)) return "0분";
    if (min < 60) return `약 ${min}분`;
    const hh = Math.floor(min / 60), mm = min % 60;
    return `약 ${hh}시간${mm ? ` ${mm}분` : ""}`;
  }

  // 읽기 속도 EMA: 터무니없는 표본(넘겨 보기·멍하니 둔 것)은 버리고, 나머지는 80~400으로 잘라 반영. 결과도 80~400
  function updateWpm(prev, sample, alpha = 0.2) {
    const p = clamp(Number(prev) || WPM_DEFAULT, WPM_MIN, WPM_MAX);
    if (!Number.isFinite(sample) || sample < WPM_MIN / 4 || sample > WPM_MAX * 4) return Math.round(p);
    return Math.round(clamp(p + alpha * (clamp(sample, WPM_MIN, WPM_MAX) - p), WPM_MIN, WPM_MAX));
  }

  // 읽기 속도 측정: 스크롤로 지나간 단어 수 / 활동 시간. m = {w0, lastT, lastW, active} | null, t = ms, w = 읽은 위치(단어)
  // → {m, sample}. 90초 넘는 공백·점프는 구간을 새로 시작, 활동 1분이 차면 표본(분당 단어, 앞으로 간 경우만)
  function meterStep(m, t, w) {
    const fresh = { w0: w, lastT: t, lastW: w, active: 0 };
    if (!m || !(t >= m.lastT) || t - m.lastT > IDLE_MS || Math.abs(w - m.lastW) > JUMP_WORDS) return { m: fresh, sample: null };
    const active = m.active + (t - m.lastT);
    if (active < WINDOW_MS) return { m: { ...m, active, lastT: t, lastW: w }, sample: null };
    const words = w - m.w0;
    return { m: fresh, sample: words > 0 ? words / (active / 60000) : null };
  }

  // 섹션(문단 범위 [a, b))에서 읽은 위치 w 뒤로 남은 단어
  const sectionLeft = (cum, a, b, w) => (b > a ? Math.max(0, cum[b] - Math.max(w, cum[a])) : 0);
  // 섹션 경계 눈금: 그 섹션 제목이 기준선(band px)에 닿는 스크롤 위치를 진행 막대 비율로
  const tickFrac = (top, band, maxY) => (maxY > 0 ? clamp((top - band) / maxY, 0, 1) : 0);
  // 이어 읽기 스크롤 위치: 문단 안 비율 → 글자 크기가 바뀌어도 같은 곳
  const resumeY = (absTop, height, ratio, topLine) => Math.max(0, absTop + clamp(Number(ratio) || 0, 0, 0.999) * height - topLine);
  // 저장된 위치가 3%를 넘고 주소에 #…(딥 링크·본문 위치)가 없을 때만 '이어 읽기'
  const shouldOfferResume = (saved, hash = "") =>
    !!saved && typeof saved === "object" && Number(saved.pct) > 3 && !String(hash || "").replace(/^#/, "");

  // '이어 읽기' 안내 문구: 제목 → §번호 → 진행률 순으로 한 줄에 들어가는 첫 것 (fits: 문구 → bool). 다 길면 '이어 읽기'만
  function resumeLabel({ title, tag, pct } = {}, fits = () => true) {
    const t = String(tag ?? "").trim(), p = Number(pct);
    const cands = [title, /^[\dA-Z]+(\.\d+)*$/.test(t) ? `§${t}` : "", pct != null && Number.isFinite(p) ? `${Math.round(p)}%` : ""];
    for (const c of cands) {
      const s = String(c ?? "").trim();
      if (s && fits(`이어 읽기 · ${s}`)) return `이어 읽기 · ${s}`;
    }
    return "이어 읽기";
  }

  // 기준선 y에 걸친(또는 그 아래 첫) 보이는 문단. boxAt(i) = 문서 순서 i번째 문단의 {top, bottom} | null(숨음: 번역 모드의
  // 원문·찾기 정리). 숨은 문단은 다음 보이는 문단과 같은 자리로 봐서 이분 탐색 유지 → [i, box], 기준선이 모든 문단 아래면 [n, null]
  function boxAtLine(n, boxAt, y) {
    const next = i => { for (; i < n; i++) { const b = boxAt(i); if (b) return [i, b]; } return [n, null]; };
    let lo = 0, hi = n;
    while (lo < hi) {
      const m = (lo + hi) >> 1, [j, b] = next(m);
      if (b && b.bottom <= y) lo = j + 1; else hi = m;
    }
    return next(lo);
  }

  // 가져오기 병합 (pr:toc-progress:pos:*): 더 최근 ts
  function mergePos(local, incoming) {
    if (!local || typeof local !== "object") return incoming ?? local;
    if (!incoming || typeof incoming !== "object") return local;
    return (Number(incoming.ts) || 0) > (Number(local.ts) || 0) ? incoming : local;
  }

  // 첫 문장 (구조도의 요약 한 줄)
  function firstSentence(text, max = 90) {
    const t = String(text ?? "").replace(/\s+/g, " ").trim();
    const m = t.match(/^.+?[.!?。！？](?=\s|$)/);
    const s = m ? m[0] : t;
    return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
  }

  // 그림 이름: ("Figure 1:", "Figure 1: Architecture of …") → "Figure 1 · Architecture of …"
  function figLabel(tag, caption, max = 60) {
    const tg = String(tag ?? "").replace(/\s+/g, " ").trim().replace(/[:.]\s*$/, "");
    let cap = String(caption ?? "").replace(/\s+/g, " ").trim();
    const raw = String(tag ?? "").replace(/\s+/g, " ").trim();
    if (raw && cap.startsWith(raw)) cap = cap.slice(raw.length).trim();
    if (cap.length > max) cap = cap.slice(0, max - 1).trimEnd() + "…";
    return tg && cap ? `${tg} · ${cap}` : tg || cap;
  }

  // 구조도: 목차 트리 + 섹션 요약 첫 문장(section-study의 paper:gists) + 섹션별 그림·표 [{id, sec, label, kind}]
  function buildMap(tree, gists, figs = []) {
    const bySec = new Map();
    for (const f of figs || []) {
      if (!bySec.has(f.sec)) bySec.set(f.sec, []);
      bySec.get(f.sec).push(f);
    }
    const gistOf = id => {
      const g = gists && typeof gists === "object" ? gists[id] : null;
      return firstSentence(typeof g === "string" ? g : (g && (g.gist || g.text)) || "");
    };
    const walk = nodes => (nodes || []).map(n => ({
      id: n.id, level: n.level, title: n.title, gist: gistOf(n.id), figs: bySec.get(n.id) || [], children: walk(n.children),
    }));
    return walk(tree);
  }

  const api = {
    buildToc, levelNum, wordCount, prefixSums, minutesLeft, fmtMinutes, updateWpm, meterStep, sectionLeft, tickFrac,
    resumeY, shouldOfferResume, resumeLabel, boxAtLine, mergePos, firstSentence, figLabel, buildMap,
  };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;
  // 위치 병합 규칙은 홈(library 가져오기)에서도 필요 → 페이지 확인 전에 등록
  if (window.PaperStore) window.PaperStore.addMerger("toc-progress:pos:", mergePos);
  if (document.body.dataset.page !== "paper") return;
  PaperApp.registerFeature("toc-progress", api);

  const UI = window.PaperUI, A = window.PaperAnchor, App = window.PaperApp, store = window.PaperStore, h = UI.h;
  const paper = A.root();
  if (!paper) return;
  const POS = "toc-progress:pos", WPM_KEY = "toc-progress:wpm";
  const BAND = 0.4;      // 화면 위에서 40% 선을 지나는 섹션이 '지금 섹션' (jumpTo가 대상을 35%에 둠)
  const DRAWER_Z = 26;   // 서랍 z (배경 25): peek는 그 위로
  const ric = window.requestIdleCallback ? fn => requestIdleCallback(fn, { timeout: 1500 }) : fn => setTimeout(fn, 200);

  // ---------- 구조 모으기 (한 번, 유휴 시간에) ----------
  // entries: 초록 + section[id] 바로 아래 .ltx_title이 h2/h3인 것 (부록·참고문헌 포함), 문서 순서
  // paras: 단어 수를 셀 문단 (맨 바깥 .ltx_para + 초록 문단), cum: 단어 누적합
  let ready = false, entries = [], byId = new Map(), byEl = new Map(), paras = [], words = [], cum = [0];
  function collect() {
    const out = [], seen = new Set();
    const abs = paper.querySelector(".ltx_abstract");
    if (abs) { out.push({ id: "abstract", level: 2, el: abs, titleEl: abs.querySelector(".ltx_title") }); seen.add(abs); }
    for (const el of paper.querySelectorAll("section[id]")) {
      const t = [...el.children].find(c => c.classList.contains("ltx_title"));
      if (seen.has(el) || !t || !/^h[23]$/i.test(t.localName) || el.closest(".pr-ui")) continue;
      out.push({ id: el.id, level: Number(t.localName[1]), el, titleEl: t });
    }
    out.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1));
    out.forEach((e, i) => {
      e.i = i;
      const tag = e.titleEl && e.titleEl.querySelector(".ltx_tag");
      e.tag = tag ? A.textOf(tag) : "";
    });
    return out;
  }
  function scan() {
    entries = collect();
    byId = new Map(entries.map(e => [e.id, e]));
    byEl = new Map(entries.map(e => [e.el, e]));
    const outer = el => !el.parentElement.closest(".ltx_para") && !el.closest(".pr-ui, .tr-ko");
    paras = [...paper.querySelectorAll(".ltx_para, .ltx_abstract .ltx_p")].filter(outer);
    if (!paras.length) paras = [...paper.querySelectorAll("p")].filter(outer);
    words = paras.map(el => wordCount(A.textOf(el)));
    cum = prefixSums(words);
    for (const e of entries) {
      let a = -1, b = -1;
      for (let i = 0; i < paras.length; i++) {
        if (e.el.contains(paras[i])) { if (a < 0) a = i; b = i + 1; } else if (a >= 0) break;
      }
      e.a = a < 0 ? 0 : a;
      e.b = a < 0 ? 0 : b;
      e.words = cum[e.b] - cum[e.a];
    }
  }
  function ensure() {
    if (ready) return;
    ready = true;
    scan();
    observe();
    measure();
  }

  // ---------- 읽는 위치 ----------
  // 내용이 시작되는 선 = 헤더 아래 띠(#top-stack)의 아래 끝 (헤더 자동 숨김도 따라감)
  const topStack = document.getElementById("top-stack");
  const topLine = () => { const b = topStack ? topStack.getBoundingClientRect().bottom : 0; return b > 0 ? b : 56; };
  // 문단이 화면에서 차지하는 자리: 문단 + 바로 뒤에 붙은 .tr-ko 번역 (번역 모드에서 원문이 숨으면 번역만).
  // 다 숨었으면(display: none → 상자 없음) null
  function paraBox(el) {
    let top = Infinity, bottom = -Infinity;
    for (let x = el; x && (x === el || x.classList.contains("tr-ko")); x = x.nextElementSibling) {
      if (!x.getClientRects().length) continue;
      const r = x.getBoundingClientRect();
      top = Math.min(top, r.top);
      bottom = Math.max(bottom, r.bottom);
    }
    return bottom >= top ? { top, bottom } : null;
  }
  // 점프 대상: paper:reveal이 숨은 원문을 드러내지 않게, 보이면서 숨은 원문을 담지 않은 요소 (번역 모드면 그 .tr-ko)
  function shownBlock(el) {
    if (el.getClientRects().length && !el.querySelector(".tr-hide")) return el;
    const sib = el.nextElementSibling;
    return el.querySelector(".tr-ko") || (sib && sib.classList.contains("tr-ko") ? sib : null) || el;
  }
  // {w: 읽은 단어 위치, el: 맨 위 문단, ratio: 그 문단 안 비율}
  function readPos() {
    if (!paras.length) return { w: 0, el: null, ratio: 0 };
    const y = topLine(), [k, r] = boxAtLine(paras.length, i => paraBox(paras[i]), y);
    if (!r) return { w: cum[paras.length], el: null, ratio: 0 };
    const hgt = r.bottom - r.top;
    const f = hgt > 0 ? clamp((y - r.top) / hgt, 0, 0.999) : 0;
    return { w: cum[k] + f * words[k], el: paras[k], ratio: f };
  }

  // 진행률: 본문 끝(아래 여백 제외)이 화면 아래에 닿으면 100%
  let maxY = null, band = 0;
  function measure() {
    const sy = window.scrollY;
    const pb = parseFloat(getComputedStyle(paper).paddingBottom) || 0;
    maxY = Math.max(1, paper.getBoundingClientRect().bottom + sy - pb - window.innerHeight);
    band = window.innerHeight * BAND;
    for (const e of entries) e.top = e.el.getBoundingClientRect().top + sy;
    renderTicks();
    renderFill();
  }
  const pctNow = () => (maxY ? clamp(window.scrollY / maxY, 0, 1) * 100 : 0);

  // ---------- 지금 섹션: 40% 선의 얇은 띠와 겹치는 가장 깊은 항목 (IntersectionObserver) ----------
  let current = null;
  const inBand = new Set();
  function observe() {
    if (typeof IntersectionObserver === "undefined" || !entries.length) return;
    const io = new IntersectionObserver(list => {
      for (const x of list) {
        const e = byEl.get(x.target);
        if (e) { if (x.isIntersecting) inBand.add(e); else inBand.delete(e); }
      }
      pickCurrent();
    }, { rootMargin: `-${BAND * 100}% 0px -${100 - BAND * 100 - 1}% 0px` });
    for (const e of entries) io.observe(e.el);
  }
  function pickCurrent() {
    let best = null;
    for (const e of inBand) if (!best || e.i > best.i) best = e;
    // 띠가 섹션 사이 틈(그림·각주 등)에 있으면 앞 섹션 유지, 첫 항목보다 위(제목·저자)면 없음
    if (!best && current && entries[0].el.getBoundingClientRect().top <= window.innerHeight * BAND) best = current;
    if (best === current) return;
    current = best;
    renderLabel();
    if (drawer && tab === "toc") renderDrawer();
  }

  // ---------- 제목 (번역 모드면 section-translate의 한국어 제목) ----------
  let trMode = store.get("section-translate:mode", "orig") || "orig";
  function titleOf(e) {
    if (!e) return "";
    if (trMode !== "orig") {
      if (e.id === "abstract") return "초록";
      let ko = null;
      try { ko = App.feature("section-translate")?.titleFor?.(e.id) || null; } catch { /* 없으면 원문 */ }
      if (ko) {
        ko = String(ko).trim();
        return e.tag && /^[\dA-Z]+(\.\d+)*$/.test(e.tag) && !ko.startsWith(e.tag) ? `${e.tag} ${ko}` : ko;
      }
    }
    return (e.titleEl && A.textOf(e.titleEl)) || (e.id === "abstract" ? "Abstract" : e.id);
  }
  // 화면에 보이는 제목 요소 (번역 모드에서 원문 제목이 숨었으면 바로 뒤 .tr-ko)
  function shownTitle(e) {
    const t = e.titleEl;
    if (!t) return null;
    if (t.getClientRects().length) return t;
    const ko = t.nextElementSibling;
    return ko && ko.classList.contains("tr-ko") ? ko : null;
  }

  // ---------- 헤더: 지금 섹션 이름 (#bar-section, .bar-title 안). 누르면 목차 ----------
  const barTitle = document.getElementById("bar-title") || document.querySelector(".bar-title");
  let label = null, defaultTitle = "";
  if (barTitle) {
    defaultTitle = barTitle.textContent.trim();
    label = h("span", { id: "bar-section", role: "button", tabindex: "0", text: defaultTitle });
    barTitle.replaceChildren(label);
    label.addEventListener("click", () => openDrawer());
    label.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDrawer(); } });
  }
  function renderLabel() {
    if (!label) return;
    const t = current ? titleOf(current) : defaultTitle;
    label.textContent = t;
    label.setAttribute("aria-label", current ? `지금 섹션: ${t} · 목차 열기` : "목차 열기");
  }

  // ---------- 진행 막대 (헤더 아래 띠의 첫 줄, 3px). 섹션 경계 눈금, 누르면 남은 시간 ----------
  const fill = h("span", { class: "toc-fill" });
  const ticks = h("span", { class: "toc-ticks" });
  const progress = h("button", { type: "button", class: "toc-progress", "aria-label": "읽기 진행 (남은 시간 보기)" },
    h("span", { class: "toc-track" }, fill, ticks));
  progress.addEventListener("click", () => { ensure(); UI.toast(infoText()); });
  UI.topSlot("toc-progress")?.append(progress);
  let shownPct = -1;
  function renderFill() {
    if (maxY == null) return;
    const p = pctNow();
    fill.style.transform = `scaleX(${(p / 100).toFixed(4)})`;
    const r = Math.round(p);
    if (r !== shownPct) { shownPct = r; progress.setAttribute("aria-label", `읽기 진행 ${r}% (남은 시간 보기)`); }
  }
  function renderTicks() {
    const top = Math.min(...entries.map(e => e.level));
    const fr = entries.filter(e => e.level === top && e.id !== "abstract" && e.top != null)
      .map(e => tickFrac(e.top, band, maxY)).filter(f => f > 0.005 && f < 0.995);
    ticks.replaceChildren(...fr.map(f => h("i", { class: "toc-tick", style: `left:${(f * 100).toFixed(2)}%` })));
  }
  // '이 섹션 약 4분 · 전체 37% · 끝까지 약 25분'
  function infoText() {
    const p = readPos(), parts = [];
    const sec = current ? minutesLeft(sectionLeft(cum, current.a, current.b, p.w), wpm) : 0;
    if (sec) parts.push(`이 섹션 ${fmtMinutes(sec)}`);
    parts.push(`전체 ${Math.round(pctNow())}%`);
    const total = minutesLeft(cum[cum.length - 1] - p.w, wpm);
    if (total) parts.push(`끝까지 ${fmtMinutes(total)}`);
    return parts.join(" · ");
  }

  // ---------- 읽기 속도 (pr:toc-progress:wpm) ----------
  let wpm = clamp(Number(store.get(WPM_KEY, WPM_DEFAULT)) || WPM_DEFAULT, WPM_MIN, WPM_MAX);
  let meter = null;
  function meterTick(w) {
    const r = meterStep(meter, Date.now(), w);
    meter = r.m;
    if (r.sample == null) return;
    const n = updateWpm(wpm, r.sample);
    if (n !== wpm) { wpm = n; store.set(WPM_KEY, wpm); }
  }
  // 읽기가 아닌 시간(점프·질문 시트·서랍·화면 꺼짐)은 구간을 새로 시작
  const resetMeter = () => { meter = null; };
  App.on("jump", resetMeter);
  App.on("sheet-open", resetMeter);
  App.on("sheet-close", resetMeter);

  // ---------- 위치 저장 (1초 간격, pr:toc-progress:pos:<baseId>) ----------
  let pending = false, dirty = false, tickTimer = 0, lastTick = 0;
  function tick() {
    tickTimer = 0;
    lastTick = Date.now();
    if (!ready) return;
    // 찾기 정리 화면(in-paper-search가 맞는 문단만 남김)은 읽는 자리가 아님: 속도·저장 모두 건너뜀 (끝나고 스크롤하면 저장)
    if (paper.classList.contains("ps-declutter")) { resetMeter(); return; }
    const p = readPos();
    meterTick(p.w);
    if (pending || !dirty) return; // '이어 읽기' 안내 중에는 저장된 자리를 덮지 않음
    dirty = false;
    store.setPaper(POS, { paraId: (p.el && p.el.id) || null, ratio: Math.round(p.ratio * 1000) / 1000, pct: Math.round(pctNow() * 10) / 10, ts: Date.now() });
  }
  function scheduleTick() {
    if (!tickTimer) tickTimer = setTimeout(tick, Math.max(0, 1000 - (Date.now() - lastTick)));
  }
  function flush() {
    if (tickTimer) { clearTimeout(tickTimer); tick(); }
  }
  let raf = 0;
  window.addEventListener("scroll", () => {
    dirty = true;
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderFill(); });
    scheduleTick();
  }, { passive: true });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") { flush(); resetMeter(); } });
  window.addEventListener("pagehide", flush);

  // 글꼴·번역·그림 로드로 높이가 바뀌면 다시 잼 (눈금·진행률)
  let measureTimer = 0;
  const remeasure = () => { clearTimeout(measureTimer); measureTimer = setTimeout(() => { if (ready) measure(); }, 250); };
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(remeasure).observe(paper);
  window.addEventListener("resize", remeasure);

  // ---------- 이어 읽기 ----------
  const saved = store.paper(POS, null);
  function navType() {
    try { return performance.getEntriesByType("navigation")[0]?.type || "navigate"; } catch { return "navigate"; }
  }
  function offerResume() {
    // 새로고침·뒤로 가기는 브라우저가 자리를 되살림. #q=(딥 링크)·#S2 같은 주소도 그쪽이 우선
    if (!shouldOfferResume(saved, location.hash) || navType() === "reload" || navType() === "back_forward") return;
    if (Math.abs(pctNow() - Number(saved.pct)) < 2) return;
    const el = saved.paraId ? document.getElementById(saved.paraId) : null;
    const e = el ? [...entries].reverse().find(x => x.el.contains(el)) : null;
    const msg = resumeLabel({ title: e ? titleOf(e) : "", tag: e ? e.tag : "", pct: saved.pct }, fitsToast);
    // 안내가 떠 있는 동안은 저장된 자리를 덮지 않음. 다른 기능의 '실행 취소' 토스트 뒤에 줄 서 있을 수 있으니
    // 시간을 재지 않고, 이 안내가 실제로 떴다가 사라질 때(또는 '이동')까지
    pending = true;
    let mo = null, shown = false, cap = 0;
    const done = () => { pending = false; if (mo) mo.disconnect(); mo = null; clearTimeout(cap); };
    const t = UI.toast(msg, { actionLabel: "이동", ms: 8000, onAction: () => { done(); resumeTo(saved); } });
    const root = document.getElementById("pr-toast");
    if (!root || typeof MutationObserver === "undefined") { cap = setTimeout(done, 8000); return; }
    const check = () => {
      if (root.isConnected && !root.hidden && root.textContent.startsWith(msg)) shown = true;
      else if (shown) done();
    };
    mo = new MutationObserver(check);
    mo.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden"] });
    check();
    cap = setTimeout(() => { if (pending) { t.close(); done(); } }, 60000); // 줄이 풀리지 않는 비정상 상황의 안전판
  }
  // 토스트 한 줄에 '문구 + 이동'이 들어가는지. 공용 토스트는 left: 50%라 폭이 화면 절반까지라서(기반 쪽 문제),
  // 길면 버튼 글자가 두 줄로 꺾임 → 캔버스로 재서 짧은 문구를 고름 (글자 14px, 좌우 여백 16, 간격 12)
  let measureCtx = null;
  function fitsToast(text) {
    try {
      measureCtx = measureCtx || document.createElement("canvas").getContext("2d");
      const fam = getComputedStyle(document.body).fontFamily;
      measureCtx.font = `14px ${fam}`;
      const tw = measureCtx.measureText(text).width;
      measureCtx.font = `600 14px ${fam}`;
      const bw = measureCtx.measureText("이동").width;
      return tw + bw + 12 + 32 + 6 <= Math.min(window.innerWidth / 2, window.innerWidth - 32);
    } catch { return text.length <= 10; }
  }
  function resumeTo(p) {
    const el = p.paraId ? document.getElementById(p.paraId) : null;
    if (el && paper.contains(el)) {
      // '↩ 돌아가기'. 대상은 보이는 요소(번역 모드면 번역)라 paper:reveal이 이 문단의 원문을 다시 꺼내지 않음
      PaperNav.jumpTo(shownBlock(el), { smooth: false, flash: false });
      const r = paraBox(el) || el.getBoundingClientRect();
      window.scrollTo({ top: resumeY(r.top + window.scrollY, r.bottom - r.top, p.ratio, topLine()), behavior: "auto" });
      A.flash(shownBlock(el));
    } else if (maxY) {
      window.scrollTo({ top: (clamp(Number(p.pct) || 0, 0, 100) / 100) * maxY, behavior: "auto" });
    }
  }

  // ---------- 서랍: 목차 / 구조 ----------
  let drawer = null, tab = "toc", gists = null;
  App.on("gists", d => {
    if (d && d.map && typeof d.map === "object") { gists = d.map; if (drawer && tab === "map") renderDrawer(); }
  });
  App.on("translations", d => {
    trMode = (d && d.mode) || "orig";
    renderLabel();
    if (drawer) renderDrawer();
  });

  function openDrawer() {
    if (drawer) return;
    ensure();
    resetMeter();
    const prev = document.activeElement;
    const backdrop = h("div", { class: "toc-backdrop pr-ui" });
    const tabBtn = (id, text) => h("button", { type: "button", class: "toc-tab", dataset: { tab: id }, text,
      onclick: () => { tab = id; renderDrawer(); } });
    const x = h("button", { type: "button", class: "toc-x", "aria-label": "닫기", text: "✕" });
    const info = h("div", { class: "toc-info" });
    const body = h("div", { class: "toc-body" });
    const tabs = [tabBtn("toc", "목차"), tabBtn("map", "구조")];
    const panel = h("section", { class: "toc-drawer pr-ui", role: "dialog", "aria-modal": "true", "aria-label": "목차", tabindex: "-1" },
      h("div", { class: "toc-head" }, h("div", { class: "toc-tabs", role: "group", "aria-label": "보기" }, tabs), x), info, body);
    document.body.append(backdrop, panel);
    const close = UI.layer(reason => {
      backdrop.remove();
      panel.remove();
      drawer = null;
      resetMeter();
      if (reason !== "sheet" && prev && prev.isConnected) try { prev.focus({ preventScroll: true }); } catch { /* 무시 */ }
    }, { kind: "drawer", z: DRAWER_Z });
    drawer = { panel, body, info, tabs, close };
    backdrop.addEventListener("click", () => close("outside"));
    x.addEventListener("click", () => close("close"));
    // 왼쪽으로 밀어 닫기 (세로 스크롤은 그대로: touch-action: pan-y)
    let sx = null, sy = 0;
    panel.addEventListener("pointerdown", e => { sx = e.clientX; sy = e.clientY; });
    panel.addEventListener("pointerup", e => {
      if (sx != null && e.clientX - sx < -60 && Math.abs(e.clientY - sy) < 50) { swipedAt = Date.now(); close("swipe"); }
      sx = null;
    });
    panel.addEventListener("pointercancel", () => { sx = null; });
    renderDrawer();
    requestAnimationFrame(() => { backdrop.classList.add("toc-in"); panel.classList.add("toc-in"); });
    const cur = body.querySelector("[aria-current]");
    if (cur) body.scrollTop = Math.max(0, cur.offsetTop - body.clientHeight / 2);
    try { (cur || panel).focus({ preventScroll: true }); } catch { /* 무시 */ }
  }

  function renderDrawer() {
    if (!drawer) return;
    for (const b of drawer.tabs) b.setAttribute("aria-pressed", String(b.dataset.tab === tab));
    drawer.info.textContent = infoText();
    const keep = drawer.body.scrollTop;
    drawer.body.replaceChildren(tab === "map" ? mapView() : tocView());
    drawer.body.scrollTop = keep;
  }

  const tocTree = () => buildToc(entries.map(e => ({ id: e.id, level: e.level, title: titleOf(e) })));
  function tocView() {
    if (!entries.length) return h("p", { class: "toc-empty", text: "이 논문에는 목차로 쓸 제목이 없습니다" });
    const p = readPos();
    const mk = nodes => h("ul", { class: "toc-ul" }, nodes.map(n => {
      const e = byId.get(n.id);
      const min = minutesLeft(e.words, wpm);
      const read = e.b > e.a && e !== current && p.w >= cum[e.b] - 0.5;
      const btn = h("button", { type: "button", class: `toc-item${read ? " toc-read" : ""}`, dataset: { id: n.id }, onclick: () => go(e) },
        h("span", { class: "toc-t", text: n.title }), min ? h("span", { class: "toc-min", text: `${min}분` }) : null);
      if (e === current) btn.setAttribute("aria-current", "location");
      return h("li", { class: `toc-l${n.level}` }, btn, n.children.length ? mk(n.children) : null);
    }));
    return mk(tocTree());
  }

  // 구조도: 섹션 → 요약 한 줄 → 그림·표 → 하위 섹션. 접기/펼치기, 노드를 누르면 그 자리로
  function figures() {
    const out = [];
    for (const f of paper.querySelectorAll("figure[id]")) {
      if (f.parentElement.closest("figure") || f.closest(".pr-ui")) continue;
      // 그림을 담은 가장 깊은 항목 (문서 순서라 마지막이 가장 깊음). 없으면 바로 앞 항목 (초록 아래 티저 그림 등)
      let e = null;
      for (const x of entries) if (x.el.contains(f)) e = x;
      if (!e) for (const x of entries) if (x.el.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING) e = x;
      e = e || entries[0];
      if (!e) continue;
      const cap = f.querySelector(":scope > figcaption") || f.querySelector("figcaption");
      const tag = cap && cap.querySelector(".ltx_tag");
      const kind = f.classList.contains("ltx_table") ? "table" : f.classList.contains("ltx_float_algorithm") ? "algorithm" : "figure";
      out.push({ id: f.id, el: f, sec: e.id, kind, label: figLabel(tag ? A.textOf(tag) : "", cap ? A.textOf(cap) : "") || f.id });
    }
    return out;
  }
  const FIG_ICON = { figure: "▣", table: "▦", algorithm: "≡" };
  function mapView() {
    if (!entries.length) return h("p", { class: "toc-empty", text: "이 논문에는 구조로 보여 줄 제목이 없습니다" });
    const tree = buildMap(tocTree(), gists, figures());
    const mk = (nodes, depth) => h("ul", { class: "toc-ul toc-map" }, nodes.map(n => {
      const e = byId.get(n.id);
      const kids = [];
      if (n.gist) kids.push(h("li", {}, h("button", { type: "button", class: "toc-gist", text: n.gist, onclick: () => go(e) })));
      for (const f of n.figs) {
        kids.push(h("li", {}, h("button", { type: "button", class: "toc-fig", onclick: () => goFig(f.el) },
          h("span", { class: "toc-fig-i", "aria-hidden": "true", text: FIG_ICON[f.kind] || "▣" }), h("span", { text: f.label }))));
      }
      if (n.children.length) kids.push(h("li", {}, mk(n.children, depth + 1)));
      const open = depth === 0 || (current && (current === e || e.el.contains(current.el)));
      const sub = kids.length ? h("ul", { class: "toc-kids", hidden: !open }, kids) : null;
      const chev = sub
        ? h("button", { type: "button", class: "toc-chev", "aria-expanded": String(!!open), "aria-label": `${n.title} ${open ? "접기" : "펼치기"}`,
          onclick: ev => {
            const on = sub.hidden;
            sub.hidden = !on;
            ev.currentTarget.setAttribute("aria-expanded", String(on));
            ev.currentTarget.setAttribute("aria-label", `${n.title} ${on ? "접기" : "펼치기"}`);
          } })
        : h("span", { class: "toc-chev-sp", "aria-hidden": "true" });
      const title = h("button", { type: "button", class: "toc-item", dataset: { id: n.id }, onclick: () => go(e) }, h("span", { class: "toc-t", text: n.title }));
      if (e === current) title.setAttribute("aria-current", "location");
      return h("li", { class: `toc-l${n.level}` }, h("div", { class: "toc-row" }, chev, title), sub);
    }));
    const wrap = h("div", {}, mk(tree, 0));
    if (!gists && App.has("section-study")) wrap.prepend(h("p", { class: "toc-hint", text: "섹션 요약은 준비되면 여기에 한 줄씩 보입니다" }));
    return wrap;
  }

  // 목차 이동: 서랍을 닫고 PaperNav.jumpTo('↩ 돌아가기'), 제목은 띠 바로 아래로. 점프 대상은 섹션 전체가 아니라 보이는 제목
  // (번역 모드면 .tr-ko 제목): paper:reveal이 섹션 원문을 통째로 다시 꺼내지 않게
  let swipedAt = 0; // 밀어 닫은 손가락이 항목 위에서 떨어져도 이동하지 않게
  const swiped = () => Date.now() - swipedAt < 400;
  function go(e) {
    if (swiped()) return;
    if (drawer) drawer.close("close");
    if (!e || !e.el.isConnected) return;
    PaperNav.jumpTo(shownTitle(e) || e.titleEl || e.el, { flash: false });
    const y = e.el.getBoundingClientRect().top + window.scrollY - topLine() - 6;
    window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
    A.flash(shownTitle(e) || e.el);
  }
  function goFig(el) {
    if (swiped()) return;
    if (drawer) drawer.close("close");
    if (el && el.isConnected) PaperNav.jumpTo(el);
  }

  UI.addBarButton({ id: "toc-progress", label: "목차", title: "목차 · 구조", onClick: openDrawer });

  // 무거운 일(문단 단어 세기·위치 재기)은 첫 화면을 그린 뒤 유휴 시간에
  ric(() => {
    ensure();
    renderLabel();
    setTimeout(offerResume, 300);
  });
})();
