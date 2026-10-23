// ref-peek: 수식·그림·표·섹션·정리·각주 참조를 그 자리에서 미리보기 (+ 언급한 곳 목록, 답변 속 참조 탭)
(function () {
  "use strict";

  // ---------- 순수 함수 (node 테스트 대상) ----------
  // "#S2.E1" | "S2.E1" | "…#S2.E1" → "S2.E1"
  function idFromHref(href) {
    let s = String(href ?? "").trim();
    const i = s.indexOf("#");
    if (i >= 0) s = s.slice(i + 1);
    try { s = decodeURIComponent(s); } catch { /* 그대로 */ }
    return s;
  }

  // LaTeXML id 모양으로 세부 종류 판별. 참고문헌(#bib.*)은 cite-cards 몫이라 null
  function refKind(href) {
    const id = idFromHref(href);
    if (!id || /^bib(\.|$)/.test(id)) return null;
    if (/(^|\.)(E|Ex|EGx)\d+/.test(id)) return "equation"; // S2.E1, S2.Ex1(번호 없음), A1.E4, S2.EGx1(정렬 묶음)
    if (/(^|\.)F\d+/.test(id)) return "figure"; // S2.F1, S2.F2.sf1(하위 그림)
    if (/(^|\.)T\d+/.test(id)) return "table";
    if (/(^|\.)alg(orithm)?\d+/i.test(id)) return "algorithm";
    if (/(^|\.)Thm/.test(id)) return "theorem"; // Thmtheorem1, Thmlemma2
    if (/^footnote/.test(id)) return "footnote";
    if (/^S\d+(\.(SS|SSS|P|Px)\d+)*$/.test(id)) return "section";
    if (/\.p\d+$/.test(id)) return "para";
    if (/^A\d/.test(id)) return "appendix";
    return "other";
  }
  // 큰 분류: 표·알고리즘도 figure 요소라 figure
  function classifyHref(href) {
    const k = refKind(href);
    return k === "table" || k === "algorithm" ? "figure" : k;
  }

  // 참조 이름 → 열쇠 낱말 (그림 3 = Figure 3 = fig:3)
  const WORD = {
    figure: "fig", figures: "fig", fig: "fig", figs: "fig", 그림: "fig",
    table: "tab", tables: "tab", tab: "tab", 표: "tab",
    algorithm: "alg", algorithms: "alg", alg: "alg", 알고리즘: "alg",
    equation: "eq", equations: "eq", eq: "eq", eqs: "eq", 식: "eq", 수식: "eq",
    section: "sec", sections: "sec", sec: "sec", secs: "sec", sect: "sec", appendix: "sec", app: "sec", 부록: "sec", 섹션: "sec",
    theorem: "theorem", theorems: "theorem", thm: "theorem", 정리: "theorem",
    lemma: "lemma", lemmas: "lemma", lem: "lemma", 보조정리: "lemma",
    proposition: "proposition", propositions: "proposition", prop: "proposition", 명제: "proposition",
    corollary: "corollary", corollaries: "corollary", cor: "corollary", 따름정리: "corollary",
    definition: "definition", definitions: "definition", def: "definition", 정의: "definition",
    assumption: "assumption", assumptions: "assumption", 가정: "assumption",
    remark: "remark", remarks: "remark", conjecture: "conjecture", conjectures: "conjecture", claim: "claim", claims: "claim",
  };
  const wordOf = w => { const k = String(w).toLowerCase().replace(/\.$/, ""); return WORD[k] || k; };
  const refKey = (word, n) => `${wordOf(word)}:${String(n).toLowerCase().replace(/\s+/g, "")}`;
  const fold = s => String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

  // "Figure 1: " → "Figure 1", "§2" → "2"
  const cleanTag = s => String(s ?? "").replace(/\s+/g, " ").trim().replace(/^§\s*/, "").replace(/\s*[:.]$/, "").trim();

  // 참고문헌 꼬리표·인용 링크 글자 → 열쇠. "[1]" → bib:1, "Shazeer et al. (2017)" → cite:shazeer:2017, cite:shazeer
  // numeric: false면 숫자만 있는 글자(연도만 링크인 "2017" 등)는 버림
  function bibKeys(text, numeric = true) {
    const t = cleanTag(text);
    let m = t.match(/^\[?(\d+)\]?$/);
    if (m) return numeric ? [refKey("bib", m[1])] : [];
    m = t.match(/^\[?\s*(\p{L}[\p{L}'’-]*(?:\s+[\p{L}'’-]+)*?)(?=\s+et\s+al|\s+and\s|\s*&|\s*,|\s*\(|\s+(?:19|20)\d{2}|\s*\]|$)/u);
    if (!m) return [];
    const s = fold(m[1].split(/\s+/).pop());
    const y = t.match(/((?:19|20)\d{2})[a-z]?/);
    return y ? [`cite:${s}:${y[1]}`, `cite:${s}`] : [`cite:${s}`];
  }

  // 대상의 꼬리표(.ltx_tag_*) 글자 → 열쇠. kind: equation | section | bibitem | 그 밖(figure·table·float·theorem)
  function tagKeys(kind, text) {
    const t = cleanTag(text);
    if (!t) return [];
    let m;
    if (kind === "equation") return (m = t.match(/^\(?\s*([\w.]+?)\s*\)?$/)) ? [refKey("eq", m[1])] : [];
    if (kind === "section") return (m = t.match(/^(?:(?:Appendix|Section|Chapter|Part)\s+)?([A-Z]|\d+)((?:\.\d+)*)$/i)) ? [refKey("sec", m[1] + m[2])] : [];
    if (kind === "bibitem") return bibKeys(t);
    return (m = t.match(/^([A-Za-z]+\.?)\s*([A-Z]?\d+(?:\.\d+)*[a-z]?)$/)) ? [refKey(m[1], m[2])] : [];
  }

  // 답변 글 속 참조 찾기: "Figure 3", "그림 3", "Table 2", "표 2", "Eq. (5)", "식 (5)", "Section 4.2", "4.2절", "§4",
  // "Appendix A", "부록 A", "Theorem 1", "정리 1", "Algorithm 1", "[12]", "Shazeer et al." → [{start, end, keys}]
  const B = "(?<![\\p{L}\\d])"; // 앞이 글자·숫자가 아님 (한국어 낱말 속 '표'·'식' 등 제외)
  const NUM = "([A-Z]?\\d+(?:\\.\\d+)*)";
  const THM = "[Tt]heorems?|[Tt]hm\\.|[Ll]emmas?|[Ll]em\\.|[Pp]ropositions?|[Pp]rop\\.|[Cc]orollar(?:y|ies)|[Cc]or\\.|[Dd]efinitions?|[Dd]ef\\.|[Aa]ssumptions?|[Rr]emarks?|[Cc]onjectures?|[Cc]laims?|보조정리|따름정리|정리|명제|정의|가정";
  const SUR = "(\\p{Lu}[\\p{L}'’\\-]*)";
  const withLetter = (w, n, l) => (l ? [refKey(w, n + l), refKey(w, n)] : [refKey(w, n)]);
  const MENTIONS = [
    [new RegExp(`${B}(?:[Ff]ig(?:ure)?s?\\.?|그림)\\s*${NUM}(?:\\s?\\(([a-z])\\)|([a-z])(?![A-Za-z]))?`, "gu"), m => withLetter("fig", m[1], m[2] || m[3])],
    [new RegExp(`${B}(?:[Tt]ables?|[Tt]ab\\.|표)\\s*${NUM}`, "gu"), m => [refKey("tab", m[1])]],
    [new RegExp(`${B}(?:[Aa]lgorithms?|[Aa]lg\\.|알고리즘)\\s*${NUM}`, "gu"), m => [refKey("alg", m[1])]],
    [new RegExp(`${B}(?:[Ee]q(?:uation)?s?\\.?|수식|식)\\s*(?:\\(([A-Z]?\\d+(?:\\.\\d+)*[a-z]?)\\)|(\\d+(?:\\.\\d+)*)(?![A-Za-z\\d]))`, "gu"), m => [refKey("eq", m[1] || m[2])]],
    [/\(([A-Z]?\d+(?:\.\d+)*[a-z]?)\)\s?(?:수식|식)/gu, m => [refKey("eq", m[1])]],
    [new RegExp(`${B}(?:[Ss]ections?|[Ss]ecs?\\.|[Ss]ect\\.|섹션|§|[Aa]ppendix|[Aa]pp\\.|부록)\\s*([A-Z](?:\\.\\d+)*|\\d+(?:\\.\\d+)*)(?![A-Za-z\\d])`, "gu"), m => [refKey("sec", m[1])]],
    [/(?<![\d.])(\d+(?:\.\d+)*)\s?절/gu, m => [refKey("sec", m[1])]],
    [new RegExp(`${B}(${THM})\\s*(\\d+(?:\\.\\d+)*)`, "gu"), m => [refKey(m[1], m[2])]],
    [new RegExp(`(?<![\\p{L}])${SUR}\\s+(?:et\\s+al\\.?|등)(?:,?\\s*\\(?((?:19|20)\\d{2})[a-z]?\\)?)?`, "gu"),
      m => (m[2] ? [`cite:${fold(m[1])}:${m[2]}`, `cite:${fold(m[1])}`] : [`cite:${fold(m[1])}`])],
    [new RegExp(`(?<![\\p{L}])${SUR}\\s*\\(((?:19|20)\\d{2})[a-z]?\\)`, "gu"), m => [`cite:${fold(m[1])}:${m[2]}`]],
  ];
  function findMentions(text) {
    const s = String(text ?? ""), out = [];
    for (const [re, keys] of MENTIONS) {
      for (const m of s.matchAll(re)) out.push({ start: m.index, end: m.index + m[0].length, keys: keys(m) });
    }
    // [1], [1, 2], [3–5]: 숫자마다 따로. 0이 있으면 ([0, 1] 구간 등) 인용이 아님
    for (const m of s.matchAll(/\[([\d\s,;–—-]{1,40})\]/g)) {
      if (!/^\s*\d+(?:\s*[,;–—-]\s*\d+)*\s*$/.test(m[1])) continue;
      const nums = [...m[1].matchAll(/\d+/g)];
      if (nums.some(x => x[0].startsWith("0"))) continue;
      for (const x of nums) {
        const st = m.index + 1 + x.index;
        out.push({ start: st, end: st + x[0].length, keys: [refKey("bib", x[0])] });
      }
    }
    out.sort((a, b) => a.start - b.start || b.end - a.end);
    const kept = [];
    let last = -1;
    for (const x of out) if (x.start >= last) { kept.push(x); last = x.end; }
    return kept;
  }

  // 문장 경계: '.' 뒤에 공백 + 소문자가 아닌 글자, 약어(Eq. Fig. et al. e.g. …) 뒤는 아님, $수식$ 안은 아님
  const ABBR = /^(?:[A-Za-z]|eqs?|figs?|secs?|sects?|tabs?|refs?|al|e\.g|i\.e|cf|vs|etc|resp|approx|nos?|thms?|lems?|defs?|algs?|apps?|props?|cors?|chs?|pp|vol|viz|ex|ca|mr|ms|dr|prof|jr|sr|inc|ltd|corp)$/i;
  function isStop(t, i) {
    const c = t[i];
    if (!/[.!?。！？]/.test(c)) return false;
    let j = i + 1;
    while (j < t.length && /["'”’)\]]/.test(t[j])) j++;
    if (j < t.length && !/\s/.test(t[j])) return /[。！？]/.test(c);
    while (j < t.length && /\s/.test(t[j])) j++;
    if (j >= t.length || c !== ".") return true;
    if (/[a-z]/.test(t[j])) return false;
    const w = t.slice(Math.max(0, i - 12), i).match(/([A-Za-z][A-Za-z.]*)$/);
    return !(w && ABBR.test(w[1]));
  }
  // text 안 [start, end) 를 품은 문장의 범위. max자보다 길면 그 주변만 (cutStart/cutEnd: 잘렸는지)
  function sentenceBounds(text, start, end, max = 280) {
    const t = String(text ?? "");
    start = Math.max(0, Math.min(start | 0, t.length));
    end = Math.max(start, Math.min(end | 0, t.length));
    const inMath = new Uint8Array(t.length + 1);
    for (let i = 0, m = 0; i < t.length; i++) { if (t[i] === "$") m ^= 1; inMath[i] = m; }
    const stop = i => !inMath[i] && isStop(t, i);
    let s = 0, e = t.length;
    for (let i = start - 1; i >= 0; i--) if (stop(i)) { s = i + 1; break; }
    for (let i = end; i < t.length; i++) if (stop(i)) { e = i + 1; break; }
    while (s < start && /\s/.test(t[s])) s++;
    while (e > end && /\s/.test(t[e - 1])) e--;
    const full = { start: s, end: e };
    if (e - s > max) {
      const room = Math.max(0, max - (end - start));
      s = Math.max(s, start - (room >> 1));
      e = Math.min(e, s + Math.max(max, end - s));
      s = Math.max(full.start, Math.min(s, e - max));
      if (s > full.start) { const k = t.indexOf(" ", s); if (k >= 0 && k < start) s = k + 1; }
      if (e < full.end) { const k = t.lastIndexOf(" ", e); if (k > end) e = k; }
    }
    return { start: s, end: e, cutStart: s > full.start, cutEnd: e < full.end };
  }

  // peek 제목: 대상 꼬리표 우선 (링크 글자는 "2"처럼 번호뿐일 때가 많음), 없으면 링크 title의 첫 부분
  function titleFrom(o = {}) {
    const tag = cleanTag(o.tag), sub = cleanTag(o.sub);
    if (o.kind === "equation") return tag ? `식 ${/^\(.*\)$/.test(tag) ? tag : `(${tag})`}` : "수식";
    if (o.kind === "footnote") return tag ? `각주 ${tag}` : "각주";
    if (o.kind === "section" || o.kind === "para") { const t = cleanTag(o.heading); if (t) return t; }
    else if (tag) return sub ? `${tag} ${sub}` : tag;
    const lt = String(o.linkTitle || "").split(" ‣ ")[0].trim();
    return lt || cleanTag(o.linkText) || "참조";
  }

  const api = { idFromHref, refKind, classifyHref, cleanTag, refKey, tagKeys, bibKeys, findMentions, sentenceBounds, titleFrom };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return; // node: 여기서 끝
  if (document.body.dataset.page !== "paper") return;
  const paper = document.getElementById("paper");
  if (!paper) return;
  // 다른 기능(equation-tools 줄·figure-viewer)도 부를 수 있게: open(id), mentionCount(id), backlinks(id), showBacklinks(id, {title})
  PaperApp.registerFeature("ref-peek", Object.assign({}, api, { open, mentionCount: id => linksTo(id).length, backlinks, showBacklinks }));

  // ---------- DOM ----------
  const UI = PaperUI, A = PaperAnchor, h = UI.h;
  const byId = id => (id ? document.getElementById(id) : null);
  const inPaper = el => !!el && el !== paper && paper.contains(el);
  const linkTarget = a => { const el = byId(idFromHref(a.getAttribute("href"))); return inPaper(el) ? el : null; };
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const child = (el, sel) => [...el.children].find(c => c.matches(sel)) || null;
  const captionTag = fig => { const cap = child(fig, "figcaption"); const t = cap && cap.querySelector(".ltx_tag"); return t ? t.textContent : ""; };
  const titleEl = sec => child(sec, ".ltx_title");
  const live = el => !el.closest(".pr-ui, .tr-ko, .ltx_note_outer");
  function sectionTitleOf(el) {
    const sec = el.closest("section"), t = sec && titleEl(sec);
    return t ? A.textOf(t) : el.closest(".ltx_abstract") ? "Abstract" : "";
  }

  // 대상 요소 → {kind, box(복제할 덩어리), mark(그 안에서 강조할 부분), jump(이동할 곳), id(언급 목록 기준), title}
  function resolve(el) {
    const note = el.closest(".ltx_note");
    if (note) {
      const tag = note.querySelector(".ltx_note_content .ltx_tag_note") || note.querySelector(".ltx_note_mark");
      return { kind: "footnote", box: note.querySelector(".ltx_note_content") || note, mark: null, jump: null, id: null,
        title: titleFrom({ kind: "footnote", tag: tag && tag.textContent }) };
    }
    const eq = el.closest("table.ltx_equation, table.ltx_equationgroup");
    if (eq) {
      // 정렬(align) 수식: #S2.E3은 table.ltx_equationgroup 안의 tbody → 표 전체를 보이고 그 줄을 강조
      const row = el !== eq && eq.querySelectorAll("tr").length > 1 ? el.closest("tbody, tr") : null;
      const unit = row && eq.contains(row) ? row : eq;
      const tag = unit.querySelector(".ltx_tag_equation");
      return { kind: "equation", box: eq, mark: unit !== eq ? unit : null, jump: unit, id: el.id || unit.id || eq.id,
        title: titleFrom({ kind: "equation", tag: tag && tag.textContent }) };
    }
    const fig = el.closest("figure");
    if (fig) {
      let top = fig;
      for (let p = top.parentElement && top.parentElement.closest("figure"); p; p = p.parentElement && p.parentElement.closest("figure")) top = p;
      const sub = fig !== top ? fig : null;
      return { kind: "figure", box: top, mark: sub, jump: sub || top, id: top.id || fig.id,
        title: titleFrom({ kind: "figure", tag: captionTag(top), sub: sub ? captionTag(sub) : "" }) };
    }
    const thm = el.closest(".ltx_theorem, .ltx_proof");
    if (thm) {
      const tag = thm.querySelector(".ltx_tag_theorem") || thm.querySelector(".ltx_title");
      return { kind: "theorem", box: thm, mark: null, jump: thm, id: thm.id, title: titleFrom({ kind: "theorem", tag: tag ? A.textOf(tag) : "" }) };
    }
    if (el.matches("section")) {
      const t = titleEl(el);
      return { kind: "section", box: el, mark: null, jump: t || el, id: el.id, title: titleFrom({ kind: "section", heading: t ? A.textOf(t) : "" }) };
    }
    const box = el.closest(".ltx_para, li, p") || el;
    return { kind: "para", box, mark: null, jump: el, id: el.id, title: titleFrom({ kind: "para", heading: sectionTitleOf(el) }) };
  }
  function bibInfo(li) {
    const tag = li.querySelector(".ltx_tag_bibitem");
    return { kind: "bib", box: li, mark: null, jump: li, id: li.id, title: `참고문헌 ${cleanTag(tag ? tag.textContent : "")}`.trim() };
  }

  // 복제: 강조할 부분(mark)은 경로로 찾아 표시한 뒤 id·기능 UI·번역·대체 <mark> 정리 (중복 id 없음)
  function cleanClone(box, mark) {
    const c = box.cloneNode(true);
    let m = null;
    if (mark && mark !== box && box.contains(mark)) {
      const path = [];
      for (let n = mark; n !== box; n = n.parentNode) path.unshift([...n.parentNode.childNodes].indexOf(n));
      m = path.reduce((n, i) => n && n.childNodes[i], c);
      if (m && m.nodeType === 1) m.classList.add("rp-mark"); else m = null;
    }
    c.querySelectorAll(".pr-ui, .tr-ko").forEach(x => x.remove());
    c.querySelectorAll("mark.pa-mark").forEach(x => x.replaceWith(...x.childNodes));
    for (const x of [c, ...c.querySelectorAll("[id], .tr-hide, .pa-flash")]) {
      x.removeAttribute("id");
      x.classList.remove("tr-hide", "pa-flash");
    }
    c.querySelectorAll('a[href^="http"]').forEach(a => { a.target = "_blank"; a.rel = "noopener"; });
    return { el: c, mark: m };
  }

  function buildBody(info) {
    const wrap = h("div", { class: `rp-body rp-${info.kind}` });
    if (info.kind !== "section") {
      const c = cleanClone(info.box, info.mark);
      if (info.kind === "footnote") c.el.querySelectorAll(".ltx_note_mark, .ltx_tag_note").forEach(x => x.remove());
      wrap.append(c.el);
      return { node: wrap, mark: c.mark };
    }
    // 섹션: 제목 + 첫 문단 2개 + 하위 절 이름
    const t = titleEl(info.box);
    if (t) wrap.append(cleanClone(t).el);
    const paras = [];
    for (const p of info.box.querySelectorAll(".ltx_para")) {
      if (paras.length >= 2) break;
      if (paras.some(x => x.contains(p)) || !live(p) || p.closest("figure, .ltx_theorem, .ltx_proof")) continue;
      paras.push(p);
    }
    paras.forEach(p => wrap.append(cleanClone(p).el));
    const subs = [...info.box.children].filter(c => c.matches("section")).map(s => (titleEl(s) ? A.textOf(titleEl(s)) : "")).filter(Boolean);
    if (subs.length) wrap.append(h("p", { class: "rp-more", text: `하위 절: ${subs.join(" · ")}` }));
    return { node: wrap, mark: null };
  }

  // peek 안에서 강조한 줄·하위 그림이 보이게 (캡션이 아니라 대상에 맞춤)
  function centerIn(box, el) {
    const b = box.getBoundingClientRect(), r = el.getBoundingClientRect();
    if (r.top >= b.top + 48 && r.bottom <= b.bottom - 8) return;
    box.scrollTop += r.top - b.top - Math.max(56, (b.height - r.height) / 2);
  }

  // 본문으로 가기: 위에 뜬 peek·뷰어는 닫고, 시트는 내려두고, 점프 ('↩ 돌아가기'로 복귀)
  function goTo(target) {
    UI.closeLayers(l => l.kind !== "jump" && l.kind !== "sheet" && !l.keepOnSheet, "close");
    if (PaperApp.isSheetOpen()) PaperApp.minimizeSheet();
    PaperNav.jumpTo(target);
  }

  function paraContext(link) {
    const p = link && link.closest(".ltx_para, p, li, figcaption");
    return p ? A.clipAround(A.textOf(p), A.textOf(link), 1500) : "";
  }

  function askAbout(info, node, opts, close) {
    if (opts.from === "answer" && PaperApp.session) {
      close("close"); // 열린 대화에 이어서 질문 (지금 대화를 버리지 않음)
      PaperApp.ask(`${info.title}에 대해 자세히 설명해줘`, { label: info.title });
      return;
    }
    // 새 대화: 대상 내용(수식은 $alttext$)이 선택, 링크가 있던 문단이 문맥. 시트가 열리며 peek는 닫힘
    PaperApp.openSheet({
      quote: info.title, selection: clip(A.textOf(node), 3000),
      context: paraContext(opts.link || (info.kind === "footnote" && inPaper(info.box) ? info.box : null)), section: sectionTitleOf(info.box),
    });
  }

  // peek를 연다: target은 id 또는 요소 (본문 안, 또는 다른 peek 복제 안의 각주). opts: {link, from: "paper"|"answer"}
  function open(target, opts = {}) {
    const el = typeof target === "string" ? byId(target) : target;
    if (!el || !(inPaper(el) || el.closest(".rp-body"))) return null;
    const bib = el.closest("li.ltx_bibitem");
    const info = bib ? bibInfo(bib) : resolve(el);
    const body = bib ? { node: h("div", { class: "rp-body rp-bib" }, cleanClone(bib).el), mark: null } : buildBody(info);
    const links = info.id ? linksTo(info.id) : []; // 문장은 목록을 열 때 계산 (peek는 바로)
    const actions = [];
    if (info.jump && inPaper(info.jump)) actions.push({ label: "그 위치로 이동", primary: true, onClick: () => goTo(info.jump) });
    actions.push({ label: "이 부분 질문", onClick: ({ close }) => askAbout(info, body.node, opts, close) });
    if (links.some(a => a !== opts.link)) {
      actions.push({ label: `${links.length}곳에서 ${bib ? "인용" : "언급"}`, onClick: () => showBacklinks(info.id, { title: info.title, current: opts.link }) });
    }
    const close = UI.peek({ title: info.title, body: body.node, actions, className: `rp-peek rp-peek-${info.kind}` });
    wireBody(close.body, info, opts);
    if (body.mark) requestAnimationFrame(() => centerIn(close.el, body.mark));
    return close;
  }

  // peek 안의 탭: 본문 참조 링크 → 그 위에 또 peek, 각주 표시 → 각주 peek, 그림 → figure-viewer (있을 때만)
  function wireBody(bodyEl, info, opts) {
    if (info.kind === "figure" && PaperApp.has("figure-viewer")) bodyEl.querySelectorAll("img").forEach(i => i.classList.add("rp-zoom"));
    bodyEl.addEventListener("click", e => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const a = t.closest("a[href]");
      if (a) {
        const href = a.getAttribute("href") || "";
        if (!href.startsWith("#")) return; // 바깥 링크는 새 탭
        e.preventDefault(); // 레이어가 열려 있을 때의 기본 점프(ui.js)도 막음
        const el = byId(idFromHref(href));
        if (inPaper(el)) open(el, { from: opts.from });
        return;
      }
      const note = t.closest(".ltx_note_mark") && t.closest(".ltx_note");
      if (note && note.querySelector(".ltx_note_content")) { open(note, { from: opts.from }); return; }
      const img = t.closest("img");
      if (img && info.kind === "figure" && PaperApp.has("figure-viewer")) {
        const i = [...bodyEl.querySelectorAll("img")].indexOf(img);
        const orig = [...info.box.querySelectorAll("img")].filter(live)[i] || null;
        document.dispatchEvent(new CustomEvent("paper:open-figure", { detail: { figureEl: info.box, img: orig } }));
      }
    });
  }

  // ---------- 언급한 곳 (backlinks): 본문의 a[href="#id"] 들과 그 문장 ----------
  const offsetsOfNode = n => { const r = document.createRange(); r.selectNodeContents(n); return A.offsetsOf(r); };
  function sentenceOf(a, idx) {
    const item = { link: a, start: null, end: null, section: clip(sectionTitleOf(a), 48) };
    const block = a.closest("p, li, figcaption, td, .ltx_para") || a.parentElement;
    const o = offsetsOfNode(a), bo = block && offsetsOfNode(block);
    if (!o || !bo || bo.end <= bo.start || o.start < bo.start) return item;
    const sb = sentenceBounds(idx.text.slice(bo.start, bo.end), o.start - bo.start, o.end - bo.start);
    return Object.assign(item, { start: bo.start + sb.start, end: bo.start + sb.end, cutStart: sb.cutStart, cutEnd: sb.cutEnd });
  }
  // id를 가리키는 본문 링크들 (그림이면 하위 그림 링크도, 섹션·참고문헌은 정확히 그 id만). 대상 안의 자기 참조는 뺌
  function linksTo(id) {
    const target = byId(id);
    if (!inPaper(target)) return [];
    const exact = target.matches("section, li.ltx_bibitem");
    return [...paper.querySelectorAll('a[href^="#"]')].filter(a => {
      if (!live(a) || a.closest(".ltx_bibliography, nav")) return false;
      const t = linkTarget(a);
      return !!t && (exact ? t === target : target.contains(t)) && !target.contains(a);
    });
  }
  // → [{link, start, end (색인 오프셋, 문장), section, cutStart, cutEnd}]
  function backlinks(id) {
    const links = linksTo(id);
    const idx = links.length ? A.index() : null;
    return links.map(a => sentenceOf(a, idx));
  }
  function sentenceNode(b, target) {
    const span = h("span", { class: "rp-bl-text" });
    const r = b.start != null ? A.rangeAt(b.start, b.end) : null;
    if (!r) { span.textContent = clip(A.textOf(b.link.closest(".ltx_para, p, li") || b.link), 280); return span; }
    span.append(r.cloneContents());
    span.querySelectorAll(".pr-ui, .tr-ko, .ltx_note_outer").forEach(x => x.remove());
    span.querySelectorAll("[id]").forEach(x => x.removeAttribute("id"));
    span.querySelectorAll(".tr-hide, .pa-flash").forEach(x => x.classList.remove("tr-hide", "pa-flash")); // 번역 모드에서 숨긴 원문도 보이게
    for (const a of span.querySelectorAll("a")) {
      const el = byId(idFromHref(a.getAttribute("href")));
      const s = h("span", { class: el && target && (el === target || target.contains(el)) ? "rp-bl-hit" : "" });
      s.append(...a.childNodes);
      a.replaceWith(s);
    }
    if (b.cutStart) span.prepend("… ");
    if (b.cutEnd) span.append(" …");
    return span;
  }
  function showBacklinks(id, opts = {}) {
    const target = byId(id);
    const list = backlinks(id);
    if (!list.length) { UI.toast("본문에서 언급한 곳이 없습니다"); return null; }
    const box = h("div", { class: "rp-bl" });
    for (const b of list) {
      const cur = b.link === opts.current;
      const label = [b.section, cur ? "지금 읽던 곳" : ""].filter(Boolean).join(" · ");
      box.append(h("button", {
        type: "button", class: `rp-bl-item${cur ? " rp-bl-cur" : ""}`,
        onclick: () => goTo(b.start != null ? { start: b.start, end: b.end } : b.link),
      }, label ? h("small", { text: label }) : null, sentenceNode(b, target)));
    }
    const title = opts.title || (inPaper(target) ? (target.closest("li.ltx_bibitem") ? bibInfo(target.closest("li.ltx_bibitem")) : resolve(target)).title : "참조");
    return UI.peek({ title: `${title} · 언급 ${list.length}곳`, body: box, className: "rp-peek rp-peek-bl" });
  }

  // ---------- 본문 탭: 참조 링크(#bib. 제외 → cite-cards), 각주 표시 ----------
  PaperApp.addTapHandler({
    id: "ref-peek", priority: 80,
    test: e => {
      const t = e.target;
      const a = t.closest('a[href^="#"]');
      if (a) {
        if (a.closest("nav, .ltx_TOC") || classifyHref(a.getAttribute("href")) === null) return null;
        const el = linkTarget(a);
        return el ? { el, link: a } : null;
      }
      const mark = t.closest(".ltx_note_mark");
      const note = mark && !mark.closest(".ltx_note_outer") && mark.closest(".ltx_note");
      return note && note.querySelector(".ltx_note_content") ? { el: note, link: null } : null;
    },
    handle: (e, hit) => open(hit.el, { link: hit.link, from: "paper" }),
  });

  // ---------- 답변 속 참조 ("Figure 3", "식 (5)", "[12]" …): .a를 바꾸지 않고 칠하기(raw Range)로 표시, 탭은 위치로 판정 ----------
  // .a를 다시 그리는 것은 근거 칩(evidence-chips)뿐 (규칙 8) → 답변이 바뀌면(MutationObserver) 다시 찾기만 함. 토큰 0
  let refMap = null;
  function buildRefMap() {
    const m = new Map();
    const put = (keys, id) => { if (id) for (const k of keys) if (!m.has(k)) m.set(k, id); };
    for (const t of paper.querySelectorAll(".ltx_tag_equation")) {
      const u = live(t) && t.closest("tr[id], tbody[id], table[id]");
      if (u && paper.contains(u)) put(tagKeys("equation", t.textContent), u.id);
    }
    for (const f of paper.querySelectorAll("figure[id]")) {
      if (!live(f)) continue;
      const parent = f.parentElement && f.parentElement.closest("figure");
      if (!parent) { put(tagKeys("figure", captionTag(f)), f.id); continue; }
      const letter = cleanTag(captionTag(f)).match(/^\(?([a-z])\)?$/i), base = tagKeys("figure", captionTag(parent))[0];
      if (letter && base) put([base + letter[1].toLowerCase()], f.id);
    }
    for (const s of paper.querySelectorAll("section[id]")) {
      const tag = titleEl(s) && titleEl(s).querySelector(".ltx_tag");
      if (tag) put(tagKeys("section", tag.textContent), s.id);
    }
    for (const t of paper.querySelectorAll(".ltx_theorem[id]")) {
      const tag = t.querySelector(".ltx_tag_theorem");
      if (tag) put(tagKeys("theorem", tag.textContent), t.id);
    }
    for (const li of paper.querySelectorAll("li.ltx_bibitem[id]")) {
      const tag = li.querySelector(".ltx_tag_bibitem");
      if (tag) put(bibKeys(tag.textContent), li.id);
    }
    for (const a of paper.querySelectorAll('a[href^="#bib."]')) {
      const li = live(a) && linkTarget(a);
      if (li) put(bibKeys(a.textContent, false), li.id);
    }
    return m;
  }

  const SKIP_ANS = "code, pre, a, button, .math, .katex, math, svg";
  let found = []; // [{a: 답변 요소, range, id}]
  const repaint = () => {
    found = found.filter(x => x.a.isConnected && x.range.startContainer.isConnected);
    A.paint("rp-ans", found.map(x => x.range), { priority: 5, raw: true });
  };
  function scanAnswer(aEl) {
    found = found.filter(x => x.a !== aEl);
    const map = refMap || (refMap = buildRefMap());
    if (aEl.isConnected && map.size) {
      const w = document.createTreeWalker(aEl, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const skip = n.parentElement && n.parentElement.closest(SKIP_ANS);
        if (skip && aEl.contains(skip)) continue;
        for (const mt of findMentions(n.data)) {
          const id = mt.keys.map(k => map.get(k)).find(Boolean);
          if (!id) continue;
          const r = document.createRange();
          r.setStart(n, mt.start);
          r.setEnd(n, mt.end);
          found.push({ a: aEl, range: r, id });
        }
      }
    }
    repaint();
  }
  const watched = new WeakSet();
  function watch(aEl) {
    if (watched.has(aEl) || typeof MutationObserver === "undefined") return;
    watched.add(aEl);
    let timer;
    new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => scanAnswer(aEl), 150); })
      .observe(aEl, { childList: true, subtree: true, characterData: true });
  }
  // 다른 기능의 answer-done 처리(근거 줄 지우고 다시 그리기)가 끝난 뒤에 찾음. 복원된 턴도 (네트워크 없음)
  PaperApp.on("answer-done", d => {
    const a = d && d.answerEl;
    if (a) setTimeout(() => { scanAnswer(a); watch(a); }, 0);
  });
  PaperApp.on("sheet-close", () => setTimeout(repaint, 0));

  const near = (r, x, y, px, py) => [...r.getClientRects()].some(b => x >= b.left - px && x <= b.right + px && y >= b.top - py && y <= b.bottom + py);
  document.getElementById("answer")?.addEventListener("click", e => {
    if (!found.length || e.defaultPrevented || e.button || !(e.target instanceof Element) || !e.target.closest(".a")) return;
    const s = document.getSelection();
    if (s && !s.isCollapsed && e.currentTarget.contains(s.anchorNode)) return; // 답변 글자를 고르는 중
    const pick = (px, py) => found.find(f => f.a.isConnected && !f.range.collapsed && near(f.range, e.clientX, e.clientY, px, py));
    const hit = pick(0, 0) || pick(3, 6);
    if (!hit) return;
    e.preventDefault();
    open(hit.id, { from: "answer" });
  });
})();
