// overview: 한눈에 보기 — 3줄 요약·핵심 질문(본문 점프)·스냅샷, 방법론 자세히, 논문 메타 칩(arXiv·PDF·코드·버전)
(function () {
  "use strict";
  // ---------- 순수 함수 (node 테스트 대상) ----------
  const ERROR_TAIL = /\n\n\[오류\][^\n]*$/;
  const FIG_RE = /\[\[fig:([^\]\s]+)\]\]/g;
  const MARK_RE = /%%OV([QF])(\d+)%%/g;
  const CODE_RE = /^https?:\/\/(?:www\.)?(github|gitlab)\.com\/([\w.-]+)\/([\w.-]+)/i;

  // '→ "인용"' 줄이면 인용문, 아니면 null (앞 목록 기호·강조, 닫는 따옴표 뒤 마침표는 뗌).
  // 따옴표로 감싸지 않은 '→ 결과적으로 …' 같은 한국어 문장은 인용이 아님 (그대로 둠)
  const QUOTE_LINE = /^\s*(?:[-*>]\s*)?(?:→|->)\s*[*_`]*["“'‘](.+?)["”'’][*_`]*[.。]?\s*$/;
  function quoteOf(line) {
    const m = String(line ?? "").match(QUOTE_LINE);
    if (!m) return null;
    const q = m[1].replace(/^[*_`]+|[*_`]+$/g, "").trim();
    return q || null;
  }
  const parseQuoteLines = text => String(text || "").split("\n")
    .map((line, i) => ({ line: i, quote: quoteOf(line) })).filter(x => x.quote);

  // 완성된 본문 → 렌더용 Markdown: 인용 줄은 찾은 것만 %%OVQn%% 자리표시(못 찾으면 줄째 삭제), [[fig:id]]는 %%OVFn%% 문단
  function prepare(text, isFound = () => true) {
    const quotes = [], figs = [];
    const lines = String(text || "").replace(ERROR_TAIL, "").split("\n").flatMap(line => {
      const q = quoteOf(line);
      if (q) {
        if (!isFound(q)) return [];
        quotes.push(q);
        return [`%%OVQ${quotes.length - 1}%%`];
      }
      return [line.replace(FIG_RE, (_, id) => { figs.push(id); return `\n\n%%OVF${figs.length - 1}%%\n\n`; })];
    });
    return { md: lines.join("\n").replace(/\n{3,}/g, "\n\n"), quotes, figs };
  }

  // 스트리밍 중 보이는 글: 그림 토큰(쓰는 중인 것 포함)과 [오류] 꼬리는 숨김
  const streamView = text => String(text || "").replace(ERROR_TAIL, "").replace(FIG_RE, "").replace(/\[\[[^\]\n]*$/, "");

  // '## 3줄 요약'의 첫 줄 (접힌 카드 미리보기·library gist). done이 아니면 끝나지 않은 마지막 줄은 아직 안 씀
  function gistOf(text, done = true) {
    const t = String(text || "");
    const at = t.search(/^#{1,3}\s*3줄\s*요약/m);
    if (at < 0) return "";
    const rest = t.slice(at).split("\n").slice(1);
    for (let i = 0; i < rest.length; i++) {
      if (/^#/.test(rest[i])) return "";
      const m = rest[i].match(/^\s*(?:[-*•]|\d+[.)])\s+(.+)/);
      if (!m) continue;
      if (!done && i === rest.length - 1) return "";
      return m[1].replace(/\*\*|__|`/g, "").trim();
    }
    return "";
  }

  // ### 질문별 본문 (인용·그림 줄 제외) → '더 묻기'의 context
  function sectionsOf(text) {
    const out = [];
    let cur = null;
    for (const line of String(text || "").replace(ERROR_TAIL, "").split("\n")) {
      const hm = line.match(/^###\s+(.+?)\s*#*\s*$/);
      if (hm) { cur = { heading: hm[1].trim(), body: [] }; out.push(cur); continue; }
      if (/^#{1,2}\s/.test(line)) { cur = null; continue; }
      if (cur && !quoteOf(line)) cur.body.push(line.replace(FIG_RE, ""));
    }
    return out.map(s => ({ heading: s.heading, body: s.body.join("\n").trim() }));
  }

  function toMarkdown({ title = "", url = "", text = "", method = "" } = {}) {
    const clean = s => String(s || "").replace(ERROR_TAIL, "").replace(FIG_RE, "").replace(/\n{3,}/g, "\n\n").trim();
    return [title && `# ${title}`, url, clean(text), method && `## 방법론 자세히\n\n${clean(method)}`]
      .filter(Boolean).join("\n\n") + "\n";
  }

  // 본문 링크 → 코드 저장소 (github/gitlab, 서버 paper_index().code_links와 같은 규칙), 중복 제거
  function codeLinks(hrefs) {
    const out = [];
    for (const href of hrefs || []) {
      const m = String(href).match(CODE_RE);
      if (!m) continue;
      const url = `https://${m[1].toLowerCase()}.com/${m[2]}/${m[3].replace(/\.git$/i, "")}`;
      if (!out.some(u => u.toLowerCase() === url.toLowerCase())) out.push(url);
    }
    return out;
  }

  // arXiv comment → 게재 정보 한 구절: 키워드부터 ';' 또는 문장 끝까지.
  // 문장 끝 = '. ' 뒤 대문자·숫자, 단 앞 낱말이 약어(Proc. Int. Conf. J. Trans.)면 계속. 'Unpublished'는 아님
  const VENUE_RE = /\b(?:accepted|to appear|published|camera[- ]ready)\b/i;
  function venueOf(comment) {
    for (const clause of String(comment || "").split(";")) {
      const at = clause.search(VENUE_RE);
      if (at < 0) continue;
      let s = clause.slice(at);
      for (const m of s.matchAll(/\.\s+(?=[A-Z0-9])/g)) {
        const word = (s.slice(0, m.index).match(/(\S+)$/) || [""])[0];
        if (/^[A-Z][a-z]{0,4}$/.test(word)) continue; // 약어
        s = s.slice(0, m.index);
        break;
      }
      s = s.trim().replace(/\.$/, "").trim();
      if (s) return s;
    }
    return "";
  }

  // arXiv 메타 → 칩 [{label, href?, title?}]. openedId에 버전이 있고 최신이 아니면 알림
  function metaChips(meta, openedId = "") {
    if (!meta || !meta.version) return [];
    const day = s => String(s || "").slice(0, 10);
    const latest = String(meta.version).replace(/^v/, "");
    const opened = (String(openedId).match(/v(\d+)$/) || [])[1];
    const chips = [{
      label: opened && opened !== latest ? `v${opened} · 최신 v${latest}` : `v${latest}`,
      href: meta.abs_url || undefined, title: "arXiv 버전",
    }];
    if (meta.published) {
      const upd = day(meta.updated) !== day(meta.published) ? ` · ${day(meta.updated)} 수정` : "";
      chips.push({ label: `${day(meta.published)} 제출${upd}` });
    }
    if (meta.primary_category) chips.push({ label: meta.primary_category, title: (meta.categories || []).join(", ") || undefined });
    // arXiv comment 중 게재 정보만 ("Accepted at ICLR 2025" 등; "12 pages, 4 figures"는 뺌)
    const venue = venueOf(meta.comment);
    if (venue) chips.push({ label: venue.slice(0, 60), title: meta.comment });
    if (meta.doi) chips.push({ label: "DOI", href: `https://doi.org/${meta.doi}`, title: meta.doi });
    return chips;
  }

  const api = { quoteOf, parseQuoteLines, prepare, streamView, gistOf, sectionsOf, toMarkdown, codeLinks, venueOf, metaChips };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;
  if (document.body.dataset.page !== "paper") return;
  PaperApp.registerFeature("overview", api);

  // ---------- DOM ----------
  const UI = window.PaperUI, A = window.PaperAnchor, h = UI.h;
  const paper = document.getElementById("paper");
  const id = PaperApp.arxivId;
  if (!paper || !id) return;
  const enc = encodeURIComponent(id);
  const URLS = { overview: `/api/overview/${enc}`, method: `/api/overview/${enc}/method`, meta: `/api/overview/${enc}/meta`, pdf: `/api/overview/${enc}/pdf` };
  const draw = (el, t) => (window.renderAnswer ? renderAnswer(el, t) : (el.textContent = t));
  const drawNow = (el, t) => (window.renderAnswerNow ? renderAnswerNow(el, t) : (el.textContent = t));

  // 카드: 메타 칩 줄 + '한눈에 보기 ▸' (접힘: 3줄 요약 첫 줄 미리보기)
  const toggle = h("button", { type: "button", class: "ov-toggle", "aria-expanded": "false" },
    h("span", { text: "한눈에 보기" }), h("span", { class: "ov-caret", "aria-hidden": "true", text: "▸" }));
  // 미리보기 줄은 처음부터 자리를 잡아 둠 (나중에 글이 와도 아래 본문이 밀리지 않게: iOS는 스크롤 앵커링 없음)
  const teaser = h("p", { class: "ov-teaser ov-pending", text: "요약 준비 중…" });
  const textEl = h("div", { class: "ov-text" });
  const methodBody = h("div", { class: "ov-text" });
  const methodEl = h("div", { class: "ov-method", hidden: true },
    h("div", { class: "ov-method-head" }, h("b", { text: "방법론 자세히" }),
      UI.feedback("overview", `${PaperApp.baseId}:overview.method.v1`, { label: "방법론 자세히" })),
    methodBody);
  const methodBtn = h("button", { type: "button", class: "ov-btn", "aria-expanded": "false", text: "방법론 자세히 ▸" });
  const copyBtn = h("button", { type: "button", class: "ov-btn", text: "마크다운 복사" });
  const bodyEl = h("div", { class: "ov-body", hidden: true }, textEl, methodEl,
    h("div", { class: "ov-foot" }, methodBtn, copyBtn, UI.feedback("overview", `${PaperApp.baseId}:overview.v1`, { label: "한눈에 보기" })));
  const card = h("section", { class: "ov-card", "aria-label": "한눈에 보기" }, toggle, teaser, bodyEl);
  const metaRow = h("div", { class: "ov-meta" });
  const wrap = h("div", { class: "ov" }, metaRow, card);
  const authors = paper.querySelector(".ltx_authors"), abs = paper.querySelector(".ltx_abstract");
  const titleEl = paper.querySelector(".ltx_title_document");
  if (authors) A.insertUI(authors, wrap, "afterend");
  else if (abs) A.insertUI(abs, wrap, "beforebegin");
  else if (titleEl) A.insertUI(titleEl, wrap, "afterend");
  else A.insertUI(paper.querySelector("article") || paper, wrap, "afterbegin");

  // ---------- 스트리밍 GET → 버퍼 (cached_stream: 실패는 502 또는 [오류] 꼬리) ----------
  async function readStream(url, onText) {
    let res;
    try { res = await fetch(url); } catch { throw new Error("네트워크 연결을 확인하세요"); }
    if (!res.ok || !res.body) {
      let msg = "";
      try { msg = (await res.json()).detail; } catch { /* 무시 */ }
      throw new Error(typeof msg === "string" && msg ? msg : `HTTP ${res.status}`);
    }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      onText(text);
    }
    text += dec.decode();
    const m = text.match(ERROR_TAIL);
    if (m) throw new Error(m[0].replace(/^\s*\[오류\]\s*/, ""));
    if (!text.trim()) throw new Error("빈 응답");
    return text;
  }
  // 한 번만 받는 작업. start(true)는 실패했을 때만 ?retry=1로 다시
  function makeJob(url, on) {
    const job = { text: "", done: false, error: null, promise: null };
    const call = name => { try { on[name](job); } catch (e) { console.error("[overview]", e); } };
    job.start = (retry = false) => {
      if (job.promise && !(retry && job.error)) return job.promise;
      Object.assign(job, { text: "", done: false, error: null });
      job.promise = readStream(retry ? `${url}?retry=1` : url, t => { job.text = t; call("text"); }).then(
        t => { job.text = t; job.done = true; PaperApp.addOfflineUrl(url); call("done"); },
        e => { job.error = String((e && e.message) || e); call("fail"); });
      return job.promise;
    };
    return job;
  }

  // ---------- 완성본 그리기: 인용 → '본문 보기' 칩, [[fig:id]] → 그림 복제, ### → '더 묻기' ----------
  function findLoose(q) {
    const r = A.findQuote(q);
    if (r) return r;
    const w = q.split(/\s+/);
    return w.length >= 8 ? A.findQuote(w.slice(0, 6).join(" ")) || A.findQuote(w.slice(-6).join(" ")) : null;
  }
  function quoteChip(q) {
    return h("button", {
      type: "button", class: "ov-chip", title: q, "aria-label": `본문 보기: ${q}`, text: "📍 본문 보기",
      onclick: () => { const r = findLoose(q); if (r) PaperNav.jumpTo(r); else UI.toast("본문에서 찾지 못했습니다"); },
    });
  }
  // 본문 그림의 복제 (figure → div: '#paper figure'를 찾는 기능들이 복제본을 세지 않게). 탭하면 원래 그림을 크게/그 자리로
  const retag = el => { const d = h("div", { class: `${el.className || ""} ov-${el.localName}`.trim() }); d.append(...el.childNodes); return d; };
  function figBlock(figId) {
    const orig = document.getElementById(figId);
    if (!orig || orig.localName !== "figure" || !paper.contains(orig) || orig.closest(".pr-ui")) return null;
    const c = UI.cloneClean(orig);
    c.querySelectorAll("figure, figcaption").forEach(f => f.replaceWith(retag(f)));
    // 캡션 속 인용·참조 링크는 글자로만 (탭은 상자 전체 = 그림 열기 하나; 링크가 살아 있으면 두 번 점프)
    c.querySelectorAll("a").forEach(a => { const s = h("span", { class: "ov-a" }); s.append(...a.childNodes); a.replaceWith(s); });
    const box = h("div", { class: "ov-fig", role: "button", tabindex: "0", "aria-label": "그림 크게 보기" }, retag(c));
    const open = () => {
      const img = orig.querySelector("img");
      if (img && PaperApp.has("figure-viewer")) document.dispatchEvent(new CustomEvent("paper:open-figure", { detail: { figureEl: orig, img } }));
      else PaperNav.jumpTo(orig);
    };
    box.addEventListener("click", open);
    box.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    return box;
  }
  function fillMarkers(root, quotes, figs) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.data.includes("%%OV")) nodes.push(n);
    for (const n of nodes) {
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const m of n.data.matchAll(MARK_RE)) {
        frag.append(n.data.slice(last, m.index));
        const el = m[1] === "Q" ? quoteChip(quotes[+m[2]]) : figBlock(figs[+m[2]]);
        if (el) frag.append(el);
        last = m.index + m[0].length;
      }
      frag.append(n.data.slice(last));
      n.replaceWith(frag);
    }
    // 그림만 있는 문단은 문단째 바꿈 (p 안에 div가 들어가지 않게)
    for (const f of root.querySelectorAll("p > .ov-fig")) {
      const p = f.parentElement;
      if ([...p.childNodes].every(c => c === f || c.nodeName === "BR" || (c.nodeType === 3 && !c.data.trim()))) p.replaceWith(f);
    }
  }
  function addAskButtons(el, text) {
    const secs = sectionsOf(text);
    el.querySelectorAll("h3").forEach((h3, i) => {
      const s = secs[i];
      if (!s) return;
      h3.append(h("button", {
        type: "button", class: "ov-ask", text: "더 묻기", "aria-label": `${s.heading} 더 묻기`,
        onclick: () => PaperApp.openSheet({
          title: "한눈에 보기", quote: s.heading, context: s.body, section: "한눈에 보기 (AI 요약)",
          autoAsk: { q: `${s.heading} 더 자세히 설명해줘`, label: "더 묻기" },
        }),
      }));
    });
  }
  function finalize(el, text) {
    const { md, quotes, figs } = prepare(text, q => !!findLoose(q));
    drawNow(el, md);
    fillMarkers(el, quotes, figs);
    if (el === textEl) addAskButtons(el, text); // 방법론에는 없음 (제목마다 버튼이면 시끄러움)
    el.querySelectorAll("a[href]").forEach(a => {
      if (!a.getAttribute("href").startsWith("#")) { a.target = "_blank"; a.rel = "noopener"; }
    });
    el.dataset.plain = window.marked && window.DOMPurify ? "" : "1"; // CDN(render.js와 같은 조건)이 늦으면 load 때 다시
    el.dataset.final = "1";
  }
  // 대기 중인 rAF 그리기(스트리밍 청크)를 취소한 뒤 바꿈: 안 그러면 한 프레임 뒤 부분 글이 오류 상자를 덮어씀
  const replaceNow = (el, ...nodes) => { drawNow(el, ""); el.replaceChildren(...nodes); };
  function showError(el, msg, retry) {
    el.dataset.final = "";
    replaceNow(el, h("p", { class: "ov-error" }, h("span", { text: `만들지 못했습니다 (${msg}) ` }),
      h("button", { type: "button", class: "ov-btn", text: "다시", onclick: retry })));
  }
  function showLoading(el, j, label) {
    el.dataset.final = "";
    if (j.text) draw(el, streamView(j.text));
    else replaceNow(el, h("p", { class: "ov-loading", text: `${label} 만드는 중…` }));
  }

  // ---------- 한눈에 보기 ----------
  let expanded = false, statusOn = false, statusTimer = null;
  function setStatus(state) {
    clearTimeout(statusTimer);
    if (state === "loading") { // 캐시 적중(즉시)이면 칩을 띄우지 않음
      statusTimer = setTimeout(() => { statusOn = true; UI.status("overview", "요약", "loading"); }, 400);
      return;
    }
    if (state === "error" || statusOn) UI.status("overview", "요약", state, { onRetry: () => loadOverview(true) });
    statusOn = state === "error";
  }
  function setTeaser(text, pending) {
    teaser.textContent = text;
    teaser.classList.toggle("ov-pending", pending);
  }
  function updateTeaser(j) {
    const g = gistOf(j.text, j.done);
    if (g) setTeaser(g, false);
    else if (j.error) setTeaser("요약을 만들지 못했습니다 · 펼쳐서 다시 시도", true);
    else if (j.done) setTeaser("펼쳐서 요약 보기", true);
    else if (!teaser.classList.contains("ov-pending")) return; // 이미 받은 미리보기는 유지
    else setTeaser("요약 준비 중…", true);
    teaser.hidden = expanded;
  }
  const ov = makeJob(URLS.overview, {
    text: j => { updateTeaser(j); if (expanded) draw(textEl, streamView(j.text)); },
    done: j => {
      setStatus("ready");
      updateTeaser(j);
      if (expanded) finalize(textEl, j.text);
      const gist = gistOf(j.text);
      if (gist) PaperApp.feature("library")?.add?.({ id: PaperApp.baseId, gist });
    },
    fail: j => { setStatus("error"); updateTeaser(j); if (expanded) showError(textEl, j.error, () => loadOverview(true)); },
  });
  function loadOverview(retry = false) {
    if (!ov.promise || (retry && ov.error)) setStatus("loading");
    const p = ov.start(retry);
    if (!ov.done && !ov.error) updateTeaser(ov);
    if (expanded && !ov.done && !ov.error) showLoading(textEl, ov, "요약");
    return p;
  }
  function setExpanded(on) {
    expanded = on;
    toggle.setAttribute("aria-expanded", String(on));
    card.classList.toggle("open", on);
    bodyEl.hidden = !on;
    teaser.hidden = on;
    if (!on) return;
    if (ov.done) { if (!textEl.dataset.final) finalize(textEl, ov.text); }
    else if (ov.error) showError(textEl, ov.error, () => loadOverview(true));
    else loadOverview();
  }
  toggle.addEventListener("click", () => setExpanded(!expanded));

  // ---------- 방법론 자세히 (요청할 때만 생성) ----------
  let methodOpen = false;
  const mj = makeJob(URLS.method, {
    text: j => { if (methodOpen) draw(methodBody, streamView(j.text)); },
    done: j => { if (methodOpen) finalize(methodBody, j.text); },
    fail: j => { if (methodOpen) showError(methodBody, j.error, () => { mj.start(true); showLoading(methodBody, mj, "방법론"); }); },
  });
  methodBtn.addEventListener("click", () => {
    methodOpen = !methodOpen;
    methodEl.hidden = !methodOpen;
    methodBtn.textContent = methodOpen ? "방법론 접기 ▾" : "방법론 자세히 ▸";
    methodBtn.setAttribute("aria-expanded", String(methodOpen));
    if (!methodOpen) return;
    if (mj.done) { if (!methodBody.dataset.final) finalize(methodBody, mj.text); }
    else if (mj.error) showError(methodBody, mj.error, () => { mj.start(true); showLoading(methodBody, mj, "방법론"); });
    else { mj.start(); showLoading(methodBody, mj, "방법론"); }
  });

  copyBtn.addEventListener("click", () => {
    if (!ov.done) { UI.toast("요약이 아직 준비되지 않았습니다"); return; }
    const title = (titleEl && A.textOf(titleEl)) || document.title;
    UI.copy(toMarkdown({ title, url: `https://arxiv.org/abs/${id}`, text: ov.text, method: mj.done ? mj.text : "" }),
      "마크다운으로 복사했습니다");
  });

  // CDN(marked)이 늦게 와서 일반 텍스트로 그렸으면 다시
  window.addEventListener("load", () => {
    if (textEl.dataset.plain === "1" && ov.done) finalize(textEl, ov.text);
    if (methodBody.dataset.plain === "1" && mj.done) finalize(methodBody, mj.text);
  });

  // ---------- 메타 칩: arXiv·PDF(제목 이름)·코드는 바로, 버전·날짜·분야는 arXiv API 응답 뒤 ----------
  const chipLink = (label, href, title) =>
    h("a", { class: "ov-mchip", href, target: "_blank", rel: "noopener", title: title || undefined, text: label });
  const repos = codeLinks([...paper.querySelectorAll("a[href]")]
    .filter(a => !a.closest(".ltx_bibliography, .pr-ui")).map(a => a.getAttribute("href")));
  function renderMeta(meta) {
    metaRow.replaceChildren(
      chipLink("arXiv ↗", `https://arxiv.org/abs/${id}`, "arXiv 초록 페이지"),
      h("a", { class: "ov-mchip", href: URLS.pdf, download: "", title: "제목 이름으로 PDF 저장", text: "PDF ↓" }),
      ...repos.slice(0, 2).map(u => chipLink(`코드 · ${u.split("/").pop()} ↗`, u, u)),
      ...metaChips(meta, id).map(c => (c.href ? chipLink(c.label, c.href, c.title)
        : h("span", { class: "ov-mchip ov-info", title: c.title || undefined, text: c.label }))),
    );
  }
  renderMeta(null);
  PaperApp.warm.then(() => setTimeout(async () => {
    try {
      const r = await fetch(URLS.meta);
      const m = r.ok ? await r.json() : null;
      if (m && m.version) { renderMeta(m); PaperApp.addOfflineUrl(URLS.meta); }
    } catch { /* 오프라인: 기본 칩만 */ }
  }, 300));

  // ---------- 헤더 '요약' (⋯ 40) · 미리 받기 ----------
  UI.addBarButton({
    id: "overview", label: "요약",
    onClick: () => {
      setExpanded(true);
      const top = wrap.getBoundingClientRect().top;
      if (top < 0 || top > window.innerHeight * 0.6) PaperNav.jumpTo(wrap, { flash: false });
    },
  });
  // 서버는 논문을 열 때(prewarm) 이미 생성을 시작함: 여기서는 버퍼로 받아 두기만 (펼치면 바로)
  PaperApp.idle(() => loadOverview());
})();
