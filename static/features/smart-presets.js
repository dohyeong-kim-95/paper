// smart-presets: 선택 유형별 프리셋(뜻·수식 풀이·3줄 요약) + 답변 스타일(길이·수준·모드·언어·관심 분야) + 내 프리셋 + 원탭 설명/번역 + 문장 선택 모드
(function () {
  "use strict";

  // ---------- 순수 함수 (node 테스트 대상) ----------
  const MEANING_Q = "선택한 표현의 한국어 뜻을 사전처럼 알려줘: 가능한 뜻 2~4개, 이 논문에서 쓰인 뜻은 **굵게**, 한 줄 설명, 이 분야에서의 뉘앙스. 6줄 이내.";
  const TRANSLATE_Q = "한국어로 번역해줘 (전문 용어는 처음 한 번만 영어 병기, 번역문만)";
  const INTUITION_Q = "이 수식을 직관적으로 설명해줘: 기호 나열 대신 비유와 작은 숫자 예시로, 무엇을 계산하고 왜 필요한지.";
  const SUMMARY_Q = "이 부분을 3줄로 요약해줘: 한 줄에 한 문장, 핵심 주장 → 방법 → 결과 순서. 다른 말 없이 3줄만.";
  // 번역문(.tr-ko)을 고르고 '번역': 한국어를 다시 번역하는 대신 영어 원문을 찾아 줌
  const ORIGINAL_Q = "이 한국어 번역에 해당하는 영어 원문 문장을 주변 문단에서 찾아 그대로 보여 주고, 핵심 용어의 영어 표현을 짚어줘. 6줄 이내.";
  const EASY = { id: "easy", label: "쉽게 설명", q: "이 부분을 쉽게 설명해줘" };

  const countWords = t => String(t || "").split(/\s+/).filter(Boolean).length;
  const wc = s => (typeof s.wordCount === "number" ? s.wordCount : countWords(s.text));
  const mathy = s => !!(s.isMath || (s.latex && s.latex.length));
  // 수식 풀이: 선택한 수식(alttext)을 질문에도 넣음 (최대 3개, 각 300자)
  function equationQ(s) {
    const tex = ((s && s.latex) || []).filter(Boolean).slice(0, 3).map(x => `$${String(x).slice(0, 300)}$`).join(", ");
    return `이 수식을 풀어줘: 각 기호의 뜻 → 식이 계산하는 것 → 왜 이런 형태인지 순서대로.${tex ? `\n수식: ${tex}` : ""}`;
  }

  // 점수표 (docs/FEATURES.md §5.3). equation·translate는 기본 프리셋을 같은 id로 덮어씀
  const SMART_PRESETS = [
    { id: "meaning", label: "뜻 (이 논문에서)", order: 1, q: MEANING_Q, match: s => (s && !s.isMath && wc(s) >= 1 && wc(s) <= 4 ? 100 : false) },
    { id: "translate", label: "번역", order: 30, q: TRANSLATE_Q, match: s => (!s || s.isMath ? false : wc(s) <= 4 ? 95 : 20) },
    { id: "equation", label: "수식 풀이", order: 20, q: equationQ, match: s => (s && mathy(s) ? 90 : false) },
    { id: "intuition", label: "직관적으로", order: 25, q: INTUITION_Q, match: s => (s && mathy(s) ? 85 : false) },
    { id: "summary3", label: "3줄 요약", order: 35, q: SUMMARY_Q, match: s => (s && wc(s) > 60 ? 60 : false) },
  ];

  // 프리셋 순위: 같은 id는 나중 것(upsert), match 점수 내림차순 → order. false면 숨김
  function rankPresets(selInfo, presets = SMART_PRESETS) {
    const byId = new Map();
    for (const p of presets) byId.set(p.id, p);
    return [...byId.values()]
      .map(p => ({ p, score: typeof p.match === "function" ? p.match(selInfo) : 0 }))
      .filter(x => typeof x.score === "number" && !Number.isNaN(x.score))
      .sort((a, b) => b.score - a.score || (a.p.order ?? 500) - (b.p.order ?? 500))
      .map(x => x.p);
  }

  // 수식이 선택의 대부분인지: 수식만이거나, 수식 밖 단어가 4개 이하이거나, LaTeX 글자 수가 산문 글자 수 이상
  // (산문에 기호 몇 개가 섞인 문단은 아님)
  function mathHeavy(s) {
    if (!s) return false;
    if (s.isMath) return true;
    const tex = (s.latex || []).filter(Boolean).map(String);
    if (!tex.length) return false;
    const prose = String(s.text || "").replace(/\$[^$]*\$/g, " ");
    return countWords(prose) <= 4 || tex.join("").length >= prose.replace(/\s+/g, "").length;
  }
  // 원탭 '설명'이 물을 프리셋: 순위 그대로가 아니라 '설명'다운 것만. 번역·3줄 요약·run(퀴즈 등)은 건너뜀,
  // 수식 풀이·직관은 수식이 대부분일 때만, 번역문(.tr-ko) 선택에는 '뜻'(한국어 뜻 사전 카드)을 쓰지 않음
  function explainPreset(s, presets = SMART_PRESETS) {
    const math = mathHeavy(s);
    const skip = p => !!p.run || p.id === "translate" || p.id === "summary3"
      || (!math && (p.id === "equation" || p.id === "intuition"))
      || (!!s && !!s.inTranslation && p.id === "meaning");
    return rankPresets(s, presets).find(p => !skip(p)) || EASY;
  }

  // 답변 스타일 (pr:smart-presets:style)
  const DEFAULT_STYLE = { len: "normal", level: "grad", field: "", mode: "normal", lang: "ko" };
  const LEN = { short: "짧게(5문장 이내)", normal: "보통(3문단 이내)", long: "자세히(단계·예시 포함)" };
  const LEVEL = { ug: "학부생(전문 용어는 쉬운 말로 풀어서)", grad: "대학원생", expert: "전문가(기초 설명 생략)" };
  const MODE = { normal: "", guide: "학습 가이드(답을 다 주지 말고 핵심 힌트 뒤 이해 확인 질문 1개로 끝내기. 사용자가 답하면 맞은 점·틀린 점을 짚고 다음 단계로)" };
  const LANG = { ko: "", both: "한국어, 전문 용어는 영어 병기(예: 전문가 혼합(mixture of experts))", en: "English" };
  const OWN_FORMAT = new Set(["meaning", "summary3", "translate", "original"]); // 프리셋 자체에 형식·길이가 있음
  const TRANSLATION = new Set(["translate", "original"]); // 번역·원문 찾기: 독자 수준·답변 언어와 무관

  const cleanField = v => String(v ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
  function normalizeStyle(raw) {
    const r = raw && typeof raw === "object" ? raw : {};
    const pick = (k, table) => (typeof r[k] === "string" && Object.prototype.hasOwnProperty.call(table, r[k]) ? r[k] : DEFAULT_STYLE[k]);
    return { len: pick("len", LEN), level: pick("level", LEVEL), field: cleanField(r.field), mode: pick("mode", MODE), lang: pick("lang", LANG) };
  }

  // 질문 끝에 붙는 <style> 줄. 뜻·3줄 요약·번역·원문은 자기 형식이 있어 길이·모드 생략, 번역·원문은 독자 수준도 생략
  function styleTag(style, presetId = null) {
    const st = normalizeStyle(style), own = OWN_FORMAT.has(presetId), tr = TRANSLATION.has(presetId), parts = [];
    if (!own) parts.push(`길이: ${LEN[st.len]}`);
    if (!tr) parts.push(`독자: ${LEVEL[st.level]}`);
    if (!own && MODE[st.mode]) parts.push(`모드: ${MODE[st.mode]}`);
    if (st.lang === "both" || (st.lang === "en" && presetId !== "meaning" && !tr)) parts.push(`언어: ${LANG[st.lang]}`);
    return parts.length ? `\n\n<style>${parts.join(" · ")}</style>` : "";
  }
  // 질문 훅: question에만 붙임 (기록에는 바뀐 질문이 저장 → 다음 턴의 앞부분이 바이트까지 같음). 이미 있으면 그대로
  function applyStyle(payload, style, presetId = null) {
    const q = String(payload.question || "");
    if (!q || q.includes("<style>")) return payload;
    return { ...payload, question: q + styleTag(style, presetId) };
  }

  // 관심 분야 → 새 세션의 context 끝에 <reader> (첫 user 턴에만 들어가고 세션 내내 고정)
  const readerTag = field => `<reader>관심 분야: ${cleanField(field)} (관련 있으면 이 분야의 예·비유로 설명)</reader>`;
  function withReader(session, style) {
    const field = normalizeStyle(style).field, ctx = String(session.context || "");
    if (!field || (session.history && session.history.length) || ctx.includes("<reader>")) return ctx;
    return (ctx ? `${ctx}\n` : "") + readerTag(field);
  }

  // 내 프리셋 템플릿: {selection} {section_title} {paper_title} {context} (한 번만 치환, 값 안의 {..}는 그대로)
  const VARS = [["selection", "선택한 글"], ["section_title", "섹션 제목"], ["paper_title", "논문 제목"], ["context", "주변 문단"]];
  const fillTemplate = (tpl, vars = {}) =>
    String(tpl || "").replace(/\{(selection|section_title|paper_title|context)\}/g, (_, k) => String(vars[k] ?? ""));
  const normalizeCustom = list => (Array.isArray(list) ? list : []).filter(c =>
    c && typeof c.id === "string" && c.id && typeof c.label === "string" && c.label.trim() && typeof c.q === "string" && c.q.trim());
  // 저장된 {id, label, q} → 프리셋. {selection}을 쓰는 것은 선택 없는 시트에서 숨김
  function customPreset(c, i = 0, getVars = () => ({})) {
    const usesSel = c.q.includes("{selection}");
    return {
      id: `custom:${c.id}`, label: c.label, order: 900 + i, custom: true,
      match: s => (s || !usesSel ? 5 : false),
      q: (sel, session) => fillTemplate(c.q, getVars(sel, session)),
    };
  }

  // 문장 경계: Intl.Segmenter(없으면 정규식) + 약어(Fig. Eq. e.g. et al. …) 뒤·수식 $…$ 안에서는 자르지 않음,
  // 각주 번호("cheap.1 Our")는 자름. 반환 [{start, end}] (앞뒤 공백 제외)
  const ABBR = /(?:^|[\s(])(?:e\.g|i\.e|cf|vs|resp|approx|al|Figs?|Eqs?|Secs?|Tab|Refs?|Thm|Def|Prop|Lem|Alg|App|Ch|No|Dr|Prof|Mr|Ms)\.["')\]]*\s*$/i;
  let segmenter;
  function sentenceSpans(text) {
    const t = String(text || "").replace(/\s/g, " "); // 소스 줄바꿈·nbsp는 문장 끝이 아님 (글자 수 그대로)
    const cuts = new Set();
    if (segmenter === undefined) segmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("en", { granularity: "sentence" }) : null;
    if (segmenter) for (const s of segmenter.segment(t)) cuts.add(s.index);
    else for (const m of t.matchAll(/[.!?。！？]["')\]]*\s+/g)) cuts.add(m.index + m[0].length);
    for (const m of t.matchAll(/[a-z)\]]\.\d{1,2}\s+(?=[A-Z])/g)) cuts.add(m.index + m[0].length);
    const math = [...t.matchAll(/\$[^$]*\$/g)].map(m => [m.index, m.index + m[0].length]);
    const keep = [...cuts].filter(c => c > 0 && c < t.length && !ABBR.test(t.slice(Math.max(0, c - 16), c))
      && !math.some(([a, b]) => c > a && c < b)).sort((a, b) => a - b);
    const bounds = [0, ...keep, t.length], out = [];
    for (let i = 0; i + 1 < bounds.length; i++) {
      let a = bounds[i], b = bounds[i + 1];
      while (a < b && t[a] === " ") a++;
      while (b > a && t[b - 1] === " ") b--;
      if (b > a) out.push({ start: a, end: b });
    }
    return out;
  }
  // off가 든 문장. 공백 틈이면 시작점은 다음 문장, 끝점(isEnd: off 바로 앞 글자 기준)은 앞 문장
  function spanAt(spans, off, isEnd = false) {
    if (!spans.length) return null;
    const o = isEnd ? off - 1 : off;
    for (let i = 0; i < spans.length; i++) {
      if (o < spans[i].start) return isEnd ? spans[i - 1] || spans[i] : spans[i];
      if (o < spans[i].end) return spans[i];
    }
    return spans[spans.length - 1];
  }
  // 한 텍스트 안에서 [start, end)를 문장 경계로 넓힘. 공백만 고른 경우 등은 null
  function snapSpan(text, start, end) {
    const spans = sentenceSpans(text);
    const a = spanAt(spans, start), b = end > start ? spanAt(spans, end, true) : a;
    return a && b && b.end > a.start ? { start: a.start, end: b.end } : null;
  }

  const api = {
    SMART_PRESETS, MEANING_Q, ORIGINAL_Q, DEFAULT_STYLE, VARS, rankPresets, mathHeavy, explainPreset, equationQ, normalizeStyle, styleTag, applyStyle,
    readerTag, withReader, fillTemplate, normalizeCustom, customPreset, sentenceSpans, spanAt, snapSpan,
  };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;
  if (document.body.dataset.page !== "paper") return;
  PaperApp.registerFeature("smart-presets", api);

  // ---------- DOM ----------
  const { h } = PaperUI, A = PaperAnchor, store = PaperStore;
  const K_STYLE = "smart-presets:style", K_CUSTOM = "smart-presets:custom", K_SENT = "smart-presets:sentence-mode";
  const DOUBLE_MS = 300;
  const loadStyle = () => normalizeStyle(store.get(K_STYLE, null));
  const saveStyle = patch => store.set(K_STYLE, { ...loadStyle(), ...patch });
  const loadCustom = () => normalizeCustom(store.get(K_CUSTOM, []));

  // 템플릿 값: 새로고침 복원된 세션은 selInfo에 context가 없으므로 session.context(기능 태그 제외)로
  const stripTags = t => String(t || "").replace(/<(reader|my-notes)>[\s\S]*?<\/\1>/g, "").trim();
  const templateVars = (sel, session) => ({
    selection: (sel && sel.text) || (session && session.selection) || "",
    section_title: (sel && sel.sectionTitle) || (session && session.section) || "",
    paper_title: A.textOf(document.querySelector("#paper .ltx_title_document")) || document.title,
    context: (sel && sel.context) || stripTags(session && session.context),
  });

  // ---------- 프리셋 등록 ----------
  for (const p of SMART_PRESETS) PaperApp.addPreset(p);
  PaperApp.addPreset({ id: "smart-presets:add", label: "+ 내 프리셋", order: 999, match: () => 0, run: () => openEditor() });
  function syncCustom() {
    for (const p of PaperApp.presets()) if (p.id.startsWith("custom:")) PaperApp.removePreset(p.id);
    loadCustom().forEach((c, i) => PaperApp.addPreset(customPreset(c, i, templateVars)));
  }
  syncCustom();

  // ---------- 질문 훅·세션 훅 ----------
  PaperApp.addAskHook((p, meta) => applyStyle(p, loadStyle(), meta.presetId));
  PaperApp.addSessionHook(s => { s.context = withReader(s, loadStyle()); });
  // '뜻' 답변은 사전 카드 모양 (.a 안은 건드리지 않고 턴에 class만)
  PaperApp.on("ask", d => {
    const t = document.querySelector("#answer > .turn:last-child");
    if (t) t.classList.toggle("sp-card", String((d.payload && d.payload.question) || "").startsWith(MEANING_Q));
  });
  PaperApp.on("answer-done", d => { if (d.restored && d.presetId === "meaning") d.turnEl.classList.add("sp-card"); });

  // ---------- 원탭 설명·번역 (선택 버튼 줄) ----------
  const sheetOpts = s => ({ quote: s.text, selection: s.text, context: s.context, section: s.sectionTitle, selInfo: s });
  const presetById = id => PaperApp.presets().find(p => p.id === id) || SMART_PRESETS.find(p => p.id === id);
  const presetQ = (p, s) => (typeof p.q === "function" ? p.q(s, null) : p.q || p.label);
  const withTimeout = (fn, ms) => new Promise(resolve => {
    setTimeout(() => resolve(null), ms);
    try { Promise.resolve(fn()).then(resolve, () => resolve(null)); } catch { resolve(null); }
  });

  // 용어집에 있으면 바로 보여 주고 '더 자세히'로 사전 카드 (glossary가 없거나 아직 안 불렀으면 null)
  function glossMarkdown(term) {
    let e = null;
    try { e = PaperApp.feature("glossary")?.lookup?.(term); } catch { e = null; }
    if (!e || typeof e !== "object" || typeof e.then === "function") return null;
    const pick = (...ks) => ks.map(k => e[k]).find(v => typeof v === "string" && v.trim());
    const def = pick("definition", "def", "meaning", "desc", "description", "explanation", "gloss");
    const ko = pick("ko", "korean", "ko_term");
    return def ? `**${e.term || term}**${ko && ko !== def ? ` (${ko})` : ""}\n\n${def}` : null;
  }

  function explain(s) {
    const top = explainPreset(s, PaperApp.presets());
    const q = presetQ(top, s);
    const gloss = top.id === "meaning" && glossMarkdown(s.text);
    if (gloss) {
      PaperApp.openSheet(sheetOpts(s));
      PaperApp.addLocalTurn({ shown: top.label, markdown: gloss, actions: [{ label: "더 자세히", onClick: () => PaperApp.ask(q, { presetId: "meaning", label: top.label }) }] });
      return;
    }
    PaperApp.openSheet({ ...sheetOpts(s), autoAsk: { q, label: top.label, id: top.id } });
  }

  const pairsNode = pairs => h("div", { class: "sp-pairs" }, pairs.map(p => h("div", { class: "sp-pair" },
    h("p", { class: "sp-ko", text: [].concat(p.ko ?? "").join(" ") }), h("p", { class: "sp-en", text: [].concat(p.en ?? "").join(" ") }))));
  // 번역문(.tr-ko) 선택이 번역하는 영어 단위(문단·제목)의 글 (section-translate.unitFor, §6.1). 없으면 null
  function sourceUnitText(s, tr) {
    const ko = elOf(s.range && s.range.startContainer)?.closest(".tr-ko");
    let unit = null;
    try { unit = ko && tr && typeof tr.unitFor === "function" ? tr.unitFor(ko) : null; } catch { unit = null; }
    const en = unit && unit.nodeType === 1 ? A.textOf(unit).replace(/\s+/g, " ").trim() : "";
    return en || null;
  }
  // 번역: section-translate가 이미 번역해 둔 문장 쌍이 선택을 덮으면 그것을 보여 줌 (Claude 호출 없음).
  // 수식만 고르면 번역할 글이 없으므로 '설명'(수식 풀이)으로, 번역문(.tr-ko)을 고르면 한국어를 다시 번역하지 않고 영어 원문
  // (캐시된 쌍 → 없으면 그 번역의 영어 단위(unitFor) → 둘 다 없으면 원문 찾기 질문)
  async function translate(s) {
    if (s.isMath) { explain(s); return; }
    const back = !!s.inTranslation, id = back ? "original" : "translate", label = back ? "원문" : "번역";
    const q = back ? ORIGINAL_Q : presetQ(presetById("translate"), s);
    const tr = PaperApp.feature("section-translate");
    let pairs = (s.anchored || back) && tr && typeof tr.lookup === "function" ? await withTimeout(() => tr.lookup(s), 500) : null;
    if (back && !(Array.isArray(pairs) && pairs.length)) {
      const en = sourceUnitText(s, tr);
      pairs = en ? [{ ko: s.text, en }] : null;
    }
    if (Array.isArray(pairs) && pairs.length) {
      PaperApp.openSheet(sheetOpts(s));
      PaperApp.addLocalTurn({ shown: label, node: pairsNode(pairs), actions: [{ label: "더 자세히", onClick: () => PaperApp.ask(q, { presetId: id, label }) }] });
    } else PaperApp.openSheet({ ...sheetOpts(s), autoAsk: { q, label, id } });
  }

  PaperApp.addSelectionAction({ id: "smart-presets:explain", label: "설명", order: 10, onClick: explain });
  PaperApp.addSelectionAction({ id: "smart-presets:translate", label: "번역", order: 20, onClick: s => { translate(s).catch(e => console.error("[smart-presets]", e)); } });
  PaperApp.addSelectionAction({ id: "smart-presets:snap", label: "문장 맞추기", order: 80, onClick: s => snap(s) });

  // ---------- 문장 단위 선택 (맞추기·문장 선택 모드) ----------
  // .ltx_abstract는 넣지 않음: 초록 글은 p.ltx_p 안에 있고, 넣으면 'Abstract' 제목 탭이 제목+첫 문장을 고름
  const SENT_BLOCK = "p, li, dd, figcaption, td, .ltx_para";
  const elOf = n => (n && n.nodeType === 1 ? n : n && n.parentElement);
  const blockOf = n => { const b = elOf(n)?.closest(SENT_BLOCK); return b && A.root()?.contains(b) ? b : null; };
  const textAt = o => A.index().text.slice(o.start, o.end);

  // 색인 오프셋 off가 든 블록(문단)의 문장 → {start, end}. isEnd면 off 바로 앞 글자 기준
  function sentenceAt(off, isEnd = false) {
    const probe = isEnd ? A.rangeAt(Math.max(0, off - 1), off) : A.rangeAt(off, off + 1);
    const block = probe && blockOf(isEnd ? probe.endContainer : probe.startContainer);
    const o = block && A.offsetsOfElement(block);
    const sp = o && spanAt(sentenceSpans(textAt(o)), off - o.start, isEnd);
    return sp ? { start: o.start + sp.start, end: o.start + sp.end } : null;
  }
  function trimmed(o) {
    const t = A.index().text;
    let { start, end } = o;
    while (start < end && /\s/.test(t[start])) start++;
    while (end > start && /\s/.test(t[end - 1])) end--;
    return { start, end };
  }
  // 색인 구간을 선택 → 선택이 실제로 가리키는 {start, end} (가장자리 수식은 $…$ 덩어리 전체), 실패면 null
  function selectOffsets(o) {
    const r = o && o.end > o.start ? A.rangeAt(o.start, o.end) : null;
    if (!r) return null;
    PaperApp.selectRange(r);
    const s = PaperApp.sel();
    return s && s.anchored ? { start: s.start, end: s.end } : { start: o.start, end: o.end };
  }

  // 색인 밖 선택(.tr-ko 번역 등): 그 블록의 텍스트 노드만으로 맞춤
  function snapDom(range) {
    const block = elOf(range.startContainer)?.closest(".tr-ko, p, li, div");
    if (!block || !block.contains(range.endContainer)) return false;
    const nodes = [], w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let text = "";
    for (let n; (n = w.nextNode());) if (!n.parentElement.closest("button")) { nodes.push([n, text.length]); text += n.data; }
    const flat = (node, off) => { const e = nodes.find(([n]) => n === node); return e ? e[1] + off : null; };
    const a = flat(range.startContainer, range.startOffset), b = flat(range.endContainer, range.endOffset);
    const sp = a != null && b != null ? snapSpan(text, a, b) : null;
    if (!sp) return false;
    const at = (off, isEnd) => {
      for (const [n, s] of nodes) if (isEnd ? off <= s + n.length : off < s + n.length) return [n, off - s];
      const [n] = nodes[nodes.length - 1];
      return [n, n.length];
    };
    const r = document.createRange();
    r.setStart(...at(sp.start, false));
    r.setEnd(...at(sp.end, true));
    PaperApp.selectRange(r);
    return true;
  }

  function snap(s) {
    let ok = false;
    if (s.anchored && s.start != null) {
      const a = sentenceAt(s.start), b = sentenceAt(Math.max(s.end, s.start + 1), true);
      ok = !!(a && b && b.end > a.start) && selectOffsets({ start: a.start, end: b.end });
    } else if (s.range) ok = snapDom(s.range);
    if (!ok) { PaperUI.toast("문장 경계를 찾지 못했습니다"); return; }
    // 처음 한 번(탭마다): 문장 선택 모드 안내
    if (!sentenceOn && !store.session.get("smart-presets:hint", false)) {
      store.session.set("smart-presets:hint", true);
      PaperUI.toast("탭 한 번으로 문장을 고를 수 있어요", { actionLabel: "문장 선택 모드 켜기", onAction: () => setSentenceMode(true) });
    }
  }

  // 문장 선택 모드: 탭 = 그 문장 선택, 300ms 안에 선택 안을 다시 탭 = 문단,
  // 고른 곳을 천천히 다시 탭 = 300ms 뒤 해제 (그 사이 두 번째 탭이 오면 문단 → 이미 고른 문장도 두 번 탭으로 문단)
  let sentenceOn = store.get(K_SENT, false) === true, lastTap = null, clearTimer = 0;
  const applySentence = () => document.body.classList.toggle("sp-sentence-on", sentenceOn);
  applySentence();
  function setSentenceMode(on) {
    sentenceOn = !!on;
    store.set(K_SENT, sentenceOn);
    applySentence();
    PaperUI.toast(sentenceOn ? "문장 선택 모드: 탭하면 문장, 두 번 탭하면 문단" : "문장 선택 모드를 껐습니다");
  }
  // 탭인지: 끌어서 고르기·Shift 클릭이 끝날 때도 click이 오므로 누른 자리에서 움직였거나 수정 키가 있으면 탭이 아님.
  // 선택 없이 시작한 누름이 끝났는데 선택이 생겼으면 브라우저가 고른 것(끌기·길게 누르기·더블클릭 단어) → 그대로 둠.
  // 이미 고른 문장 위의 빠른 두 번째 탭(더블클릭)은 누를 때 선택이 있었으므로 문단 넓히기로 감
  let press = null;
  const hasLiveSel = () => { const s = document.getSelection(); return !!(s && s.rangeCount && !s.isCollapsed && s.toString().trim()); };
  document.addEventListener("pointerdown", e => {
    press = { x: e.clientX, y: e.clientY, slop: e.pointerType === "mouse" ? 6 : 10, hadSel: hasLiveSel() };
  }, true);
  function plainTap(e) {
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return false;
    if (!press) return true;
    if (Math.abs(e.clientX - press.x) > press.slop || Math.abs(e.clientY - press.y) > press.slop) return false;
    return press.hadSel || !hasLiveSel();
  }
  PaperApp.addTapHandler({
    id: "smart-presets:sentence", priority: 20, allowWithSelection: true,
    test: e => {
      if (!sentenceOn || PaperApp.isSheetOpen() || !plainTap(e)) return false;
      if (e.target.closest("a[href], .pr-ui, .tr-ko, .ltx_title, table.ltx_equation, table.ltx_equationgroup")) return false;
      const off = A.offsetAtPoint(e.clientX, e.clientY);
      // 문장 블록 밖(제목 등)이면 처리하지 않음 → 탭이 다른 처리기로 감
      return off == null || !sentenceAt(off) ? false : { off, el: e.target };
    },
    handle: (e, hit) => {
      const now = Date.now(), prev = lastTap, quick = !!prev && (now - prev.t < DOUBLE_MS || e.detail >= 2);
      clearTimeout(clearTimer);
      // lastTap은 지금 선택이 이 모드로 고른 그대로일 때만 남아 있음 (아래 selection 이벤트)
      const inPrev = !!prev && hit.off >= prev.start && hit.off < prev.end;
      if (inPrev && quick && prev.kind === "sentence") {
        const para = hit.el.closest(".ltx_para") || blockOf(hit.el);
        const o = para && A.offsetsOfElement(para), got = o && selectOffsets(trimmed(o));
        if (got) { lastTap = { ...got, t: now, kind: "para" }; return; }
      }
      // 선택 안을 누르면 브라우저가 선택을 풀 수 있으므로 다시 고름 (빠른 세 번째 탭: 문단 그대로, 느린 탭: 잠시 뒤 해제)
      if (inPrev) {
        selectOffsets(prev);
        if (quick) return;
        const mine = lastTap = { ...prev, t: now };
        clearTimer = setTimeout(() => { if (lastTap === mine) { lastTap = null; document.getSelection()?.removeAllRanges(); } }, DOUBLE_MS);
        return;
      }
      const got = selectOffsets(sentenceAt(hit.off));
      if (got) lastTap = { ...got, t: now, kind: "sentence" };
    },
  });
  // 선택이 풀리거나 다른 곳으로 바뀌면(길게 눌러 고르기, 여백 탭) 문장 모드의 '지금 선택'도 잊음
  PaperApp.on("selection", d => { if (lastTap && (!d || d.start !== lastTap.start || d.end !== lastTap.end)) lastTap = null; });

  // ---------- 시트 위 스타일 줄 (길이 · 수준 · ⚙) ----------
  const LEN_OPTS = [["short", "짧게"], ["normal", "보통"], ["long", "자세히"]];
  const LEVEL_OPTS = [["ug", "학부생"], ["grad", "대학원생"], ["expert", "전문가"]];
  const MODE_OPTS = [["normal", "일반"], ["guide", "학습 가이드"]];
  const LANG_OPTS = [["ko", "한국어"], ["both", "한국어+영어 용어"], ["en", "English"]];
  function seg(name, opts, value, onPick) {
    const g = h("div", { class: "sp-seg", role: "group", "aria-label": name });
    for (const [v, label] of opts) {
      g.append(h("button", {
        type: "button", text: label, "aria-pressed": String(v === value), dataset: { v },
        onclick: () => {
          for (const b of g.children) b.setAttribute("aria-pressed", String(b.dataset.v === v));
          onPick(v);
        },
      }));
    }
    return g;
  }
  function styleRow() {
    const st = loadStyle();
    const extra = [st.mode === "guide" && "학습", st.lang === "en" && "EN", st.lang === "both" && "한+영", st.field && "분야"].filter(Boolean).join("·");
    return h("div", { class: "sp-style" },
      seg("답변 길이", LEN_OPTS, st.len, v => saveStyle({ len: v })),
      seg("독자 수준", LEVEL_OPTS, st.level, v => saveStyle({ level: v })),
      h("button", { type: "button", class: "sp-gear", "aria-label": "답변 설정", title: "답변 설정", onclick: openSettings },
        h("span", { "aria-hidden": "true", text: "⚙" }), extra ? h("span", { class: "sp-gear-x", text: extra }) : null));
  }
  PaperApp.addSheetTool({ id: "smart-presets:style", order: 10, render: () => styleRow() });

  // ---------- 설정 peek: 관심 분야 · 모드 · 언어 · 문장 선택 모드 · 내 프리셋 ----------
  const fieldRow = (name, input, hint) => h("label", { class: "sp-field" }, h("span", { text: name }), input, hint ? h("small", { text: hint }) : null);
  function openSettings() {
    const st = loadStyle();
    const field = h("input", { class: "sp-input", maxlength: "60", placeholder: "예: 컴퓨터 비전, 신약 개발" });
    field.value = st.field;
    field.addEventListener("input", () => saveStyle({ field: field.value }));
    const sent = h("input", { type: "checkbox" });
    sent.checked = sentenceOn;
    sent.addEventListener("change", () => setSentenceMode(sent.checked));
    const list = h("div", { class: "sp-custom-list" });
    // 편집 모드: 이름 탭 = 고치기, ✕ = 삭제 (실행 취소 토스트)
    const renderList = () => {
      const items = loadCustom().map(c => h("div", { class: "sp-custom" },
        h("button", { type: "button", class: "sp-custom-label", text: c.label, title: "고치기", onclick: () => openEditor(c, renderList) }),
        h("button", { type: "button", class: "sp-x", "aria-label": `${c.label} 삭제`, text: "✕", onclick: () => removeCustom(c.id, renderList) })));
      list.replaceChildren(...(items.length ? items : [h("small", { class: "sp-empty", text: "아직 없습니다" })]));
    };
    renderList();
    const body = h("div", { class: "sp-form" },
      fieldRow("내 연구 분야", field, "관련 있으면 이 분야의 예·비유로 설명합니다 (새 대화부터)"),
      h("div", { class: "sp-field" }, h("span", { text: "모드" }), seg("모드", MODE_OPTS, st.mode, v => saveStyle({ mode: v })),
        h("small", { text: "학습 가이드: 힌트를 주고 이해 확인 질문을 먼저 되묻습니다" })),
      h("div", { class: "sp-field" }, h("span", { text: "답변 언어" }), seg("답변 언어", LANG_OPTS, st.lang, v => saveStyle({ lang: v }))),
      h("label", { class: "sp-check" }, sent, h("span", { text: "문장 선택 모드 — 탭하면 문장, 두 번 탭하면 문단" })),
      h("div", { class: "sp-field" }, h("span", { text: "내 프리셋" }), list));
    PaperUI.peek({
      title: "답변 설정", body, className: "sp-peek",
      actions: [{ label: "+ 내 프리셋", onClick: () => openEditor(null, renderList) }],
      onClose: () => PaperApp.refreshSheetTools(), // ⚙ 옆 표시(학습·EN…) 갱신
    });
  }

  function removeCustom(id, after) {
    const list = loadCustom(), i = list.findIndex(c => c.id === id);
    if (i < 0) return;
    const [item] = list.splice(i, 1);
    store.set(K_CUSTOM, list);
    syncCustom();
    after && after();
    PaperUI.toast("삭제됨", {
      actionLabel: "실행 취소",
      onAction: () => {
        const cur = loadCustom();
        if (!cur.some(c => c.id === item.id)) cur.splice(Math.min(i, cur.length), 0, item);
        store.set(K_CUSTOM, cur);
        syncCustom();
        after && after();
      },
    });
  }

  // 내 프리셋 만들기·고치기 peek ('+ 내 프리셋' 칩, 설정 peek)
  function openEditor(item = null, after = null) {
    const label = h("input", { class: "sp-input", maxlength: "20", placeholder: "예: 반론 찾기" });
    const ta = h("textarea", { class: "sp-input", rows: "4", maxlength: "1000", placeholder: "예: {selection}에 대한 가능한 반론 2가지와 저자의 대응을 알려줘" });
    label.value = item ? item.label : "";
    ta.value = item ? item.q : "";
    const insert = tok => { ta.focus(); ta.setRangeText(tok, ta.selectionStart, ta.selectionEnd, "end"); };
    const vars = h("div", { class: "sp-vars" }, h("small", { text: "넣기" }),
      VARS.map(([k, name]) => h("button", { type: "button", text: name, title: `{${k}}`, onclick: () => insert(`{${k}}`) })));
    const save = andAsk => ({ close }) => {
      const c = {
        id: item ? item.id : Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        label: label.value.trim().slice(0, 20), q: ta.value.trim().slice(0, 1000), ts: Date.now(),
      };
      if (!c.label || !c.q) { PaperUI.toast("이름과 프롬프트를 입력하세요"); return; }
      const list = loadCustom(), i = list.findIndex(x => x.id === c.id);
      if (i >= 0) list[i] = c; else list.push(c);
      store.set(K_CUSTOM, list);
      syncCustom();
      close();
      after && after();
      const s = PaperApp.session, p = presetById(`custom:${c.id}`);
      if (andAsk && s && p) PaperApp.ask(p.q(s.selInfo, s), { label: c.label, presetId: p.id });
    };
    // '저장하고 묻기'는 시트의 '+ 내 프리셋' 칩에서 열었을 때만 (설정 peek 밑에서 답이 흐르지 않게)
    const canAsk = !!PaperApp.session && !after;
    const actions = [{ label: "저장", primary: !canAsk, onClick: save(false) }];
    if (canAsk) actions.push({ label: "저장하고 묻기", primary: true, onClick: save(true) });
    PaperUI.peek({
      title: item ? "내 프리셋 고치기" : "내 프리셋 만들기", className: "sp-peek", actions,
      body: h("div", { class: "sp-form" }, fieldRow("이름", label), fieldRow("프롬프트", ta), vars,
        h("small", { class: "sp-hint", text: "{selection} 선택한 글 · {section_title} 섹션 제목 · {paper_title} 논문 제목 · {context} 주변 문단" })),
    });
  }

  // 다른 탭에서 바꾼 설정 반영
  window.addEventListener("storage", e => {
    if (e.key === store.key(K_CUSTOM)) syncCustom();
    if (e.key === store.key(K_SENT)) { sentenceOn = store.get(K_SENT, false) === true; applySentence(); }
  });
})();
