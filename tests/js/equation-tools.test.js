// equation-tools 순수 함수: 구분자 감싸기, align 행 합치기, 번호 표기, 문맥 자르기, 복사 텍스트 조립
"use strict";
const { test, assert, load } = require("./_runner");
const { wrapLatex, normDelim, stripDisplay, joinRows, formatLabel, buildContext, eqQuote, assembleCopy } =
  load("static/features/equation-tools.js");

test("wrapLatex: 블록·인라인 구분자, none은 그대로, 모르는 값은 $$", () => {
  assert.equal(wrapLatex("a+b", "$$"), "$$a+b$$");
  assert.equal(wrapLatex("a+b", "none"), "a+b");
  assert.equal(wrapLatex(" a+b ", "$$", true), "$a+b$");
  assert.equal(wrapLatex("a", "$"), "$a$");
  assert.equal(wrapLatex("a", "\\["), "\\[a\\]");
  assert.equal(wrapLatex("a", "\\[", true), "\\(a\\)");
  assert.equal(wrapLatex("a", "bogus"), "$$a$$");
  assert.equal(normDelim(undefined), "$$");
  assert.equal(normDelim("toString"), "$$");
});

test("stripDisplay: \\displaystyle만 지우고 \\displaystyles 같은 다른 명령은 둠", () => {
  assert.equal(stripDisplay("\\displaystyle\\mathcal{L}"), "\\mathcal{L}");
  assert.equal(stripDisplay("\\displaystyle =x"), "=x");
  assert.equal(stripDisplay("\\displaystyles"), "\\displaystyles");
  assert.equal(stripDisplay(null), "");
});

test("joinRows: 한 행은 칸을 공백으로, 여러 행은 aligned(& 칸, \\\\ 행)", () => {
  assert.equal(joinRows([["g(x)=\\mathrm{softmax}(W_{g}x)"]]), "g(x)=\\mathrm{softmax}(W_{g}x)");
  assert.equal(joinRows([["\\displaystyle\\mathcal{L}", "\\displaystyle=a+b"]]), "\\mathcal{L} =a+b");
  assert.equal(joinRows([["f(x)", "=x^2"], ["g", "=1"]]), "\\begin{aligned}f(x) & =x^2 \\\\ g & =1\\end{aligned}");
  // 이어지는 줄(왼쪽 칸 비움)은 & 자리를 지키고, 끝의 빈 칸·빈 행은 버림
  assert.equal(joinRows([["a", "=b", ""], ["", "=c"], ["", ""]]), "\\begin{aligned}a & =b \\\\ & =c\\end{aligned}");
  // 열이 하나뿐인 여러 행(gather)
  assert.equal(joinRows([["a=1"], ["b=2"]]), "\\begin{aligned}a=1 \\\\ b=2\\end{aligned}");
  assert.equal(joinRows([]), "");
  assert.equal(joinRows([[""]]), "");
});

test("formatLabel: 중복 제거, 셋까지는 나열, 넷 이상은 범위", () => {
  assert.equal(formatLabel(["(1)"]), "(1)");
  assert.equal(formatLabel([" (2)", "(3)", "(3)"]), "(2), (3)");
  assert.equal(formatLabel(["(2)", "(3)", "(4)", "(5)"]), "(2)–(5)");
  assert.equal(formatLabel([]), "");
  assert.equal(eqQuote("(3)", "x"), "Eq. (3)");
  assert.equal(eqQuote("", "h=x"), "h=x");
  assert.equal(eqQuote("", "x".repeat(200)).length, 80);
});

test("buildContext: 앞은 끝쪽, 뒤는 앞쪽을 남기고 전체 1500자 이하, 수식 자리 표시", () => {
  assert.equal(buildContext("", ""), "");
  assert.equal(buildContext("앞 문단.", "뒤 문단.", "(1)"), "앞 문단.\n[이 수식 (1)]\n뒤 문단.");
  assert.equal(buildContext("앞", "", ""), "앞\n[이 수식]");
  const long = buildContext("A".repeat(3000) + "END", "START" + "B".repeat(3000), "(2)");
  assert.ok(long.length <= 1500, String(long.length));
  assert.ok(long.startsWith("…") && long.includes("END\n[이 수식 (2)]\nSTART") && long.endsWith("…"));
  // 뒤가 짧으면 남는 몫을 앞에
  const lop = buildContext("A".repeat(3000), "짧음", "");
  assert.ok(lop.length <= 1500 && lop.length > 1400, String(lop.length));
  assert.ok(lop.endsWith("\n짧음"));
});

test("assembleCopy: 인라인은 $…$, 블록은 따로 한 줄, 공백·빈 줄 정리, 빈 수식은 버림", () => {
  const parts = [
    { br: true }, { text: "Dense grows as\n  " }, { tex: "x^{2}", display: false }, { text: " for width " },
    { tex: "x", display: false }, { text: "." }, { br: true },
    { tex: "\\begin{aligned}a & =b\\end{aligned}", display: true },
    { br: true }, { br: true }, { br: true }, { text: " where " }, { tex: "", display: false }, { text: "ok " }, { br: true },
  ];
  assert.equal(assembleCopy(parts, "$$"),
    "Dense grows as $x^{2}$ for width $x$.\n\n$$\\begin{aligned}a & =b\\end{aligned}$$\n\nwhere ok");
  assert.equal(assembleCopy([{ text: "a " }, { tex: "x", display: false }], "\\["), "a \\(x\\)");
  assert.equal(assembleCopy([{ tex: "x", display: true }], "none"), "x");
});
