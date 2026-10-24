"use strict";
const { test, assert, load } = require("./_runner");
const sp = load("static/features/smart-presets.js");
const { BASE_PRESETS, buildPayload, makeSession } = load("static/app.js");
const {
  rankPresets, SMART_PRESETS, MEANING_Q, equationQ, styleTag, applyStyle, withReader, normalizeStyle,
  fillTemplate, customPreset, normalizeCustom, sentenceSpans, spanAt, snapSpan, mathHeavy, explainPreset,
} = sp;

const ids = list => list.map(p => p.id);
const labels = list => list.map(p => p.label);
const ALL = [...BASE_PRESETS, ...SMART_PRESETS]; // 브라우저에서와 같은 등록 순서 (같은 id는 나중 것)

// ---------- 프리셋 순위 ----------
test("짧은 단어: '뜻 (이 논문에서)'가 먼저, '번역'이 둘째", () => {
  assert.deepEqual(labels(rankPresets({ wordCount: 2, isMath: false })).slice(0, 2), ["뜻 (이 논문에서)", "번역"]);
  assert.deepEqual(ids(rankPresets({ wordCount: 2, isMath: false, latex: [] }, ALL)).slice(0, 2), ["meaning", "translate"]);
});

test("수식: '수식 풀이'가 먼저, 그다음 '직관적으로' (산문 속 수식 latex만 있어도)", () => {
  assert.deepEqual(labels(rankPresets({ isMath: true, latex: ["x^2"] })).slice(0, 2), ["수식 풀이", "직관적으로"]);
  assert.deepEqual(ids(rankPresets({ wordCount: 1, isMath: true, latex: ["x^2"] }, ALL)).slice(0, 2), ["equation", "intuition"]);
  assert.deepEqual(ids(rankPresets({ wordCount: 20, isMath: false, latex: ["x"] }, ALL)).slice(0, 2), ["equation", "intuition"]);
  assert.ok(!ids(rankPresets({ wordCount: 1, isMath: true, latex: ["x"] }, ALL)).includes("translate"), "수식만이면 번역 숨김");
  assert.ok(!ids(rankPresets({ wordCount: 1, isMath: true, latex: ["x"] }, ALL)).includes("meaning"));
});

test("긴 선택(60단어 초과)에는 '3줄 요약'", () => {
  assert.ok(labels(rankPresets({ wordCount: 80 })).includes("3줄 요약"));
  assert.ok(!ids(rankPresets({ wordCount: 30, isMath: false, latex: [] }, ALL)).includes("summary3"));
});

test("그 밖의 선택: '쉽게 설명'이 먼저, 수식이 없으면 '수식 풀이' 숨김", () => {
  const r = ids(rankPresets({ wordCount: 12, isMath: false, latex: [] }, ALL));
  assert.equal(r[0], "easy");
  assert.ok(!r.includes("equation"));
  assert.deepEqual(ids(rankPresets(null, ALL)), [], "선택 없는 시트에는 선택용 프리셋 없음");
});

test("wordCount가 없으면 text로 셈", () => {
  assert.equal(rankPresets({ text: "mixture of experts", isMath: false, latex: [] }, ALL)[0].id, "meaning");
});

test("'수식 풀이' 질문에 선택한 LaTeX가 들어감", () => {
  const q = equationQ({ latex: ["x^{2}", "\\alpha"] });
  assert.ok(q.includes("$x^{2}$, $\\alpha$"), q);
  assert.ok(!equationQ({ latex: [] }).includes("수식:"));
  const eq = SMART_PRESETS.find(p => p.id === "equation");
  assert.equal(eq.q, equationQ);
});

// ---------- 원탭 '설명' ----------
const P1 = "Large language models scale well, but dense computation grows as $x^{2}$ for width $x$. We propose a sparse mixture of " +
  "experts model that routes each token to two experts [1, 2]. The router is trained jointly with the experts and the KD loss is cheap.";
const words = t => t.split(/\s+/).filter(Boolean).length;

