// glossary: 용어·기호 사전 — 밑줄(CSS Highlight) 탭하면 한국어 뜻을 바로 (네트워크 없음), '용어' 목록, 루비 병기
(function () {
  "use strict";

  // ---------- 순수 함수 (node 테스트 대상) ----------
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 단어 경계: 하이픈도 단어 글자로 봄 ('kd-loss'의 kd는 KD가 아님)
  const WORD = "A-Za-z0-9_\\-";
  // 대문자가 2개 이상인 한 단어(KD, MoE, LLaMA)는 대소문자 구분
  const isAcronym = s => !/\s/.test(s) && (s.match(/[A-Z]/g) || []).length >= 2;
  const normTerm = s => String(s || "").toLowerCase().replace(/[\s\-‐-―]+/g, " ").trim();

  function termRegex(form) {
    const f = String(form || "").trim();
    const words = f.split(/[\s\-]+/).filter(Boolean).map(esc);
    if (f.length < 2 || !words.length) return null;
    const plural = /[A-Za-z]$/.test(f) ? (isAcronym(f) ? "s?" : "(?:s|es)?") : "";
    return new RegExp(`(^|[^${WORD}])(${words.join("[\\s\\-]+")}${plural})(?![${WORD}])`, isAcronym(f) ? "g" : "gi");
  }
  // 용어 목록 → [{re, i}] (t와 약어 a 각각)
  function compileTerms(terms) {
    const out = [];
    (terms || []).forEach((t, i) => {
      const forms = [t.t, ...(Array.isArray(t.a) ? t.a : [])];
      const seen = new Set();
      for (const f of forms) {
        const re = typeof f === "string" && !seen.has(f) && termRegex(f);
        seen.add(f);
        if (re) out.push({ re, i });
      }
    });
    return out;
  }
  // 정규식 하나의 모든 출현 (겹침 정리 전)
  function matchOne({ re, i }, text, hits = []) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const start = m.index + m[1].length;
      hits.push({ start, end: start + m[2].length, i });
    }
    return hits;
  }
  // 겹치면 먼저 시작한 것, 같으면 긴 것
  function resolveOverlaps(hits) {
    hits.sort((a, b) => a.start - b.start || b.end - a.end);
    const out = [];
    let last = -1;
    for (const x of hits) if (x.start >= last) { out.push(x); last = x.end; }
    return out;
  }
  // 텍스트 안의 용어 위치 [{start, end, i}]
  function findTermMatches(text, terms) {
    const hits = [];
    for (const c of compileTerms(terms)) matchOne(c, text, hits);
    return resolveOverlaps(hits);
  }
  // 묶음(섹션)마다 용어별 첫 출현만
  function firstPer(matches, keyOf) {
    const seen = new Set();
    return matches.filter(m => {
      const k = `${keyOf(m)}|${m.i}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // LaTeX → 토큰: 공백·\displaystyle 무시, 한 토큰만 감싼 중괄호 제거(x_{i} = x_i),
  // \mathcal{L}·\hat{x}는 한 토큰 (L·x와 다른 기호), \text{…}·\mathrm{…}은 한 토큰 (softmax 안의 x는 기호 x가 아님)
  const TEXTCMD = /^\\(?:mathrm|text|textrm|textit|textbf|textsf|texttt|textnormal|operatorname|mathit|mathsf|mathtt|mbox)$/;
  const WRAPCMD = /^\\(?:mathcal|mathbf|mathbb|mathfrak|mathscr|boldsymbol|bm|mathbfit|hat|tilde|bar|vec|dot|ddot|widehat|widetilde|overline|check|breve)$/;
  function texTokens(tex) {
    const s = String(tex || "").trim().replace(/^\$+|\$+$/g, "")
      .replace(/\\(?:displaystyle|textstyle|scriptstyle|scriptscriptstyle|left|right|bigl|bigr|Bigl|Bigr|biggl|biggr|big|Big|bigg|Bigg|limits|nolimits)(?![a-zA-Z])/g, " ")
      .replace(/\\[,;:! ]|~/g, " ");
    const raw = s.match(/\\[a-zA-Z]+|\\.|\S/g) || [];
    let t = [];
    for (let k = 0; k < raw.length; k++) {
      if (TEXTCMD.test(raw[k]) && raw[k + 1] === "{") {
        let depth = 0, j = k + 1, word = "";
        for (; j < raw.length; j++) {
          const c = raw[j];
          if (c === "{" && depth++ === 0) continue;
          if (c === "}" && --depth === 0) break;
          word += c;
        }
        t.push(`\\text{${word}}`);
        k = j;
      } else t.push(raw[k]);
    }
    for (let changed = true; changed;) {
      changed = false;
      const out = [];
      for (let k = 0; k < t.length; k++) {
        if (t[k] === "{" && t[k + 2] === "}" && t[k + 1] !== "{" && t[k + 1] !== "}") { out.push(t[k + 1]); k += 2; changed = true; }
        else if (WRAPCMD.test(t[k]) && t[k + 1] && !/^[{}_^]$/.test(t[k + 1])) { out.push(`${t[k]}{${t[k + 1]}}`); k += 1; changed = true; }
        else out.push(t[k]);
      }
      t = out;
    }
    return t;
  }
  const normTex = tex => texTokens(tex).join(" ");
  // 수식(alttext) 안에 들어 있는 기호들의 번호, 구체적인 것(긴 것) 먼저: x_i^t 다음 x
  function symbolsIn(alttext, symbols) {
    const hay = ` ${normTex(alttext)} `;
    return (symbols || []).map((s, i) => ({ i, n: s._n || normTex(s.tex) }))
      .filter(x => x.n && hay.includes(` ${x.n} `))
      .sort((a, b) => b.n.split(" ").length - a.n.split(" ").length || b.n.length - a.n.length)
      .map(x => x.i);
  }
  // 위치에 맞는 정의: 탭한 곳 앞의 가장 가까운 정의 → 없으면 가장 이른 정의 → 위치 모르면 첫 정의
  // defs: [{at: 색인 오프셋 | null}], offset: null이면 첫 정의
  function pickDef(defs, offset) {
    if (!defs || !defs.length) return -1;
    if (offset == null) return 0;
    let best = -1;
    defs.forEach((d, i) => { if (d.at != null && d.at <= offset && (best < 0 || d.at > defs[best].at)) best = i; });
    if (best >= 0) return best;
    defs.forEach((d, i) => { if (d.at != null && (best < 0 || d.at < defs[best].at)) best = i; });
    return best >= 0 ? best : 0;
  }
  // 검색: 정규화한 질의가 어느 필드에든 들어 있으면
  function searchEntries(list, query, fields) {
    const q = normTerm(query);
    return (list || []).map((e, i) => i).filter(i => !q || fields(list[i]).some(f => normTerm(f).includes(q)));
  }
  // 출현 목록을 묶음(섹션) 순서대로 [{key, n, first}]
  function groupUses(items, keyOf) {
    const map = new Map();
    for (const it of items) {
      const k = keyOf(it);
      const g = map.get(k);
      if (g) g.n++; else map.set(k, { key: k, n: 1, first: it });
    }
    return [...map.values()];
  }

  // 정렬된 구간 [{start, end}]에서 [start, end)를 통째로 담은 구간 | null
  function runAt(runs, start, end) {
    let lo = 0, hi = runs.length - 1, k = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (runs[mid].start <= start) { k = mid; lo = mid + 1; } else hi = mid - 1; }
    return k >= 0 && end <= runs[k].end ? runs[k] : null;
  }
  // 정규화하면 같은 항목 합치기 (서버 키보다 정밀: 'load-balancing loss'/'load balancing loss', \mathcal L/\mathcal{L}).
  // 정의(defs)는 이어 붙임(중복 제외, 최대 4개, 위치별 정의 고르기가 전부 보도록), 약어(a)는 합집합, ko는 첫 비지 않은 값.
  // 항목은 {defs: [{d, q}], a?, ko?, _k?}. d·q는 합친 뒤의 첫 정의
  const MAX_DEFS = 4;
  function mergeEntries(list, keyOf) {
    const out = [], byKey = new Map();
    for (const e of list || []) {
      const k = keyOf(e), prev = k ? byKey.get(k) : null;
      if (!prev) { if (k) byKey.set(k, e); out.push(e); continue; }
      for (const d of e.defs || []) if (prev.defs.length < MAX_DEFS && !prev.defs.some(x => x.d === d.d && x.q === d.q)) prev.defs.push(d);
      if (Array.isArray(e.a) && Array.isArray(prev.a)) {
        const have = new Set([normTerm(prev.t), ...prev.a.map(normTerm)]);
        for (const a of e.a) if (!have.has(normTerm(a))) { have.add(normTerm(a)); prev.a.push(a); }
      }
      if (!prev.ko && e.ko) prev.ko = e.ko;
    }
    for (const e of out) if (e.defs && e.defs.length) { e.d = e.defs[0].d; e.q = e.defs[0].q; }
    return out;
  }

  const api = { normTerm, isAcronym, termRegex, compileTerms, matchOne, resolveOverlaps, findTermMatches, firstPer, runAt, texTokens, normTex, symbolsIn, pickDef, searchEntries, groupUses, mergeEntries };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;
  if (document.body.dataset.page !== "paper") return;

  // ---------- DOM ----------
  const A = window.PaperAnchor, UI = window.PaperUI, App = window.PaperApp, store = window.PaperStore;
  const h = UI.h;
  const paperEl = document.getElementById("paper");
  if (!paperEl || !App.arxivId) return;
  const URL_ = `/api/glossary/${encodeURIComponent(App.arxivId)}`;
  const KNOWN = "glossary:known";
  const EQ = "table.ltx_equation, table.ltx_equationgroup";
  const SKIP = "h1, h2, h3, h4, h5, h6, .ltx_title, a, cite, .ltx_authors, .ltx_tag, code, pre, .ltx_verbatim";
  const TOP_SEC = ".ltx_abstract, section.ltx_section, section.ltx_appendix, section.ltx_chapter";
  const PARA = ".ltx_para, .ltx_abstract, figcaption, .ltx_listing, td, li, p";
  const hasHL = () => typeof CSS !== "undefined" && !!CSS.highlights && typeof Highlight !== "undefined";
  const yieldIdle = () => new Promise(r => (window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 300 }) : setTimeout(r, 16)));
  const now = () => (window.performance ? performance.now() : Date.now());
  const err = e => console.error("[glossary]", e);

  let data = null, loadP = null, appliedP = null;
  let all = [];      // 본문의 모든 출현 [{start, end, i, sec}]
  let painted = [];  // 칠한 출현 (섹션마다 첫 번째, 알아요 제외) — paintedAt 번호와 같은 순서
  let maths = null;  // [{el, n, sec, inline}]
  const symCache = new WeakMap();

  const knownSet = () => new Set((store.get(KNOWN, []) || []).map(normTerm));
  let listRender = null; // 열린 '용어' 목록 다시 그리기

  // ---------- 불러오기 ----------
  function prepare(d) {
    const terms = mergeEntries((d.terms || []).filter(t => t && t.t).map(t => ({ ...t, a: Array.isArray(t.a) ? t.a.slice() : [], _k: normTerm(t.t), defs: t.defs && t.defs.length ? t.defs.map(x => ({ ...x })) : [{ d: t.d, q: t.q }] })), t => t._k);
    const symbols = mergeEntries((d.symbols || []).filter(s => s && s.tex).map(s => ({ ...s, _n: normTex(s.tex), defs: s.defs && s.defs.length ? s.defs.map(x => ({ ...x })) : [{ d: s.d, q: s.q }] })), s => s._n);
    return { terms, symbols, compiled: compileTerms(terms) };
  }
  let errChip = false; // '용어 ✕ 다시' 칩이 떠 있음
  function load(retry = false) {
    if (data) return Promise.resolve(data);
    if (loadP && !retry) return loadP;
    let shown = false;
    const t = setTimeout(() => { shown = true; UI.status("glossary", "용어", "loading"); }, 400);
    loadP = fetch(URL_ + (retry ? "?retry=1" : "")).then(async r => {
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try { msg = (await r.json()).detail || msg; } catch { /* 무시 */ }
        throw new Error(msg);
      }
      data = prepare(await r.json());
      clearTimeout(t);
      App.addOfflineUrl(URL_);
      // 성공하면 언제나 칩 정리: 400ms 안에 끝난 재시도(디스크 캐시)도 남은 오류 칩을 '✓'로 바꿔 지움
      UI.status("glossary", "용어", shown || errChip ? "ready" : null);
      errChip = false;
      return data;
    }).catch(e => {
      clearTimeout(t);
      loadP = null;
      errChip = true;
      UI.status("glossary", "용어", "error", { onRetry: () => load(true).then(ensureApplied).catch(err) });
      throw e;
    });
    return loadP;
  }

  // ---------- 밑줄: 본문 색인에서 용어 위치 계산 → CSS Highlight로 칠함 (DOM 변경 없음) ----------
  const secIds = new Map();
  const secKey = sec => { if (!secIds.has(sec)) secIds.set(sec, secIds.size); return secIds.get(sec); };
  function textRuns(idx) {
    const runs = [];
    let cur = null;
    for (const s of idx.segs) {
      const el = s.node.parentElement;
      if (s.math || !el || el.closest(SKIP)) { cur = null; continue; }
      const sec = el.closest(TOP_SEC);
      if (cur && cur.end === s.start && cur.sec === sec) cur.end = s.end;
      else runs.push(cur = { start: s.start, end: s.end, sec });
    }
    return runs;
  }
  // 색인 전체 텍스트에 용어 정규식을 하나씩 (조각마다 쉬어 가며), 수식·제목·링크 밖 구간(run)에 든 것만
  async function apply(tries = 0) {
    if (!data) return;
    const idx = A.index();
    const runs = textRuns(idx), hits = [];
    let t0 = now();
    for (const c of data.compiled) {
      matchOne(c, idx.text, hits);
      if (now() - t0 > 12) { await yieldIdle(); t0 = now(); }
    }
    if (A.index().text !== idx.text && tries < 3) return apply(tries + 1); // 그 사이 본문 글자가 바뀜 (보통 없음)
    all = [];
    for (const m of resolveOverlaps(hits)) {
      const run = runAt(runs, m.start, m.end);
      if (run) all.push({ ...m, sec: run.sec });
    }
    repaint();
    await markMath();
    // 루비는 기다리지 않음: 선택이 풀릴 때까지 기다릴 수 있어 PaperApp.idle 줄(한 번에 하나)을 막으면 안 됨
    syncRuby().catch(err);
  }
  const ensureApplied = () => (appliedP = appliedP || apply().catch(e => { appliedP = null; err(e); }));
  function repaint() {
    const known = knownSet();
    painted = firstPer(all.filter(m => !known.has(data.terms[m.i]._k)), m => secKey(m.sec));
    if (hasHL()) A.paint("gl-term", painted.map(m => ({ start: m.start, end: m.end })), { priority: 10, fallback: false });
  }

  // ---------- 수식 기호 ----------
  function mathList() {
    if (maths) return maths;
    maths = [...paperEl.querySelectorAll("math")].filter(m => !m.closest(".pr-ui, .tr-ko")).map(el => ({
      el, n: ` ${normTex(el.getAttribute("alttext") || "")} `, sec: el.closest(TOP_SEC),
      inline: el.getAttribute("display") !== "block" && !el.closest(EQ),
    }));
    return maths;
  }
  function symbolHits(m) {
    if (!data || !data.symbols.length) return [];
    let hit = symCache.get(m);
    if (!hit) symCache.set(m, hit = symbolsIn(m.getAttribute("alttext") || "", data.symbols));
    return hit;
  }
  async function markMath() {
    let t0 = now();
    for (const m of mathList()) {
      if (m.inline) m.el.classList.toggle("gl-sym", symbolHits(m.el).length > 0);
      if (now() - t0 > 12) { await yieldIdle(); t0 = now(); }
    }
  }

  // ---------- 정의 위치·문맥 ----------
  function locDefs(e) {
    for (const d of e.defs) {
      if (d._loc === undefined) d._loc = d.q ? A.locate(d.q) : null;
      d.at = d._loc ? d._loc.start : null;
    }
    return e.defs;
  }
  function sectionTitleAt(el) {
    const sec = el && el.closest("section");
    const t = sec && [...sec.children].find(c => c.classList.contains("ltx_title"));
    if (t) return A.textOf(t);
    return el && el.closest(".ltx_abstract") ? "Abstract" : "";
  }
  function secLabel(sec) {
    if (!sec) return "본문";
    if (sec.classList.contains("ltx_abstract")) return "초록";
    const t = [...sec.children].find(c => c.classList.contains("ltx_title"));
    return (t && A.textOf(t)) || "본문";
  }
  // 묻기용 {surface, context, section}: occ는 {start,end} 출현 또는 <math>
  function contextAt(occ, fallback) {
    let el = null, surface = fallback;
    if (occ instanceof Element) { el = occ; surface = `$${occ.getAttribute("alttext") || ""}$`; }
    else if (occ) {
      const r = A.rangeAt(occ.start, occ.end);
      if (r) el = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
      surface = A.index().text.slice(occ.start, occ.end).trim() || fallback;
    }
    const para = el && el.closest(PARA);
    return { surface, context: para ? A.clipAround(A.textOf(para), surface, 1500) : "", section: sectionTitleAt(el) };
  }

  // ---------- peek ----------
  // KaTeX(CDN, 모든 페이지)로 그림. 아직 없으면 LaTeX 원문
  const texNode = tex => {
    const el = h("span", { class: "gl-tex" });
    const t = String(tex).replace(/\\displaystyle\s*/g, "");
    try { if (window.katex) { katex.render(t, el, { throwOnError: false }); return el; } } catch { /* 원문으로 */ }
    el.textContent = t;
    return el;
  };
  function usesRow(groups, total, go) {
    if (!total) return null;
    return h("div", { class: "gl-uses" },
      h("span", { class: "gl-uses-n", text: `${total}곳에서 사용` }),
      ...groups.slice(0, 8).map(g => h("button", { type: "button", class: "gl-use", onclick: () => go(g.first) },
        h("span", { class: "gl-use-t", text: secLabel(g.first.sec) }), h("span", { class: "gl-use-n", text: String(g.n) }))));
  }
  // 용어(kind "t") 또는 기호("s") 하나의 설명 블록. at: 탭한 위치(색인 오프셋) | null
  function detail(kind, i, at, closeAll, head = true) {
    const e = kind === "t" ? data.terms[i] : data.symbols[i];
    const def = e.defs[pickDef(locDefs(e), at)] || e.defs[0];
    const go = target => { closeAll("jump"); PaperNav.jumpTo(target); };
    const uses = kind === "t"
      ? all.filter(m => m.i === i).map(m => ({ sec: m.sec, target: { start: m.start, end: m.end } }))
      : mathList().filter(m => m.n.includes(` ${e._n} `)).map(m => ({ sec: m.sec, target: m.el }));
    const node = h("div", { class: "gl-detail" },
      kind === "t"
        ? h("div", { class: "gl-head" }, h("span", { class: "gl-ko", text: e.ko || e.t }), e.a.length ? h("span", { class: "gl-alias", text: e.a.join(" · ") }) : null)
        : head ? h("div", { class: "gl-head" }, texNode(e.tex)) : null,
      h("p", { class: "gl-def", text: def.d || "" }),
      e.defs.length > 1 ? h("p", { class: "gl-note", text: `이 논문 안 정의 ${e.defs.length}개 중 이 위치에 맞는 뜻` }) : null,
      def._loc ? h("button", { type: "button", class: "gl-go", text: "정의된 곳 ↗", onclick: () => go({ start: def._loc.start, end: def._loc.end }) }) : null,
      usesRow(groupUses(uses, u => secKey(u.sec)), uses.length, u => go(u.target)),
      UI.feedback("glossary", kind === "t" ? e.t : `sym:${e.tex}`, { label: kind === "t" ? "용어" : "기호" }));
    return { node, def, e };
  }

  // 뜻 칩 (ScholarPhi DefinitionPreview): 정의 문장이 화면 밖이면 peek를 닫은 뒤에도 위쪽에 짧게 남김
  let chipScroll = null;
  function hideChip() {
    const slot = UI.topSlot("glossary");
    if (slot) slot.replaceChildren();
    if (chipScroll) { window.removeEventListener("scroll", chipScroll); chipScroll = null; }
  }
  function offScreen(loc) {
    const r = A.rangeAt(loc.start, loc.end);
    if (!r) return false;
    const b = r.getBoundingClientRect();
    const ts = document.getElementById("top-stack");
    return b.bottom < (ts ? ts.getBoundingClientRect().bottom : 0) || b.top > window.innerHeight;
  }
  const CHIP_REASONS = new Set(["close", "outside", "back", "escape", "swipe"]);
  function maybeChip(reason, kind, shown) {
    if (!CHIP_REASONS.has(reason) || !shown || !shown.def._loc || !offScreen(shown.def._loc)) return;
    const slot = UI.topSlot("glossary");
    if (!slot) return;
    hideChip();
    const { e, def } = shown;
    const loc = def._loc;
    slot.append(h("div", { class: "gl-chip", role: "note" },
      kind === "t" ? h("b", { class: "gl-chip-t", text: e.t }) : h("b", { class: "gl-chip-t" }, texNode(e.tex)),
      h("span", { class: "gl-chip-d", text: kind === "t" && e.ko ? `${e.ko} · ${def.d}` : def.d }),
      h("button", { type: "button", class: "gl-chip-go", text: "정의", onclick: () => { hideChip(); PaperNav.jumpTo({ start: loc.start, end: loc.end }); } }),
      h("button", { type: "button", class: "gl-chip-x", "aria-label": "뜻 칩 닫기", text: "✕", onclick: hideChip })));
    // 많이 스크롤해 다른 곳을 읽으면 저절로 사라짐
    const y0 = window.scrollY;
    chipScroll = () => { if (Math.abs(window.scrollY - y0) > window.innerHeight * 1.5) hideChip(); };
    window.addEventListener("scroll", chipScroll, { passive: true });
  }

  function openTerm(i, occ, parent = null) {
    const t = data.terms[i];
    occ = occ || all.find(m => m.i === i) || null;
    let close = null;
    const closeAll = reason => { close && close(reason); parent && parent(reason); };
    const shown = detail("t", i, occ ? occ.start : null, closeAll);
    const actions = [
      { label: "더 묻기", primary: true, onClick: () => askAbout(occ, t.t, `이 논문에서 '${t.t}'${t.ko ? ` (${t.ko})` : ""}의 뜻과 역할을 예시와 함께 자세히 설명해줘`, "용어 자세히", closeAll) },
      { label: "알아요", onClick: () => { close("known"); setKnown(t, true); } },
    ];
    close = UI.peek({ title: t.t, body: h("div", { class: "gl-peek" }, shown.node), actions, className: "gl-term-peek", onClose: r => maybeChip(r, "t", shown) });
    return close;
  }
  function openSymbols(hits, mathEl, parent = null) {
    let close = null, shown = null;
    const closeAll = reason => { close && close(reason); parent && parent(reason); };
    const at = mathEl ? (A.offsetsOfElement(mathEl) || {}).start ?? null : null;
    const box = h("div", { class: "gl-detail-box" });
    const chips = hits.length > 1 ? h("div", { class: "gl-subs", role: "group", "aria-label": "기호 고르기" }) : null;
    const select = si => {
      shown = detail("s", si, at, closeAll, !chips);
      box.replaceChildren(shown.node);
      if (chips) for (const c of chips.children) c.setAttribute("aria-pressed", String(Number(c.dataset.i) === si));
    };
    if (chips) for (const si of hits) chips.append(h("button", { type: "button", class: "gl-sub", dataset: { i: si }, "aria-pressed": "false", onclick: () => select(si) }, texNode(data.symbols[si].tex)));
    select(hits[0]);
    const alt = mathEl ? mathEl.getAttribute("alttext") || "" : "";
    const actions = [{
      label: "더 묻기", primary: true,
      onClick: () => (mathEl
        ? askAbout(mathEl, `$${alt}$`, "이 수식의 각 기호가 무엇을 뜻하는지 이 논문 기준으로 풀어줘", "기호 풀이", closeAll)
        : askAbout(null, `$${data.symbols[hits[0]].tex}$`, "이 기호가 이 논문에서 무엇을 뜻하고 어디에 쓰이는지 풀어줘", "기호 풀이", closeAll)),
    }];
    close = UI.peek({
      title: "기호", className: "gl-sym-peek", actions, onClose: r => maybeChip(r, "s", shown),
      // 탭한 수식은 본문 MathML 그대로 (KaTeX 없이도 정확)
      body: h("div", { class: "gl-peek" }, mathEl ? h("div", { class: "gl-math" }, UI.cloneClean(mathEl)) : null, chips, box),
    });
    return close;
  }
  function askAbout(occ, fallback, q, label, closeAll) {
    const c = contextAt(occ, fallback);
    closeAll("ask");
    App.openSheet({ quote: c.surface, selection: c.surface, context: c.context, section: c.section, autoAsk: { q, label, id: "glossary:more" } });
  }

  // ---------- 알아요 (모든 논문 공통: pr:glossary:known) ----------
  function setKnown(t, on) {
    store.update(KNOWN, arr => {
      const s = new Set((Array.isArray(arr) ? arr : []).map(normTerm));
      if (on) s.add(t._k); else s.delete(t._k);
      return [...s];
    }, []);
    repaint();
    syncRuby(true).catch(err);
    if (listRender) listRender();
    if (on) UI.toast(`'${t.t}' 밑줄을 숨겼습니다`, { actionLabel: "실행 취소", onAction: () => setKnown(t, false) });
  }

  // ---------- '용어' 목록 ----------
  let listRuby = null; // 열린 목록의 '용어 한국어 병기' 스위치
  function openList() {
    const input = h("input", { type: "search", class: "gl-q", placeholder: "용어·기호 검색 (영어·한국어)", "aria-label": "용어·기호 검색", enterkeyhint: "search" });
    const sw = h("input", { type: "checkbox", role: "switch", class: "gl-ruby-sw", checked: wantRuby, onchange: () => setRuby(sw.checked) });
    const rubyRow = h("label", { class: "gl-opt" }, sw,
      h("span", { class: "gl-opt-t" }, h("b", { text: "용어 한국어 병기" }), h("span", { class: "gl-opt-d", text: "밑줄 친 용어 위에 한국어 뜻을 작게 (알아요 제외)" })));
    const listEl = h("div", { class: "gl-items" });
    let close = null;
    const render = () => {
      if (!data) return;
      const known = knownSet(), q = input.value;
      const counts = new Map();
      for (const m of all) counts.set(m.i, (counts.get(m.i) || 0) + 1);
      const ti = searchEntries(data.terms, q, t => [t.t, ...t.a, t.ko, t.d]);
      const si = searchEntries(data.symbols, q, s => [s.tex, s.d]);
      const row = (main, side) => h("div", { class: "gl-row" }, main, side);
      const termBtn = i => {
        const t = data.terms[i];
        return h("button", { type: "button", class: "gl-item", onclick: () => openTerm(i, null, close) },
          h("span", { class: "gl-item-t" }, h("b", { text: t.t }), t.ko ? h("span", { class: "gl-item-ko", text: t.ko }) : null,
            counts.get(i) ? h("span", { class: "gl-n", text: `${counts.get(i)}회` }) : null),
          h("span", { class: "gl-item-d", text: t.d }));
      };
      const nodes = [];
      const unknownT = ti.filter(i => !known.has(data.terms[i]._k)), knownT = ti.filter(i => known.has(data.terms[i]._k));
      if (unknownT.length) nodes.push(h("h3", { text: `용어 ${unknownT.length}` }), ...unknownT.map(i => row(termBtn(i))));
      if (si.length) {
        nodes.push(h("h3", { text: `기호 ${si.length}` }), ...si.map(i => row(h("button", { type: "button", class: "gl-item", onclick: () => openSymbols([i], null, close) },
          h("span", { class: "gl-item-t" }, texNode(data.symbols[i].tex)), h("span", { class: "gl-item-d", text: data.symbols[i].d })))));
      }
      if (knownT.length) {
        nodes.push(h("h3", { text: `알고 있는 용어 ${knownT.length}` }), ...knownT.map(i => row(termBtn(i),
          h("button", { type: "button", class: "gl-unknow", text: "다시 표시", onclick: () => setKnown(data.terms[i], false) }))));
      }
      listEl.replaceChildren(...(nodes.length ? nodes : [h("p", { class: "gl-empty", text: q ? "찾는 용어가 없습니다" : "용어가 없습니다" })]));
    };
    const fail = e => listEl.replaceChildren(h("p", { class: "gl-empty", text: `불러오지 못했습니다: ${e.message || e}` }),
      h("button", { type: "button", class: "gl-retry", text: "다시 시도", onclick: () => start(true) }));
    const start = retry => {
      listEl.replaceChildren(h("p", { class: "gl-empty", text: "용어 사전을 만드는 중… (논문마다 처음 한 번)" }));
      load(retry).then(() => { render(); return ensureApplied(); }).then(render).catch(fail);
    };
    input.addEventListener("input", render);
    listRender = render;
    listRuby = sw;
    close = UI.peek({ title: "용어·기호", body: h("div", { class: "gl-list" }, input, rubyRow, listEl), size: "large", className: "gl-list-peek",
      onClose: () => { if (listRender === render) listRender = null; if (listRuby === sw) listRuby = null; } });
    if (data) { render(); ensureApplied().then(render); } else start(false);
  }

  // ---------- 루비 병기 ('용어 한국어 병기': '용어' 목록의 스위치 → pr:glossary:ruby) ----------
  // 밑줄 친 용어 위에 한국어를 작게. PaperAnchor.wrap만 사용: 감싼 <ruby>는 본문(색인 그대로), <rt>만 pr-ui.
  // 아직 스위치를 쓴 적이 없으면 pr:reading-settings.ruby(§6 모양)를 따름. 읽기 설정의 paper:settings {key: "ruby"}도
  // 받아 자기 키에 옮겨 둠 (어느 쪽에서 바꾸든 마지막 선택이 다음 논문에도)
  const RUBY = "glossary:ruby";
  const ownRuby = store.get(RUBY, null);
  let wantRuby = typeof ownRuby === "boolean" ? ownRuby : !!((store.get("reading-settings", null) || {}).ruby);
  let rubyEls = [], rubyGen = 0;
  const rubyItem = new WeakMap(); // <ruby> → 칠한 출현 (rt 탭, Highlight API 없는 브라우저의 탭)
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const liveSelection = () => { const s = document.getSelection(); return !!(s && !s.isCollapsed && s.rangeCount); };
  function clearRuby() {
    if (!rubyEls.length) return;
    const els = rubyEls;
    rubyEls = [];
    for (const w of els) w.querySelectorAll(":scope > rt").forEach(rt => rt.remove());
    A.unwrap(els);
  }
  async function syncRuby(force = false) {
    const gen = ++rubyGen;
    const stale = () => gen !== rubyGen;
    if (!wantRuby || !data) { clearRuby(); return; }
    if (rubyEls.length && !force) return;
    // 사용자가 글자를 선택하고 있으면 텍스트 노드를 옮기지 않음 (선택이 깨짐) → 풀릴 때까지 대기
    while (liveSelection()) { await sleep(800); if (stale()) return; }
    clearRuby();
    // wrap은 조용히(silent) 하고 다른 기능의 다시 칠하기(paper:dom-changed)는 몰아서: 300ms에 한 번 + 끝에 한 번
    let t0 = now(), last = t0, dirty = false;
    const flush = () => { if (dirty) { dirty = false; last = now(); A.changed(); } };
    try {
      for (const m of painted) {
        const t = data.terms[m.i];
        if (!t.ko || normTerm(t.ko) === t._k) continue;
        const els = A.wrap(m.start, m.end, () => h("ruby", { class: "gl-ruby" }), { silent: true });
        if (els.length) {
          els[els.length - 1].append(h("rt", { class: "pr-ui", text: t.ko }));
          for (const el of els) rubyItem.set(el, m);
          rubyEls.push(...els);
          dirty = true;
        }
        if (now() - t0 > 12) {
          if (now() - last > 300) flush();
          await yieldIdle();
          t0 = now();
          if (stale()) return;
          while (liveSelection()) { flush(); await sleep(800); if (stale()) return; }
        }
      }
    } finally { flush(); }
  }
  function setRuby(on) {
    wantRuby = !!on;
    store.set(RUBY, wantRuby);
    if (listRuby) listRuby.checked = wantRuby;
    if (wantRuby && !data) load().then(ensureApplied).catch(err);
    else syncRuby(true).catch(err);
  }
  App.on("settings", d => { if (d && d.key === "ruby" && !!d.value !== wantRuby) setRuby(d.value); });

  // ---------- 탭: 칠한 용어 (paintedAt), 문단 안 수식 (display 수식 표는 equation-tools 몫) ----------
  App.addTapHandler({
    id: "glossary", priority: 70,
    test: e => {
      if (!data) return null;
      // 루비로 감싼 용어: 위의 한국어(<rt>, pr-ui라 offsetAtPoint가 null)를 눌러도, Highlight API가 없어도 열림
      const rb = e.target && e.target.closest ? e.target.closest("ruby.gl-ruby") : null;
      if (rb && rubyItem.has(rb)) return { term: rubyItem.get(rb) };
      if (painted.length && hasHL()) {
        const k = A.paintedAt("gl-term", e.clientX, e.clientY);
        if (k >= 0 && painted[k]) return { term: painted[k] };
      }
      const m = e.target.closest && e.target.closest("math");
      if (m && paperEl.contains(m) && m.getAttribute("display") !== "block" && !m.closest(EQ) && symbolHits(m).length) return { math: m };
      return null;
    },
    handle: (e, hit) => (hit.term ? openTerm(hit.term.i, hit.term) : openSymbols(symbolHits(hit.math), hit.math)),
  });

  // 다른 기능용 (smart-presets '뜻' 등): 불러온 목록에서 찾기, 없으면 null
  function lookup(term) {
    if (!data || !term) return null;
    const k = normTerm(term), cands = new Set([k, k.replace(/s$/, ""), k.replace(/es$/, "")].filter(Boolean));
    const t = data.terms.find(x => [x.t, ...x.a, x.ko].some(f => cands.has(normTerm(f))));
    if (t) return { term: t.t, t: t.t, a: t.a.slice(), ko: t.ko, d: t.d, q: t.q, defs: t.defs.map(({ d, q }) => ({ d, q })) };
    const n = normTex(term), s = data.symbols.find(x => x._n === n);
    return s ? { term: s.tex, tex: s.tex, d: s.d, q: s.q, defs: s.defs.map(({ d, q }) => ({ d, q })) } : null;
  }

  App.registerFeature("glossary", { ...api, lookup });
  UI.addBarButton({ id: "glossary", label: "용어", title: "용어·기호 사전", onClick: openList });
  // 미리 불러와 밑줄 (백그라운드: 한 번에 하나, 답변 스트리밍 중엔 대기)
  App.idle(() => load().then(ensureApplied)).catch(() => { /* 상태 칩이 '다시'를 보여 줌 */ });
})();
