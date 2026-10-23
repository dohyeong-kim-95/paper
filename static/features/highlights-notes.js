// highlights-notes: 형광펜(4색)·메모·답변 저장, 질문 기록 자동 저장, 내 노트 패널(문서 순서), Markdown 내보내기
(function () {
  "use strict";
  // ---------- 순수 함수 (node 테스트 대상) ----------
  const COLORS = [
    { id: "yellow", label: "노랑" },
    { id: "green", label: "초록" },
    { id: "blue", label: "파랑" },
    { id: "pink", label: "분홍" },
  ];
  const COLOR_IDS = COLORS.map(c => c.id);
  const MAX_THREADS = 40;     // 논문당 질문 기록 (오래된 것부터 지움)
  const NOTES_MAX = 1500;     // <my-notes> 길이
  const THREAD_FIELDS = ["quote", "selection", "context", "section", "endpoint", "extra", "history", "shown", "meta", "title", "origin"];

  const colorOf = c => (COLOR_IDS.includes(c) ? c : COLOR_IDS[0]);
  const newId = (now = Date.now()) => now.toString(36) + Math.random().toString(36).slice(2, 7);
  const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  const oneLine = s => String(s || "").replace(/\s+/g, " ").trim();
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  function normPrefs(p) {
    p = p && typeof p === "object" ? p : {};
    return { color: colorOf(p.color), highlighter: !!p.highlighter, useNotes: !!p.useNotes };
  }
  function cleanAnchor(a) {
    if (!a || !a.quote) return null;
    return { quote: String(a.quote), prefix: String(a.prefix || ""), suffix: String(a.suffix || ""), paraId: a.paraId || null };
  }
  // 종류: Q&A가 있으면 qa, 메모가 있으면 note, 아니면 hl
  const typeOf = it => (it.qa && it.qa.length ? "qa" : it.note && String(it.note).trim() ? "note" : "hl");

  function makeItem({ anchor = null, color, note = "", qa = [], thread = null, source = null } = {}, now = Date.now()) {
    const it = {
      id: newId(now), type: "hl", color: colorOf(color), anchor: cleanAnchor(anchor), note: String(note || ""),
      qa: (qa || []).map(x => ({ q: String(x.q || ""), a: String(x.a || "") })), ts: now,
    };
    if (thread) it.thread = String(thread); // 이 답변이 나온 대화 (이어서 질문하면 그 대화 그대로)
    if (source) it.source = String(source);
    it.type = typeOf(it);
    return it;
  }
  function addQa(it, q, a, now = Date.now()) {
    if (!it.qa.some(x => x.a === a)) it.qa.push({ q: String(q || ""), a: String(a || "") });
    it.type = typeOf(it);
    it.ts = now;
    return it;
  }

  // 문서 순서: pos[id] = {start} | 숫자. 앵커 없는 것(논문 전체)은 맨 앞, 본문에서 못 찾은 것은 맨 뒤, 같으면 저장 순
  function startOf(pos, it) {
    if (!it.anchor) return -1;
    const p = pos ? (pos instanceof Map ? pos.get(it.id) : pos[it.id]) : null;
    const s = p == null ? null : typeof p === "number" ? p : p.start;
    return typeof s === "number" ? s : Infinity;
  }
  function sortByPosition(list, pos) {
    return (list || []).map((it, i) => ({ it, i, s: startOf(pos, it) }))
      .sort((a, b) => (a.s - b.s) || (a.it.ts || 0) - (b.it.ts || 0) || a.i - b.i)
      .map(x => x.it);
  }

  // 탭한 오프셋을 포함하는 가장 짧은 구간의 id
  function hitAt(entries, off) {
    let best = null;
    for (const e of entries || []) {
      if (e && e.start != null && off >= e.start && off < e.end && (!best || e.end - e.start < best.end - best.start)) best = e;
    }
    return best ? best.id : null;
  }
  const overlaps = (a, b) => !!(a && b && a.start < b.end && b.start < a.end);

  const flattenQa = qa => (qa || []).flatMap(x => [{ role: "user", content: String(x.q) }, { role: "assistant", content: String(x.a) }]);
  const turnsOf = t => {
    const out = [], hist = t.history || [], shown = t.shown || [];
    for (let i = 0; i + 1 < hist.length; i += 2) out.push({ q: String(shown[i / 2] || hist[i].content || ""), a: String(hist[i + 1].content || "") });
    return out;
  };

  // 세션 프리셋 중 저장할 수 있는 것만 (문자열, 또는 q가 문자열이고 run이 없는 것). 없으면 null
  function serialPresets(list) {
    if (!Array.isArray(list)) return null;
    const out = list.filter(p => typeof p === "string"
      || (p && typeof p === "object" && typeof p.run !== "function" && (p.q == null || typeof p.q === "string")))
      .map(p => (typeof p === "string" ? p : { id: p.id == null ? null : String(p.id), label: String(p.label || p.q || ""), q: p.q == null ? null : p.q }));
    return out.length ? out : null;
  }

  // 질문 기록 한 건: 세션의 고정 필드 전부 (이어 갈 때 첫 user 턴이 바이트까지 같도록) + 앵커·이름
  function threadRecord(s, prev = null, anchor = null, now = Date.now()) {
    const rec = { id: String(s.threadId || s.id), anchor: prev ? prev.anchor || null : cleanAnchor(anchor) };
    for (const k of THREAD_FIELDS) rec[k] = clone(s[k]);
    rec.presets = serialPresets(s.presets);
    if (!rec.endpoint) rec.endpoint = "/api/ask";
    const first = (s.meta && s.meta[0] && s.meta[0].label) || (s.shown && s.shown[0]) || (s.history && s.history[0] && s.history[0].content) || "질문";
    rec.label = (prev && prev.label) || clip(oneLine(first), 80);
    rec.ts = now;
    return rec;
  }
  function upsertThread(list, rec, cap = MAX_THREADS) {
    const out = (list || []).filter(t => t.id !== rec.id);
    out.push(rec);
    out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return out.slice(-cap);
  }

  // <my-notes>: 이 논문의 하이라이트·메모를 문서 순서로, max자까지
  function notesDigest(items, pos, max = NOTES_MAX) {
    const lines = [];
    let n = 0;
    for (const it of sortByPosition((items || []).filter(x => (x.anchor && typeOf(x) !== "qa") || (x.note && x.note.trim())), pos)) {
      const q = it.anchor ? `"${clip(oneLine(it.anchor.quote), 300)}"` : "(논문 전체)";
      const note = it.note && it.note.trim() ? ` — 메모: ${oneLine(it.note)}` : "";
      let line = `- ${q}${note}`;
      if (n + line.length + 1 > max) {
        if (lines.length) break;
        line = clip(line, max);
      }
      lines.push(line);
      n += line.length + 1;
    }
    return lines.join("\n");
  }

  // 문서 순서 목록에서 같은 섹션이 이어지는 것끼리 묶음 → [{section, items}] (패널·내보내기의 섹션 제목)
  function groupRuns(list, sectionOf = () => "") {
    const out = [];
    for (const it of list || []) {
      const k = sectionOf(it) || "", last = out[out.length - 1];
      if (last && last.section === k) last.items.push(it);
      else out.push({ section: k, items: [it] });
    }
    return out;
  }

  // Markdown 내보내기 (Notion·Obsidian): 제목, arXiv 링크, 섹션별 '> 인용', 메모, Q&A, 질문 기록 — 문서 순서
  // opts.sections: {id: "2 Method"} (항목이 있는 섹션 제목, 없으면 섹션 제목 없이)
  const quoteMd = q => String(q || "").trim().split(/\n/).map(l => `> ${l}`).join("\n");
  function toMarkdown(meta = {}, items = [], opts = {}) {
    const { pos = {}, threads = [], tpos = {}, date = "", sections = {} } = opts;
    const id = meta.id || "";
    const out = [`# ${meta.title || id || "논문 노트"}`, ""];
    if (id) out.push(`arXiv: https://arxiv.org/abs/${id}`);
    if (date) out.push(`내보낸 날짜: ${date}`);
    out.push("");
    const list = sortByPosition(items, pos);
    if (list.length) out.push("## 하이라이트·메모", "");
    for (const run of groupRuns(list, it => sections[it.id])) {
      if (run.section) out.push(`### ${oneLine(run.section)}`, "");
      for (const it of run.items) {
        out.push(it.anchor ? quoteMd(it.anchor.quote) : "*(논문 전체)*", "");
        if (it.note && it.note.trim()) out.push(it.note.trim(), "");
        for (const x of it.qa || []) out.push(`**Q.** ${oneLine(x.q)}`, "", String(x.a).trim(), "");
        out.push("---", "");
      }
    }
    const ts = sortByPosition(threads, tpos).filter(t => turnsOf(t).length);
    if (ts.length) out.push("## 질문 기록", "");
    for (const t of ts) {
      out.push(`### ${oneLine(t.label) || "질문"}`, "");
      if (t.quote) out.push(quoteMd(t.quote), "");
      for (const x of turnsOf(t)) out.push(`**Q.** ${oneLine(x.q)}`, "", x.a.trim(), "");
    }
    return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }

  const api = {
    COLORS, MAX_THREADS, normPrefs, typeOf, makeItem, addQa, sortByPosition, hitAt, overlaps, flattenQa, turnsOf,
    serialPresets, threadRecord, upsertThread, notesDigest, groupRuns, toMarkdown,
  };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;           // node: 여기서 끝
  if (document.body.dataset.page !== "paper") return;
  api.add = add; // 다른 기능용 (§6.1): skim-highlights·audio-summary의 '하이라이트로 저장'
  PaperApp.registerFeature("highlights-notes", api);

  // ---------- 저장 ----------
  const UI = PaperUI, A = PaperAnchor, S = PaperStore, h = UI.h;
  const paperEl = A.root();
  const NS = "highlights-notes", TNS = "highlights-notes:threads", PREFS = "highlights-notes:prefs";
  const KIND_LABEL = { hl: "하이라이트", note: "메모", qa: "저장한 Q&A" };
  const loadList = ns => { const v = S.paper(ns, []); return Array.isArray(v) ? v.filter(x => x && typeof x === "object" && x.id) : []; };
  let items = loadList(NS).map(x => ({ ...x, qa: Array.isArray(x.qa) ? x.qa : [], anchor: cleanAnchor(x.anchor) }));
  let threads = loadList(TNS).filter(t => Array.isArray(t.history));
  let prefs = normPrefs(S.get(PREFS, null));
  const pos = new Map(), tpos = new Map(); // id → 본문에서 다시 찾은 {start, end} | null (이 페이지 동안 고정)

  let fullAt = 0;
  function fullToast() {
    if (Date.now() - fullAt < 30000) return;
    fullAt = Date.now();
    UI.toast("저장 공간 부족 · 내보내기", { actionLabel: "내보내기", onAction: () => downloadMd() });
  }
  let persisted = false;
  function saveItems() {
    if (!persisted) { persisted = true; try { navigator.storage?.persist?.().catch(() => {}); } catch { /* 무시 */ } }
    if (S.setPaper(NS, items)) return true;
    fullToast();
    return false;
  }
  // 질문 기록은 자동 저장: 용량이 모자라면 오래된 기록부터 비우고 다시
  function saveThreads() {
    while (!S.setPaper(TNS, threads)) {
      if (threads.length <= 1) { fullToast(); return false; }
      threads = threads.slice(1);
    }
    return true;
  }
  const savePrefs = () => S.set(PREFS, prefs);

  // ---------- 위치 다시 찾기·칠하기 ----------
  function locateAnchor(a) {
    if (!a || !a.quote) return null;
    const para = a.paraId ? document.getElementById(a.paraId) : null;
    const o = { prefix: a.prefix, suffix: a.suffix };
    return (para && para !== paperEl && paperEl.contains(para) && A.locate(a.quote, { ...o, root: para })) || A.locate(a.quote, o);
  }
  const resolve = (map, rec) => { if (!map.has(rec.id)) map.set(rec.id, locateAnchor(rec.anchor)); return map.get(rec.id); };
  const posOf = it => resolve(pos, it);
  const tposOf = t => resolve(tpos, t);
  const posMap = () => Object.fromEntries(items.map(it => [it.id, posOf(it)]));
  const tposMap = () => Object.fromEntries(threads.map(t => [t.id, tposOf(t)]));
  const samePos = (a, b) => !!(a && b && a.start === b.start && a.end === b.end);

  function trimRange(p) {
    const t = A.index().text;
    let { start, end } = p;
    while (start < end && /\s/.test(t[start])) start++;
    while (end > start && /\s/.test(t[end - 1])) end--;
    return { start, end };
  }
  function elAt(off) {
    const r = A.rangeAt(off, off);
    const n = r && r.startContainer;
    return n ? (n.nodeType === 1 ? n : n.parentElement) : null;
  }
  function paraIdAt(off) {
    const el = elAt(off);
    const p = el && (el.closest(".ltx_para[id]") || el.closest("[id]"));
    return p && p !== paperEl && paperEl.contains(p) ? p.id : null;
  }
  // 위치가 속한 섹션 제목 ("2.1 Routing", 초록은 "Abstract") — 패널·내보내기의 묶음 제목
  function sectionAt(p) {
    const el = p && elAt(p.start);
    if (!el) return "";
    const sec = el.closest("section");
    const t = sec && [...sec.children].find(c => c.classList.contains("ltx_title"));
    return t ? A.textOf(t) : el.closest(".ltx_abstract") ? "Abstract" : "";
  }

  function paintAll() {
    for (const c of COLOR_IDS) {
      const list = items.filter(it => colorOf(it.color) === c).map(posOf).filter(Boolean);
      if (list.length) A.paint(`hn-${c}`, list, { priority: 40 });
      else A.clear(`hn-${c}`);
    }
    const q = threads.map(tposOf).filter(Boolean);
    if (q.length) A.paint("hn-q", q, { priority: 39, fallback: false }); // 질문 기록: 점선 밑줄
    else A.clear("hn-q");
    scheduleBadges();
  }
  function changed() {
    paintAll();
    updateBar();
    refreshPanel();
  }

  // ---------- 저장·삭제 ----------
  // 같은 자리에 이미 있으면 그 항목을 갱신 (색·메모)
  function addItem(anchor, p, { color, note, source } = {}) {
    const same = items.find(it => samePos(posOf(it), p));
    if (same) {
      if (color) same.color = colorOf(color);
      if (note) same.note = note;
      same.type = typeOf(same);
      same.ts = Date.now();
      saveItems();
      changed();
      return { id: same.id, created: false };
    }
    const it = makeItem({ anchor, color: color || prefs.color, note, source });
    if (!it.anchor) return null;
    items.push(it);
    pos.set(it.id, p);
    saveItems();
    changed();
    return { id: it.id, created: true };
  }
  function addFromSel(s, extra = {}) {
    if (!s || !s.anchored || s.start == null || !s.text) return null;
    const p = trimRange({ start: s.start, end: s.end });
    if (p.end <= p.start) return null;
    return addItem({ quote: s.text, prefix: s.prefix, suffix: s.suffix, paraId: s.paraId || paraIdAt(p.start) }, p, extra);
  }

  // 공개 API (§6.1): {anchor | range, color?, note?, source?} → id | null. 저장·칠하기·실행 취소 토스트까지
  function add(opts = {}) {
    try {
      let anchor = null, p = null;
      if (opts.range) {
        const q = A.rangeToQuote(opts.range);
        if (!q || !q.quote) return null; // 번역문(.tr-ko) 등 색인 밖
        p = trimRange(q);
        if (p.end <= p.start) return null;
        anchor = { quote: q.quote, prefix: q.prefix, suffix: q.suffix, paraId: paraIdAt(p.start) };
      } else if (opts.anchor && opts.anchor.quote) {
        anchor = cleanAnchor(opts.anchor);
        p = locateAnchor(anchor);
        if (!p) return null;
      } else return null;
      const r = addItem(anchor, p, { color: opts.color, note: opts.note, source: opts.source });
      if (!r) return null;
      if (r.created) UI.toast("내 하이라이트에 저장했습니다", { actionLabel: "실행 취소", onAction: () => removeItem(r.id, { undo: false }) });
      else UI.toast("이미 내 하이라이트에 있습니다");
      return r.id;
    } catch (e) {
      console.error("[highlights-notes]", e);
      return null;
    }
  }

  function removeItem(id, { undo = true } = {}) {
    const i = items.findIndex(x => x.id === id);
    if (i < 0) return;
    const [it] = items.splice(i, 1);
    saveItems();
    changed();
    if (undo) {
      UI.toast("삭제됨", {
        actionLabel: "실행 취소",
        onAction: () => { items.splice(Math.min(i, items.length), 0, it); saveItems(); changed(); },
      });
    }
  }
  function deleteThread(id) {
    const i = threads.findIndex(x => x.id === id);
    if (i < 0) return;
    const [t] = threads.splice(i, 1);
    saveThreads();
    changed();
    UI.toast("삭제됨", {
      actionLabel: "실행 취소",
      onAction: () => { threads.splice(Math.min(i, threads.length), 0, t); saveThreads(); changed(); },
    });
  }
  function setColor(it, c) {
    it.color = colorOf(c);
    it.ts = Date.now();
    prefs.color = it.color; // '마지막 색'이 다음 펜 색
    savePrefs();
    saveItems();
    changed();
  }
  function setNote(it, text) {
    it.note = String(text || "").trim();
    it.type = typeOf(it);
    it.ts = Date.now();
    saveItems();
    changed();
  }

  // ---------- 질문 시트 연동 ----------
  // 세션의 인용 위치: 선택에서 왔으면 그 앵커, 아니면 인용문을 본문에서 찾아 봄, 없으면 논문 전체(null)
  function sessionAnchor(s) {
    const si = s.selInfo;
    if (si && si.anchored && si.text && si.start != null) {
      return { quote: si.text, prefix: si.prefix || "", suffix: si.suffix || "", paraId: si.paraId || paraIdAt(si.start) };
    }
    const q = oneLine(s.quote || s.selection);
    if (q.length < 4) return null;
    const o = A.locate(q);
    if (!o) return null;
    const t = A.quoteAt(A.index().text, o.start, o.end);
    return { quote: t.quote, prefix: t.prefix, suffix: t.suffix, paraId: (si && si.paraId) || paraIdAt(o.start) };
  }

  // 모든 시트 대화를 자동 저장 (질문 기록). 같은 threadId면 그 기록을 갱신
  PaperApp.on("answer-done", d => {
    if (d.restored || !d.session || !d.session.history || !d.session.history.length) return;
    const s = d.session;
    const prev = threads.find(t => t.id === String(s.threadId || s.id)) || null;
    const rec = threadRecord(s, prev, prev ? null : sessionAnchor(s));
    threads = upsertThread(threads, rec);
    tpos.delete(rec.id);
    saveThreads();
    changed();
  });

  // 답변 아래 '노트에 저장' (자리 highlights-notes 30)
  const savedItemFor = d => items.find(it => it.thread && it.thread === d.session.threadId && it.qa.some(x => x.a === d.text));
  PaperApp.addAnswerAction({
    id: "highlights-notes", order: 30,
    render: d => {
      if (!d.text || !d.session) return null;
      const b = h("button", { type: "button", class: "hn-save" });
      const sync = () => {
        const it = savedItemFor(d);
        b.textContent = it ? "노트에 저장됨 · 보기" : "노트에 저장";
        b.classList.toggle("hn-saved", !!it);
      };
      b.addEventListener("click", () => {
        const it = savedItemFor(d);
        if (it) { openItem(it.id); return; }
        saveAnswer(d);
        sync();
      });
      sync();
      return b;
    },
  });
  function saveAnswer(d) {
    const s = d.session, q = d.shown || d.question;
    let it = items.find(x => x.thread && x.thread === s.threadId);
    if (!it) {
      const t = threads.find(x => x.id === s.threadId);
      const anchor = t ? t.anchor : sessionAnchor(s), p = anchor && locateAnchor(anchor);
      // 같은 자리에 이미 하이라이트·메모가 있으면 거기에 Q&A를 붙임 (그 부분을 탭하면 한 peek에 모두)
      it = p ? items.find(x => !x.thread && samePos(posOf(x), p)) : null;
      if (it) it.thread = String(s.threadId);
      else {
        it = makeItem({ anchor, color: prefs.color, thread: s.threadId });
        items.push(it);
        if (p) pos.set(it.id, p);
      }
    }
    addQa(it, q, d.text);
    saveItems();
    changed();
    UI.toast(it.anchor ? "노트에 저장했습니다 · 그 부분을 탭하면 다시 볼 수 있습니다" : "노트에 저장했습니다 (논문 전체)");
  }

  // '내 메모 참고': 선택 없는 세션(논문에 질문)의 첫 턴 context에 <my-notes> (새 세션에서만 → 이어 가도 같은 바이트)
  PaperApp.addSessionHook(s => {
    if (!prefs.useNotes || s.selection || (s.endpoint && s.endpoint !== "/api/ask")) return;
    const digest = notesDigest(items, posMap());
    if (digest) s.context = (s.context ? s.context + "\n" : "") + `<my-notes>\n${digest}\n</my-notes>`;
  });

  function openThread(id) {
    const t = threads.find(x => x.id === id);
    if (!t) return;
    const cur = PaperApp.session;
    if (cur && cur.threadId === t.id) { PaperApp.restoreSheet(); return; } // 이미 열린(내려둔) 같은 대화
    // 처음 연 기능의 origin·프리셋도 그대로 (논문에 질문 FAB가 이 대화를 자기 것으로 다시 엶)
    PaperApp.openSheet({
      quote: t.quote, selection: t.selection, context: t.context, section: t.section, endpoint: t.endpoint,
      extra: t.extra || {}, history: t.history, shown: t.shown, meta: t.meta, title: t.title || "질문",
      presets: t.presets || null, threadId: t.id, origin: t.origin ?? "highlights-notes",
    });
  }

  // 항목의 문단·섹션 (새로 질문할 때 context)
  function contextFor(it) {
    const p = posOf(it), q = (it.anchor && it.anchor.quote) || "";
    let el = it.anchor && it.anchor.paraId ? document.getElementById(it.anchor.paraId) : null;
    if (!el && p) el = elAt(p.start)?.closest(".ltx_para, p, li, figcaption") || null;
    const sec = el && el.closest("section");
    const title = sec && [...sec.children].find(c => c.classList.contains("ltx_title"));
    return { context: el ? A.clipAround(A.textOf(el), q, 1500) : "", section: title ? A.textOf(title) : "" };
  }
  // '이어서 질문': 원래 대화가 기록에 있으면 그대로, 없으면 저장한 Q&A를 기록으로. Q&A가 없으면 새 질문 (메모는 context에)
  function askFromItem(it) {
    const t = it.thread && threads.find(x => x.id === it.thread);
    if (t) { openThread(t.id); return; }
    const quote = (it.anchor && it.anchor.quote) || "";
    const { context, section } = contextFor(it);
    if (it.qa.length) {
      PaperApp.openSheet({
        quote, selection: quote, context, section, history: flattenQa(it.qa),
        shown: it.qa.map(x => x.q), meta: it.qa.map(() => ({ label: null })), title: "저장한 Q&A", origin: "highlights-notes",
      });
      return;
    }
    const note = it.note && it.note.trim() ? `\n<my-note>\n${it.note.trim()}\n</my-note>` : "";
    PaperApp.openSheet({ quote, selection: quote, context: context + note, section, origin: "highlights-notes" });
  }

  // ---------- 화면: 바 버튼·선택 버튼·탭 ----------
  const bar = UI.addBarButton({ id: "highlights-notes", label: "노트", icon: "🖍", onClick: () => openPanel() });
  function updateBar() {
    const n = items.length;
    bar.setLabel(`노트${n ? ` ${n}` : ""}${prefs.highlighter ? " · 형광펜 켜짐" : ""}`);
    bar.setActive(prefs.highlighter);
  }

  PaperApp.addSelectionAction({
    id: "highlights-notes:highlight", label: "하이라이트", order: 30, when: s => !!s.anchored,
    onClick: s => {
      const r = addFromSel(s);
      if (!r) { UI.toast("이 부분은 하이라이트할 수 없습니다"); return; }
      document.getSelection()?.removeAllRanges();
      showQuick(r.id);
    },
  });
  PaperApp.addSelectionAction({
    id: "highlights-notes:note", label: "메모", order: 40, when: s => !!s.anchored,
    onClick: s => openMemo(s),
  });

  // 저장한 부분을 탭: 항목 peek, 질문 기록만 있는 곳이면 그 대화 (링크 위 탭은 ref-peek·cite-cards에)
  PaperApp.addTapHandler({
    id: "highlights-notes", priority: 90,
    test: e => {
      if ((!items.length && !threads.length) || e.target.closest("a[href]")) return null;
      const off = A.offsetAtPoint(e.clientX, e.clientY);
      if (off == null) return null;
      const it = hitAt(items.map(x => ({ id: x.id, ...posOf(x) })), off);
      if (it) return { kind: "item", id: it };
      // 시트가 열려 있으면 질문 기록 자리 탭은 '내려두기'로 (방금 물은 그 문장을 탭해도 시트가 다시 열리지 않게)
      if (PaperApp.isSheetOpen()) return null;
      const t = hitAt(threads.map(x => ({ id: x.id, ...tposOf(x) })), off);
      return t ? { kind: "thread", id: t } : null;
    },
    handle: (e, hit) => (hit.kind === "item" ? openItem(hit.id) : openThread(hit.id)),
  });

  // ---------- 하이라이트 직후 도구 (색 4개·메모·삭제) ----------
  let quick = null;
  function hideQuick() {
    if (!quick) return;
    quick.el.remove();
    document.removeEventListener("pointerdown", quick.off, true);
    clearTimeout(quick.timer);
    quick = null;
  }
  function swatches(it, onPick) {
    return h("div", { class: "hn-swatches", role: "group", "aria-label": "색" }, COLORS.map(c => h("button", {
      type: "button", class: "hn-sw", dataset: { c: c.id }, "aria-label": c.label, "aria-pressed": String(colorOf(it.color) === c.id),
      onclick: () => onPick(c.id),
    })));
  }
  function showQuick(id) {
    hideQuick();
    const it = items.find(x => x.id === id), p = it && posOf(it);
    const r = p && A.rangeAt(p.start, p.end);
    const rects = r ? [...r.getClientRects()].filter(b => b.width && b.height) : [];
    if (!rects.length) return;
    const el = h("div", { class: "hn-quick pr-ui", role: "toolbar", "aria-label": "하이라이트 도구" });
    const render = () => el.replaceChildren(
      swatches(it, c => { setColor(it, c); render(); restart(); }),
      h("button", { type: "button", text: "메모", onclick: () => { hideQuick(); openItem(it.id, { edit: true }); } }),
      h("button", { type: "button", text: "삭제", onclick: () => { hideQuick(); removeItem(it.id); } }),
      prefs.highlighter ? h("button", { type: "button", text: "펜 끄기", onclick: () => { hideQuick(); setPen(false); } }) : null,
    );
    render();
    document.body.append(el);
    const first = rects[0], last = rects[rects.length - 1], H = el.offsetHeight, W = el.offsetWidth;
    const top = last.bottom + 8 + H < innerHeight - 90 ? last.bottom + 8 : Math.max(8, first.top - H - 8);
    el.style.top = `${Math.round(top + scrollY)}px`;
    el.style.left = `${Math.round(Math.max(8, Math.min(first.left, innerWidth - W - 8)) + scrollX)}px`;
    const off = e => { if (!el.contains(e.target)) hideQuick(); };
    const restart = () => { clearTimeout(quick.timer); quick.timer = setTimeout(hideQuick, 6000); };
    document.addEventListener("pointerdown", off, true);
    quick = { el, off, timer: 0 };
    restart();
  }
  PaperApp.on("sheet-open", hideQuick);

  // ---------- 형광펜 모드: 선택하면 바로 칠함, 선택 버튼 줄 없음 ----------
  const root = document.documentElement;
  let penTimer = 0, penDown = false;
  function setPen(on) {
    prefs.highlighter = !!on;
    savePrefs();
    root.classList.toggle("hn-pen", prefs.highlighter);
    if (!on) root.classList.remove("hn-pen-sel");
    updateBar();
    refreshPanel();
    UI.toast(on ? "형광펜 모드: 본문을 선택하면 바로 칠합니다" : "형광펜 모드를 껐습니다");
  }
  function penCommit() {
    penTimer = 0;
    if (!prefs.highlighter) return;
    if (penDown) { penTimer = -1; return; } // 손을 떼면 다시
    const live = document.getSelection();
    const s = live && !live.isCollapsed ? PaperApp.sel() : null;
    root.classList.remove("hn-pen-sel");
    if (!s || !s.anchored) return;
    const r = addFromSel(s);
    if (!r) return;
    live.removeAllRanges();
    showQuick(r.id);
  }
  PaperApp.on("selection", s => {
    clearTimeout(penTimer);
    penTimer = 0;
    const pen = !!(prefs.highlighter && s && s.anchored);
    root.classList.toggle("hn-pen-sel", pen); // 선택 버튼 줄 숨김 (CSS)
    if (pen) penTimer = setTimeout(penCommit, 700); // 손잡이를 끄는 동안은 기다림
  });
  // 마우스 끌기만 '누르는 중'으로 셈 (터치 길게 누르기는 pointerup이 안 올 수 있음 → 700ms 대기로)
  document.addEventListener("pointerdown", e => { penDown = e.pointerType === "mouse"; }, true);
  const penUp = () => {
    penDown = false;
    if (penTimer) { clearTimeout(penTimer); penTimer = setTimeout(penCommit, 250); }
  };
  document.addEventListener("pointerup", penUp, true);
  document.addEventListener("pointercancel", penUp, true);
  root.classList.toggle("hn-pen", prefs.highlighter);

  // ---------- 메모 편집기 (Markdown 미리보기) ----------
  function memoEditor(initial, onSave, onCancel) {
    const ta = h("textarea", { class: "hn-ta", rows: "4", placeholder: "메모 (Markdown, 수식 $x$ 가능)", "aria-label": "메모" });
    ta.value = initial || "";
    const pv = h("div", { class: "hn-preview answer", "aria-label": "미리보기" });
    const draw = () => {
      const v = ta.value.trim();
      pv.hidden = !v;
      if (v) (window.renderAnswer || ((el, t) => { el.textContent = t; }))(pv, v);
    };
    ta.addEventListener("input", draw);
    ta.addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSave(ta.value); } });
    draw();
    const el = h("div", { class: "hn-editor" }, ta, pv, h("div", { class: "hn-ed-actions" },
      h("button", { type: "button", class: "primary", text: "저장", onclick: () => onSave(ta.value) }),
      onCancel ? h("button", { type: "button", text: "취소", onclick: onCancel }) : null));
    el.value = () => ta.value;
    el.focusNow = () => { try { ta.focus({ preventScroll: true }); } catch { /* 무시 */ } };
    return el;
  }
  // iOS는 탭 처리 중(동기)에 focus해야 키보드가 열림 → 입력칸에 바로 focus하고,
  // peek가 다음 프레임에 자기 상자로 옮기는 포커스(키보드가 닫힘)는 이번 한 번만 막음
  function keepFocus(close) {
    const box = close && close.el;
    if (!box) return;
    box.focus = () => {};
    requestAnimationFrame(() => requestAnimationFrame(() => { delete box.focus; }));
  }

  // 선택 → '메모': 같은 자리에 항목이 있으면 그 메모를 편집. 바깥 탭·뒤로가기로 닫아도 쓴 내용은 저장 (취소만 버림)
  function openMemo(s) {
    const p = s && s.anchored && s.start != null ? trimRange({ start: s.start, end: s.end }) : null;
    if (!p || p.end <= p.start) { UI.toast("이 부분에는 메모할 수 없습니다"); return; }
    const existing = items.find(it => samePos(posOf(it), p));
    const initial = existing ? existing.note : "";
    let done = false;
    const commit = text => {
      done = true;
      text = String(text || "").trim();
      if (existing) { if (text !== existing.note.trim()) setNote(existing, text); return; }
      if (text) addFromSel(s, { note: text });
    };
    const ed = memoEditor(initial, text => { commit(text); close("close"); }, () => { done = true; close("close"); });
    const close = UI.peek({
      title: existing ? "메모 편집" : "메모", className: "hn-peek",
      body: h("div", {}, h("blockquote", { class: "hn-quote", text: s.text }), ed),
      onClose: () => {
        if (done) return;
        const v = ed.value().trim();
        if (v && v !== initial.trim()) { commit(v); UI.toast("메모를 저장했습니다"); }
      },
    });
    keepFocus(close);
    ed.focusNow();
  }

  // ---------- 항목 peek: 인용·색·메모·저장한 Q&A·이 부분 질문 기록, 이어서 질문·삭제 ----------
  function openItem(id, { edit = false, fromPanel = false } = {}) {
    const it = items.find(x => x.id === id);
    if (!it) return;
    const body = h("div", { class: "hn-item" });
    const actions = [
      { label: it.qa.length ? "이어서 질문" : "질문하기", primary: true, onClick: ({ close }) => { close(); askFromItem(it); } },
    ];
    if (fromPanel && it.anchor) actions.push({ label: "본문 위치", onClick: ({ close }) => { close(); jumpRec(posOf(it)); } });
    actions.push({ label: "삭제", onClick: ({ close }) => { close(); removeItem(it.id); } });
    let editing = edit, ed = null;
    // 편집 중에 바깥 탭·뒤로가기로 닫아도 쓴 메모는 저장 ('취소'만 버림, 비운 경우는 저장 안 함)
    const close = UI.peek({
      title: KIND_LABEL[typeOf(it)], body, className: "hn-peek", actions, size: it.qa.length ? "large" : undefined,
      onClose: () => {
        const v = editing && ed ? ed.value().trim() : "";
        if (v && v !== (it.note || "").trim() && items.includes(it)) { setNote(it, v); UI.toast("메모를 저장했습니다"); }
      },
    });
    if (edit) keepFocus(close);
    const render = () => {
      ed = editing ? memoEditor(it.note, text => { setNote(it, text); editing = false; render(); }, () => { editing = false; render(); }) : null;
      const note = ed
        || h("div", { class: "hn-note-row" },
          it.note ? h("div", { class: "hn-note answer" }) : h("span", { class: "hn-muted", text: "메모 없음" }),
          h("button", { type: "button", class: "hn-link", text: it.note ? "메모 편집" : "메모 추가", onclick: () => { editing = true; render(); } }));
      if (!editing && it.note) renderAnswerNowSafe(note.firstChild, it.note);
      const p = posOf(it);
      const near = p ? threads.filter(t => t.id !== it.thread && overlaps(tposOf(t), p)) : [];
      body.replaceChildren(
        h("blockquote", { class: "hn-quote", dataset: { c: colorOf(it.color) }, text: it.anchor ? it.anchor.quote : "논문 전체" }),
        it.anchor ? swatches(it, c => { setColor(it, c); render(); }) : null,
        note,
        ...it.qa.map(x => {
          const a = h("div", { class: "hn-qa-a answer" });
          renderAnswerNowSafe(a, x.a);
          return h("div", { class: "hn-qa" }, h("div", { class: "hn-qa-q", text: x.q }), a);
        }),
        near.length ? h("div", { class: "hn-near" }, h("div", { class: "hn-muted", text: "이 부분 질문 기록" }),
          near.map(t => h("button", { type: "button", class: "hn-link", text: `Q · ${t.label}`, onclick: () => { close("close"); openThread(t.id); } }))) : null,
      );
      if (ed) ed.focusNow();
    };
    render();
  }
  const renderAnswerNowSafe = (el, text) => (window.renderAnswerNow ? renderAnswerNow(el, text) : (el.textContent = text));

  // ---------- 본문 옆 표시 (Q: 질문 기록, ✎: 메모·저장한 Q&A) — #paper 밖 body의 절대 위치 층 ----------
  let gutter = null, badgeTimer = 0, ro = null;
  function scheduleBadges() { clearTimeout(badgeTimer); badgeTimer = setTimeout(renderBadges, 120); }
  function renderBadges() {
    const marks = [];
    for (const t of threads) { const p = tposOf(t); if (p) marks.push({ kind: "thread", id: t.id, p, label: t.label }); }
    for (const it of items) if (typeOf(it) !== "hl") { const p = posOf(it); if (p) marks.push({ kind: "item", id: it.id, p, label: it.note || (it.qa[0] && it.qa[0].q) || "" }); }
    if (!marks.length) { gutter?.replaceChildren(); return; }
    if (!gutter) {
      gutter = h("div", { class: "hn-gutter pr-ui" });
      document.body.append(gutter);
      if (typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(scheduleBadges); ro.observe(paperEl); }
    }
    // 본문 오른쪽 여백 안 (여백을 좁게 설정해도 화면 밖으로 나가 가로 스크롤이 생기지 않게)
    const pr = paperEl.getBoundingClientRect();
    const x = Math.round(Math.min(pr.right - (parseFloat(getComputedStyle(paperEl).paddingRight) || 16) + 1,
      document.documentElement.clientWidth - 16) + scrollX);
    const rows = [];
    for (const m of marks) {
      const r = A.rangeAt(m.p.start, m.p.end);
      const b = r && [...r.getClientRects()].find(c => c.width > 0 && c.height > 0); // 숨은 글(번역 모드 원문)은 건너뜀
      if (!b) continue;
      const top = Math.round(b.top + scrollY);
      const row = rows.find(w => Math.abs(w.top - top) < 12);
      if (row) row.marks.push(m); else rows.push({ top, h: Math.round(b.height), marks: [m] });
    }
    gutter.replaceChildren(...rows.map(row => {
      const q = row.marks.some(m => m.kind === "thread");
      const btn = h("button", {
        type: "button", class: `hn-badge${q ? " hn-badge-q" : ""}`, text: q ? "Q" : "✎",
        "aria-label": q ? "질문 기록 열기" : "메모 열기", onclick: () => openMarks(row.marks),
      });
      btn.style.top = `${row.top + Math.max(0, (row.h - 18) / 2)}px`;
      btn.style.left = `${x}px`;
      return btn;
    }));
  }
  function openMarks(marks) {
    if (marks.length === 1) { const m = marks[0]; m.kind === "item" ? openItem(m.id) : openThread(m.id); return; }
    const list = h("div", { class: "hn-list" });
    const close = UI.peek({ title: "이 줄의 노트", body: list, className: "hn-peek" });
    list.append(...marks.map(m => h("button", {
      type: "button", class: "hn-row-main", onclick: () => { close("close"); m.kind === "item" ? openItem(m.id) : openThread(m.id); },
    }, h("span", { class: "hn-row-title", text: `${m.kind === "thread" ? "Q" : "✎"} ${clip(oneLine(m.label), 80)}` }))));
  }
  window.addEventListener("resize", scheduleBadges);
  // 넓은 화면에서는 시트가 열리면 본문이 옆으로 비킴 (크기는 그대로라 ResizeObserver가 못 잡음)
  for (const ev of ["dom-changed", "settings", "translations", "reveal", "sheet-open", "sheet-close"]) PaperApp.on(ev, scheduleBadges);

  // ---------- 내 노트 패널 (바 버튼 '노트'): 노트 | 질문 기록, 문서 순서, 색 필터, 펜·메모 참고, 내보내기 ----------
  let panel = null;
  const FILTERS = [["all", "전체"], ...COLORS.map(c => [c.id, c.label]), ["note", "메모"], ["qa", "Q&A"]];
  const passes = (it, f) => f === "all" || (f === "note" ? !!(it.note && it.note.trim()) : f === "qa" ? it.qa.length > 0 : colorOf(it.color) === f);
  const dateStr = ts => { try { return new Date(ts).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" }); } catch { return ""; } };

  function openPanel(tab = "notes") {
    const body = h("div", { class: "hn-panel" });
    const close = UI.peek({ title: "내 노트", body, size: "large", className: "hn-peek hn-panel-peek", onClose: () => { panel = null; } });
    panel = { close, body, tab, filter: "all" };
    renderPanel();
  }
  function refreshPanel() { if (panel) renderPanel(); }
  function jumpRec(p) {
    if (!p) { UI.toast("본문에서 위치를 찾지 못했습니다"); return; }
    panel?.close("close");
    PaperNav.jumpTo(p);
  }
  function toggle(label, on, fn, hint) {
    const input = h("input", { type: "checkbox" });
    input.checked = on;
    input.addEventListener("change", () => fn(input.checked));
    return h("label", { class: "hn-toggle", title: hint || label }, input, h("span", { text: label }));
  }
  function renderPanel() {
    const P = panel, scroller = P.close.el, y = scroller.scrollTop;
    const tabBtn = (id, label) => h("button", {
      type: "button", role: "tab", class: "hn-tab", "aria-selected": String(P.tab === id), text: label,
      onclick: () => { P.tab = id; renderPanel(); },
    });
    const tools = h("div", { class: "hn-tools" },
      toggle("형광펜 모드", prefs.highlighter, v => setPen(v), "선택하면 바로 칠하고 선택 버튼 줄을 숨김"),
      toggle("내 메모 참고", prefs.useNotes, v => { prefs.useNotes = v; savePrefs(); UI.toast(v ? "'논문에 질문'할 때 내 하이라이트·메모를 함께 보냅니다" : "내 메모 참고를 껐습니다"); },
        "논문 전체 질문의 첫 턴에 내 하이라이트·메모(1500자까지)를 붙임"),
      h("button", { type: "button", class: "hn-btn", text: "복사", onclick: () => UI.copy(exportMd(), "노트를 Markdown으로 복사했습니다") }),
      h("button", { type: "button", class: "hn-btn", text: ".md 다운로드", onclick: () => downloadMd() }));
    const kids = [h("div", { class: "hn-tabs", role: "tablist" }, tabBtn("notes", `노트 ${items.length}`), tabBtn("threads", `질문 기록 ${threads.length}`)), tools];
    if (P.tab === "notes") {
      kids.push(h("div", { class: "hn-filters", role: "group", "aria-label": "필터" }, FILTERS.map(([id, label]) => h("button", {
        type: "button", class: "hn-chip", dataset: { c: id }, "aria-pressed": String(P.filter === id), text: label,
        onclick: () => { P.filter = id; renderPanel(); },
      }))));
      const list = sortByPosition(items.filter(it => passes(it, P.filter)), posMap());
      kids.push(list.length ? h("div", { class: "hn-list" }, sectioned(list, posOf, itemRow))
        : h("p", { class: "hn-empty", text: items.length ? "이 필터에 맞는 노트가 없습니다." : "아직 노트가 없습니다. 본문을 선택하고 '하이라이트'나 '메모'를 누르거나, 답변 아래 '노트에 저장'을 누르세요." }));
    } else {
      const list = sortByPosition(threads, tposMap());
      kids.push(list.length ? h("div", { class: "hn-list" }, sectioned(list, tposOf, threadRow))
        : h("p", { class: "hn-empty", text: "질문하면 대화가 여기에 자동으로 저장됩니다. 다시 열어 이어서 물을 수 있습니다." }));
    }
    P.body.replaceChildren(...kids);
    scroller.scrollTop = y;
  }
  // 섹션이 바뀌는 곳마다 작은 제목 (문서 순서 목록)
  const sectioned = (list, at, row) => groupRuns(list, x => sectionAt(at(x)))
    .flatMap(run => [run.section ? h("div", { class: "hn-sec", text: run.section }) : null, ...run.items.map(row)]);
  function itemRow(it) {
    const p = posOf(it);
    const main = h("button", { type: "button", class: "hn-row-main", onclick: () => (it.anchor ? jumpRec(p) : openItem(it.id, { fromPanel: true })) },
      h("span", { class: "hn-row-quote", text: it.anchor ? it.anchor.quote : "논문 전체" }),
      it.note && it.note.trim() ? h("span", { class: "hn-row-note", text: it.note.trim() }) : null,
      it.qa.length ? h("span", { class: "hn-row-meta", text: `Q&A ${it.qa.length} · ${clip(oneLine(it.qa[0].q), 40)}` }) : null,
      it.anchor && !p ? h("span", { class: "hn-row-meta", text: "본문에서 위치를 찾지 못함" }) : null);
    return h("div", { class: "hn-row", dataset: { c: colorOf(it.color) } }, main,
      h("button", { type: "button", class: "hn-row-x", "aria-label": "열기", text: "⋯", onclick: () => openItem(it.id, { fromPanel: true }) }));
  }
  function threadRow(t) {
    const p = tposOf(t), n = Math.floor(t.history.length / 2);
    const main = h("button", { type: "button", class: "hn-row-main", onclick: () => openThread(t.id) },
      h("span", { class: "hn-row-title", text: t.label }),
      t.quote ? h("span", { class: "hn-row-quote", text: t.quote }) : h("span", { class: "hn-row-meta", text: "논문 전체 질문" }),
      h("span", { class: "hn-row-meta", text: `답변 ${n}개 · ${dateStr(t.ts)}` }));
    return h("div", { class: "hn-row hn-row-t" }, main,
      p ? h("button", { type: "button", class: "hn-row-x", "aria-label": "본문 위치로", text: "📍", onclick: () => jumpRec(p) }) : null,
      h("button", { type: "button", class: "hn-row-x", "aria-label": "기록 삭제", text: "✕", onclick: () => deleteThread(t.id) }));
  }

  // ---------- 내보내기 ----------
  const paperTitle = () => A.textOf(paperEl.querySelector(".ltx_title_document")) || document.title;
  const exportMd = () => toMarkdown({ title: paperTitle(), id: PaperApp.arxivId }, items, {
    pos: posMap(), threads, tpos: tposMap(), date: new Date().toISOString().slice(0, 10),
    sections: Object.fromEntries(items.map(it => [it.id, sectionAt(posOf(it))])),
  });
  const downloadMd = () => UI.download(`notes-${PaperApp.baseId || "paper"}.md`, exportMd(), "text/markdown");

  // 다른 탭에서 바뀌면 다시 읽음
  window.addEventListener("storage", e => {
    if (e.key === S.paperKey(NS)) { items = loadList(NS).map(x => ({ ...x, qa: Array.isArray(x.qa) ? x.qa : [], anchor: cleanAnchor(x.anchor) })); pos.clear(); changed(); }
    else if (e.key === S.paperKey(TNS)) { threads = loadList(TNS).filter(t => Array.isArray(t.history)); tpos.clear(); changed(); }
  });

  // 처음 칠하기는 한가할 때 (저장한 것이 있을 때만: 본문 색인 만들기 비용)
  updateBar();
  if (items.length || threads.length) {
    (window.requestIdleCallback ? f => requestIdleCallback(f, { timeout: 800 }) : f => setTimeout(f, 50))(() => paintAll());
  }
})();