test("mathHeavy: 수식만·수식 위주만 참, 기호 몇 개가 섞인 산문 문단은 거짓", () => {
  assert.equal(mathHeavy({ isMath: true, latex: ["x^2"], text: "$x^2$" }), true);
  assert.equal(mathHeavy({ isMath: false, latex: ["x^{2}", "x"], text: "grows as $x^{2}$ for width $x$" }), true, "산문 4단어 이하");
  assert.equal(mathHeavy({ isMath: false, latex: ["\\sum_{i=1}^{N} g_i(x) E_i(x)"], text: "we have $\\sum_{i=1}^{N} g_i(x) E_i(x)$ where the gate is small" }), true, "LaTeX가 산문보다 김");
  assert.equal(mathHeavy({ isMath: false, latex: ["x^{2}", "x"], text: P1, wordCount: words(P1) }), false);
  assert.equal(mathHeavy({ isMath: false, latex: [], text: "plain words here" }), false);
  assert.equal(mathHeavy(null), false);
});

test("explainPreset: 수식이 섞인 문단은 '쉽게 설명', 수식 위주는 '수식 풀이', 긴 선택은 3줄 요약 대신 '쉽게 설명', 한 단어는 '뜻'", () => {
  const RUN = { id: "section-study:quiz", label: "퀴즈", match: s => (s && s.sectionId ? 1 : false), run: () => {} };
  const all = [...ALL, RUN];
  assert.equal(explainPreset({ isMath: false, latex: ["x^{2}", "x"], text: P1, wordCount: words(P1), sectionId: "S1" }, all).id, "easy");
  assert.equal(explainPreset({ isMath: true, latex: ["x^{2}"], text: "$x^{2}$", wordCount: 1 }, all).id, "equation");
  const tex = "\\sum_{i=1}^{N} g_i(x) E_i(x)";
  assert.equal(explainPreset({ isMath: false, latex: [tex], text: `we have $${tex}$ where the gate is small`, wordCount: 8 }, all).id, "equation", "수식 위주 (산문 6단어)");
  const long = Array(80).fill("word").join(" ");
  assert.equal(explainPreset({ isMath: false, latex: [], text: long, wordCount: 80 }, all).id, "easy");
  assert.equal(explainPreset({ isMath: false, latex: [], text: "gating network", wordCount: 2 }, all).id, "meaning");
  assert.equal(explainPreset({ isMath: false, latex: [], text: "상위 두", wordCount: 2, inTranslation: true }, all).id, "easy", "번역문에는 한국어 뜻 카드 안 씀");
  assert.equal(explainPreset({ isMath: false, latex: [], text: "gating", wordCount: 1 }, [RUN]).id, "easy", "남는 것이 없으면 기본 '쉽게 설명'");
});

// ---------- 답변 스타일 ----------
test("applyStyle: 질문 끝에 <style> (예시 그대로), 다른 필드는 그대로", () => {
  const p = { question: "Q", selection: "S", context: "C", history: [] };
  const out = applyStyle(p, { len: "short", level: "grad" });
  assert.equal(out.question, "Q\n\n<style>길이: 짧게(5문장 이내) · 독자: 대학원생</style>");
  assert.equal(out.context, "C");
  assert.equal(p.question, "Q", "원본은 그대로");
  assert.equal(applyStyle(out, { len: "long" }).question, out.question, "이미 붙어 있으면 두 번 붙이지 않음");
  assert.equal(applyStyle({ question: "" }, {}).question, "");
});

test("styleTag: 모드·언어, 자기 형식 있는 프리셋(뜻·3줄 요약·번역)은 길이·모드 생략", () => {
  const st = { len: "long", level: "ug", mode: "guide", lang: "en" };
  const full = styleTag(st);
  assert.ok(full.includes("길이: 자세히") && full.includes("독자: 학부생") && full.includes("모드: 학습 가이드") && full.includes("언어: English"), full);
  const meaning = styleTag(st, "meaning");
  assert.ok(!meaning.includes("길이") && !meaning.includes("모드") && !meaning.includes("English") && meaning.includes("독자: 학부생"), meaning);
  assert.ok(styleTag(st, "summary3").includes("언어: English"));
  assert.equal(styleTag(st, "translate"), "", "번역: 영어 답변·독자 수준 의미 없음");
  assert.ok(styleTag({ lang: "both" }, "translate").includes("영어 병기"));
});

