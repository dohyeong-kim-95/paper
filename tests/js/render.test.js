"use strict";
const { test, assert, load } = require("./_runner");
const { protect, restore } = load("static/render.js");

test("protect: 수식은 자리표시자, 코드 안의 $는 그대로", () => {
  const { out, math } = protect("값은 $x_1$ 이고 `a $b$ c` 그리고 $$\\sum_i x$$");
  assert.deepEqual(math, ["$x_1$", "$$\\sum_i x$$"]);
  assert.ok(out.includes("`a $b$ c`"));
  assert.ok(!out.includes("x_1"));
});

test("protect: 금액 표기($5 and $10)는 수식 아님", () => {
  assert.deepEqual(protect("costs $5 and $10 total").math, []);
});

test("restore: 원문을 이스케이프해서 span.math로", () => {
  const { out, math } = protect("$a<b$");
  assert.equal(restore(out, math), '<span class="math">$a&lt;b$</span>');
});
