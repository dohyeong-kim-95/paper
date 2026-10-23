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

  const api = {
    FACETS, MAX_ITEMS, EXPLAIN, cleanItem, parseLine, makeParser, filterByDensity, countByFacet, groupBySection,
    normSettings, densityLabel, nextAfter,
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
  let loading = null, painted = {}, paintQueued = false, legend = null, tellWhenReady = false, chip = false;

  const save = () => store.set(KEY, settings);
  const located = () => items.filter(it => it.start != null);
  const visible = () => filterByDensity(located(), settings);
  const startEl = r => (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement);

  // 인용 → 본문 위치·섹션. 같은 자리를 두 번 칠하지 않음
  function place(it) {
    const o = A.locate(it.q);
    if (!o || items.some(x => x.start === o.start)) return { ...it, start: null, end: null };
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

  const btn = UI.addBarButton({ id: KEY, label: "핵심 문장", onClick: () => setOn(!settings.on) });
  btn.setActive(settings.on);
  const updateDot = () => btn.setDot(state === "ready" && !settings.on && located().length > 0);
  const refreshLegend = () => legend && legend();

  function announce() {
    const n = visible().length;
    UI.toast(n ? `핵심 문장 ${n}개 표시` : "조건에 맞는 핵심 문장이 없습니다", { actionLabel: "목록", onAction: openLegend });
  }

  function setOn(on, { quiet = false } = {}) {
    settings.on = !!on;
    save();
    btn.setActive(settings.on);
    updateDot();
    paintNow();
    refreshLegend();
    if (!settings.on) { if (!quiet) UI.toast("핵심 문장 표시를 껐습니다"); return; }
    if (state === "ready") { if (!quiet) announce(); return; }
    // 아직 없으면 바로 받기 시작 (사용자 동작이므로 idle을 기다리지 않음), 도착하는 대로 칠함
    tellWhenReady = !quiet;
    if (!quiet) UI.toast("핵심 문장을 찾는 중…");
    ensureLoad(state === "error");
  }

  function add(list) {
    if (!list.length) return;
    for (const it of list) items.push(place(it));
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
    paintNow(); // 다시 받기: 이전 일부 결과 지움
    refreshLegend();
    // 캐시 적중(바로 끝남)이면 상태 칩을 띄우지 않음
    const t = setTimeout(() => { chip = true; UI.status(KEY, "핵심 문장", "loading"); }, 400);
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
      chip = true;
      UI.status(KEY, "핵심 문장", "error", { onRetry: () => ensureLoad(true) });
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
      note.replaceChildren(h("span", { text: msg }),
        state === "error" ? h("button", { type: "button", text: "다시", onclick: () => ensureLoad(true) }) : null);
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
