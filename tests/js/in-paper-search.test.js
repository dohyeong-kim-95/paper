"use strict";
const { test, assert, load } = require("./_runner");
const { findAll, nearestIndex, hasHangul, wantsAI, cleanResults, pushRecent, countLabel, MAX_HITS } = load("static/features/in-paper-search.js");

const slices = (text, hits) => hits.map(h => text.slice(h.start, h.end));

test("findAll: 대소문자 무시, 원문 오프셋 2개", () => {
  const text = "Attention is all attention";
  const hits = findAll(text, "attention");
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map(h => h.start), [0, 17]);
  assert.deepEqual(slices(text, hits), ["Attention", "attention"]);
  assert.equal(findAll(text, "ATTENTION").length, 2);
});

test("findAll: 둥근 따옴표·대시·여러 공백·줄바꿈 차이를 무시", () => {
  const text = "Dense models are  “slow” –\n really slow.";
  const hits = findAll(text, 'models are "slow" - really');
  assert.deepEqual(slices(text, hits), ["models are  “slow” –\n really"]);
});

test("findAll: 겹치지 않게, 빈 검색어는 없음, 상한", () => {
  assert.equal(findAll("aaaa", "aa").length, 2);
  assert.deepEqual(findAll("abc", "   "), []);
  assert.deepEqual(findAll("", "x"), []);
  assert.equal(findAll("x ".repeat(50), "x", { limit: 7 }).length, 7);
  assert.ok(MAX_HITS >= 100);
});

test("findAll: 수식은 색인처럼 $alttext$ 로 찾음 (기호 검색)", () => {
  const text = "a learning rate of  $3\\times 10^{-4}$ . The coefficient  $\\alpha$  is small";
  assert.deepEqual(slices(text, findAll(text, "$3\\times 10^{-4}$")), ["$3\\times 10^{-4}$"]);
  assert.deepEqual(slices(text, findAll(text, "\\alpha")), ["\\alpha"]);
});

test("findAll: 미리 계산한 normMap(nm)을 그대로 씀", () => {
  const A = load("static/anchor.js");
  const text = "One two. one TWO.";
  assert.deepEqual(findAll(text, "one two", { nm: A.normMap(text) }).map(h => h.start), [0, 9]);
});

test("nearestIndex: offset 이후 첫 결과, 없으면 처음으로", () => {
  const hits = [{ start: 5 }, { start: 20 }, { start: 40 }];
  assert.equal(nearestIndex(hits, 0), 0);
  assert.equal(nearestIndex(hits, 20), 1);
  assert.equal(nearestIndex(hits, 21), 2);
  assert.equal(nearestIndex(hits, 99), 0);
  assert.equal(nearestIndex([], 3), 0);
});

test("hasHangul / wantsAI: 한글 질문이나 일치 없는 3글자 이상이면 AI", () => {
  assert.equal(hasHangul("학습률 얘기 어디 나와?"), true);
  assert.equal(hasHangul("ㅎㅎ"), true);
  assert.equal(hasHangul("learning rate"), false);
  assert.equal(wantsAI("학습률", 3), true);
  assert.equal(wantsAI("where is the limitation", 0), true);
  assert.equal(wantsAI("rate", 2), false);
  assert.equal(wantsAI("ab", 0), false);
});

test("cleanResults: 형식이 틀린 항목을 버리고 5개까지", () => {
  assert.deepEqual(cleanResults(null), []);
  assert.deepEqual(cleanResults({ q: "x" }), []);
  const raw = [null, { why: "q 없음" }, { q: "  ", why: "빈" }, { q: " We minimize ", why: 3 },
    ...Array.from({ length: 6 }, (_, i) => ({ q: `quote ${i}`, why: ` 이유 ${i} ` }))];
  const out = cleanResults(raw);
  assert.equal(out.length, 5);
  assert.deepEqual(out[0], { q: "We minimize", why: "" });
  assert.deepEqual(out[1], { q: "quote 0", why: "이유 0" });
});

test("pushRecent: 맨 앞, 대소문자 무시 중복 제거, 최대 개수", () => {
  assert.deepEqual(pushRecent(["b", "A", "c"], " a "), ["a", "b", "c"]);
  assert.deepEqual(pushRecent(null, "x"), ["x"]);
  assert.deepEqual(pushRecent(["x", 3, "y"], ""), ["x", "y"]);
  assert.deepEqual(pushRecent(["1", "2", "3"], "0", 3), ["0", "1", "2"]);
});

test("countLabel", () => {
  assert.equal(countLabel(2, 12), "3/12");
  assert.equal(countLabel(-1, 0), "0/0");
  assert.equal(countLabel(0, 1000, true), "1/1000+");
});
