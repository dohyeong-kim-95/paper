"use strict";
const { test, assert, load } = require("./_runner");
const { BASE_PRESETS, rankPresets, selInfoFromText, buildPayload, splitSentences, ERROR_TAIL, SLOTS } = load("static/app.js");

const ids = list => list.map(p => p.id);

test("기본 프리셋 4개: 고정 id, 일반 선택은 기존 순서", () => {
  assert.deepEqual(ids(BASE_PRESETS), ["easy", "equation", "translate", "why"]);
  assert.deepEqual(ids(rankPresets(BASE_PRESETS, { isMath: false, wordCount: 12 })), ["easy", "equation", "translate", "why"]);
});

test("수식 선택이면 '수식 풀이'가 먼저", () => {
  assert.equal(rankPresets(BASE_PRESETS, { isMath: true, latex: ["x^2"] })[0].id, "equation");
});

test("선택 없는 세션(논문 전체 질문)에서는 선택용 프리셋 숨김, match 없는 프리셋은 표시", () => {
  const extra = { id: "free", label: "자유", q: "q", order: 1 };
  assert.deepEqual(ids(rankPresets([...BASE_PRESETS, extra], null)), ["free"]);
});

test("match가 false면 숨김, 점수 높은 것이 먼저", () => {
  const list = [
    { id: "a", order: 1, match: () => false },
    { id: "b", order: 2, match: () => 5 },
    { id: "c", order: 3, match: () => 50 },
  ];
  assert.deepEqual(ids(rankPresets(list, {})), ["c", "b"]);
});

test("selInfoFromText: 단어 수, 수식 판정, latex 추출", () => {
  const m = selInfoFromText("$$g(x)=\\mathrm{softmax}(W_g x)$$");
  assert.equal(m.isMath, true);
  assert.deepEqual(m.latex, ["g(x)=\\mathrm{softmax}(W_g x)"]);
  const t = selInfoFromText("routes each token to two experts");
  assert.equal(t.wordCount, 6);
  assert.equal(t.isMath, false);
});

const session = () => ({
  arxivId: "2401.00001", selection: "SEL", context: "CTX", section: "2 Method", endpoint: "/api/ask",
  extra: { figure_id: "S2.F1" }, history: [{ role: "user", content: "Q1" }, { role: "assistant", content: "A1" }],
});

test("buildPayload: 훅은 question만 바꿀 수 있음 (선택·문맥·기록·extra 고정)", () => {
  const s = session();
  const p = buildPayload(s, "Q2", [
    (x, meta) => ({ ...x, question: x.question + " +style", selection: "HACK", context: "HACK", history: [], figure_id: "X" }),
    (x, meta) => { assert.equal(meta.endpoint, "/api/ask"); assert.equal(meta.turn, 1); assert.equal(meta.presetId, "easy"); x.question += " +ev"; },
  ], { presetId: "easy" });
  assert.equal(p.question, "Q2 +style +ev");
  assert.equal(p.selection, "SEL");
  assert.equal(p.context, "CTX");
  assert.equal(p.section, "2 Method");
  assert.equal(p.figure_id, "S2.F1");
  assert.equal(p.arxiv_id, "2401.00001");
  assert.deepEqual(p.history, s.history);
  assert.notEqual(p.history, s.history, "기록은 복사본");
});

test("buildPayload: 훅 오류는 무시하고 계속", () => {
  const orig = console.error;
  console.error = () => {};
  try {
    const p = buildPayload(session(), "Q", [() => { throw new Error("boom"); }, x => ({ ...x, question: "ok" })]);
    assert.equal(p.question, "ok");
  } finally { console.error = orig; }
});

test("splitSentences", () => {
  assert.equal(splitSentences("가. 나? 다!").length, 3);
  assert.deepEqual(splitSentences("First one. Second\nThird"), ["First one.", "Second", "Third"]);
});

test("서버 스트림 오류 꼬리 감지", () => {
  assert.ok(ERROR_TAIL.test("답변 일부\n\n[오류] Connection error."));
  assert.ok(!ERROR_TAIL.test("정상 답변 [오류] 라는 단어"));
});

test("답변 슬롯 순서표", () => {
  const order = Object.entries(SLOTS).sort((a, b) => a[1] - b[1]).map(x => x[0]);
  assert.deepEqual(order, ["evidence-chips", "answer-actions", "highlights-notes", "vocab", "ask-paper"]);
});
