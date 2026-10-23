"use strict";
const { test, assert, load } = require("./_runner");
const { STARTERS, ENDPOINT, followupBody, cleanFollowups } = load("static/features/ask-paper.js");

test("시작 질문 6개: 고유 id, 짧은 칩 글자, 실제 질문", () => {
  assert.deepEqual(STARTERS.map(s => s.label),
    ["핵심 기여는?", "한계점은?", "실험 설정 요약", "기존 연구와 차이", "내 연구에 어떻게 쓸까?", "저자 입장에서 약점 방어"]);
  assert.equal(new Set(STARTERS.map(s => s.id)).size, STARTERS.length);
  for (const s of STARTERS) {
    assert.ok(s.id.startsWith("ask-paper:"));
    assert.ok(typeof s.q === "string" && s.q.length >= 8, s.id);
  }
  assert.equal(ENDPOINT, "/api/ask-paper/followups");
});

test("followupBody: 고정 필드 + 방금 끝난 턴까지의 history, question 비움, extra는 안 보냄", () => {
  const payload = {
    arxiv_id: "2401.00001", selection: "SEL", context: "CTX", section: "2 Method", question: "Q2 <style>짧게</style>",
    history: [{ role: "user", content: "Q1", junk: 1 }, { role: "assistant", content: "A1" }],
    figure_id: "S2.F1", image_urls: ["x"],
  };
  const body = followupBody(payload, "A2\n근거: \"x\"");
  assert.deepEqual(body, {
    arxiv_id: "2401.00001", selection: "SEL", context: "CTX", section: "2 Method", question: "",
    history: [
      { role: "user", content: "Q1" }, { role: "assistant", content: "A1" },
      { role: "user", content: "Q2 <style>짧게</style>" }, { role: "assistant", content: "A2\n근거: \"x\"" },
    ],
  });
  assert.equal(payload.history.length, 2, "payload를 바꾸지 않음");
});

test("followupBody: 선택 없는 첫 턴", () => {
  const body = followupBody({ arxiv_id: "id", question: "핵심 기여를 정리해줘", history: [] }, "답");
  assert.deepEqual(body.history, [{ role: "user", content: "핵심 기여를 정리해줘" }, { role: "assistant", content: "답" }]);
  assert.equal(body.selection, "");
});

test("cleanFollowups: 문자열만, 공백 정리, 중복·이미 물은 질문·긴 것 제외, 최대 3개", () => {
  assert.deepEqual(cleanFollowups(["a", "b", "c", "d"]), ["a", "b", "c"]);
  assert.deepEqual(cleanFollowups(null), []);
  assert.deepEqual(cleanFollowups({ q: ["a"] }), []);
  assert.deepEqual(cleanFollowups([" 왜  top-2? ", "왜 top-2?", 3, "", "가".repeat(41), "Q1", "비용은?"], ["Q1"]),
    ["왜 top-2?", "비용은?"]);
});
