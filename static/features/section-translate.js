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

  let units = null; // [{id, kind, el, src, len, h, fp, state, ko, chip, revealed, solo, force, notes, host, noteId}]
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
      byId.get(`${note.id}.note`).noteId = note.id;
    }
    // 각주 본문은 관찰하지 않고 그 각주가 든 단위(단락·캡션·제목)와 함께 요청 (ref-peek가 .ltx_note_outer를 숨기면
    // 본문 자체는 보이지 않음). 번역은 단락 번역문 안 각주 복제에 들어감 (koNote). 든 단위가 없는 각주(표 칸 등)는 번역 안 함
    for (const u of units) {
      if (u.kind !== "note") continue;
      const host = unitAt(u.el.parentElement);
      if (host) { u.host = host; (host.notes = host.notes || []).push(u); }
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
  // koNotes: 한국어 쪽(번역문·각주 번역)이면 각주 복제의 본문도 한국어로. 영어 원문 줄(.tr-en)은 원문 그대로
  function fill(el, text, ph, srcs, koNotes = false) {
    for (const part of restorePlaceholders(text, ph.map((_, i) => i))) {
      if (typeof part === "string") el.append(part);
      else {
        const node = srcs[part] ? UI.cloneClean(srcs[part]) : fallbackAtom(ph[part]);
        if (!node) continue;
        if (koNotes && ph[part].k === "note" && ph[part].id && node.classList && node.classList.contains("ltx_note")) koNote(node, ph[part].id);
        el.append(node);
      }
    }
    return el;
  }
  // 번역문 안 각주 복제의 본문을 그 각주 단위의 번역으로 (각주 표시를 탭하면 ref-peek가 가장 가까운 .ltx_note의
  // .ltx_note_content를 보여 주므로 번역문에서는 한국어 각주가, ref-peek가 없으면 원문처럼 그 자리에 보임)
  function koNote(clone, noteId) {
    clone.dataset.trNote = noteId;
    const nu = byId.get(`${noteId}.note`), rec = nu && recs.get(nu.id);
    const c = clone.querySelector(".ltx_note_content");
    if (!c || !rec || !rec.s || !checkPlaceholders(rec.s.map(p => p[1]), rec.ph.length)) return;
    const srcs = resolveAtoms(nu, rec.ph);
    c.replaceChildren();
    rec.s.forEach((pair, i) => { if (i) c.append(" "); fill(c, pair[1], rec.ph, srcs, true); });
    c.lang = "ko";
  }
  function refreshNotes(nu) {
    for (const c of paper.querySelectorAll(".tr-ko [data-tr-note]")) if (c.dataset.trNote === nu.noteId) koNote(c, nu.noteId);
  }
  function buildKo(u, rec) {
    const srcs = resolveAtoms(u, rec.ph);
    const tag = u.kind === "title" ? u.el.localName : "div";
    const ko = h(tag, { class: `tr-ko tr-${u.kind}`, lang: "ko", dataset: { unit: u.id } });
    rec.s.forEach((pair, i) => {
      if (i) ko.append(" ");
      ko.append(fill(h("span", { class: "tr-s", dataset: { i } }), pair[1], rec.ph, srcs, true));
    });
    return ko;
  }

  // ---------- 화면 위치 유지: 뷰포트 위쪽에서 높이가 바뀌어도 읽던 곳이 밀리지 않게 (iOS는 scroll anchoring 없음) ----------
  // skipNotes: 각주 본문 단위 대신 그 각주가 든 단위 (각주 번역은 따로 그리지 않고 단락 번역문 안에 들어감)
  function unitAt(el, skipNotes = false) {
    for (let e = el; e && e !== paper; e = e.parentElement) {
      const u = unitOfEl.get(e) || (e.classList.contains("tr-ko") && koOf.get(e));
      if (u && !(skipNotes && u.kind === "note")) return u;
    }
    return null;
  }
  const shown = el => !!el && el.isConnected && el.getClientRects().length > 0;
  // 기준 요소: 탐침 줄(상단 띠 바로 아래)에 걸치거나 그 아래에서 처음 만나는 번역 단위·번역문·잎 블록(수식 표, 그림 등).
  // 단락 사이 여백에선 section·.ltx_para·#paper 같은 상자가 잡히는데, 안쪽이 바뀌어도 상자의 top은 그대로라 기준이 못 됨
  // → 단위를 품은 상자는 건너뛰고 12px씩 아래로 다시 찾음. 대기 칩(.tr-state)은 fn()이 지우므로 건너뜀
  const HOLDS_UNITS = "p.ltx_p, .ltx_title, figcaption, .tr-ko, .tr-state";
  function anchorAt(y0) {
    const x = window.innerWidth / 2, end = Math.min(window.innerHeight, y0 + 480);
    for (let y = Math.max(0, y0); y < end; y += 12) {
      const hit = document.elementFromPoint(x, y);
      if (!hit || !paper.contains(hit) || hit.closest(".tr-state")) continue;
      const u = unitAt(hit, true);
      if (u) return { u, ko: !!hit.closest(".tr-ko") }; // 영어·한국어 중 보던 쪽을 먼저 (둘다 모드)
      if (!hit.querySelector(HOLDS_UNITS)) return { el: hit };
    }
    return null;
  }
  function keepPlace(fn) {
    const a = anchorAt((document.getElementById("top-stack")?.getBoundingClientRect().bottom || 0) + 8);
    // 보던 쪽이 사라지면(번역 모드로 바꿔 영어를 숨김 등) 짝으로: 원문 자리에 번역문이 오고, 그 반대도
    const pick = () => (!a ? null : !a.u ? (shown(a.el) ? a.el : null)
      : (a.ko ? [a.u.ko, a.u.el] : [a.u.el, a.u.ko]).find(shown) || null);
    const first = pick(), before = first ? first.getBoundingClientRect().top : 0;
    const root = document.documentElement;
    if (first) root.style.overflowAnchor = "none"; // 기준을 못 찾았으면 브라우저의 scroll anchoring에 맡김
    try { fn(); } finally {
      const b = first && pick();
      if (b) {
        const d = b.getBoundingClientRect().top - before;
        if (Math.abs(d) > 1) window.scrollBy(0, d);
      }
      if (first) requestAnimationFrame(() => { root.style.overflowAnchor = ""; });
    }
  }

  // ---------- 그리기 ----------
  function clearChip(u) { if (u.chip) { u.chip.remove(); u.chip = null; } }
  let lineH = 0;
  function showChip(u, kind, height = 0) {
    clearChip(u);
    if (u.kind === "note") return; // 각주는 단락 번역문 안에 들어감 (실패는 상태 칩의 '다시'로)
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
    if (u.kind === "note") { u.state = "done"; refreshNotes(u); return; }
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
      keepPlace(() => UI.status("section-translate", label, state, opts)); // 띠(#top-stack)는 흐름 안: 높이가 바뀌어도 본문 제자리
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
          const r = placeOf(u).getBoundingClientRect();
          return { u, d: Math.abs((r.top + r.bottom) / 2 - center), len: u.len };
        }).sort((a, b) => a.d - b.d);
        // 지금 화면에 있는 단위가 맨 앞이면 작은 묶음으로 (첫 번역이 빨리 뜨게), 앞쪽 단위는 2500자까지
        const cap = items[0].d < center ? MAX_CHARS_NEAR : MAX_CHARS;
        const batch = items[0].u.solo ? [items[0]] : planBatch(items.filter(x => !x.u.solo), MAX_UNITS, cap);
        batch.forEach(x => wanted.delete(x.u));
        send(batch.map(x => x.u), { force: batch.length === 1 && !!batch[0].u.force }); // '다시 번역'은 늘 혼자 (solo)
      }
    }
    setStatus();
  }

  async function send(batch, { force = false } = {}) {
    inflight++;
    const heights = batch.map(u => (mode === "both" && (u.kind === "p" || u.kind === "cap") ? u.el.getBoundingClientRect().height : 0));
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
    // 칩을 지우고 그리는 것까지 모두 keepPlace 안에서: 위쪽 단위의 대기 칩이 건너뛰기·실패로 사라져도 읽던 곳이 그대로
    keepPlace(() => {
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
        return;
      }
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
      for (const u of done) {
        clearChip(u);
        if (force) u.force = false; // '다시 번역' 끝: 오프라인·실패 뒤 다시 보낼 때까지 force 유지
        if (force || u.ko) dropUnit(u); // 다시 번역: 새 번역으로 바꿈
        if (mode === "orig") u.state = "";
        else showUnit(u);
      }
    });
    saveRows(rows).catch(() => {});
    if (done.some(u => u.kind === "title")) emitTranslations();
    pump();
  }
  // '다시 번역': 캐시를 건너뛰고 새로. 오프라인·실패로 다시 보낼 때도 force가 남게 단위에 표시 (늘 혼자 보냄)
  function redo(u) {
    if (u.state === "sent") return;
    u.force = u.solo = true;
    wanted.delete(u);
    send([u], { force: true });
  }
  function retry(list) {
    keepPlace(() => {
      for (const u of list) {
        if (u.state !== "err") continue;
        clearChip(u);
        u.solo = true;
        u.state = "wanted";
        wanted.add(u);
      }
    });
    pump();
  }

  const withNotes = (u, out = []) => { out.push(u); for (const n of u.notes || []) withNotes(n, out); return out; };
  // 거리 계산용 위치: 각주는 든 단위, 번역 모드에서 숨긴 원문은 번역문
  function placeOf(u) {
    while (u.host) u = u.host;
    return shown(u.el) || !u.ko ? u.el : u.ko;
  }
  // 보이기 직전(위아래 1.5화면)에 들어온 단위: 저장된 번역은 바로 그리고, 없으면 요청 대기열로
  function onIntersect(entries) {
    const now = [];
    const take = u => {
      if (u.ko || u.state) return;
      const rec = recs.get(u.id);
      if (rec) { if (rec.skip) u.state = "skip"; else now.push(u); return; }
      if (shouldSkip(u.src, u.kind)) { u.state = "skip"; return; }
      wanted.add(u);
      u.state = "wanted";
    };
    for (const e of entries) {
      const u = unitOfEl.get(e.target);
      if (!u) continue;
      if (!e.isIntersecting) {
        for (const x of withNotes(u)) if (wanted.delete(x)) x.state = ""; // 지나쳐 간 단위는 보내지 않음
        continue;
      }
      take(u);
      if (u.state !== "skip") withNotes(u).slice(1).forEach(take); // 각주는 든 단위 다음에 (번역문 안 복제에 들어감)
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
    units.forEach(u => { if (u.kind !== "note") io.observe(u.el); });
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
      u.revealed = u.force = false;
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
      h("button", { type: "button", text: "다시 번역", onclick: () => redo(u) })));
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
  // 선택을 덮는 저장된 번역 쌍 [{en, ko}] (요청하지 않음). 선택한 글 중 한 글자라도(공백 빼고) 번역 쌍 밖이면 null:
  // 번역 전 단위, 단위가 아닌 곳(수식 블록·표·코드), 원문에서 찾지 못한 문장. 그러면 smart-presets가 번역을 물어봄
  async function lookup(sel) {
    if (!sel) return null;
    collectUnits();
    await loadCache();
    const range = sel.range || null, out = [];
    const add = (rec, i) => { if (rec.s[i]) out.push({ en: phText(rec.s[i][0], rec.ph), ko: phText(rec.s[i][1], rec.ph) }); };
    const elOf = n => (n && n.nodeType !== 1 ? n.parentElement : n);
    const ko = range ? elOf(range.startContainer)?.closest(".tr-ko") : null;
    if (sel.inTranslation || ko) {
      // 번역문 안 선택: 한 .tr-ko 안에서 고른 한국어 문장들
      const u = ko && koOf.get(ko), rec = u && recs.get(u.id);
      if (!rec || !rec.s || !ko.contains(range.endContainer)) return null;
      for (const s of ko.querySelectorAll(".tr-s")) if (range.intersectsNode(s)) add(rec, Number(s.dataset.i));
      return out.length ? out : null;
    }
    const meets = u => { try { return range.intersectsNode(u.el); } catch { return false; } };
    let hit = units.filter(u => u.kind !== "note" && (range ? meets(u)
      : !!sel.paragraphEl && (sel.paragraphEl.contains(u.el) || u.el.contains(sel.paragraphEl)))); // 문단 기준은 범위가 없을 때만
    hit = hit.filter(u => !hit.some(o => o !== u && o.el.contains(u.el)));
    if (!hit.length || hit.some(u => !(recs.get(u.id) || {}).s)) return null;
    if (sel.start == null || sel.end == null) {
      if (range) return null; // 색인 밖 선택(원문 각주 본문 등): 덮는지 알 수 없음
      for (const u of hit) { const rec = recs.get(u.id); rec.s.forEach((_, i) => add(rec, i)); }
      return out.length ? out : null;
    }
    // 원문에서 찾은 문장들이 선택 범위를 빈틈없이 덮는지 (색인 오프셋으로)
    const spans = [];
    for (const u of hit) {
      const rec = recs.get(u.id);
      rec.s.forEach((pair, i) => {
        const o = A.locate(phText(pair[0], rec.ph), { root: u.el });
        if (o) spans.push({ start: o.start, end: o.end, rec, i });
      });
    }
    spans.sort((a, b) => a.start - b.start);
    const text = A.index().text;
    let pos = sel.start;
    for (const sp of spans) {
      if (sp.start >= sel.end) break;
      if (sp.end <= pos) continue;
      if (sp.start > pos && text.slice(pos, sp.start).trim()) return null;
      add(sp.rec, sp.i);
      pos = sp.end;
    }
    if (pos < sel.end && text.slice(pos, sel.end).trim()) return null;
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
