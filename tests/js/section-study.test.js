// section-study 순수 함수: 칩 줄 자리(.tr-ko 제목 뒤), 퀴즈 진행·점수
"use strict";
const { test, assert, load } = require("./_runner");
const S = load("static/features/section-study.js");

// classList·nextElementSibling만 있는 가짜 요소
const el = (...cls) => ({ classList: { contains: c => cls.includes(c) }, nextElementSibling: null });
const chain = (...els) => { els.forEach((e, i) => { e.nextElementSibling = els[i + 1] || null; }); return els[0]; };

test("headRef: 제목 바로 뒤, 번역 제목(.tr-ko)이 있으면 그 뒤 (제목 안은 아님)", () => {
  const title = el("ltx_title"), para = el("ltx_para");
  chain(title, para);
  assert.equal(S.headRef(title), title);
  const t2 = el("ltx_title"), ko = el("tr-ko", "pr-ui"), ko2 = el("tr-ko"), p2 = el("ltx_para");
  chain(t2, ko, ko2, p2);
  assert.equal(S.headRef(t2), ko2);
});

test("hasClass: 요약 대상은 section/subsection/appendix, 퀴즈는 최상위만", () => {
  assert.ok(S.hasClass(el("ltx_subsection"), S.GIST_CLASSES));
  assert.ok(!S.hasClass(el("ltx_subsection"), S.QUIZ_CLASSES));
  assert.ok(S.hasClass(el("ltx_appendix"), S.QUIZ_CLASSES));
  assert.ok(!S.hasClass(el("ltx_paragraph"), S.GIST_CLASSES));
  assert.ok(!S.hasClass(null, S.GIST_CLASSES));
});

test("explainQuestion", () => {
  assert.equal(S.explainQuestion("2 Method"), "2 Method 섹션을 쉽게 풀어줘");
  assert.equal(S.explainQuestion(""), "이 섹션을 쉽게 풀어줘");
});

test("퀴즈 진행: 한 문항에 한 번만 답, 다음, 점수", () => {
  const items = [{ a: 1 }, { a: 0 }, { a: 3 }];
  const st = S.newQuiz(items);
  assert.notEqual(st.items, items); // 복사본
  assert.deepEqual(S.pick(st, 1), { correct: true, a: 1 });
  assert.equal(S.pick(st, 2), null, "이미 답한 문항");
  assert.equal(S.advance(st), true);
  assert.deepEqual(S.pick(st, 2), { correct: false, a: 0 });
  assert.equal(S.advance(st), true);
  S.pick(st, 3);
  assert.equal(S.advance(st), false);
  assert.equal(S.pick(st, 0), null, "끝난 뒤");
  assert.equal(S.advance(st), false);
  assert.equal(st.i, 3);
  assert.equal(S.score(st), 2);
});

test("scoreMessage", () => {
  assert.equal(S.scoreMessage(3, 3), "3문제 모두 정답! 이 섹션을 잘 이해했어요");
  assert.equal(S.scoreMessage(2, 3), "3문제 중 2개 정답");
  assert.match(S.scoreMessage(0, 3), /0개 정답/);
  assert.equal(S.scoreMessage(0, 0), "");
});
