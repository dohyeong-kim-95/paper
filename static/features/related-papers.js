// related-papers: 관련 논문 패널 (참고한 · 비슷한 · 인용한 논문) + 선택 구절 '관련 연구' arXiv 검색
(function () {
  "use strict";

  // ---------- 순수 함수 (node 테스트 대상) ----------
  const squash = s => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

  // 초록 앞부분: n자 근처 단어 경계에서 자르고 …
  function clip(text, n = 140) {
    const t = squash(text);
    if (t.length <= n) return t;
    const cut = t.slice(0, n), sp = cut.lastIndexOf(" ");
    return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:]+$/, "") + "…";
  }

  // 저자 줄: "A, B, C 외 2명"
  function authorsLine(authors, total = 0) {
    const a = (authors || []).filter(Boolean);
    if (!a.length) return "";
    const rest = Math.max(total || 0, a.length) - a.length;
    return rest > 0 ? `${a.join(", ")} 외 ${rest}명` : a.join(", ");
  }

  // 항목 정보 줄: 연도 · 저자 · (참고문헌 번호 · 본문 인용 n회 | 피인용 n)
  function metaLine(it, kind) {
    const parts = [it.year, authorsLine(it.authors, it.n_authors)];
    if (kind === "cited") parts.push(it.label, it.cites > 0 ? `본문 인용 ${it.cites}회` : null);
    if (kind === "citing") parts.push(`피인용 ${Number(it.citations || 0).toLocaleString("ko-KR")}`);
    return parts.filter(x => x != null && x !== "").join(" · ");
  }

  // 선택 구절 검색 주소 (검색어 여러 개는 t=…&t=…)
  function searchUrl(id, terms) {
    return `/api/related-papers/${encodeURIComponent(id)}/search?` + terms.map(t => "t=" + encodeURIComponent(t)).join("&");
  }

  // Google Scholar 검색어: 짧은 구절(10단어 이하)은 그대로, 길면 고른 검색어 (여러 단어는 따옴표)
  function scholarQuery(text, terms = []) {
    const words = squash(String(text || "").replace(/\$[^$]*\$/g, " ")).split(" ").filter(Boolean);
    if (words.length > 10 && terms.length) return terms.map(t => (/\s/.test(t) ? `"${t}"` : t)).join(" ");
    return words.slice(0, 30).join(" ");
  }
  const scholarUrl = q => "https://scholar.google.com/scholar?q=" + encodeURIComponent(q);

  // 탭 이름 + 개수 (모르면 이름만)
  const tabLabel = (name, n) => (n == null || n === "" ? name : `${name} ${n}`);

  // 서재 기록 → 배지 (읽기 진행은 status, opened는 연 시각일 뿐)
  const libraryBadge = rec => {
    if (!rec) return null;
    const by = { done: "읽은 논문", reading: "읽는 중", "to-read": "읽을 목록" }[rec.status];
    return by || (rec.star ? "즐겨찾기" : "열어 본 논문");
  };
  const api = { clip, authorsLine, metaLine, searchUrl, scholarQuery, scholarUrl, tabLabel, libraryBadge };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;
  if (document.body.dataset.page !== "paper") return;
  PaperApp.registerFeature("related-papers", api);

  // ---------- DOM ----------
  const UI = window.PaperUI, h = UI.h;
  const id = PaperApp.arxivId;
  if (!id) return;
  const KEY = "related-papers", LABEL = "관련 논문";
  const BASE = `/api/related-papers/${encodeURIComponent(id)}`;
  const CITES = `${BASE}/citations`;
  const TABS = [
    { key: "cited", label: "참고한 논문", full: "이 논문이 참고한 논문" },
    { key: "similar", label: "비슷한 논문", full: "비슷한 논문" },
    { key: "citing", label: "인용한 논문", full: "이 논문을 인용한 논문" },
  ];
  const CITE_ERR = {
    not_found: "Semantic Scholar에 아직 이 논문이 없습니다. 새 논문은 며칠 걸릴 수 있습니다.",
    rate_limited: "요청이 많아 잠시 막혔습니다. 조금 뒤 다시 시도해 주세요.",
    network: "Semantic Scholar에 연결하지 못했습니다.",
  };

  // 오류 상태 코드는 throw (detail 메시지), 본문의 {error}는 정상 응답으로 돌려줌
  async function getJSON(url, opts) {
    const r = await fetch(url, opts);
    let body = null;
    try { body = await r.json(); } catch { /* 본문 없음 */ }
    if (!r.ok) throw Object.assign(new Error((body && typeof body.detail === "string" && body.detail) || `HTTP ${r.status}`), { status: r.status });
    return body || {};
  }
  const errText = e => (typeof navigator !== "undefined" && navigator.onLine === false ? "네트워크 연결이 필요합니다."
    : e && e.status === 404 ? "논문을 찾을 수 없습니다." : (e && e.message) || "불러오지 못했습니다.");

  // 같은 주소는 한 번만 받고 성공만 기억 (본문 error·네트워크 실패는 다음에 다시). 서버도 7일 캐시
  const memo = new Map();
  let relData = null; // 참고한·비슷한 논문 (선택 구절 결과에 '참고문헌 [n]' 표시용)
  function load(url) {
    if (!memo.has(url)) {
      const p = getJSON(url).then(d => {
        if (d.error) memo.delete(url);
        else {
          PaperApp.addOfflineUrl(url);
          if (url === BASE) relData = d;
        }
        return d;
      }, e => { memo.delete(url); throw e; });
      memo.set(url, p);
    }
    return memo.get(url);
  }
  const citedLabels = () => new Map(((relData && relData.cited) || []).map(c => [c.id, c.label || ""]));
  const paperTitle = () => (relData && relData.title) || squash(document.querySelector("#paper .ltx_title_document")?.textContent) || document.title;

  // ---------- 항목 ----------
  const libraryRec = pid => { try { return PaperApp.feature("library")?.get?.(pid) || null; } catch { return null; } };
  const ext = (href, text) => h("a", { href, target: "_blank", rel: "noopener", text });

  function absEl(summary) {
    const full = squash(summary), short = clip(full);
    const span = h("span", { text: short });
    const p = h("p", { class: "rel-abs" }, span);
    if (short.length < full.length) {
      const more = h("button", { type: "button", class: "rel-more", "aria-expanded": "false", text: "더보기" });
      more.addEventListener("click", () => {
        const open = more.getAttribute("aria-expanded") !== "true";
        span.textContent = open ? full : short;
        more.textContent = open ? "접기" : "더보기";
        more.setAttribute("aria-expanded", String(open));
      });
      p.append(" ", more);
    }
    return p;
  }

  function actionsEl(it) {
    const row = h("div", { class: "rel-actions" });
    if (it.id) {
      row.append(h("a", { class: "rel-open", href: `/paper/${encodeURIComponent(it.id)}`, text: "이 앱에서 열기" }),
        ext(it.abs_url || `https://arxiv.org/abs/${it.id}`, "arXiv"));
    } else {
      if (it.abs_url) row.append(ext(it.abs_url, "arXiv"));
      if (it.s2_url) row.append(ext(it.s2_url, "Semantic Scholar"));
      else if (it.doi) row.append(ext(`https://doi.org/${it.doi}`, "DOI"));
    }
    const lib = PaperApp.feature("library");
    if (it.id && lib && typeof lib.add === "function" && !libraryRec(it.id)) {
      const b = h("button", { type: "button", class: "rel-save", text: "☆ 나중에 읽기" });
      b.addEventListener("click", () => {
        try { lib.add({ id: it.id, title: it.title, authors: it.authors || [], status: "to-read" }); } catch (e) { console.error(e); return; }
        b.textContent = "★ 읽을 목록에 추가됨";
        b.disabled = true;
      });
      row.append(b);
    }
    return row.childNodes.length ? row : null;
  }

  function itemEl(it, kind, cited) {
    const badges = [];
    if (kind !== "cited" && it.id && cited && cited.has(it.id)) badges.push(squash(`참고문헌 ${cited.get(it.id)}`));
    const badge = it.id ? libraryBadge(libraryRec(it.id)) : null;
    if (badge) badges.push(badge);
    const meta = metaLine(it, kind);
    return h("li", { class: "rel-item" },
      h("div", { class: "rel-title" }, h("span", { text: it.title || it.id || "" }), ...badges.map(b => h("span", { class: "rel-badge", text: b }))),
      meta ? h("div", { class: "rel-meta", text: meta }) : null,
      it.summary ? absEl(it.summary) : null,
      actionsEl(it));
  }
  const listEl = (items, kind, cited) => h("ul", { class: "rel-list" }, items.map(it => itemEl(it, kind, cited)));
  const note = text => h("p", { class: "rel-note", text });
  function message(text, retry) {
    return h("div", { class: "rel-msg" }, h("span", { text }),
      retry ? h("button", { type: "button", class: "rel-retry", text: "다시", onclick: retry }) : null);
  }
  function skeleton(text) {
    return h("div", { class: "rel-loading", "aria-busy": "true" }, h("p", { class: "rel-note", text }),
      h("div", { class: "rel-skel" }), h("div", { class: "rel-skel" }), h("div", { class: "rel-skel" }));
  }

  // ---------- 관련 논문 패널 (⋯ 메뉴) ----------
  function openPanel() {
    const st = { cur: "cited", picked: false, alive: true, rel: null, relErr: null, relBusy: false, cite: null, citeErr: null, citeBusy: false };
    const tabsEl = h("div", { class: "rel-tabs", role: "tablist", "aria-label": "관련 논문 종류" });
    const panel = h("div", { class: "rel-panel", role: "tabpanel" });
    const btns = TABS.map(t => h("button", {
      type: "button", role: "tab", class: "rel-tab", title: t.full, dataset: { tab: t.key },
      onclick: () => { st.picked = true; show(t.key); },
    }, t.label));
    tabsEl.append(...btns);
    // ← → 로 탭 이동
    tabsEl.addEventListener("keydown", e => {
      const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!d) return;
      e.preventDefault();
      const i = (TABS.findIndex(t => t.key === st.cur) + d + TABS.length) % TABS.length;
      st.picked = true;
      show(TABS[i].key);
      btns[i].focus();
    });
    UI.peek({ title: LABEL, body: h("div", { class: "rel-body" }, tabsEl, panel), size: "large", className: "rel-peek",
      onClose: () => { st.alive = false; } });

    function fetchRel() {
      st.relBusy = true;
      st.relErr = null;
      paint();
      load(BASE).then(d => {
        st.rel = d;
        // 참고한 논문이 없으면 처음 한 번은 비슷한 논문 탭으로
        if (!st.picked && st.cur === "cited" && !(d.cited || []).length && (d.similar || []).length) st.cur = "similar";
      }, e => { st.relErr = e; }).finally(() => { st.relBusy = false; paint(); });
    }
    function fetchCite() {
      st.citeBusy = true;
      st.citeErr = null;
      paint();
      load(CITES).then(d => { st.cite = d; }, e => { st.citeErr = e; }).finally(() => { st.citeBusy = false; paint(); });
    }
    function show(key) {
      st.cur = key;
      if (key === "citing" && !st.citeBusy && !st.cite && !st.citeErr) fetchCite(); // 실패 뒤에는 '다시' 버튼으로만
      else paint();
    }

    function counts() {
      const ok = st.rel && !st.rel.error;
      const c = st.cite && !st.cite.error ? st.cite : null;
      return {
        cited: ok ? (st.rel.cited || []).length : null,
        similar: ok ? (st.rel.similar || []).length : null,
        citing: c ? `${c.total}${c.more ? "+" : ""}` : null,
      };
    }
    function relBody(key, d) {
      const list = d[key] || [];
      const out = [];
      if (key === "cited") out.push(note("이 논문이 참고한 arXiv 논문 · 본문에서 많이 인용한 순"));
      else out.push(note(d.terms && d.terms.length ? `제목 키워드로 찾은 arXiv 논문 · ${d.terms.join(" · ")}` : "제목 키워드로 찾은 arXiv 논문"));
      if (d.stale) out.push(note("arXiv에 연결하지 못해 저장해 둔 결과를 보여줍니다."));
      if (d.error && !list.length) out.push(message(d.error, fetchRel));
      else if (!list.length) out.push(message(key === "cited" ? "참고문헌에서 arXiv 논문을 찾지 못했습니다." : "비슷한 논문을 찾지 못했습니다."));
      else out.push(listEl(list, key, key === "similar" ? new Map((d.cited || []).map(c => [c.id, c.label || ""])) : null));
      return out;
    }
    function citeBody(d) {
      const list = d.citing || [];
      const out = [];
      if (d.error) out.push(message(CITE_ERR[d.error] || CITE_ERR.network, d.error === "not_found" ? null : fetchCite));
      else if (!list.length) out.push(message("아직 이 논문을 인용한 논문이 없습니다."));
      else {
        out.push(note(`이 논문을 인용한 논문 ${d.total}${d.more ? "+" : ""}편 · 피인용 많은 순${d.total > list.length ? ` ${list.length}편` : ""} (Semantic Scholar)`));
        out.push(listEl(list, "citing", citedLabels()));
      }
      out.push(h("p", { class: "rel-foot" },
        ext(scholarUrl(`"${paperTitle()}"`), "Google Scholar에서 보기"),
        ext(`https://www.semanticscholar.org/arxiv/${encodeURIComponent(PaperApp.baseId || id)}`, "Semantic Scholar에서 보기")));
      return out;
    }
    function paint() {
      if (!st.alive) return;
      const n = counts();
      TABS.forEach((t, i) => {
        const on = t.key === st.cur;
        // 이름과 개수를 두 줄로: 세 탭이 좁은 폰 폭에서도 잘리지 않게
        btns[i].replaceChildren(h("span", { class: "rel-tab-name", text: t.label }),
          n[t.key] == null ? "" : h("span", { class: "rel-tab-n", text: String(n[t.key]) }));
        btns[i].setAttribute("aria-label", tabLabel(t.label, n[t.key]));
        btns[i].setAttribute("aria-selected", String(on));
        btns[i].tabIndex = on ? 0 : -1;
      });
      const cite = st.cur === "citing";
      const [data, busy, err] = cite ? [st.cite, st.citeBusy, st.citeErr] : [st.rel, st.relBusy, st.relErr];
      let nodes;
      if (busy) nodes = [skeleton(cite ? "Semantic Scholar에서 찾는 중…" : "arXiv에서 찾는 중…")];
      else if (err) nodes = [message(errText(err), cite ? fetchCite : fetchRel)];
      else if (data) nodes = cite ? citeBody(data) : relBody(st.cur, data);
      else nodes = [];
      panel.replaceChildren(...nodes);
    }

    fetchRel();
  }

  // ---------- 선택 구절 → 관련 연구 ----------
  function openPassage(sel) {
    const text = squash(sel && sel.text).slice(0, 1500);
    if (!text) return;
    const ctrl = new AbortController();
    let terms = [], on = new Set(), runCtrl = null, timer = null, ai = true;
    // Google Scholar 링크는 결과를 기다리지 않고 바로 (arXiv에 없는 연구도 찾게)
    const scholar = ext(scholarUrl(scholarQuery(text)), "Google Scholar에서 검색 ↗");
    scholar.className = "rel-scholar";
    const termsEl = h("div", { class: "rel-terms", role: "group", "aria-label": "검색어" });
    const results = h("div", { class: "rel-panel" });
    UI.peek({
      title: "관련 연구", size: "large", className: "rel-peek",
      body: h("div", { class: "rel-body" }, h("blockquote", { class: "rel-quote", text: clip(text, 160) }), termsEl,
        h("p", { class: "rel-ext" }, scholar), results),
      onClose: () => { clearTimeout(timer); ctrl.abort(); runCtrl && runCtrl.abort(); },
    });

    function renderTerms() {
      termsEl.replaceChildren(h("span", { class: "rel-terms-label", text: ai ? "검색어" : "검색어 (구절의 단어)" }),
        ...terms.map(t => h("button", {
          type: "button", class: "rel-term", "aria-pressed": String(on.has(t)), text: t,
          onclick: e => {
            if (on.has(t)) on.delete(t); else on.add(t);
            e.currentTarget.setAttribute("aria-pressed", String(on.has(t)));
            scholar.href = scholarUrl(scholarQuery(text, terms.filter(x => on.has(x))));
            clearTimeout(timer);
            timer = setTimeout(run, 500); // 여러 개를 연달아 끄고 켤 때 한 번만 검색
          },
        })));
    }
    function getTerms() {
      results.replaceChildren(skeleton("검색어를 고르는 중…"));
      getJSON(`${BASE}/terms`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: text }), signal: ctrl.signal,
      }).then(d => {
        terms = d.terms || [];
        ai = d.ai !== false;
        on = new Set(terms);
        scholar.href = scholarUrl(scholarQuery(text, terms));
        renderTerms();
        if (terms.length) run();
        else results.replaceChildren(message("검색어를 찾지 못했습니다. Google Scholar에서 찾아보세요."));
      }, e => { if (!ctrl.signal.aborted) results.replaceChildren(message(errText(e), getTerms)); });
    }
    function run() {
      const list = terms.filter(t => on.has(t));
      if (runCtrl) runCtrl.abort();
      if (ctrl.signal.aborted) return;
      if (!list.length) { results.replaceChildren(message("검색어를 하나 이상 골라 주세요.")); return; }
      const rc = runCtrl = new AbortController();
      results.replaceChildren(skeleton("arXiv에서 찾는 중…"));
      getJSON(searchUrl(id, list), { signal: rc.signal }).then(d => {
        if (rc !== runCtrl) return;
        const hits = d.hits || [];
        if (d.error && !hits.length) results.replaceChildren(message(d.error, run));
        else if (!hits.length) results.replaceChildren(message("arXiv에서 찾지 못했습니다. 검색어를 몇 개 빼 보거나 Google Scholar에서 찾아보세요."));
        else results.replaceChildren(note(`arXiv 검색 결과 ${hits.length}편 · 관련도 순`), listEl(hits, "similar", citedLabels()));
      }, e => { if (rc === runCtrl && !rc.signal.aborted) results.replaceChildren(message(errText(e), run)); });
    }
    getTerms();
  }

  // ---------- 연결 ----------
  UI.addBarButton({ id: KEY, label: LABEL, icon: "📚", title: LABEL, onClick: () => openPanel() });
  PaperApp.addSelectionAction({ id: KEY, label: "관련 연구", order: 70, when: s => s.wordCount >= 3, onClick: openPassage });

  // 다 읽어 갈 때(참고문헌이 보이기 시작하면) 한가할 때 미리 받아 둠 → 패널이 바로 열림
  function prefetch() {
    if (memo.has(BASE)) return memo.get(BASE).catch(() => null);
    UI.status(KEY, LABEL, "loading");
    return load(BASE).then(d => UI.status(KEY, LABEL, d.error ? null : "ready"), () => UI.status(KEY, LABEL, null));
  }
  const bib = document.querySelector("#paper .ltx_bibliography");
  if (bib && typeof IntersectionObserver !== "undefined") {
    const io = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return;
      io.disconnect();
      PaperApp.idle(prefetch).catch(() => null);
    }, { rootMargin: "0px 0px 800px 0px" });
    io.observe(bib);
  }
})();
