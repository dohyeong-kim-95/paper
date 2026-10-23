// PaperAnchor: 본문(#paper)의 평면 텍스트 색인 + 인용문 위치 찾기 + 칠하기(CSS Highlight)
// PaperNav: 본문 위치로 점프 + '↩ 돌아가기' (시스템 뒤로가기와 연동)
// 위치의 기준은 색인 텍스트의 오프셋 {start, end}. 색인은 .pr-ui/.tr-ko/각주 본문/참고문헌을 건너뛰고
// <math>는 " $alttext$ " 한 덩어리로 셈 → 기능들이 UI를 끼워 넣어도(.pr-ui) 오프셋은 그대로.
(function () {
  "use strict";

  // ---------- 순수 함수 (node 테스트) ----------
  const SINGLE_Q = /[‘’‚‛′`´]/;
  const DOUBLE_Q = /[“”„‟″]/;
  const DASH = /[‐-―−]/;
  const INVISIBLE = /[­​-‍﻿]/;
  const NO_SPACE_BEFORE = /[.,;:!?)\]}]/;
  const NO_SPACE_AFTER = /[([{]/;

  function normChar(ch) {
    if (SINGLE_Q.test(ch)) return "'";
    if (DOUBLE_Q.test(ch)) return '"';
    if (DASH.test(ch)) return "-";
    return ch.toLowerCase();
  }

  // 정규화 문자열 + (정규화 위치 → 원문 위치) 표. 소문자·따옴표·대시 통일, 공백 하나로,
  // 구두점 앞/여는 괄호 뒤 공백 제거 ("width $x$ ." == "width $x$.")
  function normMap(text) {
    let norm = "", pendingSpace = -1;
    const map = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (/\s/.test(ch)) { if (pendingSpace < 0) pendingSpace = i; continue; }
      if (INVISIBLE.test(ch)) continue;
      const n = normChar(ch);
      if (pendingSpace >= 0 && norm && !NO_SPACE_BEFORE.test(n) && !NO_SPACE_AFTER.test(norm[norm.length - 1])) {
        norm += " ";
        map.push(pendingSpace);
      }
      pendingSpace = -1;
      norm += n;
      for (let k = 0; k < n.length; k++) map.push(i);
    }
    map.push(text.length);
    return { norm, map };
  }
  const normalize = s => normMap(String(s ?? "")).norm;

  function allIndexes(hay, needle, lo = 0, hi = hay.length, limit = 200) {
    const out = [];
    for (let i = hay.indexOf(needle, lo); i >= 0 && i + needle.length <= hi && out.length < limit; i = hay.indexOf(needle, i + 1)) out.push(i);
    return out;
  }
  const commonSuffix = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++; return n; };
  const commonPrefix = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; };
  const lowerBound = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };

  // text 안에서 quote 위치 찾기 → {start, end} (원문 오프셋) | null
  // 1) 정규화 후 정확히 일치 (prefix/suffix가 있으면 가장 잘 맞는 후보), 2) 앞 8단어로 찾고 끝 8단어까지 확장
  // opts: {prefix, suffix, from, to (원문 오프셋 범위), nm (미리 계산한 normMap)}
  function locateIn(text, quote, opts = {}) {
    const nm = opts.nm || normMap(text);
    const q = normalize(quote);
    if (!q) return null;
    const lo = opts.from ? lowerBound(nm.map, opts.from) : 0;
    const hi = opts.to != null ? lowerBound(nm.map, opts.to) : nm.norm.length;
    const pre = normalize(opts.prefix || ""), suf = normalize(opts.suffix || "");
    const best = (hits, len) => {
      if (hits.length <= 1 || (!pre && !suf)) return hits[0] ?? -1;
      let bi = hits[0], bs = -1;
      for (const i of hits) {
        const s = commonSuffix(nm.norm.slice(Math.max(0, i - pre.length - 1), i).trimEnd(), pre)
          + commonPrefix(nm.norm.slice(i + len, i + len + suf.length + 1).trimStart(), suf);
        if (s > bs) { bs = s; bi = i; }
      }
      return bi;
    };
    const span = (i, len) => ({ start: nm.map[i], end: nm.map[i + len - 1] + 1 });
    let i = best(allIndexes(nm.norm, q, lo, hi), q.length);
    if (i >= 0) return span(i, q.length);
    const words = q.split(" ");
    if (words.length <= 8) return null;
    const head = words.slice(0, 8).join(" "), tail = words.slice(-8).join(" ");
    i = best(allIndexes(nm.norm, head, lo, hi), head.length);
    if (i < 0) return null;
    const j = nm.norm.indexOf(tail, i + head.length);
    const end = j >= 0 && j + tail.length - i <= q.length * 1.5 ? j + tail.length : i + head.length;
    return span(i, end - i);
  }

  // 인용 앞뒤 문맥 (저장용): {quote, prefix, suffix, start, end}
  function quoteAt(text, start, end, ctx = 32) {
    return {
      quote: text.slice(start, end).replace(/\s+/g, " ").trim(),
      prefix: text.slice(Math.max(0, start - ctx), start),
      suffix: text.slice(end, end + ctx),
      start, end,
    };
  }

  // 긴 문단에서 needle 주변만 max자로 자르기
  function clipAround(full, needle, max = 1500) {
    if (full.length <= max) return full;
    const at = needle ? full.indexOf(needle.slice(0, 40)) : -1;
    const from = Math.max(0, Math.min(full.length - max, (at < 0 ? 0 : at) - Math.floor((max - Math.min(needle?.length || 0, max)) / 2)));
    return (from > 0 ? "…" : "") + full.slice(from, from + max) + (from + max < full.length ? "…" : "");
  }

  const api = { normalize, normMap, locateIn, quoteAt, clipAround, lowerBound };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;

  // ---------- 색인 (DOM) ----------
  const SKIP_CLASS = ["pr-ui", "tr-ko", "ltx_note_outer", "ltx_bibliography"];
  const SKIP_TAG = new Set(["script", "style", "button", "noscript", "template"]);
  const skip = el => SKIP_TAG.has(el.localName) || SKIP_CLASS.some(c => el.classList.contains(c));
  const mathText = m => ` $${m.getAttribute("alttext") || m.textContent.trim()}$ `;
  const root = () => document.getElementById("paper");

  function walk(rootEl, onText, onMath, skipRoot = false) {
    const visit = node => {
      for (let n = node.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) onText(n);
        else if (n.nodeType === 1) {
          if (n.localName === "math") onMath(n);
          else if (!skip(n)) visit(n);
        }
      }
    };
    if (rootEl.nodeType === 1 && rootEl.localName === "math") onMath(rootEl);
    else if (!(skipRoot && skip(rootEl))) visit(rootEl);
  }

  // 요소의 텍스트 (수식은 $alttext$, .pr-ui·번역·각주 본문 제외), 공백 정리
  function textOf(el) {
    if (!el) return "";
    const parts = [];
    walk(el, n => parts.push(n.data), m => parts.push(mathText(m)));
    return parts.join("").replace(/\s+/g, " ").trim();
  }

  let cache = null;
  const mo = typeof MutationObserver !== "undefined" ? new MutationObserver(() => { cache = null; }) : null;
  let observed = null;

  // {text, segs: [{node, start, end, math}], nodeSeg: WeakMap}
  function index() {
    const r = root();
    if (!r) return { text: "", segs: [], nodeSeg: new WeakMap(), root: null };
    if (mo && observed !== r) { mo.observe(r, { childList: true, subtree: true, characterData: true }); observed = r; }
    if (mo && mo.takeRecords().length) cache = null;
    if (cache && cache.root === r) return cache;
    const segs = [], parts = [], nodeSeg = new WeakMap();
    let pos = 0;
    const add = (node, t, math) => {
      if (!t) return;
      const seg = { node, start: pos, end: pos + t.length, math };
      segs.push(seg);
      nodeSeg.set(node, seg);
      parts.push(t);
      pos += t.length;
    };
    walk(r, n => add(n, n.data, false), m => add(m, mathText(m), true));
    cache = { text: parts.join(""), segs, nodeSeg, root: r, nm: null };
    return cache;
  }
  const invalidate = () => { cache = null; };
  const nmOf = idx => idx.nm || (idx.nm = normMap(idx.text));

  // offset이 들어 있는 세그먼트 (isEnd면 offset 바로 앞 글자의 세그먼트)
  function segAt(segs, offset, isEnd) {
    let lo = 0, hi = segs.length - 1, ans = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (segs[m].start < offset || (!isEnd && segs[m].start === offset)) { ans = m; lo = m + 1; } else hi = m - 1;
    }
    return ans < 0 ? (segs.length ? segs[0] : null) : segs[ans];
  }

  function rangeAt(start, end, idx = index()) {
    if (!idx.segs.length || start == null || end == null || end < start) return null;
    const a = segAt(idx.segs, start, false), b = segAt(idx.segs, Math.max(end, start), true);
    if (!a || !b) return null;
    const r = document.createRange();
    if (a.math) r.setStartBefore(a.node); else r.setStart(a.node, Math.min(Math.max(0, start - a.start), a.node.length));
    if (b.math) r.setEndAfter(b.node); else r.setEnd(b.node, Math.min(Math.max(0, end - b.start), b.node.length));
    return r;
  }

  // DOM 위치 → 색인 오프셋
  function pointToOffset(node, offset, isEnd, idx = index()) {
    if (!node || !idx.segs.length) return null;
    const el = node.nodeType === 1 ? node : node.parentElement;
    const math = el && el.closest("math");
    if (math && idx.nodeSeg.has(math)) { const s = idx.nodeSeg.get(math); return isEnd ? s.end : s.start; }
    if (node.nodeType === 3 && idx.nodeSeg.has(node)) { const s = idx.nodeSeg.get(node); return s.start + Math.min(offset, node.length); }
    // 요소 경계: 그 지점 뒤에 오는 첫 세그먼트의 시작
    const pt = document.createRange();
    try { pt.setStart(node, offset); } catch { return null; }
    let lo = 0, hi = idx.segs.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (pt.comparePoint(idx.segs[m].node, 0) < 0) lo = m + 1; else hi = m;
    }
    return lo < idx.segs.length ? idx.segs[lo].start : idx.text.length;
  }

  function offsetsOf(range, idx = index()) {
    if (!range) return null;
    const start = pointToOffset(range.startContainer, range.startOffset, false, idx);
    const end = pointToOffset(range.endContainer, range.endOffset, true, idx);
    return start == null || end == null ? null : { start, end: Math.max(start, end) };
  }

  // 요소가 차지하는 색인 범위
  function offsetsOfElement(el, idx = index()) {
    let start = null, end = null;
    for (const s of idx.segs) {
      if (el.contains(s.node)) { if (start === null) start = s.start; end = s.end; }
      else if (start !== null) break;
    }
    return start === null ? null : { start, end };
  }

  // 인용문 → {start, end} | null. opts: {root: Element(범위 제한), prefix, suffix}
  function locate(quote, opts = {}) {
    const idx = index();
    let from, to;
    if (opts.root) {
      const o = offsetsOfElement(opts.root, idx);
      if (!o) return null;
      from = o.start; to = o.end;
    }
    return locateIn(idx.text, quote, { prefix: opts.prefix, suffix: opts.suffix, from, to, nm: nmOf(idx) });
  }
  function findQuote(quote, opts = {}) {
    const o = locate(quote, opts);
    return o ? rangeAt(o.start, o.end) : null;
  }
  // 선택 범위 → 저장용 인용 (수식은 $alttext$라 다시 찾을 수 있음)
  function rangeToQuote(range) {
    const idx = index();
    const o = offsetsOf(range, idx);
    return o ? quoteAt(idx.text, o.start, o.end) : null;
  }

  // 화면 좌표 → 색인 오프셋 (탭 위치가 칠한 구간 안인지 판정할 때)
  function offsetAtPoint(x, y) {
    let node, off;
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (!p) return null;
      node = p.offsetNode; off = p.offset;
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (!r) return null;
      node = r.startContainer; off = r.startOffset;
    } else return null;
    const r = root();
    return r && r.contains(node) ? pointToOffset(node, off, false) : null;
  }

  // ---------- 칠하기: CSS Custom Highlight API, 없으면 <mark> 감싸기 ----------
  const hasHL = () => typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined";
  const painted = new Map(); // name -> {items: [{start,end}], marks: [Element], priority}

  function paint(name, items, { priority = 0 } = {}) {
    clear(name);
    const offs = (items || []).map(it => (it && typeof it.start === "number" && !("startContainer" in it) ? it : offsetsOf(it))).filter(Boolean);
    const entry = { items: offs, marks: [], priority };
    painted.set(name, entry);
    render(name, entry);
    return offs;
  }
  function render(name, entry) {
    if (hasHL()) {
      const ranges = entry.items.map(o => rangeAt(o.start, o.end)).filter(Boolean);
      if (!ranges.length) { CSS.highlights.delete(name); return; }
      const hl = new Highlight(...ranges);
      hl.priority = entry.priority;
      CSS.highlights.set(name, hl);
    } else {
      for (const o of entry.items) entry.marks.push(...wrap(o.start, o.end, () => {
        const m = document.createElement("mark");
        m.className = `pa-mark pa-mark-${name}`;
        return m;
      }, { silent: true }));
      if (entry.marks.length) changed();
    }
  }
  function clear(name) {
    const e = painted.get(name);
    if (!e) return;
    painted.delete(name);
    if (hasHL()) CSS.highlights.delete(name);
    if (e.marks.length) unwrap(e.marks);
  }
  // 탭한 점이 칠한 구간 안이면 그 항목의 번호, 아니면 -1
  function paintedAt(name, x, y) {
    const e = painted.get(name);
    if (!e) return -1;
    const off = offsetAtPoint(x, y);
    if (off == null) return -1;
    return e.items.findIndex(o => off >= o.start && off < o.end);
  }

  // ---------- 안전한 DOM 변경 (glossary·section-translate만 사용) ----------
  // 색인 구간의 텍스트 노드를 잘라 make()가 만든 요소로 감쌈. 텍스트·순서는 그대로라 오프셋 불변.
  function wrap(start, end, make, { silent = false } = {}) {
    const idx = index(), els = [];
    for (const seg of idx.segs.slice()) {
      if (seg.end <= start || seg.start >= end) continue;
      const w = make();
      if (seg.math) { seg.node.before(w); w.append(seg.node); els.push(w); continue; }
      let node = seg.node;
      const a = Math.max(start, seg.start) - seg.start, b = Math.min(end, seg.end) - seg.start;
      if (b <= a || !node.data.slice(a, b).trim()) continue;
      if (b < node.length) node.splitText(b);
      if (a > 0) node = node.splitText(a);
      node.before(w);
      w.append(node);
      els.push(w);
    }
    invalidate();
    if (!silent) changed();
    return els;
  }
  function unwrap(els) {
    for (const w of els) {
      if (!w.parentNode) continue;
      while (w.firstChild) w.before(w.firstChild);
      w.remove();
    }
    invalidate();
    changed();
  }
  // 본문 노드를 움직였으면 호출 → 다른 기능들이 칠하기를 다시 함
  let changeTimer;
  function changed() {
    invalidate();
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      if (hasHL()) for (const [name, e] of painted) render(name, e);
      document.dispatchEvent(new CustomEvent("paper:dom-changed"));
    }, 0);
  }
  // 기능이 본문에 끼워 넣는 UI는 반드시 pr-ui (색인·선택·복제에서 빠짐)
  function insertUI(ref, el, where = "afterend") {
    el.classList.add("pr-ui");
    ref.insertAdjacentElement(where, el);
    return el;
  }

  // 잠깐 강조 (1.5초)
  function flash(target) {
    if (!target) return;
    if (target instanceof Element) {
      target.classList.remove("pa-flash");
      void target.offsetWidth;
      target.classList.add("pa-flash");
      setTimeout(() => target.classList.remove("pa-flash"), 1600);
      return;
    }
    if (hasHL()) {
      CSS.highlights.set("pa-flash", new Highlight(target));
      setTimeout(() => CSS.highlights.delete("pa-flash"), 1500);
    } else {
      const el = target.startContainer.nodeType === 1 ? target.startContainer : target.startContainer.parentElement;
      flash(el && el.closest(".ltx_para, p, li, figure, table, section") || el);
    }
  }

  window.PaperAnchor = Object.assign(api, {
    root, index, invalidate, textOf, rangeAt, offsetsOf, offsetsOfElement, pointToOffset, locate, findQuote,
    rangeToQuote, offsetAtPoint, paint, clear, paintedAt, wrap, unwrap, changed, insertUI, flash,
  });

  // ---------- PaperNav ----------
  const backStack = []; // [{y, close}]
  const chip = () => document.getElementById("back-chip");
  const updateChip = () => { const c = chip(); if (c) c.hidden = !backStack.length; };

  function jumpTo(target, opts = {}) {
    let range = null, el = null;
    if (!target) return false;
    if (target instanceof Element) el = target;
    else if (typeof Range !== "undefined" && target instanceof Range) range = target;
    else if (typeof target.start === "number") range = rangeAt(target.start, target.end);
    if (!el && !range) return false;
    const block = el || (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement);
    // 숨겨진 곳(번역 모드의 원문 등)이면 기능이 먼저 드러내도록
    document.dispatchEvent(new CustomEvent("paper:reveal", { detail: { el: block, range } }));
    const fromY = window.scrollY;
    const rect = (range || el).getBoundingClientRect();
    const top = window.scrollY + rect.top - window.innerHeight * 0.35;
    window.scrollTo({ top: Math.max(0, top), behavior: opts.smooth === false ? "auto" : "smooth" });
    if (opts.flash !== false) flash(range || el);
    if (opts.back !== false) {
      const entry = { y: fromY };
      const restore = () => {
        backStack.splice(backStack.indexOf(entry), 1);
        updateChip();
        window.scrollTo({ top: entry.y, behavior: "auto" });
      };
      entry.close = window.PaperUI ? PaperUI.layer(restore, { kind: "jump" }) : restore;
      backStack.push(entry);
      updateChip();
    }
    document.dispatchEvent(new CustomEvent("paper:jump", { detail: { el: block, range } }));
    return true;
  }
  function back() {
    const e = backStack[backStack.length - 1];
    if (!e) return false;
    e.close("close");
    return true;
  }
  document.addEventListener("click", e => {
    if (e.target.closest && e.target.closest("#back-chip")) { e.preventDefault(); back(); }
  });

  window.PaperNav = { jumpTo, back, get depth() { return backStack.length; } };
})();
