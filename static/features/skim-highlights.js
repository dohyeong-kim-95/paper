// skim-highlights: 핵심 문장 자동 하이라이트 (목표·새로움·방법·결과·한계 색 구분, 밀도 조절, 섹션별 목록)
(function () {
  "use strict";
  // ---------- 순수 함수 (node 테스트 대상) ----------
  const FACETS = [
    { id: "goal", label: "목표" },
    { id: "novelty", label: "새로움" },
    { id: "method", label: "방법" },
    { id: "result", label: "결과" },
    { id: "limit", label: "한계" },
  ];
  const FACET_IDS = FACETS.map(f => f.id);
  const LABEL = Object.fromEntries(FACETS.map(f => [f.id, f.label]));
  const ALIASES = {
    objective: "goal", aim: "goal", contribution: "novelty", novel: "novelty", methods: "method", approach: "method",
    results: "result", findings: "result", limitation: "limit", limitations: "limit",
  };
  const MAX_ITEMS = 30;
  const ERROR_TAIL = /\n\n\[오류\][^\n]*$/;
  // 밀도 슬라이더 (오른쪽일수록 많이): 슬라이더 값 v = 4 - 최소 중요도
  const DENSITY = { 1: "적게", 2: "보통", 3: "많이" };
  // 문장을 눌러 '설명'할 때 역할별 질문
  const EXPLAIN = {
    goal: "이 문장이 말하는 연구 목표(풀려는 문제)를 쉽게 설명해줘",
    novelty: "이 문장에서 새로운 점이 무엇이고 기존 방법과 어떻게 다른지 쉽게 설명해줘",
    method: "이 문장이 설명하는 방법이 어떻게 동작하는지 쉽게 설명해줘",
    result: "이 결과가 무엇을 뜻하고 얼마나 의미 있는지 쉽게 설명해줘",
    limit: "이 한계가 무엇이고 왜 중요한지 쉽게 설명해줘",
  };

  // 한 항목 검증 (서버와 같은 규칙): 모르는 역할·3단어 미만 인용은 버림, 중요도는 1~3
  function cleanItem(o) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    let f = String(o.f || o.facet || "").trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(ALIASES, f)) f = ALIASES[f];
    const raw = o.q || o.quote;
    const q = (typeof raw === "string" ? raw : "").replace(/\s+/g, " ").replace(/^(\.\.\.|…)\s*|\s*(\.\.\.|…)$/g, "").trim();
    if (!FACET_IDS.includes(f) || q.split(" ").filter(Boolean).length < 3) return null;
    let s = parseInt(o.s, 10);
    if (Number.isNaN(s)) s = 2;
    return { f, q: q.slice(0, 400), s: Math.min(3, Math.max(1, s)) };
  }

  const itemsOf = v => (Array.isArray(v) ? v : v && typeof v === "object" ? (Array.isArray(v.items) ? v.items : [v]) : []);
  // JSONL 한 줄 → 항목들 (펜스·쉼표·대괄호가 붙거나 {"items": [...]} 통째여도)
  function parseLine(line) {
    const s = String(line || ""), i = s.indexOf("{"), j = s.lastIndexOf("}");
    if (i < 0 || j <= i) return [];
    const raw = s.slice(i, j + 1);
    for (const cand of [raw, `[${raw}]`]) {
      try { return itemsOf(JSON.parse(cand)).map(cleanItem).filter(Boolean); } catch { /* 다음 후보 */ }
    }
    return [];
  }

  // 스트림 파서: push(조각) → 새로 완성된 항목들, end() → {items, error('[오류] …' 줄 | null)}. 같은 인용은 한 번만, 최대 30
  function makeParser() {
    let buf = "", all = "";
    const seen = new Set();
    const take = lines => {
      const out = [];
      for (const line of lines) {
        for (const it of parseLine(line)) {
          const k = it.q.toLowerCase();
          if (seen.has(k) || seen.size >= MAX_ITEMS) continue;
          seen.add(k);
          out.push(it);
        }
      }
      return out;
    };
    return {
      push(text) {
        all += text;
        const parts = (buf + text).split("\n");
        buf = parts.pop();
        return take(parts);
      },
      end(text = "") {
        all += text;
        const items = take((buf + text).split("\n"));
        buf = "";
        const m = all.match(ERROR_TAIL);
        return { items, error: m ? m[0].trim() : null };
      },
    };
  }

  // 켠 역할(facets: {goal: false, …} 또는 켠 id 배열)이면서 중요도 minScore 이상인 항목
  function filterByDensity(items, { facets, minScore = 1 } = {}) {
    const on = f => (Array.isArray(facets) ? facets.includes(f) : !facets || facets[f] !== false);
    const min = Number(minScore) || 1;
    return (items || []).filter(it => it && on(it.f) && (Number(it.s) || 0) >= min);
  }

  function countByFacet(items) {
    const out = Object.fromEntries(FACET_IDS.map(f => [f, 0]));
    for (const it of items || []) if (it && it.f in out) out[it.f]++;
    return out;
  }

  // 본문 순서(start)로 정렬해 이어지는 같은 섹션끼리 묶음: [{key, title, items}]. 위치 없는 항목은 뺌
  function groupBySection(items) {
    const groups = [];
    const sorted = (items || []).filter(it => it && it.start != null).sort((a, b) => a.start - b.start);
    for (const it of sorted) {
      const key = it.secId || it.sec || "";
      const g = groups[groups.length - 1];
      if (g && g.key === key) g.items.push(it);
      else groups.push({ key, title: it.sec || "", items: [it] });
    }
    return groups;
  }

  // pr:skim-highlights {on, facets, minScore} 기본값 채우기 (기본: 꺼짐, 모든 역할, 중요도 1 이상)
  function normSettings(raw) {
    const r = raw && typeof raw === "object" ? raw : {};
    const facets = {};
    for (const f of FACET_IDS) facets[f] = !(r.facets && r.facets[f] === false);
    const m = Math.round(Number(r.minScore));
    return { on: r.on === true, facets, minScore: m >= 1 && m <= 3 ? m : 1 };
  }

  const densityLabel = minScore => `${DENSITY[4 - minScore] || DENSITY[3]} · ★${minScore} 이상`;

  // offset 뒤의 첫 항목 (다음 핵심 문장으로)
  function nextAfter(items, offset) {
    let best = null;
    for (const it of items || []) if (it && it.start != null && it.start > offset && (!best || it.start < best.start)) best = it;
    return best;
  }

  // 인용이 들어갈 본문 자리. 모델은 논문 순서로 쓰므로 from(앞 항목 자리)부터 먼저 찾고, 없으면 처음부터
  // (초록 문장이 서론·결론에 그대로 되풀이돼도 제자리에). 이미 칠한 자리(taken [{start, end}])와 겹치면 다음 등장 위치로.
  // locateFrom(q, from) → {start, end} | null. 반환: {start, end} | "dup"(본문에 있지만 모두 이미 칠한 자리) | null(못 찾음)
  function findSpot(locateFrom, q, from, taken) {
    let found = false;
    for (const lo of from > 0 ? [from, 0] : [0]) {
      for (let at = lo, n = 0; n < 50; n++) {
        const o = locateFrom(q, at);
        if (!o) break;
        found = true;
        if (!(taken || []).some(x => x.start < o.end && o.start < x.end)) return o;
        at = o.start + 1;
      }
    }
    return found ? "dup" : null;
  }

  const api = {
    FACETS, MAX_ITEMS, EXPLAIN, cleanItem, parseLine, makeParser, filterByDensity, countByFacet, groupBySection,
    normSettings, densityLabel, nextAfter, findSpot,
  };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;
  if (document.body.dataset.page !== "paper") return;
  PaperApp.registerFeature("skim-highlights", api);

  // ---------- DOM ----------
  const UI = window.PaperUI, A = window.PaperAnchor, store = window.PaperStore, h = UI.h;
  const KEY = "skim-highlights";
  const url = `/api/skim-highlights/${encodeURIComponent(PaperApp.arxivId)}`;
  const hasHL = () => typeof CSS !== "undefined" && !!CSS.highlights && typeof Highlight !== "undefined";
  let settings = normSettings(store.get(KEY, null));
  let items = []; // 도착한 문장 {f, q, s, start, end, one, secId, sec} (start null = 본문에서 못 찾음)
  let state = "idle"; // idle | loading | ready | error
  let loading = null, painted = {}, paintQueued = false, legend = null, tellWhenReady = false;
  let chip = false, slow = false, lastStart = 0, toastH = null;

  const save = () => store.set(KEY, settings);
  const located = () => items.filter(it => it.start != null);
  const visible = () => filterByDensity(located(), settings);
  const startEl = r => (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement);

  // 색인 텍스트의 normMap은 텍스트가 같으면 다시 계산하지 않음 (문장마다 locateIn에 넘김)
  let nmText = null, nmVal = null;
  const nmFor = text => (nmText === text ? nmVal : (nmText = text, nmVal = A.normMap(text)));

  // 인용 → 본문 위치·섹션 (findSpot: 앞 항목 다음부터, 이미 칠한 자리는 피함). null = 못 찾음, "dup" = 이미 칠한 자리뿐
  function place(it) {
    const idx = A.index(), nm = nmFor(idx.text);
    const o = findSpot((q, from) => A.locateIn(idx.text, q, { from, nm }), it.q, lastStart, located());
    if (o === "dup") return null;
    if (!o) return { ...it, start: null, end: null };
    lastStart = o.start;
    const r = A.rangeAt(o.start, o.end), el = r && startEl(r);
    const sec = el && el.closest("section");
    const title = sec && [...sec.children].find(c => c.classList.contains("ltx_title"));
    return {
      ...it, start: o.start, end: o.end,
      one: !!r && r.startContainer === r.endContainer && r.startContainer.nodeType === 3, // 텍스트 노드 하나 안
      secId: sec ? sec.id : "", sec: title ? A.textOf(title) : el && el.closest(".ltx_abstract") ? "초록" : "",
    };
  }

  // 역할마다 Highlight 하나 (::highlight(sk-<facet>)). Highlight API가 없으면 <mark> 대체는 텍스트 노드 하나 안의
  // 문장만 (링크·수식에 걸친 문장은 DOM을 쪼개지 않게 건너뜀). painted[f]의 순서 = paintedAt 번호
  function paintNow() {
    paintQueued = false;
    painted = {};
    const vis = settings.on ? visible() : [];
    const hl = hasHL();
    for (const f of FACET_IDS) {
      const list = vis.filter(it => it.f === f && (hl || it.one));
      if (list.length) {
        A.paint(`sk-${f}`, list.map(it => ({ start: it.start, end: it.end })), { priority: 20 });
        painted[f] = list;
      } else A.clear(`sk-${f}`);
    }
  }
  function schedulePaint() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(paintNow);
  }

  // 메뉴 '핵심 문장': 꺼져 있으면 켬(칠하고 '목록' 토스트), 켜져 있으면 목록 peek (끄기 스위치·역할·밀도가 거기에)
  const btn = UI.addBarButton({ id: KEY, label: "핵심 문장", onClick: () => (settings.on ? openLegend() : setOn(true)) });
  btn.setActive(settings.on);
  const updateDot = () => btn.setDot(state === "ready" && !settings.on && located().length > 0);
  const refreshLegend = () => legend && legend();

  // '목록' 버튼이 있는 토스트는 다른 토스트를 뒤에 줄 세우므로, 끄거나 peek를 열 때 직접 닫음
  const dropToast = () => { if (toastH) toastH.close(); toastH = null; };
  function announce() {
    dropToast();
    const n = visible().length;
    toastH = UI.toast(n ? `핵심 문장 ${n}개 표시` : "조건에 맞는 핵심 문장이 없습니다", { actionLabel: "목록", onAction: openLegend });
  }

  // 상태 칩은 형광펜을 켠 사용자에게만 (꺼 둔 채 유휴 시간에 미리 받는 건 조용히: 느려도·실패해도 띠에 띄우지 않음)
  function syncStatus() {
    if (settings.on && state === "loading" && slow) { chip = true; UI.status(KEY, "핵심 문장", "loading"); }
    else if (settings.on && state === "error") { chip = true; UI.status(KEY, "핵심 문장", "error", { onRetry: () => ensureLoad(true) }); }
    else if (chip && state !== "ready") { chip = false; UI.status(KEY, "핵심 문장", null); }
  }

  function setOn(on, { quiet = false } = {}) {
    settings.on = !!on;
    save();
    btn.setActive(settings.on);
    updateDot();
    paintNow();
    refreshLegend();
    if (!settings.on) { // 끄기는 목록 peek의 스위치에서 (스위치가 상태를 보여 주므로 토스트 없음)
      tellWhenReady = false;
      syncStatus();
      dropToast();
      return;
    }
    if (state === "ready") { if (!quiet) announce(); return; }
    // 아직 없으면 바로 받기 시작 (사용자 동작이므로 idle을 기다리지 않음, 실패했었으면 다시 생성), 도착하는 대로 칠함
    tellWhenReady = !quiet;
    if (!quiet) UI.toast("핵심 문장을 찾는 중…");
    syncStatus();
    ensureLoad(state === "error");
  }

  function add(list) {
    let n = 0;
    for (const it of list) {
      const p = place(it);
      if (p) { items.push(p); n++; } // 이미 칠한 자리와 같은 문장은 버림 (못 찾은 문장으로 세지 않음)
    }
    if (!n) return;
    if (settings.on) schedulePaint();
    refreshLegend();
  }

  function ensureLoad(retry = false) {
    if (!loading && (state !== "ready" || retry)) loading = load(retry).finally(() => { loading = null; });
    return loading || Promise.resolve();
  }

  async function load(retry) {
    state = "loading";
    items = [];
    lastStart = 0;
    paintNow(); // 다시 받기: 이전 일부 결과 지움
    refreshLegend();
    // 칩이 떠 있으면('다시') 바로 '…'로, 아니면 400ms 뒤에 (캐시 적중처럼 바로 끝나면 띄우지 않음)
    slow = chip;
    syncStatus();
    const t = setTimeout(() => { slow = true; syncStatus(); }, 400);
    let error = null;
    try {
      const res = await fetch(retry ? `${url}?retry=1` : url);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader(), dec = new TextDecoder(), p = makeParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        add(p.push(dec.decode(value, { stream: true })));
      }
      const end = p.end(dec.decode());
      add(end.items);
      error = end.error;
    } catch (e) {
      error = String((e && e.message) || e);
    }
    clearTimeout(t);
    state = error ? "error" : "ready";
    if (error) {
      syncStatus(); // 꺼 둔 채 미리 받다 실패하면 조용히: 켤 때·목록의 '다시'가 다시 시도
      if (tellWhenReady) UI.toast("핵심 문장을 불러오지 못했습니다");
    } else {
      PaperApp.addOfflineUrl(url);
      if (chip) UI.status(KEY, "핵심 문장", "ready");
      chip = false;
      if (tellWhenReady && settings.on) announce();
    }
    tellWhenReady = false;
    updateDot();
    refreshLegend();
  }

  // ---------- 칠한 문장 탭 → 작은 peek (설명 · 번역 · 내 하이라이트로 저장 · 다음 · 목록) ----------
  PaperApp.addTapHandler({
    id: KEY, priority: 30,
    test: e => {
      if (!settings.on) return null;
      for (const f of FACET_IDS) {
        const i = painted[f] ? A.paintedAt(`sk-${f}`, e.clientX, e.clientY) : -1;
        if (i >= 0 && painted[f][i]) return painted[f][i];
      }
      return null;
    },
    handle: (e, it) => openSentence(it),
  });

  // 문장이 든 문단 (짧은 목록 항목이면 바깥 문단까지, app.js 선택과 같은 규칙)
  function where(it) {
    const range = A.rangeAt(it.start, it.end), el = range && startEl(range);
    let para = el && el.closest(".ltx_para, .ltx_abstract, figcaption, li, p");
    const outer = para && para.parentElement && para.parentElement.closest(".ltx_para");
    if (outer && A.textOf(para).length < 200) para = outer;
    const idEl = para && (para.id ? para : para.closest("[id]"));
    return { range, para: para || null, paraId: idEl ? idEl.id : null };
  }

  function sheetOpts(it) {
    const { range, para, paraId } = where(it);
    const context = para ? A.clipAround(A.textOf(para), it.q, 1500) : "";
    const selInfo = {
      ...PaperApp.selInfoFromText(it.q), raw: it.q, range, anchored: true, start: it.start, end: it.end,
      prefix: "", suffix: "", inTranslation: false, paragraphEl: para, paraId,
      sectionEl: it.secId ? document.getElementById(it.secId) : null, sectionId: it.secId || null,
      sectionTitle: it.sec || "", context,
    };
    return { quote: it.q, selection: it.q, context, section: it.sec || "", selInfo, title: `핵심 문장 · ${LABEL[it.f]}` };
  }

  function explain(it) {
    PaperApp.openSheet({ ...sheetOpts(it), autoAsk: { q: EXPLAIN[it.f], label: "설명", id: `${KEY}:explain` } });
  }

  function translate(it) {
    const s = PaperApp.openSheet(sheetOpts(it));
    if (!s) return;
    const p = PaperApp.presets().find(x => x.id === "translate"); // smart-presets가 바꿨을 수 있음
    let q = p && p.q;
    try { if (typeof q === "function") q = q(s.selInfo, s); } catch { q = null; }
    PaperApp.ask(typeof q === "string" && q ? q : "한국어로 번역해줘", { label: "번역", presetId: "translate" });
  }

  function saveMine(it) {
    const { range, paraId } = where(it);
    const qt = range && A.rangeToQuote(range);
    const id = qt && qt.quote
      ? PaperApp.feature("highlights-notes")?.add?.({ anchor: { quote: qt.quote, prefix: qt.prefix, suffix: qt.suffix, paraId }, source: KEY })
      : null;
    if (!id) UI.toast("내 하이라이트로 저장하지 못했습니다"); // 성공하면 highlights-notes가 실행 취소 토스트를 띄움
  }

  const stars = s => "★".repeat(s) + "☆".repeat(3 - s);
  const jumpTo = (it, opts) => PaperNav.jumpTo({ start: it.start, end: it.end }, opts);

  function openSentence(it) {
    dropToast();
    const actions = [
      { label: "설명", primary: true, onClick: ({ close }) => { close(); explain(it); } },
      { label: "번역", onClick: ({ close }) => { close(); translate(it); } },
    ];
    if (PaperApp.has("highlights-notes")) {
      actions.push({ label: "내 하이라이트로 저장", onClick: ({ close }) => { close(); saveMine(it); } });
    }
    const nx = nextAfter(visible(), it.start);
    // 연달아 '다음'으로 넘겨도 돌아가기는 처음 자리 하나만
    if (nx) actions.push({ label: "다음 ↓", onClick: ({ close }) => { close(); jumpTo(nx, { back: !PaperNav.depth }); } });
    actions.push({ label: "목록", onClick: ({ close }) => { close(); openLegend(); } });
    UI.peek({
      title: `${LABEL[it.f]} · ${stars(it.s)}`,
      className: "sk-peek",
      body: h("div", { class: "sk-one", dataset: { sk: it.f } },
        h("blockquote", { class: "sk-quote", text: it.q }),
        h("div", { class: "sk-meta" }, h("span", { text: it.sec || "" }),
          UI.feedback("skim", it.q.slice(0, 200), { label: it.f }))),
      actions,
    });
  }

  // ---------- 목록 peek: 표시 켜기/끄기, 역할 칩(개수·토글), 밀도 슬라이더, 섹션별 핵심 문장 목록 ----------
  function openLegend() {
    dropToast();
    if (legend) return;
    const sw = h("button", { type: "button", class: "sk-switch", onclick: () => setOn(!settings.on, { quiet: true }) });
    const chips = h("div", { class: "sk-chips", role: "group", "aria-label": "역할별 표시" });
    const slider = h("input", { type: "range", min: "1", max: "3", step: "1", value: String(4 - settings.minScore), "aria-label": "밀도" });
    const dens = h("span", { class: "sk-dens-val" });
    const note = h("div", { class: "sk-note" });
    const list = h("div", { class: "sk-list" });
    slider.addEventListener("input", () => {
      settings.minScore = 4 - Number(slider.value);
      save();
      paintNow();
      render();
    });
    const body = h("div", { class: "sk-legend" }, sw, chips,
      h("label", { class: "sk-density" }, h("span", { text: "밀도" }), slider, dens), note, list,
      h("div", { class: "sk-foot" }, h("span", { text: "목록이 도움이 됐나요?" }), UI.feedback("skim", "list")));

    function render() {
      sw.textContent = settings.on ? "형광펜 켜짐" : "형광펜 꺼짐";
      sw.setAttribute("aria-pressed", String(settings.on));
      const placed = located();
      const counts = countByFacet(filterByDensity(placed, { minScore: settings.minScore }));
      chips.replaceChildren(...FACETS.map(f => h("button", {
        type: "button", class: "sk-chip", dataset: { sk: f.id }, "aria-pressed": String(settings.facets[f.id]),
        onclick: () => { settings.facets[f.id] = !settings.facets[f.id]; save(); paintNow(); render(); },
      }, h("span", { class: "sk-sw", "aria-hidden": "true" }), `${f.label} ${counts[f.id]}`)));
      dens.textContent = densityLabel(settings.minScore);
      const vis = filterByDensity(placed, settings), lost = items.length - placed.length;
      const msg = state === "loading" ? `찾는 중… (${placed.length}개)`
        : state === "error" ? "불러오지 못했습니다"
          : !vis.length ? "조건에 맞는 문장이 없습니다. 밀도를 높이거나 역할을 켜 보세요."
            : `${vis.length}개 · 누르면 그 위치로 이동${lost ? ` (본문에서 못 찾은 ${lost}개 제외)` : ""}`;
      note.replaceChildren(h("span", { text: msg }));
      if (state === "error") note.append(h("button", { type: "button", text: "다시", onclick: () => ensureLoad(true) }));
      list.replaceChildren(...groupBySection(vis).map(g => h("section", { class: "sk-group" },
        h("h4", { text: g.title || "본문" }),
        ...g.items.map(it => h("button", { type: "button", class: "sk-item", dataset: { sk: it.f }, onclick: () => { close(); jumpTo(it); } },
          h("span", { class: "sk-sw", "aria-hidden": "true" }),
          h("span", { class: "sk-q", text: it.q }),
          h("span", { class: "sk-stars", "aria-label": `중요도 ${it.s}`, text: "★".repeat(it.s) }))))));
    }

    const close = UI.peek({ title: "핵심 문장", body, size: "large", className: "sk-legend-peek", onClose: () => { legend = null; } });
    legend = render;
    render();
  }

  // ---------- 시작: 미리 받아 둠 (켜 둔 사용자는 프리웜 직후 바로, 아니면 유휴 시간에) ----------
  if (settings.on) PaperApp.warm.then(() => ensureLoad());
  else PaperApp.idle(() => ensureLoad()).catch(() => {});
})();
