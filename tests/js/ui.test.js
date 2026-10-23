"use strict";
const { test, assert, load } = require("./_runner");
const { BAR, TOP, BOTTOM, barLayout, upsert } = load("static/ui.js");
const { SLOTS } = load("static/app.js");
const fs = require("node:fs");
const path = require("node:path");
const DOC = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "FEATURES.md"), "utf8");
// 문서의 한 절(### 번호 제목 ~ 다음 ###/---)에서 표의 행: | `id` | ... |
const section = no => DOC.split(/\n(?=### |---\n)/).find(x => x.startsWith(`### ${no} `)) || "";
const rows = text => [...text.matchAll(/^\| `([^`]+)` \|([^\n]*)$/gm)].map(m => [m[1], m[2].split("|").map(c => c.trim())]);

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

test("문서 표와 코드가 같음: §5.1 헤더, §5.5 답변 슬롯, §5.11 위·아래 자리", () => {
  const bar = Object.fromEntries(rows(section("5.1")).map(([id, c]) => {
    const m = c[1].match(/(primary|⋯) (\d+)/);
    return [id, { order: Number(m[2]), ...(m[1] === "primary" ? { primary: true } : {}) }];
  }));
  assert.deepEqual(bar, BAR);
  assert.deepEqual(Object.fromEntries(rows(section("5.5")).map(([id, c]) => [id, Number(c[0])])), SLOTS);
  const [top, bottom] = section("5.11").split("Above the bottom edge");
  assert.deepEqual(Object.fromEntries(rows(top).map(([id, c]) => [id, Number(c[0])])), TOP);
  assert.deepEqual(Object.fromEntries(rows(bottom).map(([id, c]) => [id, Number(c[0])])), BOTTOM);
});
