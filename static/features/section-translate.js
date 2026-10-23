// section-translate: 스크롤 따라 단락 번역 (원문 → 둘다 → 번역), 수식·인용 보존, 한국어 문장 탭 → 영어 원문 대응
(function () {
  "use strict";
  // ---------- 순수 함수 (node 테스트 대상) ----------
  const MODES = ["orig", "both", "ko"];
  const MODE_TOAST = { orig: "원문 보기", both: "원문과 번역 함께 보기", ko: "번역만 보기 (원문 숨김)" };
  const PH_RE = /⟦(\d+)⟧/g;
  const cp = (a, b) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`;
  const HANGUL_RE = new RegExp(`[${cp(0xac00, 0xd7a3)}${cp(0x1100, 0x11ff)}${cp(0x3130, 0x318f)}]`, "g"); // 한글 음절·자모·호환 자모 (서버와 같음)
  const nextMode = m => MODES[(MODES.indexOf(m) + 1) % MODES.length];

  // "a ⟦0⟧ b" + [node] → ["a ", node, " b"]. 없는 번호는 뺌 (문자열 단계: DOM 없이 테스트)
  function restorePlaceholders(text, items) {
    const s = String(text ?? ""), out = [];
    let last = 0;
    for (const m of s.matchAll(PH_RE)) {
      if (m.index > last) out.push(s.slice(last, m.index));
      const it = items[Number(m[1])];
      if (it != null) out.push(it);
      last = m.index + m[0].length;
    }
    if (last < s.length) out.push(s.slice(last));
    return out;
  }

  // 모든 ⟦0..n-1⟧이 (문장 전체에서) 정확히 한 번씩, 범위 밖 번호 없음
  function checkPlaceholders(texts, n) {
    const seen = new Array(n).fill(0);
    for (const t of texts) {
      for (const m of String(t ?? "").matchAll(PH_RE)) {
        const i = Number(m[1]);
        if (i >= n) return false;
        seen[i]++;
      }
    }
    return seen.every(c => c === 1);
  }

  // 자리표시 → 글자 (번역 쌍·목차 제목·원문 문장 찾기용). 수식은 $tex$, 번호 뒤에는 공백
  function phText(text, ph = []) {
    return String(text ?? "").replace(PH_RE, (_, i) => {
      const p = ph[Number(i)];
      if (!p) return "";
      if (p.k === "math") return ` $${p.tex || ""}$ `;
      if (p.k === "eq" || p.k === "img") return " ";
      return p.k === "tag" ? `${p.text || ""} ` : p.text || "";
    }).replace(/\s+/g, " ").trim();
  }

  // 서버 should_skip과 같은 규칙: 글자 없음 / 한글 비율 0.3 초과 / 단어(2글자 이상) 부족
  function shouldSkip(text, kind) {
    const plain = String(text ?? "").replace(PH_RE, " ");
    const letters = (plain.match(/\p{L}/gu) || []).length;
    if (!letters) return true;
    if ((plain.match(HANGUL_RE) || []).length / letters > 0.3) return true;
    return (plain.match(/\p{L}{2,}/gu) || []).length < (kind === "title" || kind === "cap" ? 1 : 3);
  }

  // 서버 fingerprint와 같음: 같은 단위를 가리키는지 확인
  const fingerprint = text => String(text ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32);

  // FNV-1a 32bit (IndexedDB 키의 본문 해시)
  function hashText(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, "0");
  }

  // 가까운 것부터 maxUnits개·maxChars자까지 (첫 단위는 길어도 넣음). items: [{d, len, ...}]
  function planBatch(items, maxUnits = 6, maxChars = 2500) {
    const out = [];
    let chars = 0;
    for (const it of items.slice().sort((a, b) => a.d - b.d)) {
      if (out.length >= maxUnits) break;
      if (out.length && chars + it.len > maxChars) continue;
      out.push(it);
      chars += it.len;
    }
    return out;
  }

  const api = { MODES, nextMode, restorePlaceholders, checkPlaceholders, phText, shouldSkip, fingerprint, hashText, planBatch };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;
  if (document.body.dataset.page !== "paper") return;
  PaperApp.registerFeature("section-translate", api);

  // ---------- DOM ----------
  const UI = window.PaperUI, A = window.PaperAnchor, App = window.PaperApp, store = window.PaperStore, h = UI.h;
  const paper = A.root();
  if (!paper) return;
  const MODE_KEY = "section-translate:mode";
  const ENDPOINT = `/api/section-translate/${encodeURIComponent(App.arxivId)}`;
  const MAX_UNITS = 6, MAX_CHARS = 2500, MAX_CHARS_NEAR = 1200, MAX_TITLES = 40;
  const saved = store.get(MODE_KEY, "orig");
  let mode = MODES.includes(saved) ? saved : "orig";

  let units = null; // [{id, kind, el, src, len, h, fp, state, ko, chip, revealed, solo}]
  const byId = new Map(), unitOfEl = new WeakMap(), koOf = new WeakMap();
  const recs = new Map(); // 단위 id → {s: [[en, ko]], ph} | {skip: true} (지금 본문과 해시가 같은 것만)
  const wanted = new Set();
  let io = null, inflight = 0, pumpTimer = 0, cacheLoad = null, active = null;

  // 번역 단위 모으기: 서버 features/section_translate.py collect_units와 같은 규칙·번호
  function collectUnits() {
    if (units) return units;
    units = [];
    const add = (id, kind, el) => {
      if (byId.has(id)) return;
      const src = scan(el).text;
      const u = { id, kind, el, src, len: src.length, h: hashText(src), fp: fingerprint(A.textOf(el)), state: "" };
      units.push(u);
      byId.set(id, u);
      unitOfEl.set(el, u);
    };
    const ours = el => el.closest(".pr-ui, .tr-ko");
    for (const t of paper.querySelectorAll(".ltx_title")) {
      if (ours(t) || t.closest(".ltx_bibliography, .ltx_note")) continue;
      const c = t.classList, parent = t.parentElement;
      const id = c.contains("ltx_title_document") ? "doc.title" : c.contains("ltx_title_abstract") ? "abs.title"
        : parent && parent.id ? `${parent.id}.title` : null;
      if (id) add(id, "title", t);
    }
    let absN = 0;
    const paraN = new Map();
    for (const p of paper.querySelectorAll("p.ltx_p")) {
      if (ours(p) || (p.parentElement && p.parentElement.closest("p, td, th, .ltx_bibliography, .ltx_note"))) continue;
      if (p.closest(".ltx_abstract")) { add(`abs.${absN++}`, "p", p); continue; }
      const para = p.closest(".ltx_para[id]");
      if (!para) continue;
      const n = paraN.get(para.id) || 0;
      paraN.set(para.id, n + 1);
      add(`${para.id}#${n}`, "p", p);
    }
    const capN = new Map();
    for (const c of paper.querySelectorAll("figcaption")) {
      const fig = c.parentElement;
      if (!fig || fig.localName !== "figure" || !fig.id || ours(c) || c.closest(".ltx_bibliography")) continue;
      const n = capN.get(fig.id) || 0;
      capN.set(fig.id, n + 1);
      add(`${fig.id}.cap${n || ""}`, "cap", c);
    }
    for (const c of paper.querySelectorAll(".ltx_note_content")) {
      const note = c.closest(".ltx_note");
      if (!note || !note.id || c.closest(".ltx_bibliography")) continue;
      add(`${note.id}.note`, "note", c);
    }
    return units;
  }

  // 자리표시가 될 노드 (서버 unit_source와 같은 순서·종류)
  function atomKind(n) {
    const c = n.classList;
    if (n.localName === "math") return "math";
    if (n.localName === "table" && (c.contains("ltx_equation") || c.contains("ltx_equationgroup"))) return "eq";
    if (c.contains("ltx_note")) return "note";
    if (n.localName === "cite") return "cite";
    if (n.localName === "a" && c.contains("ltx_ref")) return "ref";
    if (c.contains("ltx_tag") || c.contains("ltx_note_mark")) return "tag";
    if (n.localName === "img") return "img";
    return null;
  }
  const SCAN_SKIP = ".pr-ui, .tr-ko, .ltx_note_outer, script, style, button";
  function scan(el) {
    const parts = [], atoms = [];
    const visit = node => {
      for (let n = node.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) { parts.push(n.data); continue; }
        if (n.nodeType !== 1) continue;
        const k = atomKind(n);
        if (k) { parts.push(`⟦${atoms.length}⟧`); atoms.push({ k, el: n }); continue; }
        if (!n.matches(SCAN_SKIP)) visit(n);
      }
    };
    visit(el);
    return { text: parts.join("").replace(/\s+/g, " ").trim(), atoms };
  }
  // 자리표시의 짝: 순서가 아니라 내용(alttext·href·id·글자)으로 찾음 (파서 차이로 순서가 달라도 엉뚱한 수식이 안 들어가게)
  function atomKey(k, x, isPh) {
    if (k === "math") return isPh ? x.tex || "" : x.getAttribute("alttext") || "";
    if (k === "eq" || k === "note") return isPh ? x.id || "" : x.id;
    if (k === "ref") return isPh ? x.href || "" : x.getAttribute("href") || "";
    if (k === "img") return isPh ? x.src || "" : x.getAttribute("src") || "";
    return A.normalize(isPh ? x.text || "" : A.textOf(x));
  }
  function resolveAtoms(u, ph) {
    const atoms = scan(u.el).atoms.map(a => ({ ...a, key: atomKey(a.k, a.el, false), used: false }));
    return ph.map(p => {
      const key = atomKey(p.k, p, true);
      const a = atoms.find(x => !x.used && x.k === p.k && x.key === key);
      if (a) a.used = true;
      return a ? a.el : null;
    });
  }
  // 본문에서 못 찾은 자리표시의 대체 노드 (수식은 KaTeX, 없으면 $tex$)
  function fallbackAtom(p) {
    if (p.k === "math") {
      const s = h("span", { class: "tr-math" });
      try {
        if (window.katex) { window.katex.render(p.tex || "", s, { throwOnError: false }); return s; }
      } catch { /* 아래 글자로 */ }
      s.textContent = `$${p.tex || ""}$`;
      return s;
    }
    if (p.k === "ref" && /^(#|https?:\/\/)/.test(p.href || "")) return h("a", { class: "ltx_ref", href: p.href, text: p.text || p.href });
    if (p.k === "eq") { const t = p.id && document.getElementById(p.id); return t ? UI.cloneClean(t) : null; }
    return h("span", { text: p.k === "img" ? "" : p.text || "" });
  }
  function fill(el, text, ph, srcs) {
    for (const part of restorePlaceholders(text, ph.map((_, i) => i))) {
      if (typeof part === "string") el.append(part);
      else {
        const node = srcs[part] ? UI.cloneClean(srcs[part]) : fallbackAtom(ph[part]);
        if (node) el.append(node);
      }
    }
    return el;
  }
  function buildKo(u, rec) {
    const srcs = resolveAtoms(u, rec.ph);
    const tag = u.kind === "title" ? u.el.localName : u.kind === "note" ? "span" : "div";
    const ko = h(tag, { class: `tr-ko tr-${u.kind}`, lang: "ko", dataset: { unit: u.id } });
    rec.s.forEach((pair, i) => {
      if (i) ko.append(" ");
      ko.append(fill(h("span", { class: "tr-s", dataset: { i } }), pair[1], rec.ph, srcs));
    });
    return ko;
  }

  // ---------- 화면 위치 유지: 뷰포트 위쪽에서 높이가 바뀌어도 읽던 곳이 밀리지 않게 (iOS는 scroll anchoring 없음) ----------
  function unitAt(el) {
    for (let e = el; e && e !== paper; e = e.parentElement) {
      const u = unitOfEl.get(e) || (e.classList.contains("tr-ko") && koOf.get(e));
      if (u) return u;
    }
    return null;
  }
  const shown = el => !!el && el.isConnected && el.getClientRects().length > 0;
  function keepPlace(fn) {
    const top = (document.getElementById("top-stack")?.getBoundingClientRect().bottom || 0) + 8;
    const hit = document.elementFromPoint(window.innerWidth / 2, top);
    const inPaper = hit && paper.contains(hit);
    const u = inPaper ? unitAt(hit) : null;
    const box = inPaper ? hit.closest(".ltx_para, figure, .ltx_abstract") || hit : null;
    const pick = () => (u && shown(u.el) ? u.el : u && shown(u.ko) ? u.ko : shown(box) ? box : null);
    const a = pick(), before = a ? a.getBoundingClientRect().top : 0;
    const root = document.documentElement;
    root.style.overflowAnchor = "none";
    try { fn(); } finally {
      const b = a && pick();
      if (b) {
        const d = b.getBoundingClientRect().top - before;
        if (Math.abs(d) > 1) window.scrollBy(0, d);
      }
      requestAnimationFrame(() => { root.style.overflowAnchor = ""; });
    }
  }

  // ---------- 그리기 ----------
  function clearChip(u) { if (u.chip) { u.chip.remove(); u.chip = null; } }
  let lineH = 0;
  function showChip(u, kind, height = 0) {
    clearChip(u);
    if (kind === "pending") {
      if (u.kind === "title") return; // 제목은 짧아 자리만 차지
      lineH = lineH || parseFloat(getComputedStyle(paper).lineHeight) || 26;
      const n = mode === "both" && height ? Math.max(1, Math.min(8, Math.round((height / lineH) * 0.9))) : 1;
      u.chip = h("span", { class: "tr-state tr-pending", "aria-hidden": "true" },
        ...Array.from({ length: n }, () => h("span", { class: "tr-bar" })));
    } else {
      u.chip = h("span", { class: "tr-state tr-err", role: "status" }, h("span", { text: "번역 실패" }), " · ",
        h("button", { type: "button", text: "다시", onclick: () => retry([u]) }));
    }
    A.insertUI(u.ko || u.el, u.chip, "afterend");
  }
  function showUnit(u) {
    const rec = recs.get(u.id);
    if (!rec || !rec.s || u.ko || mode === "orig") return;
    if (!checkPlaceholders(rec.s.map(p => p[1]), rec.ph.length)) { u.state = "err"; showChip(u, "err"); return; }
    clearChip(u);
    const ko = buildKo(u, rec);
    A.insertUI(u.el, ko, "afterend"); // 제목이면 .ltx_title 바로 뒤 (section-study의 .ss-head보다 앞)
    u.ko = ko;
    koOf.set(ko, u);
    u.state = "done";
    u.el.classList.toggle("tr-hide", mode === "ko" && !u.revealed);
  }
  function dropUnit(u) {
    if (active && active.u === u) { A.clear("tr-align"); active = null; }
    if (u.ko) { u.ko.remove(); u.ko = null; }
    u.el.classList.remove("tr-hide");
  }

  const emitTranslations = () => document.dispatchEvent(new CustomEvent("paper:translations", { detail: { mode } }));

  // ---------- 저장: IndexedDB pr-section-translate (오프라인·다시 열 때 바로), 못 쓰면 PaperStore ----------
  const DB_NAME = "pr-section-translate", STORE = "units", LS_NS = "section-translate:units";
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise(resolve => {
        try {
          const r = indexedDB.open(DB_NAME, 1);
          r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "k" }).createIndex("paper", "paper");
          r.onsuccess = () => resolve(r.result);
          r.onerror = r.onblocked = () => resolve(null);
          setTimeout(() => resolve(null), 2000); // 옛 iOS에서 open이 끝나지 않는 경우
        } catch { resolve(null); }
      });
    }
    return dbp;
  }
  async function readRows() {
    const d = await db();
    if (!d) return Object.values(store.paper(LS_NS, {}) || {});
    return new Promise(resolve => {
      try {
        const q = d.transaction(STORE).objectStore(STORE).index("paper").getAll(App.baseId);
        q.onsuccess = () => resolve(q.result || []);
        q.onerror = () => resolve([]);
      } catch { resolve([]); }
    });
  }
  async function saveRows(list) {
    if (!list.length) return;
    const rows = list.map(([u, rec]) => ({
      k: `${App.baseId}|${u.id}|${u.h}`, paper: App.baseId, id: u.id, h: u.h, ts: Date.now(),
      ...(rec.skip ? { skip: true } : { s: rec.s, ph: rec.ph }),
    }));
    const d = await db();
    if (d) {
      try { const os = d.transaction(STORE, "readwrite").objectStore(STORE); rows.forEach(r => os.put(r)); return; } catch { /* 아래로 */ }
    }
    store.update(store.paperKey(LS_NS), m => {
      const map = m && typeof m === "object" ? m : {};
      for (const r of rows) map[r.id] = r;
      const keys = Object.keys(map).sort((a, b) => map[b].ts - map[a].ts);
      for (const k of keys.slice(300)) delete map[k];
      return map;
    }, {});
  }
  function loadCache() {
    if (!cacheLoad) {
      cacheLoad = readRows().then(rows => {
        collectUnits();
        let titles = false;
        for (const r of rows) {
          const u = byId.get(r.id);
          if (!u || r.h !== u.h || recs.has(r.id)) continue;
          if (r.skip) recs.set(r.id, { skip: true });
          else if (Array.isArray(r.s)) { recs.set(r.id, { s: r.s, ph: r.ph || [] }); titles = titles || u.kind === "title"; }
        }
        if (titles && mode !== "orig") emitTranslations();
      }).catch(() => {});
    }
    return cacheLoad;
  }

  // ---------- 요청: 가까운 것부터, 동시 2개 (답변 스트리밍 중 1개) ----------
  // 상태 칩: 모드를 켠 직후(사용자가 기다리는 첫 묶음들)와 오프라인·실패만. 스크롤 중 묶음마다 띄우면
  // 헤더 아래 띠(#top-stack, 흐름 안) 높이가 바뀌어 본문이 들썩임 → 그때는 제자리 스켈레톤만
  let announce = false, loadingShown = false, chip = null;
  function setStatus() {
    const set = (label, state, opts) => {
      const key = state ? `${label}|${state}` : null;
      if (chip === key && state !== "error") return;
      chip = key;
      UI.status("section-translate", label, state, opts);
    };
    if (mode === "orig") { announce = loadingShown = false; if (chip) set("번역", null); return; }
    const busy = inflight || wanted.size, failed = (units || []).filter(u => u.state === "err");
    if (busy && navigator.onLine === false) set("번역 (오프라인)", "error");
    else if (busy) { if (announce) { set("번역", "loading"); loadingShown = true; } }
    else {
      announce = false; // 첫 화면 몫이 끝났거나 모두 저장돼 있었음
      if (failed.length) set("번역", "error", { onRetry: () => retry(failed) });
      else if (loadingShown) set("번역", "ready");
      else if (chip && !chip.endsWith("|ready")) set("번역", null);
      loadingShown = false;
    }
  }
  function schedule() {
    if (!pumpTimer) pumpTimer = setTimeout(() => { pumpTimer = 0; pump(); }, 80); // 빠른 스크롤의 관찰 결과를 모아서
  }
  function pump() {
    if (mode !== "orig" && navigator.onLine !== false) {
      const center = window.innerHeight / 2;
      while (inflight < (App.streaming ? 1 : 2) && wanted.size) {
        const items = [...wanted].map(u => {
          const r = u.el.getBoundingClientRect();
          return { u, d: Math.abs((r.top + r.bottom) / 2 - center), len: u.len };
        }).sort((a, b) => a.d - b.d);
        // 지금 화면에 있는 단위가 맨 앞이면 작은 묶음으로 (첫 번역이 빨리 뜨게), 앞쪽 단위는 2500자까지
        const cap = items[0].d < center ? MAX_CHARS_NEAR : MAX_CHARS;
        const batch = items[0].u.solo ? [items[0]] : planBatch(items.filter(x => !x.u.solo), MAX_UNITS, cap);
        batch.forEach(x => wanted.delete(x.u));
        send(batch.map(x => x.u));
      }
    }
    setStatus();
  }

  async function send(batch, { force = false } = {}) {
    inflight++;
    const heights = batch.map(u => (mode === "both" && u.kind !== "title" ? u.el.getBoundingClientRect().height : 0));
    batch.forEach(u => { u.state = "sent"; });
    keepPlace(() => batch.forEach((u, i) => showChip(u, "pending", heights[i])));
    setStatus();
    let data = null, error = null;
    try {
      await App.warm; // 논문 캐시가 먼저 만들어지게 (동시에 보내면 캐시 쓰기를 두 번 냄)
      const r = await fetch(ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: batch.map(u => u.id), force }),
      });
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
      data = await r.json();
    } catch (e) { error = e; }
    inflight--;
    const done = [], rows = [];
    if (error) {
      const offline = !error.status && navigator.onLine === false;
      const titlesOnly = batch.every(u => u.kind === "title");
      for (const u of batch) {
        clearChip(u);
        if (mode === "orig" || (titlesOnly && batch.length > 1)) { u.state = ""; continue; } // 제목 미리 받기 실패: 조용히 (보일 때 다시)
        if (offline || (error.status && batch.length > 1 && !force)) {
          // 오프라인: 'online'까지 대기 / 묶음 실패(잘림·형식 오류): 하나씩 다시
          if (!offline) u.solo = true;
          u.state = "wanted";
          wanted.add(u);
        } else {
          u.state = "err";
          showChip(u, "err");
        }
      }
    } else {
      for (const u of batch) {
        const d = data && data[u.id];
        if (!d || (d.s && d.fp !== u.fp)) { u.state = "gone"; clearChip(u); continue; } // 서버가 모르는 단위·다른 글 (파서 차이)
        if (d.skip) { recs.set(u.id, { skip: true }); rows.push([u, { skip: true }]); u.state = "skip"; clearChip(u); continue; }
        const rec = Array.isArray(d.s) ? { s: d.s, ph: Array.isArray(d.ph) ? d.ph : [] } : null;
        if (!rec || !checkPlaceholders(rec.s.map(p => p[1]), rec.ph.length)) {
          u.state = "err";
          if (mode !== "orig") showChip(u, "err"); else clearChip(u);
          continue;
        }
        recs.set(u.id, rec);
        rows.push([u, rec]);
        done.push(u);
      }
      saveRows(rows).catch(() => {});
    }
    if (done.length) {
      keepPlace(() => {
        for (const u of done) {
          clearChip(u);
          if (force || u.ko) dropUnit(u); // 다시 번역: 새 번역으로 바꿈
          if (mode === "orig") u.state = "";
          else showUnit(u);
        }
      });
    }
    if (done.some(u => u.kind === "title")) emitTranslations();
    pump();
  }
  function retry(list) {
    for (const u of list) {
      if (u.state !== "err") continue;
      clearChip(u);
      u.solo = true;
      u.state = "wanted";
      wanted.add(u);
    }
    pump();
  }

  // 보이기 직전(위아래 1.5화면)에 들어온 단위: 저장된 번역은 바로 그리고, 없으면 요청 대기열로
  function onIntersect(entries) {
    const now = [];
    for (const e of entries) {
      const u = unitOfEl.get(e.target);
      if (!u) continue;
      if (!e.isIntersecting) {
        if (wanted.delete(u)) u.state = ""; // 지나쳐 간 단위는 보내지 않음
        continue;
      }
      if (u.ko || u.state) continue;
      const rec = recs.get(u.id);
      if (rec) { if (rec.skip) u.state = "skip"; else now.push(u); continue; }
      if (shouldSkip(u.src, u.kind)) { u.state = "skip"; continue; }
      wanted.add(u);
      u.state = "wanted";
    }
    if (now.length) keepPlace(() => now.forEach(showUnit));
    schedule();
  }

  // 목차·현재 섹션 표시(toc-progress)용: 모든 제목을 한 번에 (가벼운 배경 작업)
  async function prefetchTitles() {
    if (mode === "orig") return;
    await loadCache();
    const todo = units.filter(u => u.kind === "title" && !recs.has(u.id) && (!u.state || u.state === "wanted") && !shouldSkip(u.src, "title"));
    todo.forEach(u => wanted.delete(u));
    for (let i = 0; i < todo.length && mode !== "orig"; i += MAX_TITLES) await send(todo.slice(i, i + MAX_TITLES));
  }

  async function activate() {
    if (mode === "orig") return;
    collectUnits();
    await loadCache();
    if (mode === "orig" || io || typeof IntersectionObserver === "undefined") return;
    io = new IntersectionObserver(onIntersect, { rootMargin: "150% 0px" });
    units.forEach(u => io.observe(u.el));
    App.idle(prefetchTitles).catch(() => {});
  }
  function deactivate() {
    if (io) { io.disconnect(); io = null; }
    for (const u of wanted) u.state = "";
    wanted.clear();
    A.clear("tr-align");
    active = null;
    for (const u of units || []) {
      dropUnit(u);
      clearChip(u);
      u.revealed = false;
      if (u.state === "done" || u.state === "err") u.state = "";
    }
  }
  function applyMode() {
    paper.classList.toggle("tr-mode-both", mode === "both");
    paper.classList.toggle("tr-mode-ko", mode === "ko");
    if (mode === "orig") { deactivate(); return; }
    for (const u of units || []) if (u.ko) u.el.classList.toggle("tr-hide", mode === "ko" && !u.revealed);
  }
  function setMode(m) {
    mode = m;
    announce = m !== "orig";
    store.set(MODE_KEY, m);
    btn.setActive(m !== "orig");
    btn.el.dataset.tr = m;
    UI.toast(MODE_TOAST[m]);
    keepPlace(applyMode);
    if (m === "orig") setStatus(); // 켤 때는 첫 관찰·요청 뒤에 (pump)
    emitTranslations();
    activate();
  }

  // ---------- 한국어 문장 탭: 영어 원문 한 줄 + 원문 문장 하이라이트 ----------
  function toggleSentence(span) {
    const ko = span.closest(".tr-ko"), u = ko && koOf.get(ko), rec = u && recs.get(u.id);
    if (!rec || !rec.s) return;
    const i = Number(span.dataset.i), pair = rec.s[i];
    const open = span.nextElementSibling && span.nextElementSibling.classList.contains("tr-en") ? span.nextElementSibling : null;
    if (open) {
      open.remove();
      span.classList.remove("tr-on");
      if (active && active.span === span) { A.clear("tr-align"); active = null; }
      return;
    }
    if (!pair) return;
    const en = fill(h("span", { class: "tr-en", lang: "en" }), pair[0], rec.ph, resolveAtoms(u, rec.ph));
    en.append(h("span", { class: "tr-en-tools" },
      UI.feedback("translate", u.id, { label: "번역" }),
      h("button", { type: "button", text: "다시 번역", onclick: () => { if (u.state !== "sent") send([u], { force: true }); } })));
    span.after(en);
    if (active && active.span !== span) active.span.classList.remove("tr-on");
    // 쌍 칠하기 (§5.10 tr-align): 영어 쪽은 색인 오프셋으로 찾은 그 문장(둘다 모드에서 위 문단), 한국어 쪽은 raw Range.
    // Highlight API가 없으면 영어는 <mark> 대체, 한국어 문장은 클래스로
    const o = A.locate(phText(pair[0], rec.ph), { root: u.el });
    if (typeof CSS !== "undefined" && CSS.highlights) {
      const koRange = document.createRange();
      koRange.selectNodeContents(span);
      A.paint("tr-align", [o && A.rangeAt(o.start, o.end), koRange].filter(Boolean), { priority: 35, raw: true });
    } else {
      span.classList.add("tr-on");
      if (o) A.paint("tr-align", [o], { priority: 35 }); else A.clear("tr-align");
    }
    active = { u, span };
  }

  // ---------- 다른 기능용 API (§6.1) ----------
  function sentencesIn(u, rec, sel) {
    if (sel.start == null || sel.end == null) return null;
    const idx = [];
    rec.s.forEach((pair, i) => {
      const o = A.locate(phText(pair[0], rec.ph), { root: u.el });
      if (o && o.start < sel.end && o.end > sel.start) idx.push(i);
    });
    return idx;
  }
  // 선택을 덮는 저장된 번역 쌍 [{en, ko}] (요청하지 않음). 하나라도 번역 전이면 null
  async function lookup(sel) {
    if (!sel) return null;
    collectUnits();
    await loadCache();
    const range = sel.range || null, picks = [];
    const startEl = range ? (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement) : null;
    const ko = startEl && startEl.closest(".tr-ko");
    if (sel.inTranslation || ko) {
      const u = ko && koOf.get(ko);
      if (!u) return null;
      const idx = [...ko.querySelectorAll(".tr-s")].filter(s => range.intersectsNode(s)).map(s => Number(s.dataset.i));
      picks.push({ u, idx });
    } else {
      let hit = range ? units.filter(u => { try { return range.intersectsNode(u.el); } catch { return false; } }) : [];
      if (!hit.length && sel.paragraphEl) hit = units.filter(u => sel.paragraphEl.contains(u.el) || u.el.contains(sel.paragraphEl));
      hit = hit.filter(u => !hit.some(o => o !== u && o.el.contains(u.el))); // 문단 안 각주 본문은 빼고
      if (!hit.length) return null;
      for (const u of hit) picks.push({ u, idx: null });
    }
    const out = [];
    for (const p of picks) {
      const rec = recs.get(p.u.id);
      if (!rec || !rec.s) return null;
      const idx = p.idx && p.idx.length ? p.idx : sentencesIn(p.u, rec, sel);
      const list = idx && idx.length ? idx : rec.s.map((_, i) => i);
      for (const i of list) if (rec.s[i]) out.push({ en: phText(rec.s[i][0], rec.ph), ko: phText(rec.s[i][1], rec.ph) });
    }
    return out.length ? out : null;
  }
  // 섹션 제목 번역 (목차·현재 섹션 표시용). 아직 없으면 null
  function titleFor(sectionId) {
    const r = recs.get(`${sectionId}.title`);
    return r && r.s ? phText(r.s.map(p => p[1]).join(" "), r.ph) || null : null;
  }
  // .tr-ko 요소(또는 그 안)가 번역하는 영어 단위 요소
  function unitFor(el) {
    if (!el || !el.closest) return null;
    collectUnits();
    const ko = el.closest(".tr-ko");
    if (ko) { const u = koOf.get(ko); return u ? u.el : null; }
    const u = unitAt(el);
    return u ? u.el : null;
  }
  Object.assign(api, { lookup, titleFor, unitFor });

  // ---------- 연결 ----------
  const btn = UI.addBarButton({ id: "section-translate", label: "번역", title: "번역 (원문 → 둘다 → 번역)", onClick: () => setMode(nextMode(mode)) });
  btn.setActive(mode !== "orig");
  btn.el.dataset.tr = mode;

  // 시트가 열려 있으면 번역문 탭은 '내려두기'로 (번역 모드에선 보이는 글자 거의 전부가 .tr-ko)
  App.addTapHandler({
    id: "section-translate", priority: 40,
    test: e => (e.target.closest("a") || App.isSheetOpen() ? null : e.target.closest(".tr-ko .tr-s")),
    handle: (e, span) => toggleSentence(span),
  });

  // 점프 대상이 숨긴 원문 안이면 드러냄 (검색·근거 칩·목차 복원 등)
  App.on("reveal", d => {
    if (mode !== "ko" || !d || !d.el) return;
    for (let e = d.el.nodeType === 1 ? d.el : d.el.parentElement; e && e !== paper; e = e.parentElement) {
      if (!e.classList.contains("tr-hide")) continue;
      e.classList.remove("tr-hide");
      const u = unitOfEl.get(e);
      if (u) u.revealed = true;
    }
  });
  window.addEventListener("online", () => schedule());
  window.addEventListener("offline", () => setStatus());

  if (mode !== "orig") {
    announce = true;
    applyMode();
    requestAnimationFrame(() => setTimeout(activate, 0)); // 첫 화면을 그린 뒤 단위 수집
  }
})();
