// section-translate 순수 함수: 자리표시 되돌리기·검사, 건너뛰기 규칙(서버와 같음), 묶음 계획, 모드 순환
"use strict";
const { test, assert, load } = require("./_runner");
const st = load("static/features/section-translate.js");

test("restorePlaceholders: 'a ⟦0⟧ b' + [node] → 노드가 제자리에", () => {
  const node = { tag: "math" };
  assert.deepEqual(st.restorePlaceholders("a ⟦0⟧ b", [node]), ["a ", node, " b"]);
  assert.deepEqual(st.restorePlaceholders("⟦1⟧와 ⟦0⟧.", ["x", "y"]), ["y", "와 ", "x", "."]);
  assert.deepEqual(st.restorePlaceholders("없는 ⟦5⟧ 번호", ["x"]), ["없는 ", " 번호"]);
  assert.deepEqual(st.restorePlaceholders("자리표시 없음", []), ["자리표시 없음"]);
  // 번호 자체(0)도 항목으로 쓸 수 있음 (DOM 쪽은 번호 → 복제 노드로 바꿈)
  assert.deepEqual(st.restorePlaceholders("⟦0⟧서론", [0]), [0, "서론"]);
});

test("checkPlaceholders: 모든 번호가 문장 전체에서 정확히 한 번", () => {
  assert.equal(st.checkPlaceholders(["⟦0⟧ 그리고", "⟦1⟧."], 2), true);
  assert.equal(st.checkPlaceholders(["⟦0⟧ ⟦0⟧", "⟦1⟧"], 2), false);
  assert.equal(st.checkPlaceholders(["⟦0⟧"], 2), false);
  assert.equal(st.checkPlaceholders(["⟦0⟧ ⟦1⟧ ⟦2⟧"], 2), false);
  assert.equal(st.checkPlaceholders(["자리표시 없음"], 0), true);
});

test("phText: 수식은 $tex$, 번호 뒤 공백, 블록은 빈칸", () => {
  const ph = [{ k: "tag", text: "1" }, { k: "math", tex: "x^{2}" }, { k: "cite", text: "[1, 2]" }, { k: "eq", id: "E1" }];
  assert.equal(st.phText("⟦0⟧서론", ph), "1 서론");
  assert.equal(st.phText("grows as ⟦1⟧ for ⟦2⟧.", ph), "grows as $x^{2}$ for [1, 2].");
  assert.equal(st.phText("see ⟦3⟧ done ⟦9⟧", ph), "see done");
});

test("shouldSkip: 서버 should_skip과 같은 규칙", () => {
  assert.equal(st.shouldSkip("이 문단은 한국어로 작성된 문단입니다.", "p"), true);
  assert.equal(st.shouldSkip("⟦0⟧ and ⟦1⟧", "p"), true);
  assert.equal(st.shouldSkip("⟦0⟧.", "title"), true);
  assert.equal(st.shouldSkip("⟦0⟧Introduction", "title"), false);
  assert.equal(st.shouldSkip("⟦0⟧Training loss", "cap"), false);
  assert.equal(st.shouldSkip("Training loss", "p"), true);
  assert.equal(st.shouldSkip("We minimize the loss.", "p"), false);
  assert.equal(st.shouldSkip("BERT 모델을 사용한 실험 결과를 보고합니다", "p"), true); // 한글 비율 > 0.3
});

test("fingerprint·hashText", () => {
  assert.equal(st.fingerprint("Large language models scale well, but dense computation grows"), "largelanguagemodelsscalewellbutd");
  assert.equal(st.fingerprint("1 Introduction"), "1introduction");
  assert.equal(st.hashText("abc"), st.hashText("abc"));
  assert.notEqual(st.hashText("abc"), st.hashText("abd"));
  assert.match(st.hashText(""), /^[0-9a-f]{8}$/);
});

test("planBatch: 가까운 것부터 6개·2500자, 첫 단위는 길어도", () => {
  const items = [{ id: "far", d: 900, len: 100 }, { id: "near", d: 10, len: 300 }, { id: "mid", d: 200, len: 2300 }, { id: "n2", d: 50, len: 100 }];
  assert.deepEqual(st.planBatch(items).map(x => x.id), ["near", "n2", "far"]); // mid는 2500자를 넘김
  assert.deepEqual(st.planBatch([{ id: "big", d: 5, len: 9000 }, { id: "x", d: 6, len: 10 }]).map(x => x.id), ["big"]);
  const many = Array.from({ length: 10 }, (_, i) => ({ id: i, d: i, len: 10 }));
  assert.deepEqual(st.planBatch(many).map(x => x.id), [0, 1, 2, 3, 4, 5]);
});

test("nextMode: 원문 → 둘다 → 번역 → 원문", () => {
  assert.equal(st.nextMode("orig"), "both");
  assert.equal(st.nextMode("both"), "ko");
  assert.equal(st.nextMode("ko"), "orig");
  assert.equal(st.nextMode("weird"), "orig");
});
