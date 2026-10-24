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

test("levelOf: 서버 build_index와 같은 순서로 첫 ltx_<level>", () => {
  assert.equal(S.levelOf(el("ltx_section")), "section");
  assert.equal(S.levelOf(el("ltx_subsection")), "subsection");
  assert.equal(S.levelOf(el("ltx_appendix")), "appendix");
  assert.equal(S.levelOf(el("ltx_paragraph")), "paragraph");
  assert.equal(S.levelOf(el("ltx_bibliography")), null);
  assert.equal(S.levelOf(null), null);
  assert.ok(S.TOP_LEVELS.every(lv => S.GIST_LEVELS.includes(lv)));
});

test("pickGistIds: 최상위를 먼저 모두, 남는 자리는 하위 섹션 (서버 gist_sections와 같은 규칙, 최대 30)", () => {
  const fixture = [{ id: "S1", level: "section" }, { id: "S2", level: "section" }, { id: "S2.SS1", level: "subsection" },
    { id: "S2.SS1.SSS1", level: "subsubsection" }, { id: "A1", level: "appendix" }, { id: "bib", level: null }];
  assert.deepEqual([...S.pickGistIds(fixture)], ["S1", "S2", "A1", "S2.SS1"]);
  // 8개 섹션 × 하위 4개 + 부록 6개 × 하위 3개 = 64개 → 최상위 14개 + 앞쪽 하위 16개
  const big = [];
  for (let i = 1; i <= 8; i++) {
    big.push({ id: `S${i}`, level: "section" });
    for (let j = 1; j <= 4; j++) big.push({ id: `S${i}.SS${j}`, level: "subsection" });
  }
  for (let i = 1; i <= 6; i++) {
    big.push({ id: `A${i}`, level: "appendix" });
    for (let j = 1; j <= 3; j++) big.push({ id: `A${i}.SS${j}`, level: "subsection" });
  }
  const got = S.pickGistIds(big);
  assert.equal(got.size, 30);
  assert.equal(S.MAX_GISTS, 30);
  for (const x of big) if (x.level !== "subsection") assert.ok(got.has(x.id), x.id);
  assert.ok(got.has("S4.SS4") && !got.has("S5.SS1"));
  // 최상위만으로 넘치면 최상위 앞쪽 max개
  const tops = Array.from({ length: 35 }, (_, i) => ({ id: `S${i + 1}`, level: "section" }));
  assert.deepEqual([...S.pickGistIds(tops)], tops.slice(0, 30).map(x => x.id));
  assert.equal(S.pickGistIds(null).size, 0);
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
