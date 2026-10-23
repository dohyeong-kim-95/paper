"use strict";
const { test, assert, load } = require("./_runner");
const { normalize, normMap, locateIn, quoteAt, clipAround } = load("static/anchor.js");

test("normalize: 소문자, 따옴표·대시 통일, 공백 하나로", () => {
  assert.equal(normalize("  We  “Propose”\n a ‘sparse’ — model "), `we "propose" a 'sparse' - model`);
  assert.equal(normalize("soft­hyphen zero​width"), "softhyphen zerowidth");
});

test("normalize: 구두점 앞·여는 괄호 뒤 공백 제거 (수식 덩어리 주변)", () => {
  assert.equal(normalize("width  $x$ . We ( see )"), "width $x$. we (see)");
  assert.equal(normalize("width $x$. We (see)"), normalize("width  $x$ . We ( see )"));
});

test("normMap: 정규화 위치 → 원문 위치", () => {
  const text = "A  B\n\nC";
  const { norm, map } = normMap(text);
  assert.equal(norm, "a b c");
  assert.equal(text[map[0]], "A");
  assert.equal(text[map[2]], "B");
  assert.equal(text[map[4]], "C");
  assert.equal(map[norm.length], text.length);
});

const TEXT = "Large models scale well. We propose a sparse mixture of experts model that routes each token to two experts. "
  + "In our experiments the sparse mixture of experts model wins. Dense models are “slow” – really.";

test("locateIn: 정확히 일치 (대소문자·공백 무시) → 원문 오프셋", () => {
  const o = locateIn(TEXT, "we propose a SPARSE   mixture");
  assert.ok(o);
  assert.equal(TEXT.slice(o.start, o.end), "We propose a sparse mixture");
});

test("locateIn: 둥근 따옴표·대시가 섞여도 찾음", () => {
  const o = locateIn(TEXT, 'Dense models are "slow" - really');
  assert.ok(o);
  assert.equal(TEXT.slice(o.start, o.end), "Dense models are “slow” – really");
});

test("locateIn: 여러 번 나오면 prefix/suffix로 고름", () => {
  const first = locateIn(TEXT, "sparse mixture of experts model");
  const second = locateIn(TEXT, "sparse mixture of experts model", { prefix: "In our experiments the ", suffix: " wins." });
  assert.ok(first && second);
  assert.ok(second.start > first.start);
  assert.equal(TEXT.slice(second.start - 4, second.start), "the ");
});

test("locateIn: 범위(from/to) 제한", () => {
  const cut = TEXT.indexOf("In our");
  const o = locateIn(TEXT, "sparse mixture", { from: cut });
  assert.ok(o.start > cut);
  assert.equal(locateIn(TEXT, "We propose", { from: cut }), null);
});

test("locateIn: 끝부분이 달라도 앞 8단어로 찾고 끝 8단어까지 늘림", () => {
  const q = "We propose a sparse mixture of experts model that routes every token to two experts.";
  const o = locateIn(TEXT, q);
  assert.ok(o);
  assert.ok(TEXT.slice(o.start, o.end).startsWith("We propose a sparse mixture of experts model"));
  // 8단어 이하는 정확 일치만
  assert.equal(locateIn(TEXT, "We propose a dense thing"), null);
});

test("locateIn: 빈 인용·없는 인용은 null", () => {
  assert.equal(locateIn(TEXT, "   "), null);
  assert.equal(locateIn(TEXT, "nothing like this here"), null);
});

test("locateIn: 수식 덩어리($alttext$) 포함 인용", () => {
  const t = "dense computation grows as  $x^{2}$  for a model of width  $x$ . We propose";
  const o = locateIn(t, "grows as $x^{2}$ for a model of width $x$. We");
  assert.ok(o);
  assert.match(t.slice(o.start, o.end), /^grows as {2}\$x\^\{2\}\$/);
});

test("quoteAt: 앞뒤 32자 문맥", () => {
  const start = TEXT.indexOf("routes"), end = start + "routes each token".length;
  const q = quoteAt(TEXT, start, end);
  assert.equal(q.quote, "routes each token");
  assert.equal(q.prefix.length, 32);
  assert.ok(TEXT.slice(0, start).endsWith(q.prefix));
  assert.ok(TEXT.slice(end).startsWith(q.suffix));
  // 저장한 인용은 prefix/suffix와 함께 다시 같은 곳을 찾음
  const again = locateIn(TEXT, q.quote, { prefix: q.prefix, suffix: q.suffix });
  assert.deepEqual([again.start, again.end], [start, end]);
});

test("clipAround: 길면 needle 주변만", () => {
  const full = "a".repeat(3000) + "NEEDLE here" + "b".repeat(3000);
  const c = clipAround(full, "NEEDLE here", 200);
  assert.ok(c.includes("NEEDLE here"));
  assert.ok(c.length <= 202);
  assert.equal(clipAround("short", "x", 200), "short");
});
