"use strict";
const { test, assert, load } = require("./_runner");
const { BAR, barLayout, upsert } = load("static/ui.js");

test("헤더: 표의 primary 3개만 헤더에, 나머지는 메뉴 (등록 순서와 무관)", () => {
  const buttons = ["library", "overview", "in-paper-search", "reading-settings", "section-translate", "toc-progress", "x-unknown"]
    .map(id => ({ id, label: id }));
  const { primary, overflow } = barLayout(buttons);
  assert.deepEqual(primary.map(b => b.id), ["toc-progress", "section-translate", "in-paper-search"]);
  assert.deepEqual(overflow.map(b => b.id), ["overview", "reading-settings", "library", "x-unknown"]);
});

test("헤더: 표에 없는 id는 primary를 요청해도 메뉴로", () => {
  const { primary, overflow } = barLayout([{ id: "rogue", primary: true, order: 1 }]);
  assert.equal(primary.length, 0);
  assert.equal(overflow[0].id, "rogue");
});

test("헤더: primary는 최대 3개", () => {
  const table = { a: { order: 1, primary: true }, b: { order: 2, primary: true }, c: { order: 3, primary: true }, d: { order: 4, primary: true } };
  const { primary, overflow } = barLayout(["d", "c", "b", "a"].map(id => ({ id })), table);
  assert.deepEqual(primary.map(b => b.id), ["a", "b", "c"]);
  assert.deepEqual(overflow.map(b => b.id), ["d"]);
});

test("자리표: 정확히 3개의 primary", () => {
  assert.equal(Object.values(BAR).filter(v => v.primary).length, 3);
});

test("upsert: 같은 id는 교체, order 정렬", () => {
  const list = [];
  upsert(list, { id: "b", order: 20 });
  upsert(list, { id: "a", order: 10 });
  upsert(list, { id: "b", order: 5, v: 2 });
  assert.deepEqual(list.map(x => x.id), ["b", "a"]);
  assert.equal(list[0].v, 2);
});
