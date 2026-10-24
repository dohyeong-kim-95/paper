// cite-cards: 인용 [n] 탭 → 참고문헌 카드(즉시) + arXiv·Semantic Scholar·Crossref 보강, 왜 인용?, .bib 담기, GitHub 링크 미리보기
(function () {
  "use strict";

  // ---------- 순수 함수 (node 테스트 대상) ----------
  const WHY_Q = "인용된 논문이 무엇이고 이 문장에서 왜 인용됐는지 한국어로 3문장 이내로 설명해줘";
  const ABS_CUT = 300;
  // 마침표가 문장 끝이 아닌 약어 (et al. / e.g. / Fig. …). 한 글자(이니셜 A.)도 제외
  const ABBR = new Set("al e.g i.e etc cf vs resp approx fig figs eq eqs sec secs tab tabs ref refs thm app lem def prop cor ch no vol pp dr prof st".split(" "));

  const clip = (s, n) => {
    s = String(s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s;
  };

  // 문장 시작 위치들 (0 포함)
  function sentenceStarts(text) {
    const out = [0];
    const re = /[.!?]["')\]]*\s+/g;
    let m;
    while ((m = re.exec(text))) {
      if (text[m.index] === ".") {
        const w = (text.slice(Math.max(0, m.index - 12), m.index).match(/([A-Za-z.]+)$/) || ["", ""])[1].toLowerCase();
        if (ABBR.has(w) || /^[a-z]$/.test(w)) continue;
      }
      out.push(m.index + m[0].length);
    }
    return out;
  }

  // 문단 text에서 오프셋 at(인용 표시 위치)이 든 문장. 너무 길면 at 주변 max자
  function citingSentence(text, at, max = 300) {
    text = String(text || "");
    at = Math.max(0, Math.min(Number(at) || 0, text.length));
    let s = 0, e = text.length;
    for (const x of sentenceStarts(text)) { if (x <= at) s = x; else { e = x; break; } }
    let out = text.slice(s, e);
    if (out.length > max) {
      const from = Math.max(0, Math.min(out.length - max, at - s - Math.floor(max / 2)));
      out = (from > 0 ? "…" : "") + out.slice(from, from + max) + (from + max < out.length ? "…" : "");
    }
    return out.replace(/\s+/g, " ").trim();
  }

  // github.com/<owner>/<repo>[/...] → {owner, repo, full} | null (저장소가 아닌 경로는 제외)
  const GH_SKIP = new Set("orgs features topics about marketplace sponsors settings login join explore collections site apps enterprise pricing search trending notifications security".split(" "));
  function ghRepo(href) {
    const m = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})(?=[/?#]|$)/i.exec(String(href || "").trim());
    if (!m || GH_SKIP.has(m[1].toLowerCase())) return null;
    const repo = m[2].replace(/(\.git|\.+)$/i, "");
    if (!repo || repo === "." || repo === "..") return null;
    return { owner: m[1], repo, full: `${m[1]}/${repo}` };
  }

  function ago(iso, now = Date.now()) {
    const t = Date.parse(iso || "");
    if (!t) return "";
    const d = Math.floor((now - t) / 86400000);
    if (d < 1) return "오늘";
    if (d < 30) return `${d}일 전`;
    if (d < 365) return `${Math.floor(d / 30)}개월 전`;
    return `${Math.floor(d / 365)}년 전`;
  }
  const fmtNum = n => (typeof n === "number" ? n.toLocaleString("en-US") : "");

  // 저자 줄: 5명까지 + 외
  const authorLine = e => (e && e.authors && e.authors.length ? e.authors.join(", ") + (e.n_authors > e.authors.length ? " 외" : "") : "");
  // 게재처 · 연도 · 인용 N회
  const metaLine = e => [e.venue, e.year, typeof e.citations === "number" ? `인용 ${fmtNum(e.citations)}회` : ""].filter(Boolean).join(" · ");

  // ---- .bib 바구니 ----
  const STOP = new Set("a an the on of for in to and with via from towards toward is are we our at by".split(" "));
  const ascii = s => String(s || "").normalize("NFKD").replace(/[^\x00-\x7f]/g, "");
  // 참고문헌 원문의 첫 저자 성: '이름 성,' / '성, 이니셜' / 'A. 성.' / 'A 성 and …'
  function firstSurname(raw) {
    const s = String(raw || "");
    const m = /^(.*?)(?:,|\s+and\s+|([A-Za-z]{2})\.\s)/.exec(s); // 두 글자 이상 단어 뒤의 '. '만 (이니셜 'A.' 제외)
    const head = m ? m[1] + (m[2] || "") : s;
    const w = head.trim().split(/\s+/).filter(x => /[A-Za-z]{2}/.test(x));
    return w.length ? w[w.length - 1] : "";
  }
  function bibKey(card) {
    const e = (card && card.enriched) || {};
    const raw = (card && card.bib_text) || "";
    const who = e.authors && e.authors[0] ? e.authors[0].trim().split(/\s+/).pop() : firstSurname(raw);
    const year = e.year || (raw.match(/\b(?:19|20)\d{2}\b/) || [""])[0];
    const word = ascii(e.title || (card && card.title_guess) || "").toLowerCase().split(/[^a-z0-9]+/)
      .find(w => w.length > 2 && !STOP.has(w)) || "";
    const key = (ascii(who).toLowerCase().replace(/[^a-z]/g, "") + year + word).slice(0, 40);
    return key || "ref";
  }
  // BibTeX 값 이스케이프. $…$ 수식은 그대로 두고(그 안의 % & #만), 밖에서는 & % # _ ^ ~ $ 를 이스케이프.
  // 서지(raw=false, arXiv 제목 등은 LaTeX가 섞임): \명령·이미 이스케이프된 문자·짝 맞는 중괄호는 살리고, 홀로 선 \ 와 짝 없는 괄호만 처리.
  // 참고문헌 원문(raw=true, 화면 글자): 중괄호는 빼고 \ 는 \textbackslash{}
  const TEX_CH = { "&": "\\&", "%": "\\%", "#": "\\#", _: "\\_", "^": "\\^{}", "~": "\\~{}", $: "\\$" };
  function texText(t, raw) {
    if (raw) return t.replace(/[{}]/g, "").replace(/\\|[&%#_^~$]/g, c => (c === "\\" ? "\\textbackslash{}" : TEX_CH[c]));
    return t.replace(/\\(?:[A-Za-z]+|[&%$#_{}~^\\ ])|\\|[&%#_^~$]/g, m => (m.length > 1 ? m : m === "\\" ? "\\textbackslash{}" : TEX_CH[m]));
  }
  function texBalance(s) { // 짝 없는 { } 는 뺌 (\{ \} 는 글자이므로 셈에서 제외)
    const drop = new Set(), open = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "\\") i++;
      else if (s[i] === "{") open.push(i);
      else if (s[i] === "}") { if (open.length) open.pop(); else drop.add(i); }
    }
    open.forEach(i => drop.add(i));
    return drop.size ? s.split("").filter((_, i) => !drop.has(i)).join("") : s;
  }
  function texEsc(v, raw = false) {
    const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim().replace(/\\\$/g, "\u0000"); // \$ 는 수식 구분자가 아님
    const out = s.split(/(\$[^$]+\$)/).map((p, i) => (i % 2 ? p.replace(/\\.|[%&#]/g, m => (m.length > 1 ? m : "\\" + m)) : texText(p, raw)));
    return texBalance(out.join("").replace(/\u0000/g, "\\$")).replace(/\s+/g, " ").trim();
  }
  const CONF = /conference|proceedings|workshop|symposium|\b(neurips|nips|icml|iclr|acl|emnlp|naacl|eacl|coling|cvpr|iccv|eccv|aaai|ijcai|sigir|kdd|interspeech|icassp|uai|aistats|colt|wacv|corl|rss)\b/i;
  function toBibtex(card) {
    const e = card && card.enriched;
    const key = bibKey(card);
    const f = [];
    const add = (k, v) => { if (v != null && String(v).trim()) f.push(`  ${k} = {${String(v).trim()}}`); };
    if (!e) {
      add("note", texEsc(card && card.bib_text, true));
      return `@misc{${key},\n${f.join(",\n")}\n}`;
    }
    const conf = !!e.venue && CONF.test(e.venue);
    const authors = (e.authors || []).map(a => texEsc(a)).filter(Boolean);
    add("title", texEsc(e.title));
    if (authors.length) add("author", authors.join(" and ") + (e.n_authors > authors.length ? " and others" : ""));
    add("year", e.year);
    if (e.venue) add(conf ? "booktitle" : "journal", texEsc(e.venue));
    else if (e.arxiv_id) add("journal", `arXiv preprint arXiv:${e.arxiv_id}`);
    if (e.arxiv_id) { add("eprint", e.arxiv_id); add("archivePrefix", "arXiv"); }
    add("doi", e.doi);
    add("url", e.arxiv_id ? `https://arxiv.org/abs/${e.arxiv_id}` : e.doi ? `https://doi.org/${e.doi}` : "");
    const type = conf ? "inproceedings" : e.venue || e.arxiv_id ? "article" : "misc";
    return `@${type}{${key},\n${f.join(",\n")}\n}`;
  }
  // 바구니 항목 id: arXiv > DOI > 이 논문의 참고문헌 번호
  function basketId(card, baseId) {
    const e = (card && card.enriched) || {};
    const ax = e.arxiv_id || card.arxiv_id;
    if (ax) return `arxiv:${ax}`;
    const doi = e.doi || card.doi;
    return doi ? `doi:${String(doi).toLowerCase()}` : `ref:${baseId}:${card.bib_id}`;
  }
  const basketEntry = (card, baseId, ts = Date.now()) => ({ id: basketId(card, baseId), key: bibKey(card), bibtex: toBibtex(card), ts });
  function basketAdd(list, entry) {
    const out = (Array.isArray(list) ? list : []).filter(x => x && x.id !== entry.id);
    out.push(entry);
    return out;
  }
  // 내보내기: 키가 겹치면 뒤의 것에 b, c … 붙임
  function bibExport(list) {
    const seen = new Map();
    return (Array.isArray(list) ? list : []).filter(x => x && x.bibtex).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0)).map(x => {
      const n = seen.get(x.key) || 0;
      seen.set(x.key, n + 1);
      return n ? x.bibtex.replace(/^(@\w+\{)([^,]*),/, (_, a, k) => `${a}${k}${String.fromCharCode(97 + Math.min(n, 25))},`) : x.bibtex;
    }).join("\n\n") + "\n";
  }
  const bibTitle = bibtex => {
    const m = /\btitle = \{([^\n]*)\},?$/m.exec(bibtex || "") || /\bnote = \{([^\n]*)\},?$/m.exec(bibtex || "");
    return m ? m[1] : "";
  };

  // '여기서 왜 인용?' 질문의 문맥: 참고문헌 원문 + 알게 된 서지·초록
  function whyContext(card) {
    const e = card && card.enriched;
    const lines = [`인용 ${(card && card.label) || ""}: ${(card && card.bib_text) || ""}`.replace(/\s+:/, ":")];
    if (e) {
      if (e.title) lines.push(`제목: ${e.title}`);
      if (authorLine(e)) lines.push(`저자: ${authorLine(e)}`);
      const pub = [e.venue, e.year].filter(Boolean).join(", ");
      if (pub) lines.push(`게재: ${pub}`);
      if (e.tldr) lines.push(`TL;DR: ${e.tldr}`);
      if (e.summary) lines.push(`초록: ${clip(e.summary, 1500)}`);
    }
    return lines.join("\n");
  }

  // 선택 안의 인용들 → 질문 문맥에 덧붙일 블록 (참고문헌 원문 + 이번 세션에 불러온 제목·초록)
  function citedContext(items, max = 600) {
    const parts = [];
    for (const it of (items || []).slice(0, 6)) {
      const card = it.card || {};
      const e = card.enriched;
      const lines = [`${card.label || it.id}: ${clip(card.bib_text || "", 300)}`];
      if (e && e.title) lines.push(`제목: ${e.title}`);
      const abs = e && (e.summary || e.tldr);
      if (abs) lines.push(`초록: ${clip(abs, max)}`);
      parts.push(lines.join("\n"));
    }
    return parts.length ? `<cited-papers>\n${parts.join("\n\n")}\n</cited-papers>` : "";
  }

  const api = {
    WHY_Q, clip, sentenceStarts, citingSentence, ghRepo, ago, fmtNum, authorLine, metaLine, firstSurname, bibKey,
    texEsc, toBibtex, basketId, basketEntry, basketAdd, bibExport, bibTitle, whyContext, citedContext,
  };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;
  if (document.body.dataset.page !== "paper") return;
  PaperApp.registerFeature("cite-cards", api);

  // ---------- DOM ----------
  const UI = PaperUI, A = PaperAnchor, h = UI.h;
  const BASKET = "cite-cards:bib";
  const BIB_LINK = 'a[href^="#bib."]';
  const cards = new Map(); // bibId -> 서버 카드 (이번 세션; 선택 질문 문맥에도 씀)
  const pending = new Map(); // bibId -> Promise
  const repos = new Map(); // owner/repo -> Promise
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const basket = () => { const l = PaperStore.get(BASKET, []); return Array.isArray(l) ? l.filter(x => x && x.id) : []; };

  function bibIdOf(a) {
    let id = (a.getAttribute("href") || "").slice(1);
    try { id = decodeURIComponent(id); } catch { /* 그대로 */ }
    return id;
  }
  // 서버 응답 전에도 바로 쓰는 카드 (본문의 참고문헌 항목에서)
  function localCard(bibId) {
    const li = document.getElementById(bibId);
    const tag = li && li.querySelector(".ltx_tag_bibitem, .ltx_tag");
    const label = tag ? A.textOf(tag) : "";
    let text = li ? A.textOf(li) : "";
    if (label && text.startsWith(label)) text = text.slice(label.length).trim();
    return { bib_id: bibId, label, bib_text: text, arxiv_id: null, doi: null, title_guess: "", enriched: null, local: true };
  }
  const cardOf = bibId => cards.get(bibId) || localCard(bibId);

  function load(bibId) {
    const hit = cards.get(bibId);
    if (hit && !hit.partial) return Promise.resolve(hit);
    if (pending.has(bibId)) return pending.get(bibId);
    const url = `/api/cite-cards/${encodeURIComponent(PaperApp.arxivId)}/${encodeURIComponent(bibId)}`;
    const p = fetch(url)
      .then(r => (r.ok ? r.json() : Promise.reject(Object.assign(new Error(`HTTP ${r.status}`), { status: r.status }))))
      .then(card => {
        const before = cardOf(bibId);
        cards.set(bibId, card);
        if (!card.partial) PaperApp.addOfflineUrl(url);
        upgradeBasket(before, card);
        return card;
      })
      .finally(() => pending.delete(bibId));
    pending.set(bibId, p);
    return p;
  }

  // 본문 위치 정보: 인용 문장(색인 텍스트 기준, 수식은 $alttext$)과 섹션 제목
  function citeContext(a) {
    let link = a;
    const ko = a.closest(".tr-ko");
    if (ko) { // 번역문 안의 복제 링크 → 원문 단위의 같은 링크로
      const unit = PaperApp.feature("section-translate")?.unitFor?.(ko);
      const href = a.getAttribute("href");
      const twin = unit && [...unit.querySelectorAll("a[href]")].find(x => x.getAttribute("href") === href);
      if (twin) link = twin;
    }
    const sec = link.closest("section");
    const title = sec && [...sec.children].find(c => c.classList.contains("ltx_title"));
    const section = title ? A.textOf(title) : link.closest(".ltx_abstract") ? "Abstract" : "";
    let sentence = "";
    const p = link.closest(".ltx_p, p, li, figcaption, td") || link.parentElement;
    const idx = A.index();
    const po = !link.closest(".tr-ko") && A.offsetsOfElement(p, idx), ao = po && A.offsetsOfElement(link, idx);
    if (po && ao) sentence = citingSentence(idx.text.slice(po.start, po.end), ao.start - po.start);
    else { // 색인 밖(번역문): 그 요소 글자에서
      const host = link.closest(".tr-ko") || p;
      const r = document.createRange();
      r.selectNodeContents(host);
      r.setEndBefore(link);
      sentence = citingSentence(host.textContent, r.toString().length);
    }
    return { sentence, section };
  }

  // ---------- 인용 카드 peek ----------
  function link(label, href, ext, cls) {
    const el = h("a", { href, class: cls || "", text: label });
    if (ext) { el.target = "_blank"; el.rel = "noopener"; }
    return el;
  }
  const button = (label, onclick, cls) => h("button", { type: "button", class: cls || "", text: label, onclick });
  const doiUrl = doi => "https://doi.org/" + String(doi).split("/").map(encodeURIComponent).join("/");
  const scholarUrl = q => "https://scholar.google.com/scholar?q=" + encodeURIComponent(clip(q, 250));

  // 초록 300자 + 더보기 (펼침 상태는 ctx에: 카드를 다시 그려도 유지)
  function absBlock(text, ctx) {
    const full = String(text).replace(/\s+/g, " ").trim();
    const p = h("p", { class: "cc-abs" });
    if (full.length <= ABS_CUT) { p.textContent = full; return p; }
    const more = button("", () => { ctx.absOpen = !ctx.absOpen; show(); }, "cc-more");
    const show = () => {
      p.textContent = ctx.absOpen ? full : clip(full, ABS_CUT);
      more.textContent = ctx.absOpen ? "접기" : "더보기";
      more.setAttribute("aria-expanded", String(!!ctx.absOpen));
    };
    show();
    return h("div", {}, p, more);
  }

  function infoBlock(ctx) {
    const { card, state } = ctx;
    const e = card.enriched;
    if (e) {
      return h("div", { class: "cc-info" },
        h("div", { class: "cc-title", text: e.title || card.title_guess || "" }),
        authorLine(e) ? h("div", { class: "cc-sub", text: authorLine(e) }) : null,
        metaLine(e) ? h("div", { class: "cc-sub", text: metaLine(e) }) : null,
        e.tldr ? h("div", { class: "cc-tldr" }, h("b", { text: "TL;DR" }), h("span", { text: e.tldr })) : null,
        e.summary ? absBlock(e.summary, ctx) : null);
    }
    if (state === "loading") {
      return h("div", { class: "cc-info cc-loading", "aria-busy": "true" },
        h("span", { class: "cc-skel" }), h("span", { class: "cc-skel cc-skel-short" }),
        h("span", { class: "cc-status", text: "논문 정보를 찾는 중…" }));
    }
    if (state === "error" || card.partial) {
      return h("div", { class: "cc-status" }, h("span", { text: "추가 정보를 불러오지 못했습니다 (오프라인·요청 제한)" }),
        button("다시", () => refresh(ctx, true)));
    }
    return h("div", { class: "cc-status", text: "온라인에서 이 문헌의 추가 정보를 찾지 못했습니다" });
  }

  function render(ctx) {
    const { view, card, li } = ctx;
    if (!view.isConnected && ctx.drawn) return;
    ctx.drawn = true;
    const e = card.enriched || {};
    const ax = e.arxiv_id || card.arxiv_id;
    const doi = e.doi || card.doi;
    const bib = UI.cloneClean(li);
    bib.querySelectorAll("a[href^='http']").forEach(x => { x.target = "_blank"; x.rel = "noopener"; });
    const main = h("div", { class: "cc-row" }, button("여기서 왜 인용?", ev => askWhy(ctx, ev.currentTarget), "primary"));
    if (ax) main.append(link("이 앱에서 열기", `/paper/${encodeURIComponent(ax)}`, false, "cc-open"));
    const more = h("div", { class: "cc-row cc-chips" });
    if (ax) more.append(link("arXiv", `https://arxiv.org/abs/${encodeURIComponent(ax)}`, true));
    if (doi) more.append(link("DOI", doiUrl(doi), true));
    more.append(link("Scholar 검색", scholarUrl(e.title || card.title_guess || card.bib_text), true));
    if (e.summary || e.tldr) more.append(button("초록 번역", () => translateAbstract(ctx)));
    if (ax) more.append(button("★ 나중에 읽기", () => readLater(card, ax)));
    const inBasket = basket().some(x => x.id === basketId(card, PaperApp.baseId));
    more.append(button(inBasket ? ".bib에 담김 ✓" : ".bib에 담기", () => toggleBasket(ctx), inBasket ? "on" : ""));
    more.append(button("목록에서 보기", () => { ctx.close("close"); PaperNav.jumpTo(li); }));
    const n = basket().length;
    view.replaceChildren(...[
      infoBlock(ctx), h("div", { class: "cc-bib" }, bib), main, more,
      n ? button(`모아둔 참고문헌 ${n}개 ›`, openBasket, "cc-basket-link") : null,
    ].filter(Boolean));
  }

  function refresh(ctx, force) {
    if (force) cards.delete(ctx.bibId);
    ctx.state = "loading";
    render(ctx);
    load(ctx.bibId).then(card => { ctx.card = card; ctx.state = "ready"; render(ctx); })
      .catch(() => { ctx.state = "error"; render(ctx); });
  }

  function openCard(a) {
    const bibId = bibIdOf(a);
    const li = document.getElementById(bibId);
    if (!li) return;
    const card = cardOf(bibId);
    const view = h("div", { class: "cc-card" });
    const close = UI.peek({ title: `참고문헌 ${card.label}`.trim(), body: view, className: "cc-peek" });
    const ctx = { bibId, li, view, close, card, state: cards.has(bibId) ? "ready" : "loading", ...citeContext(a) };
    if (!cards.has(bibId) || card.partial) refresh(ctx, false); // 원문 카드는 바로, 보강은 도착하면 다시 그림
    else render(ctx);
  }

  async function askWhy(ctx, btn) {
    if (pending.has(ctx.bibId)) { // 보강이 곧 오면 초록까지 넣어서 (최대 1.5초)
      btn.disabled = true;
      btn.textContent = "…";
      await Promise.race([pending.get(ctx.bibId).catch(() => null), sleep(1500)]);
      if (!ctx.view.isConnected) return; // 기다리는 사이 카드를 닫음(✕·뒤로·바깥 탭) → 묻지 않음
    }
    const card = cardOf(ctx.bibId);
    const s = ctx.sentence || card.bib_text;
    PaperApp.openSheet({
      quote: s, selection: s, context: whyContext(card), section: ctx.section, title: `인용 ${card.label}`.trim(),
      autoAsk: { q: WHY_Q, label: "왜 인용?", id: "cite-cards:why" },
    });
  }

  function translateAbstract(ctx) {
    const e = ctx.card.enriched || {};
    PaperApp.openSheet({
      quote: e.title || "", selection: e.summary || e.tldr, context: `인용된 논문: ${e.title || ctx.card.bib_text}`,
      title: "초록 번역", autoAsk: { q: "한국어로 번역해줘", label: "초록 번역", id: "translate" },
    });
  }

  function readLater(card, ax) {
    const lib = PaperApp.feature("library");
    if (!lib || typeof lib.add !== "function") { UI.toast("라이브러리 기능이 없어 저장할 수 없습니다"); return; }
    const e = card.enriched || {};
    lib.add({ id: PaperStore.baseIdOf(ax), title: e.title || card.title_guess || "", authors: e.authors || [], status: "to-read" });
    UI.toast("읽을 목록에 추가했습니다");
  }

  // ---------- .bib 바구니 (pr:cite-cards:bib) ----------
  function toggleBasket(ctx) {
    const id = basketId(ctx.card, PaperApp.baseId);
    const old = basket().find(x => x.id === id);
    if (old) {
      PaperStore.set(BASKET, basket().filter(x => x.id !== id));
      UI.toast("바구니에서 뺐습니다", { actionLabel: "실행 취소", onAction: () => { PaperStore.update(BASKET, l => basketAdd(l, old), []); render(ctx); } });
    } else {
      const l = PaperStore.update(BASKET, l => basketAdd(l, basketEntry(ctx.card, PaperApp.baseId)), []);
      UI.toast(`.bib에 담았습니다 (${l.length}개)`); // 버튼 없는 토스트: 뒤이은 '실행 취소' 토스트를 막지 않게 (목록은 카드 아래 링크)
    }
    render(ctx);
  }
  // 보강 전에 담은 항목(원문 @misc)은 서지가 오면 더 나은 BibTeX로 바꿈
  function upgradeBasket(before, card) {
    const list = basket();
    const ids = new Set([basketId(before, PaperApp.baseId), basketId({ ...card, enriched: null }, PaperApp.baseId)]);
    const old = list.find(x => ids.has(x.id));
    if (!old || !card.enriched) return;
    const next = basketEntry(card, PaperApp.baseId, old.ts);
    if (next.bibtex === old.bibtex && next.id === old.id) return;
    PaperStore.set(BASKET, basketAdd(list.filter(x => x.id !== old.id), next));
  }

  function openBasket() {
    const body = h("div", { class: "cc-basket" });
    const draw = () => {
      const items = basket().sort((a, b) => (b.ts || 0) - (a.ts || 0));
      body.replaceChildren(...(items.length ? items.map(x => h("div", { class: "cc-bitem" },
        h("div", { class: "cc-bmain" }, h("code", { text: x.key }), h("div", { class: "cc-sub", text: clip(bibTitle(x.bibtex), 120) })),
        h("button", { type: "button", "aria-label": `${x.key} 빼기`, text: "✕", onclick: () => remove(x) }))) :
        [h("p", { class: "cc-status", text: "아직 담은 참고문헌이 없습니다. 인용 카드에서 '.bib에 담기'를 누르세요." })]));
    };
    const remove = x => {
      PaperStore.set(BASKET, basket().filter(y => y.id !== x.id));
      draw();
      UI.toast("삭제됨", { actionLabel: "실행 취소", onAction: () => { PaperStore.update(BASKET, l => basketAdd(l, x), []); draw(); } });
    };
    draw();
    const text = () => bibExport(basket());
    UI.peek({
      title: "모아둔 참고문헌", body, className: "cc-peek",
      actions: [
        { label: ".bib 복사", primary: true, onClick: () => UI.copy(text(), ".bib를 복사했습니다") },
        { label: ".bib 다운로드", onClick: () => UI.download("references.bib", text(), "application/x-bibtex") },
      ],
    });
  }

  // ---------- GitHub 링크 미리보기 ----------
  function loadRepo(full) {
    if (!repos.has(full)) {
      const url = `/api/cite-cards/github?repo=${encodeURIComponent(full)}`;
      const p = fetch(url).then(r => (r.ok ? r.json() : Promise.reject(Object.assign(new Error(`HTTP ${r.status}`), { status: r.status }))));
      // 404(없음)는 서버도 캐시하므로 이번 세션 동안 그대로, 그 밖의 실패(503·오프라인)만 다음 탭에서 다시
      p.then(() => PaperApp.addOfflineUrl(url), e => { if (e.status !== 404) repos.delete(full); });
      repos.set(full, p);
    }
    return repos.get(full);
  }
  function repoView(d) {
    const meta = [typeof d.stars === "number" ? `★ ${fmtNum(d.stars)}` : "", d.language, d.license && d.license !== "NOASSERTION" ? d.license : "",
      d.pushed_at ? `${ago(d.pushed_at)} 업데이트` : ""].filter(Boolean).join(" · ");
    return [
      h("p", { class: "cc-abs", text: d.description || "설명이 없는 저장소입니다." }),
      meta ? h("div", { class: "cc-sub", text: meta }) : null,
      d.archived ? h("div", { class: "cc-warn", text: "보관됨 (더 이상 관리되지 않음)" }) : null,
      d.topics && d.topics.length ? h("div", { class: "cc-row cc-topics" }, d.topics.map(t => h("span", { text: t }))) : null,
      d.homepage ? h("div", { class: "cc-sub" }, "홈페이지: ", link(clip(d.homepage.replace(/^https?:\/\//, ""), 60), d.homepage, true)) : null,
    ].filter(Boolean);
  }
  function openRepo(a, gh) {
    const href = a.href;
    const body = h("div", { class: "cc-card cc-repo" }, h("span", { class: "cc-skel" }), h("span", { class: "cc-status", text: "저장소 정보를 불러오는 중…" }));
    UI.peek({
      title: gh.full, body, className: "cc-peek",
      actions: [
        { label: "열기", primary: true, onClick: ({ close }) => { window.open(href, "_blank", "noopener"); close(); } },
        { label: "링크 복사", onClick: () => UI.copy(href, "링크를 복사했습니다") },
      ],
    });
    loadRepo(gh.full)
      .then(d => body.replaceChildren(...repoView(d)))
      .catch(e => body.replaceChildren(h("p", {
        class: "cc-status",
        text: e.status === 404 ? "저장소를 찾을 수 없습니다 (비공개이거나 삭제됨)." : "지금은 정보를 불러올 수 없습니다 (GitHub 요청 제한 또는 오프라인).",
      })));
  }

  // ---------- 탭 처리기 (§5.4) ----------
  PaperApp.addTapHandler({
    id: "cite-cards", priority: 80,
    test: e => { const a = e.target.closest(BIB_LINK); return a && document.getElementById(bibIdOf(a)) ? a : null; },
    handle: (e, a) => openCard(a),
  });
  PaperApp.addTapHandler({
    id: "cite-cards:link", priority: 75,
    test: e => { const a = e.target.closest("a[href]"); const gh = a && ghRepo(a.href); return gh ? { a, gh } : null; },
    handle: (e, hit) => openRepo(hit.a, hit.gh),
  });

  // ---------- 선택에 인용이 들어 있으면 질문 문맥에 그 논문 정보 ----------
  function citesIn(range) {
    if (!range || typeof range.intersectsNode !== "function") return [];
    let root = range.commonAncestorContainer;
    if (root && root.nodeType !== 1) root = root.parentElement;
    if (!root) return [];
    const own = root.closest(BIB_LINK);
    const links = own ? [own] : [...root.querySelectorAll(BIB_LINK)].filter(x => range.intersectsNode(x));
    return [...new Set(links.map(bibIdOf))].filter(id => document.getElementById(id));
  }
  PaperApp.addSessionHook(s => {
    const ids = citesIn(s.selInfo && s.selInfo.range);
    const block = citedContext(ids.map(id => ({ id, card: cardOf(id) })));
    if (block) s.context = s.context ? `${s.context}\n\n${block}` : block;
  });
  // 인용이 든 선택을 하면 (3개까지) 미리 보강 → 곧 하는 질문에 제목·초록이 들어감.
  // idle은 시작 시점만 정함: 응답(arXiv 대기로 최대 12초)을 기다리며 공유 idle 큐를 붙잡지 않게 promise를 돌려주지 않음
  PaperApp.on("selection", sel => {
    const ids = sel && sel.anchored ? citesIn(sel.range).filter(id => !cards.has(id)).slice(0, 3) : [];
    if (ids.length) PaperApp.idle(() => { for (const id of ids) load(id).catch(() => null); });
  });
})();
