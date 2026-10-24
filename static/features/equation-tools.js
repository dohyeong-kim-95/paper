// equation-tools: 수식 탭 → 수식 설명(정확한 LaTeX로 질문)·LaTeX 복사·전체 화면, 본문 복사 시 수식을 LaTeX로, 답변 수식 탭 복사
(function () {
  "use strict";

  // ---------- 순수 함수 (node 테스트) ----------
  // 복사 형식: [블록 수식 구분자, 인라인 수식 구분자]
  const DELIMS = {
    "$$": [["$$", "$$"], ["$", "$"]],
    "$": [["$", "$"], ["$", "$"]],
    "\\[": [["\\[", "\\]"], ["\\(", "\\)"]],
    "none": [["", ""], ["", ""]],
  };
  const DELIM_NAMES = { "$$": "블록 $$…$$ · 인라인 $…$", "$": "모두 $…$", "\\[": "블록 \\[…\\] · 인라인 \\(…\\)", "none": "구분자 없음" };
  const normDelim = d => (Object.prototype.hasOwnProperty.call(DELIMS, d) ? d : "$$");

  function wrapLatex(tex, delim = "$$", inline = false) {
    const [l, r] = DELIMS[normDelim(delim)][inline ? 1 : 0];
    return l + String(tex ?? "").trim() + r;
  }

  // LaTeXML이 align 칸마다 붙이는 \displaystyle 제거
  const stripDisplay = tex => String(tex ?? "").replace(/\\displaystyle(?![A-Za-z])\s*/g, "").trim();

  // 행(칸별 alttext 배열)들 → LaTeX 하나. 한 행: 칸을 공백으로. 여러 행: 칸은 &, 행은 \\, aligned로 감쌈
  // (빈 칸은 정렬 자리라 남김: ["", "=c"] → "& =c". 끝의 빈 칸만 버림)
  function joinRows(rows) {
    const rs = (rows || []).map(r => (r || []).map(stripDisplay)).filter(r => r.some(Boolean));
    if (!rs.length) return "";
    if (rs.length === 1) return rs[0].filter(Boolean).join(" ");
    const row = r => {
      const cells = r.slice();
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      return cells.join(" & ").trim();
    };
    return `\\begin{aligned}${rs.map(row).join(" \\\\ ")}\\end{aligned}`;
  }

  // 수식 번호들 → "(1)" · "(2), (3)" · 넷 이상은 "(2)–(5)"
  function formatLabel(labels) {
    const ls = [...new Set((labels || []).map(s => String(s).trim()).filter(Boolean))];
    return ls.length <= 3 ? ls.join(", ") : `${ls[0]}–${ls[ls.length - 1]}`;
  }

  const head = (s, n) => (s.length <= n ? s : n > 1 ? s.slice(0, n - 1) + "…" : "");
  const tail = (s, n) => (s.length <= n ? s : n > 1 ? "…" + s.slice(s.length - n + 1) : "");

  // 수식 앞뒤 문단 → 질문 문맥 (max자 이하, 수식 자리 표시). 한쪽이 짧으면 남는 몫을 다른 쪽에
  function buildContext(before, after, label = "", max = 1500) {
    const b = String(before || "").trim(), a = String(after || "").trim();
    if (!b && !a) return "";
    const mark = `[이 수식${label ? " " + label : ""}]`;
    const room = Math.max(0, max - mark.length - 2);
    const nb = Math.min(b.length, Math.max(Math.floor(room / 2), room - a.length));
    return [tail(b, nb), mark, head(a, room - nb)].filter(Boolean).join("\n");
  }

  // 시트 인용 줄: 번호가 있으면 "Eq. (3)", 없으면 LaTeX 앞부분
  const eqQuote = (label, latex) => (label ? `Eq. ${label}` : head(String(latex || ""), 80));

  // 복사 조각들 [{text} | {tex, display} | {br}] → 클립보드 텍스트 (공백 정리, 블록 수식은 따로 한 줄)
  function assembleCopy(parts, delim = "$$") {
    let out = "";
    for (const p of parts || []) {
      if (p.br) out += "\n";
      else if (p.tex != null) { if (String(p.tex).trim()) out += p.display ? `\n${wrapLatex(p.tex, delim)}\n` : wrapLatex(p.tex, delim, true); }
      else out += String(p.text || "").replace(/\s+/g, " ");
    }
    return out.replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  const api = { DELIMS, normDelim, wrapLatex, stripDisplay, joinRows, formatLabel, buildContext, eqQuote, assembleCopy };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;
  if (document.body.dataset.page !== "paper") return;
  PaperApp.registerFeature("equation-tools", api);

  // ---------- DOM ----------
  const UI = window.PaperUI, A = window.PaperAnchor, store = window.PaperStore, h = UI.h;
  const paperEl = document.getElementById("paper");
  if (!paperEl) return;
  const EQ = "table.ltx_equation, table.ltx_equationgroup";
  const KEY = "equation-tools:delim";
  const delim = () => normDelim(store.get(KEY, "$$"));
  const alt = m => m.getAttribute("alttext") || m.querySelector('annotation[encoding="application/x-tex"]')?.textContent || "";
  // 수식 표의 여백·번호 칸 (내용 칸이 아님)
  const PAD = /\bltx_eqn_(eqno|\w*pad(left|right))\b/;

  // 수식 블록 → 행별 칸 alttext (align/eqnarray는 & 칸마다 math가 따로). 중첩 표의 행은 바깥 칸에 포함
  function rowsOf(block) {
    if (block.localName === "math") return [[alt(block)]];
    const trs = [...block.querySelectorAll("tr")].filter(tr => tr.closest("table") === block && tr.matches(".ltx_equation, .ltx_eqn_row"));
    if (!trs.length) return [[...block.querySelectorAll("math")].map(alt).join(" ")];
    return trs.map(tr => [...tr.cells].filter(td => !PAD.test(td.className)).map(td => [...td.querySelectorAll("math")].map(alt).join(" ")));
  }
  function infoOf(block) {
    const labels = block.localName === "math" ? [] : [...block.querySelectorAll(".ltx_tag_equation")].map(t => t.textContent);
    return { latex: joinRows(rowsOf(block)), label: formatLabel(labels) };
  }

  // 수식 앞/뒤 글: 같은 문단의 형제 → 없으면 바깥(문단)의 형제. 섹션 경계는 넘지 않음
  function neighborText(block, dir) {
    const step = el => (dir < 0 ? el.previousElementSibling : el.nextElementSibling);
    for (let node = block; node && node !== paperEl && !node.matches("section, article"); node = node.parentElement) {
      for (let s = step(node); s; s = step(s)) {
        if (s.matches(".pr-ui, .tr-ko, figure, .ltx_title")) continue;
        const t = A.textOf(s);
        if (t) return t;
      }
    }
    return "";
  }
  function sectionTitle(block) {
    const sec = block.closest("section");
    const t = sec && [...sec.children].find(c => c.classList.contains("ltx_title"));
    return t ? A.textOf(t) : "";
  }

  // ---------- 수식 설명 (시트) ----------
  const PRESETS = [
    { id: "equation-tools:symbols", label: "기호별 풀이", q: "이 수식을 표로: 기호 | 의미 | 처음 정의된 곳, 그 다음 수식이 하는 일을 2문장으로" },
    { id: "equation-tools:intuition", label: "직관적으로", q: "이 수식이 직관적으로 무엇을 뜻하는지 쉽게 설명해줘. 각 항이 커지거나 작아지면 결과가 어떻게 바뀌는지도" },
    { id: "equation-tools:derive", label: "유도 과정", q: "이 수식이 어떻게 나오는지 앞의 정의·가정에서 출발해 단계별로 유도해줘. 논문에 없는 단계는 따로 표시해줘" },
    { id: "equation-tools:legend", label: "기호만", q: "이 수식에 나오는 기호만 '기호 — 뜻' 목록으로 (처음 정의된 곳을 괄호로). 다른 설명은 빼고" },
  ];
  function explain(block, presetId = PRESETS[0].id) {
    const { latex, label } = infoOf(block);
    if (!latex) { UI.toast("이 수식의 LaTeX를 찾지 못했습니다"); return; }
    const before = block.localName === "math" ? A.textOf(block.closest(".ltx_para, p") || block) : neighborText(block, -1);
    const after = block.localName === "math" ? "" : neighborText(block, 1);
    const p = PRESETS.find(x => x.id === presetId) || PRESETS[0];
    PaperApp.openSheet({
      title: "수식 설명",
      quote: eqQuote(label, latex),
      selection: `$$${latex}$$`,
      context: buildContext(before, after, label),
      section: sectionTitle(block),
      presets: PRESETS,
      autoAsk: { q: p.q, label: p.label, id: p.id },
      origin: { feature: "equation-tools", id: block.id || null, label },
    });
  }

  // ---------- LaTeX 복사 ----------
  // 탭(사용자 제스처) 안에서 바로 clipboard.writeText → iOS Safari·안드로이드 크롬 모두 허용
  const copyTex = (tex, inline = false) => UI.copy(wrapLatex(tex, delim(), inline), "LaTeX 복사됨");
  function copyBlock(block) {
    const { latex } = infoOf(block);
    if (latex) copyTex(latex);
    else UI.toast("이 수식의 LaTeX를 찾지 못했습니다");
  }

  const delimLabel = () => (delim() === "none" ? "형식 ▾" : `${DELIMS[delim()][0][0]} ▾`);
  const refreshDelim = () => document.querySelectorAll(".eq-delim").forEach(b => { b.textContent = delimLabel(); });
  function pickDelim() {
    const cur = delim();
    const list = h("div", { class: "eq-delims", role: "radiogroup", "aria-label": "LaTeX 복사 형식" });
    const close = UI.peek({
      title: "LaTeX 복사 형식",
      body: h("div", {}, list, h("p", { class: "eq-note", text: "본문을 선택해 복사할 때도 수식이 이 형식의 LaTeX로 바뀝니다." })),
    });
    for (const d of Object.keys(DELIMS)) {
      list.append(h("button", {
        type: "button", role: "radio", "aria-checked": String(d === cur),
        onclick: () => { store.set(KEY, d); refreshDelim(); close(); UI.toast(`복사 형식: ${DELIM_NAMES[d]}`); },
      }, h("code", { text: wrapLatex("E=mc^2", d) }), h("span", { text: DELIM_NAMES[d] })));
    }
  }

  // ---------- 전체 화면 (긴 수식): 너비에 맞춤, ＋/− 버튼, 두 손가락 확대 ----------
  function pinch(el, get, set) {
    let d0 = 0, s0 = 1, want = null;
    const apply = s => { if (want === null) requestAnimationFrame(() => { set(want); want = null; }); want = s; };
    const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    el.addEventListener("touchstart", e => { if (e.touches.length === 2) { d0 = dist(e.touches); s0 = get(); } }, { passive: true });
    el.addEventListener("touchmove", e => {
      if (e.touches.length !== 2 || !d0) return;
      e.preventDefault(); // 페이지 확대 대신 수식만
      apply(s0 * dist(e.touches) / d0);
    }, { passive: false });
    el.addEventListener("touchend", e => { if (e.touches.length < 2) d0 = 0; });
    for (const g of ["gesturestart", "gesturechange"]) el.addEventListener(g, e => e.preventDefault()); // iOS 페이지 확대 막기
    el.addEventListener("wheel", e => { if (e.ctrlKey) { e.preventDefault(); apply(get() * Math.exp(-e.deltaY / 200)); } }, { passive: false });
  }

  function openFull(block) {
    const { label } = infoOf(block);
    const clone = block.localName === "math" ? h("div", { class: "eq-math" }, UI.cloneClean(block)) : UI.cloneClean(block);
    const stage = h("div", { class: "eq-stage" }, clone);
    let scale = 1, fitScale = 1;
    const set = s => { scale = Math.min(6, Math.max(0.3, s)); stage.style.setProperty("--eq-s", scale.toFixed(3)); };
    // 배율을 바꿔도 보던 곳(가운데)이 그대로 있게
    const zoomTo = s => {
      const cx = stage.scrollLeft + stage.clientWidth / 2, cy = stage.scrollTop + stage.clientHeight / 2, old = scale;
      set(s);
      stage.scrollLeft = cx * scale / old - stage.clientWidth / 2;
      stage.scrollTop = cy * scale / old - stage.clientHeight / 2;
    };
    const fit = () => {
      set(1);
      const w = clone.getBoundingClientRect().width;
      fitScale = w ? Math.min(3, Math.max(0.3, (stage.clientWidth - 16) / w)) : 1;
      set(fitScale);
    };
    const btn = (text, onClick, extra = {}) => h("button", { type: "button", text, onclick: onClick, ...extra });
    const tools = h("div", { class: "eq-full-tools" },
      btn("−", () => zoomTo(scale / 1.25), { "aria-label": "축소" }),
      btn("＋", () => zoomTo(scale * 1.25), { "aria-label": "확대" }),
      btn("맞춤", fit, { "aria-label": "화면 너비에 맞춤" }),
      btn("LaTeX 복사", () => copyBlock(block)),
      btn("수식 설명", () => explain(block), { class: "primary" })); // 시트가 열리면 이 peek는 자동으로 닫힘
    // 화면 회전·크기 변화: 맞춤 상태였으면 다시 맞춤
    const onResize = () => { if (Math.abs(scale - fitScale) < 0.01) requestAnimationFrame(fit); };
    UI.peek({
      title: label ? `Eq. ${label}` : "수식",
      body: h("div", { class: "eq-full" }, tools, stage),
      size: "large", className: "eq-full-peek",
      onClose: () => window.removeEventListener("resize", onResize),
    });
    window.addEventListener("resize", onResize);
    pinch(stage, () => scale, zoomTo);
    requestAnimationFrame(fit);
  }

  // ---------- 수식 아래 도구 줄 (.pr-ui, 한 번에 하나) ----------
  let open = null; // {block, row}
  function closeRow() {
    if (!open) return;
    open.row.remove();
    open.block.classList.remove("eq-active");
    open = null;
  }
  function toggleRow(block) {
    if (open && open.block === block) { closeRow(); return; }
    closeRow();
    const btn = (text, onClick, extra = {}) => h("button", { type: "button", text, onclick: onClick, ...extra });
    const row = h("div", { class: "eq-row", role: "toolbar", "aria-label": "수식 도구" },
      btn("수식 설명", () => explain(block), { class: "primary" }),
      btn("LaTeX 복사", () => copyBlock(block)),
      btn(delimLabel(), pickDelim, { class: "eq-delim", "aria-label": "LaTeX 복사 형식", title: "LaTeX 복사 형식" }),
      btn("기호만", () => explain(block, "equation-tools:legend")),
      btn("전체 화면", () => openFull(block)),
      btn("✕", closeRow, { class: "eq-x", "aria-label": "수식 도구 닫기" }));
    A.insertUI(block, row, "afterend");
    block.classList.add("eq-active");
    open = { block, row };
  }

  // 표시 수식 탭 (링크·선택 중 제외: 선택이 있으면 처리기가 아예 안 불림). 인라인 수식은 glossary·선택 몫
  PaperApp.addTapHandler({
    id: "equation-tools", priority: 60,
    test: e => {
      const t = e.target;
      if (t.closest("a, .pr-ui")) return null;
      return t.closest(EQ) || t.closest('math[display="block"]');
    },
    handle: (e, block) => toggleRow(block),
  });

  // ---------- 답변 속 수식(KaTeX) 탭 → LaTeX 복사 (길게 누르기는 기본 선택에 양보) ----------
  // 선택을 풀려고 누른 탭은 복사하지 않음: click 때는 이미 mousedown/touchstart가 선택을 풀었으므로
  // 누르는 순간(capture pointerdown)에 선택이 있었는지 기억 (app.js의 downHadSel과 같은 방식)
  const liveSel = () => { const s = document.getSelection(); return !!(s && !s.isCollapsed && s.toString().trim()); };
  let downHadSel = false;
  document.addEventListener("pointerdown", () => { downHadSel = liveSel() || PaperApp.justSelected(); }, true);
  document.addEventListener("click", e => {
    const hadSel = downHadSel;
    downHadSel = false;
    const k = e.target instanceof Element && e.target.closest(".answer .katex");
    if (!k || e.defaultPrevented || e.button || e.target.closest("a, button")) return;
    if (hadSel || liveSel() || PaperApp.justSelected()) return;
    const tex = k.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
    if (tex) copyTex(tex, !k.closest(".katex-display"));
  });

  // ---------- 본문(번역 .tr-ko 포함) 선택 복사: 수식(MathML)을 $alttext$ / 블록은 $$…$$ 로 ----------
  const SKIP_TAG = /^(script|style|button|noscript|template|svg)$/;
  const BLOCK = /^(p|div|section|article|h[1-6]|li|ul|ol|dl|dt|dd|tr|table|tbody|thead|figure|figcaption|blockquote|pre)$/;
  const hidden = el => !el.getClientRects().length && getComputedStyle(el).display !== "contents";
  function mathPart(el) {
    const eq = el.matches(EQ) ? el : el.closest(EQ);
    if (eq) return { tex: infoOf(eq).latex, display: true };
    return { tex: stripDisplay(alt(el)), display: el.getAttribute("display") === "block" };
  }
  // text/html용 얕은 복제: 태그 + 링크·그림·표 칸 속성만 (id·class·data-*는 버림). 주소는 절대 주소로,
  // 굵게·기울임은 LaTeXML이 class(ltx_font_bold 등)로 주므로 그 class나 계산된 스타일을 부모와 비교해 인라인으로
  const KEEP_ATTR = ["alt", "title", "colspan", "rowspan", "width", "height"];
  const isBold = el => el.classList.contains("ltx_font_bold") || Number(getComputedStyle(el).fontWeight) >= 600;
  const isItalic = el => el.classList.contains("ltx_font_italic") || getComputedStyle(el).fontStyle === "italic";
  function shallowCopy(n) {
    const c = document.createElement(n.localName);
    for (const a of KEEP_ATTR) if (n.hasAttribute(a)) c.setAttribute(a, n.getAttribute(a));
    if (n.localName === "a" && n.href) c.setAttribute("href", n.href);
    if (n.localName === "img" && (n.currentSrc || n.src)) c.setAttribute("src", n.currentSrc || n.src);
    const p = n.parentElement, style = [];
    if (isBold(n) && !(p && isBold(p))) style.push("font-weight:bold");
    if (isItalic(n) && !(p && isItalic(p))) style.push("font-style:italic");
    if (style.length) c.setAttribute("style", style.join(";"));
    return c;
  }

  // 선택 범위 → {parts: assembleCopy 조각, html: 같은 내용의 정리된 DOM 조각}. 수식은 둘 다 LaTeX 글자로
  function copyParts(range, d) {
    const parts = [], html = document.createDocumentFragment();
    const addMath = (el, out) => {
      const p = mathPart(el);
      parts.push(p);
      if (!String(p.tex).trim()) return;
      if (p.display) out.append(h("div", { text: wrapLatex(p.tex, d) }));
      else out.append(wrapLatex(p.tex, d, true));
    };
    let root = range.commonAncestorContainer;
    if (root.nodeType !== 1) root = root.parentElement;
    const whole = root && root.closest("math, " + EQ); // 수식 하나 안에서 고름 → 그 수식 전체
    if (whole) { addMath(whole, html); return { parts, html }; }
    // 공통 조상 자체(문단 등)는 껍데기 없이 내용만. 단 표·목록 안쪽(tr, li…)이면 바깥 표·목록까지 감싸서 고아 태그가 없게
    let rootOut = html;
    if (root && /^(thead|tbody|tfoot|tr|td|th|li|dt|dd)$/.test(root.localName)) {
      const chain = [];
      for (let el = root; el && el !== paperEl; el = el.parentElement) {
        chain.unshift(el);
        if (/^(table|ul|ol|dl)$/.test(el.localName)) break;
      }
      if (/^(table|ul|ol|dl)$/.test(chain[0].localName)) for (const el of chain) rootOut = rootOut.appendChild(shallowCopy(el));
    }
    const visit = (n, out) => {
      if (!range.intersectsNode(n)) return;
      if (n.nodeType === 3) {
        let t = n.data;
        if (n === range.endContainer) t = t.slice(0, range.endOffset);
        if (n === range.startContainer) t = t.slice(range.startOffset);
        parts.push({ text: t });
        out.append(t);
        return;
      }
      if (n.nodeType !== 1 || SKIP_TAG.test(n.localName)) return;
      // 기능 UI는 빼고 번역(.tr-ko)은 포함, 숨긴 것(번역 모드의 원문 등)은 뺌 — 브라우저 기본 복사와 같게
      if ((n.classList.contains("pr-ui") && !n.classList.contains("tr-ko")) || hidden(n)) return;
      if (n.localName === "math" || n.matches(EQ)) { addMath(n, out); return; }
      if (n.localName === "br") { parts.push({ br: true }); out.append(document.createElement("br")); return; }
      const block = BLOCK.test(n.localName);
      const c = n === root ? rootOut : out.appendChild(shallowCopy(n));
      if (block) parts.push({ br: true });
      for (let ch = n.firstChild; ch; ch = ch.nextSibling) visit(ch, c);
      if (block) parts.push({ br: true });
      else if (n.localName === "td" || n.localName === "th") parts.push({ text: " " });
    };
    if (root) visit(root, html);
    return { parts, html };
  }
  document.addEventListener("copy", e => {
    if (e.defaultPrevented || !e.clipboardData) return;
    const s = document.getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) return;
    const range = s.getRangeAt(0);
    if (!paperEl.contains(range.commonAncestorContainer)) return;
    const d = delim();
    let out;
    try { out = copyParts(range, d); } catch (x) { console.error("[equation-tools] copy", x); return; }
    if (!out.parts.some(p => p.tex)) return; // 수식이 없으면 브라우저 기본 복사
    const text = assembleCopy(out.parts, d);
    if (!text) return;
    // 기본 복사를 막으면 브라우저의 text/html도 사라지므로 직접 넣음 (서식 붙여넣기에서 링크·굵게·목록·그림 유지)
    const box = document.createElement("div");
    box.append(out.html);
    e.clipboardData.setData("text/html", `<meta charset="utf-8">${box.innerHTML}`);
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
  });
})();