test("normalizeStyle: 잘못된 값은 기본값, 분야는 태그 문자 제거·60자", () => {
  assert.deepEqual(normalizeStyle(null), { len: "normal", level: "grad", field: "", mode: "normal", lang: "ko" });
  const st = normalizeStyle({ len: "huge", level: "toString", mode: "guide", lang: "en", field: " <b>NLP</b>\n " + "x".repeat(100) });
  assert.equal(st.len, "normal");
  assert.equal(st.level, "grad");
  assert.equal(st.mode, "guide");
  assert.ok(!/[<>]/.test(st.field) && st.field.length <= 60 && st.field.startsWith("bNLP/b x"), st.field);
});

test("withReader: 관심 분야는 기록이 없는 새 세션의 context에만, 한 번만", () => {
  const style = { field: "컴퓨터 비전" };
  const fresh = withReader({ context: "CTX", history: [] }, style);
  assert.equal(fresh, "CTX\n<reader>관심 분야: 컴퓨터 비전 (관련 있으면 이 분야의 예·비유로 설명)</reader>");
  assert.equal(withReader({ context: "", history: [] }, style), "<reader>관심 분야: 컴퓨터 비전 (관련 있으면 이 분야의 예·비유로 설명)</reader>");
  assert.equal(withReader({ context: "CTX", history: [{ role: "user", content: "Q" }] }, style), "CTX", "이어가는 대화에는 안 붙임");
  assert.equal(withReader({ context: fresh, history: [] }, style), fresh, "이미 있으면 그대로");
  assert.equal(withReader({ context: "CTX", history: [] }, { field: "  " }), "CTX", "분야가 비면 그대로");
});

test("후속 질문: 기록에는 바뀐 질문이 저장돼 앞 턴이 바이트까지 같음 (중간에 스타일을 바꿔도)", () => {
  let style = { len: "short", level: "grad", field: "로보틱스" };
  const ask = (p, meta) => applyStyle(p, style, meta.presetId);
  const sessHook = s => { s.context = withReader(s, style); };
  const s = makeSession({ quote: "routes", selection: "routes", context: "We propose…" }, "2401.00001", [sessHook]);
  assert.ok(s.context.endsWith("</reader>"));
  const p1 = buildPayload(s, MEANING_Q, [ask], { presetId: "meaning" });
  assert.ok(p1.question.startsWith(MEANING_Q) && p1.question.endsWith("</style>"));
  assert.ok(!p1.question.includes("길이"), "뜻 카드는 자기 형식");
  s.history.push({ role: "user", content: p1.question }, { role: "assistant", content: "A1" });
  style = { len: "long", level: "expert", field: "다른 분야" };
  const p2 = buildPayload(s, "더 쉽게", [ask], {});
  assert.equal(p2.history[0].content, p1.question);
  assert.equal(p2.context, p1.context, "세션 context 고정");
  assert.ok(p2.question.includes("길이: 자세히"));
  // 저장된 대화를 그대로 이어가면 세션 훅이 다시 돌지 않아 <reader>가 두 번 붙지 않음
  const again = makeSession({ ...s, history: s.history }, "2401.00001", [sessHook]);
  assert.equal(again.context, s.context);
});

// ---------- 내 프리셋 ----------
test("fillTemplate: {selection}·{section_title}·{paper_title}·{context} 치환, 모르는 것·값 안의 {}는 그대로", () => {
  const out = fillTemplate("[{selection}] in {section_title} of {paper_title}: {context} {unknown}",
    { selection: "top-two {context}", section_title: "2 Method", paper_title: "Sparse", context: "CTX" });
  assert.equal(out, "[top-two {context}] in 2 Method of Sparse: CTX {unknown}");
  assert.equal(fillTemplate("{selection}{selection}", { selection: "a" }), "aa");
  assert.equal(fillTemplate("{selection}", {}), "");
});

