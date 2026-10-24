// section-study: 섹션 제목 아래 '요약'(2~3줄 한국어 요약) · '퀴즈'(3문항, 근거 문장으로 점프) 칩
(function () {
  "use strict";

  // ---------- 순수 함수 (node 테스트 대상) ----------
  // 섹션 단계: 서버 build_index와 같은 순서로 첫 ltx_<level> 클래스
  const LEVELS = ["section", "subsection", "subsubsection", "appendix", "paragraph"];
  const GIST_LEVELS = ["section", "subsection", "appendix"]; // 서버 GIST_LEVELS와 같게
  const TOP_LEVELS = ["section", "appendix"]; // 퀴즈 칩은 최상위 섹션만
  const MAX_GISTS = 30; // 서버 MAX_SECTIONS와 같게
  const TOP_SELECTOR = "section.ltx_section[id], section.ltx_appendix[id]";
  const NUMS = "①②③④";
  const levelOf = el => (el && el.classList ? LEVELS.find(lv => el.classList.contains(`ltx_${lv}`)) || null : null);

  // 요약을 받을 섹션 (서버 gist_sections와 같은 규칙): list = 문서 순서 [{id, level}] → id Set.
  // 최상위를 먼저 모두, 남는 자리는 하위 섹션으로 → 요약이 올 리 없는 섹션엔 '요약' 칩을 안 만듦
  function pickGistIds(list, max = MAX_GISTS) {
    const cand = (list || []).filter(x => GIST_LEVELS.includes(x.level));
    const keep = new Set(cand.filter(x => TOP_LEVELS.includes(x.level)).slice(0, max).map(x => x.id));
    for (const x of cand) {
      if (keep.size >= max) break;
      if (!TOP_LEVELS.includes(x.level)) keep.add(x.id);
    }
    return keep;
  }

  // .ss-head 자리: 섹션 .ltx_title 바로 뒤, section-translate의 .tr-ko 제목이 있으면 그 뒤 (제목 안은 금지: 번역 모드에 tr-hide)
  function headRef(title) {
    let ref = title;
    while (ref.nextElementSibling && ref.nextElementSibling.classList.contains("tr-ko")) ref = ref.nextElementSibling;
    return ref;
  }

  const explainQuestion = title => `${String(title || "이").trim()} 섹션을 쉽게 풀어줘`;
  const QUIZ_FALLBACK_Q = "이 섹션을 이해했는지 확인하는 4지선다 문제 3개를 내줘. 정답과 짧은 해설은 문제를 모두 낸 뒤 맨 끝에 따로 적어줘";

  // 퀴즈 진행 상태 (peek를 닫았다 열어도 이어서): {items, i, picks}
  const newQuiz = items => ({ items: (items || []).slice(), i: 0, picks: [] });
  // 지금 문항에 답하기 → {correct, a}, 이미 답했으면 null
  function pick(st, choice) {
    const it = st.items[st.i];
    if (!it || st.picks[st.i] != null) return null;
    st.picks[st.i] = choice;
    return { correct: choice === it.a, a: it.a };
  }
  // 다음 문항으로 → 아직 남았으면 true
  function advance(st) {
    if (st.i < st.items.length) st.i++;
    return st.i < st.items.length;
  }
  const score = st => st.items.reduce((n, it, i) => n + (st.picks[i] === it.a ? 1 : 0), 0);
  function scoreMessage(n, total) {
    if (!total) return "";
    if (n === total) return `${total}문제 모두 정답! 이 섹션을 잘 이해했어요`;
    if (!n) return `${total}문제 중 0개 정답 · 근거 문장을 다시 읽어 볼까요?`;
    return `${total}문제 중 ${n}개 정답`;
  }

  const api = { GIST_LEVELS, TOP_LEVELS, MAX_GISTS, levelOf, pickGistIds, headRef, explainQuestion, newQuiz, pick, advance, score, scoreMessage };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;
  if (document.body.dataset.page !== "paper") return;

  const App = window.PaperApp, UI = window.PaperUI, A = window.PaperAnchor, h = UI.h;
  const paper = document.getElementById("paper");
  if (!paper || !App.arxivId) return;
  App.registerFeature("section-study", api);

  const base = `/api/section-study/${encodeURIComponent(App.arxivId)}`;
  const GIST_URL = `${base}/gists`;
  const STATUS = ["section-study", "섹션 요약"];
  const renderNow = (el, text) => (window.renderAnswerNow ? window.renderAnswerNow(el, text) : (el.textContent = text));
  const note = text => h("p", { class: "ss-note", text });
  const btn = (text, onclick, cls = "ss-btn") => h("button", { type: "button", class: cls, text, onclick });
  const titleElOf = sec => [...sec.children].find(c => c.classList.contains("ltx_title")) || null;
  const titleOf = s => (s.titleEl ? A.textOf(s.titleEl) : "") || s.id;
  // 퀴즈를 낼 수 있는 최상위 섹션 (참고문헌 등은 아님)
  const topSectionOf = el => (el && el.closest ? el.closest(TOP_SELECTOR) : null);

  // ---------- 섹션마다 칩 줄 + 요약 상자 (.ss-head, pr-ui) ----------
  // 처음에 바로 넣고 나중에 숨기지 않음 (번들은 스크롤 복원 전에 돎 → 줄이 생기거나 접혀 읽던 자리가 밀리지 않게.
  // iOS Safari는 스크롤 앵커링이 없음). 그래서 요약이 올 섹션(서버와 같은 규칙)과 퀴즈 칩이 있는 섹션에만 넣음
  const found = [...paper.querySelectorAll("section[id]")]
    .map(el => ({ el, id: el.id, level: levelOf(el), titleEl: titleElOf(el) }))
    .filter(x => x.level && x.titleEl);
  const gistIds = pickGistIds(found);
  const secs = new Map(); // id -> {id, el, titleEl, head, gistChip?, box?}
  for (const { el, id, level, titleEl } of found) {
    const withGist = gistIds.has(id), withQuiz = TOP_LEVELS.includes(level);
    if (!withGist && !withQuiz) continue;
    const s = { id, el, titleEl };
    const chips = h("div", { class: "ss-chips" });
    const parts = [chips];
    if (withGist) {
      const boxId = `ss-box-${secs.size}`;
      s.box = h("div", { class: "ss-box", id: boxId, hidden: true });
      s.gistChip = h("button", {
        type: "button", class: "ss-chip", text: "요약", "aria-expanded": "false", "aria-controls": boxId,
        onclick: () => toggleGist(s),
      });
      chips.append(s.gistChip);
      parts.push(s.box);
    }
    if (withQuiz) {
      chips.append(h("button", { type: "button", class: "ss-chip", text: "퀴즈", "aria-haspopup": "dialog", onclick: () => openQuiz(s) }));
    }
    s.head = h("div", { class: "ss-head" }, ...parts);
    A.insertUI(headRef(titleEl), s.head, "afterend");
    secs.set(id, s);
  }
  const gistSecs = [...secs.values()].filter(s => s.gistChip);

  // ---------- 요약: idle에 미리 받아 두고, 칩을 누르면 바로 ----------
  let gists = null, gistFail = false, gistLoading = null;
  function loadGists(retry = false) {
    if (gists) return Promise.resolve(gists);
    if (gistLoading) return gistLoading;
    gistFail = false;
    let shown = false;
    const t = setTimeout(() => { shown = true; UI.status(...STATUS, "loading"); }, 400); // 캐시 적중이면 칩 깜빡임 없음
    gistLoading = fetch(retry ? `${GIST_URL}?retry=1` : GIST_URL)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(map => {
        gists = map && typeof map === "object" && !Array.isArray(map) ? map : {};
        App.addOfflineUrl(GIST_URL);
        UI.status(...STATUS, shown ? "ready" : null); // 전에 뜬 오류 칩도 지움
        document.dispatchEvent(new CustomEvent("paper:gists", { detail: { map: gists } }));
        return gists;
      }, e => {
        gistFail = true;
        UI.status(...STATUS, "error", { onRetry: () => loadGists(true).catch(() => {}) });
        throw e;
      })
      .finally(() => { clearTimeout(t); gistLoading = null; refresh(); });
    refresh();
    return gistLoading;
  }

  // 모델이 요약을 빠뜨린 섹션: 칩은 자리에 그대로 두고(줄이 접혀 읽던 자리가 밀리지 않게) 점선으로만 구분.
  // 누르면 '요약이 없습니다' + '이 섹션 더 묻기'
  function refresh() {
    for (const s of gistSecs) {
      if (!s.box.hidden) fillBox(s);
      s.gistChip.classList.toggle("ss-empty", !!gists && !gists[s.id]);
    }
  }

  function fillBox(s) {
    const g = gists && gists[s.id];
    const more = btn("이 섹션 더 묻기", () => askMore(s));
    if (g) {
      const text = h("div", { class: "ss-gist" });
      renderNow(text, g);
      s.box.replaceChildren(text, h("div", { class: "ss-actions" }, more, UI.feedback("gist", s.id, { label: titleOf(s).slice(0, 100) })));
    } else if (gists) {
      s.box.replaceChildren(note("이 섹션은 요약이 없습니다."), h("div", { class: "ss-actions" }, more));
    } else if (gistFail) {
      s.box.replaceChildren(note("요약을 불러오지 못했습니다."),
        h("div", { class: "ss-actions" }, btn("다시", () => loadGists(true).catch(() => {})), more));
    } else {
      s.box.replaceChildren(note("섹션 요약을 만드는 중… (논문마다 처음 한 번)"));
    }
  }

  function toggleGist(s) {
    const open = s.box.hidden;
    s.box.hidden = !open;
    s.gistChip.setAttribute("aria-expanded", String(open));
    if (!open) return;
    fillBox(s);
    // 사용자가 기다리는 중: idle 차례를 기다리지 않고 바로 받기
    if (!gists && !gistLoading && !gistFail) loadGists().catch(() => {});
  }

  function askMore(s) {
    const title = titleOf(s);
    const g = (gists && gists[s.id]) || "";
    App.openSheet({
      quote: title, section: title, context: g ? `섹션 요약: ${g}` : "", title: "섹션 질문",
      presets: [
        { id: "section-study:example", label: "예시로", q: "이 섹션 내용을 구체적인 예시로 설명해줘" },
        { id: "section-study:flow", label: "논문 흐름에서", q: "이 섹션이 논문 전체 흐름에서 어떤 역할을 하는지 알려줘" },
        // run은 새로고침·탭 복원 때 저장되지 않음 (JSON) → 복원된 시트에서는 q로 대화 안에서 퀴즈
        { id: "section-study:quiz", label: "이 섹션 퀴즈", q: QUIZ_FALLBACK_Q, run: () => { const t = quizTarget(s.el); t && openQuiz(t); } },
      ],
      autoAsk: { q: explainQuestion(title), label: "섹션 풀이", id: "section-study:explain" },
    });
  }

  // ---------- 퀴즈 (peek 하나, 한 문항씩) ----------
  // 퀴즈 대상은 최상위 섹션 (칩과 같은 캐시를 씀). 참고문헌 등 그 밖의 섹션은 null
  function quizTarget(el) {
    const top = topSectionOf(el);
    if (!top) return null;
    return secs.get(top.id) || { id: top.id, el: top, titleEl: titleElOf(top) };
  }

  const quizzes = new Map(); // sectionId -> {p, state, error}
  function fetchQuiz(id, retry) {
    const url = `${base}/quiz/${encodeURIComponent(id)}`;
    return fetch(retry ? `${url}?retry=1` : url).then(async r => {
      if (!r.ok) {
        let msg = "";
        try { msg = (await r.json()).detail; } catch { /* 무시 */ }
        throw Object.assign(new Error(typeof msg === "string" && msg ? msg : `HTTP ${r.status}`), { status: r.status });
      }
      const items = await r.json();
      if (!Array.isArray(items) || !items.length) throw new Error("문항이 없습니다");
      App.addOfflineUrl(url);
      return items;
    });
  }
  function ensureQuiz(s, retry) {
    let q = quizzes.get(s.id);
    if (q && !(retry && q.error)) return q;
    q = { state: null, error: null };
    // peek를 닫아도 받기는 계속 (다시 열면 이어서)
    q.p = fetchQuiz(s.id, retry).then(items => { q.state = newQuiz(items); }, e => { q.error = e; });
    quizzes.set(s.id, q);
    return q;
  }

  function openQuiz(s) {
    const body = h("div", { class: "ss-quiz" });
    const close = UI.peek({ title: `퀴즈 · ${titleOf(s)}`, body, className: "ss-quiz-peek" });
    showQuiz({ s, body, close }, false);
  }
  function showQuiz(ctx, retry) {
    const q = ensureQuiz(ctx.s, retry);
    if (q.state || q.error) { renderQuiz(ctx, q); return; }
    ctx.body.replaceChildren(note("퀴즈를 만드는 중… (몇 초 걸려요)"));
    q.p.then(() => { if (ctx.close.el.isConnected) renderQuiz(ctx, q); });
  }

  function renderQuiz(ctx, q) {
    const { body } = ctx;
    if (q.error) {
      // 404(논문에 없는 섹션)는 다시 해도 같음 → '다시' 없음
      const retry = q.error.status === 404 ? null : h("div", { class: "ss-actions" }, btn("다시", () => showQuiz(ctx, true)));
      body.replaceChildren(note(`퀴즈를 만들지 못했습니다. ${q.error.message || ""}`.trim()), ...(retry ? [retry] : []));
      return;
    }
    const st = q.state;
    if (st.i >= st.items.length) { renderResult(ctx, q); return; }
    const it = st.items[st.i], picked = st.picks[st.i];
    const qtext = h("div", { class: "ss-qtext" });
    renderNow(qtext, it.q);
    const choices = it.choices.map((c, k) => {
      const label = h("span", { class: "ss-ctext" });
      renderNow(label, c);
      const b = h("button", { type: "button", class: "ss-choice" }, h("span", { class: "ss-cnum", "aria-hidden": "true", text: NUMS[k] }), label);
      if (picked == null) b.addEventListener("click", () => { if (pick(st, k)) renderQuiz(ctx, q); });
      else {
        b.disabled = true;
        if (k === it.a) b.classList.add("ss-right");
        else if (k === picked) b.classList.add("ss-wrong");
      }
      return b;
    });
    body.replaceChildren(
      h("div", { class: "ss-progress", text: `${st.i + 1} / ${st.items.length}` }),
      qtext,
      h("div", { class: "ss-choices", role: "group", "aria-label": "선택지" }, choices),
    );
    if (picked == null) return;
    const rev = reveal(ctx, q, it, picked === it.a);
    body.append(rev);
    rev.querySelector(".ss-next")?.focus({ preventScroll: true });
    rev.scrollIntoView({ block: "nearest" });
  }

  function reveal(ctx, q, it, ok) {
    const st = q.state, last = st.i >= st.items.length - 1;
    const why = h("div", { class: "ss-why" });
    renderNow(why, it.why || "");
    const actions = h("div", { class: "ss-actions" });
    if (it.quote && findEvidence(ctx.s, it.quote, false)) actions.append(btn("근거 보기", () => showEvidence(ctx, it.quote)));
    actions.append(btn(last ? "결과 보기" : "다음 문제", () => {
      advance(st);
      if (last && !st.toasted) { st.toasted = true; UI.toast(scoreMessage(score(st), st.items.length)); }
      renderQuiz(ctx, q);
      ctx.close.el.scrollTop = 0;
    }, "ss-btn ss-next primary"));
    return h("div", { class: "ss-reveal", role: "status" },
      h("b", { class: ok ? "ss-ok" : "ss-no", text: ok ? "정답!" : `오답 · 정답은 ${NUMS[it.a]}` }), why, actions);
  }

  function renderResult(ctx, q) {
    const st = q.state, total = st.items.length;
    const review = h("ol", { class: "ss-review" }, st.items.map((it, i) => {
      const ok = st.picks[i] === it.a;
      const text = h("span", { class: "ss-ctext" });
      renderNow(text, it.q);
      // 문항을 누르면 그 문항(정답·해설)으로 돌아가 다시 보기
      return h("li", {}, h("button", { type: "button", class: "ss-review-item", onclick: () => { st.i = i; renderQuiz(ctx, q); } },
        h("span", { class: ok ? "ss-ok" : "ss-no", "aria-label": ok ? "정답" : "오답", text: ok ? "✓" : "✕" }), text));
    }));
    ctx.body.replaceChildren(
      h("p", { class: "ss-score", text: scoreMessage(score(st), total) }),
      review,
      h("div", { class: "ss-actions" },
        btn("다시 풀기", () => { q.state = newQuiz(st.items); renderQuiz(ctx, q); }),
        btn("이 섹션 질문하기", () => askMore(ctx.s)),
        UI.feedback("quiz", ctx.s.id, { label: titleOf(ctx.s).slice(0, 100) })),
    );
  }

  // 근거 원문: 그 섹션 안에서 먼저, 없으면 논문 전체
  function findEvidence(s, quote, asRange) {
    const find = asRange ? A.findQuote : A.locate;
    return find(quote, { root: s.el }) || find(quote);
  }
  function showEvidence(ctx, quote) {
    const r = findEvidence(ctx.s, quote, true);
    if (!r) { UI.toast("본문에서 근거 문장을 찾지 못했습니다"); return; }
    // 점프 레이어를 먼저 쌓고 peek를 닫음 → 뒤로가기 한 번이 원래 위치로. 시트가 열려 있으면 가리지 않게 내려둠
    window.PaperNav.jumpTo(r);
    ctx.close("evidence");
    if (App.isSheetOpen()) App.minimizeSheet();
    UI.toast("근거 문장으로 이동했어요", { actionLabel: "퀴즈로", onAction: () => openQuiz(ctx.s) });
  }

  // 시트 프리셋: 선택이 최상위 섹션(하위 섹션 포함) 안이면 '이 섹션 퀴즈' (질문 대신 퀴즈 peek). 참고문헌 등은 없음
  App.addPreset({
    id: "section-study:quiz", label: "이 섹션 퀴즈", order: 900,
    match: si => (si && si.sectionId && topSectionOf(si.sectionEl || document.getElementById(si.sectionId)) ? 1 : false),
    run: session => {
      const id = session && session.selInfo && session.selInfo.sectionId;
      const s = quizTarget(id ? document.getElementById(id) : null);
      if (s) openQuiz(s); else UI.toast("섹션을 찾지 못했습니다");
    },
  });

  if (gistSecs.length) App.idle(() => loadGists()).catch(() => { /* 상태 칩이 '다시'를 보여 줌 */ });
})();