test("customPreset: id·점수 5, {selection}을 쓰면 선택 없는 시트에서 숨김, q는 템플릿 치환", () => {
  const p = customPreset({ id: "k1", label: "반론", q: "{selection}의 반론은?" }, 0, sel => ({ selection: sel.text }));
  assert.equal(p.id, "custom:k1");
  assert.equal(p.match({ text: "x" }), 5);
  assert.equal(p.match(null), false);
  assert.equal(p.q({ text: "top-two routing" }, null), "top-two routing의 반론은?");
  const free = customPreset({ id: "k2", label: "기여", q: "{paper_title}의 기여 3가지" }, 1);
  assert.equal(free.match(null), 5);
  assert.deepEqual(ids(rankPresets({ wordCount: 12, isMath: false, latex: [] }, [...ALL, p])).slice(-1), ["custom:k1"]);
});

test("normalizeCustom: 깨진 항목은 버림", () => {
  const list = normalizeCustom([{ id: "a", label: "A", q: "q" }, { id: "b", label: " ", q: "q" }, null, { id: 3, label: "C", q: "q" }, { id: "d", label: "D" }]);
  assert.deepEqual(list.map(c => c.id), ["a"]);
  assert.deepEqual(normalizeCustom("x"), []);
});

// ---------- 문장 경계 ----------
const SAMPLE = "Large models scale well, but dense computation grows as  $x^{2}$  for width  $x$ . We propose a sparse model [1, 2]. " +
  "The KD loss is cheap.1 Our code is at https://github.com/example/sparse-moe. See Fig. 3 and Eq. (2), e.g. the router. " +
  "As Smith et al. (2020) show, cf. Section 2 it works.\nThis line is new. 이 문단은 한국어입니다. 번역은 건너뜁니다. Math $a. B$ stays.";
const sentences = t => sentenceSpans(t).map(s => t.slice(s.start, s.end));

test("sentenceSpans: 약어·인용·수식 안 마침표에서 안 자르고, 각주 번호·줄바꿈·한국어는 처리", () => {
  assert.deepEqual(sentences(SAMPLE), [
    "Large models scale well, but dense computation grows as  $x^{2}$  for width  $x$ .",
    "We propose a sparse model [1, 2].",
    "The KD loss is cheap.1",
    "Our code is at https://github.com/example/sparse-moe.",
    "See Fig. 3 and Eq. (2), e.g. the router.",
    "As Smith et al. (2020) show, cf. Section 2 it works.",
    "This line is new.",
    "이 문단은 한국어입니다.",
    "번역은 건너뜁니다.",
    "Math $a. B$ stays.",
  ]);
  assert.deepEqual(sentenceSpans("   "), []);
});

test("spanAt·snapSpan: 문장 중간 선택을 문장 경계로, 공백 틈은 다음/앞 문장", () => {
  const t = "First one here. Second sentence is longer. Third.";
  const spans = sentenceSpans(t);
  assert.equal(t.slice(spanAt(spans, 3).start, spanAt(spans, 3).end), "First one here.");
  assert.equal(spanAt(spans, 15).start, t.indexOf("Second"), "틈의 시작점 → 다음 문장");
  assert.equal(spanAt(spans, 16, true).end, t.indexOf(" Second"), "틈의 끝점 → 앞 문장");
  const a = t.indexOf("one"), b = t.indexOf("is longer") + 2;
  const sn = snapSpan(t, a, b);
  assert.equal(t.slice(sn.start, sn.end), "First one here. Second sentence is longer.");
  const one = snapSpan(t, t.indexOf("sentence"), t.indexOf("sentence") + 4);
  assert.equal(t.slice(one.start, one.end), "Second sentence is longer.");
  assert.equal(snapSpan("One.  Two.", 4, 6), null, "공백만 고르면 null");
});
