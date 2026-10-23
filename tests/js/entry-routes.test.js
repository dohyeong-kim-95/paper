// entry-routes 순수 함수: 인용 자르기, 텍스트 지시자, 딥링크 ↔ 해시 파싱, 북마클릿, 공유 항목 변환
"use strict";
const { test, assert, load } = require("./_runner");
const er = load("static/features/entry-routes.js");
const { normalize } = load("static/anchor.js");

test("clipQuote: 공백 정리, 120자 이하, 단어 중간에서 안 자름", () => {
  assert.equal(er.clipQuote("  a\n  b  "), "a b");
  const long = "word ".repeat(40).trim(); // 199자
  const c = er.clipQuote(long);
  assert.ok(c.length <= 120);
  assert.ok(long.startsWith(c));
  assert.ok(c.endsWith("word"));
  assert.equal(er.clipQuote("x".repeat(200)).length, 120); // 공백이 없으면 그냥 자름
  assert.equal(er.clipQuote(null), "");
});

test("textDirective: 짧으면 통째, 길면 앞 4단어,끝 4단어, '-' ',' 이스케이프, 수식이면 생략", () => {
  assert.equal(er.textDirective("top-two routing, rule"), "text=top%2Dtwo%20routing%2C%20rule");
  assert.equal(er.textDirective("one two three four five six seven eight nine ten"),
    "text=one%20two%20three%20four,seven%20eight%20nine%20ten");
  assert.equal(er.textDirective("gate scores $s_i$ are"), "");
  assert.equal(er.textDirective(""), "");
  assert.equal(er.textDirective("a&b"), "text=a%26b");
});

test("deepLink → parseHash 왕복 (한글·&·#·수식·앞 문맥)", () => {
  const quotes = ["We introduce a top-two routing rule", "이 문단은 한국어 & #해시 50% 'x'", "scores $s_i = W x$ per token"];
  for (const q of quotes) {
    const url = er.deepLink("https://p.example", "2401.00001v2", q, "model that ");
    assert.ok(url.startsWith("https://p.example/paper/2401.00001v2#q="));
    const hash = url.slice(url.indexOf("#"));
    const hp = er.parseHash(hash);
    assert.equal(hp.q, q);
    assert.equal(hp.p, "model that ");
    // 브라우저가 :~: 지시자를 떼어 낸 해시도 같게
    assert.deepEqual(er.parseHash(hash.split(":~:")[0]), hp);
  }
  assert.ok(er.deepLink("o", "1", "plain words here").includes(":~:text=plain%20words%20here"));
  assert.ok(!er.deepLink("o", "1", "has $x$ math").includes(":~:"));
  assert.ok(!er.deepLink("o", "1", "no prefix").includes("&p="));
  // 메신저 링크 인식이 끊기는 문자 없음
  const odd = er.deepLink("o", "1", "it's (very) fun! *~*", "x (y)");
  assert.doesNotMatch(odd.slice(odd.indexOf("#")).split(":~:")[0], /[\s'()!*~]/);
  assert.equal(er.parseHash(odd.slice(odd.indexOf("#"))).q, "it's (very) fun! *~*");
  assert.equal(er.deepLink("o", "2401.00001", "  "), "o/paper/2401.00001");
});

test("parseHash: q/s만, 잘못된 공유 id·다른 해시는 null", () => {
  assert.equal(er.parseHash("#S2.SS1"), null);
  assert.equal(er.parseHash(""), null);
  assert.equal(er.parseHash("#bib.bib1"), null);
  assert.deepEqual(er.parseHash("#s=AbC_12-xyz9"), { s: "AbC_12-xyz9" });
  assert.equal(er.parseHash("#s=../../etc"), null);
  assert.equal(er.parseHash("#s=short"), null);
  assert.deepEqual(er.parseHash("#q=%E0%A4%A"), { q: "%E0%A4%A" }); // 깨진 인코딩은 그대로
  assert.deepEqual(er.parseHash("q=hello%20world&x=1"), { q: "hello world" });
  assert.equal(er.parseHash("#q=%20%20"), null);
});

test("needsPrefix: 정규화 텍스트에 두 번 이상이면 true", () => {
  const text = normalize("The model routes tokens. Later the model routes tokens again.");
  assert.equal(er.needsPrefix(text, normalize("model routes tokens")), true);
  assert.equal(er.needsPrefix(text, normalize("again")), false);
  assert.equal(er.needsPrefix(text, normalize("missing")), false);
  assert.equal(er.needsPrefix(text, ""), false);
});

test("shareText·errMessage", () => {
  assert.equal(er.shareText(" a  b "), "“a b”");
  assert.equal(er.shareText(""), "");
  const t = er.shareText("x".repeat(400));
  assert.equal(t.length, 282);
  assert.ok(t.endsWith("…”"));
  assert.match(er.errMessage("noid"), /arXiv 논문 번호/);
  assert.match(er.errMessage("weird"), /열지 못했/);
  assert.equal(er.errMessage(null), "");
});

test("bookmarklet: 현재 주소·제목을 /share로 보냄 (반환값이 없어 페이지를 덮어쓰지 않음)", () => {
  const code = er.bookmarklet("https://p.example");
  assert.ok(code.startsWith("javascript:void("));
  const location = { href: "https://arxiv.org/abs/2401.04088?x=1&y=2" };
  const document = { title: "Mixtral & co" };
  const ret = new Function("location", "document", `return ${code.slice("javascript:".length)}`)(location, document);
  assert.equal(ret, undefined);
  const u = new URL(location.href);
  assert.equal(u.origin + u.pathname, "https://p.example/share");
  assert.equal(u.searchParams.get("url"), "https://arxiv.org/abs/2401.04088?x=1&y=2");
  assert.equal(u.searchParams.get("title"), "Mixtral & co");
});

test("shareItems: 앵커 있는 항목만, Q&A 모양 여러 가지, 한도 자르기", () => {
  const items = er.shareItems([
    { id: "h1", type: "hl", color: "yellow", anchor: { quote: "routes each token", prefix: "p", suffix: "s", paraId: "S1.p1" }, ts: 1 },
    { id: "n1", type: "note", color: "Bad;", note: "메모", anchor: { quote: "q2" } },
    { id: "x", type: "hl", anchor: {} },
    null,
    { id: "qa1", type: "qa", anchor: { quote: "q3" }, qa: { q: "왜?", a: "그래서" } },
    { id: "qa2", type: "qa", anchor: { quote: "q4" }, qa: [{ role: "user", content: "Q1" }, { role: "assistant", content: "A1" }, { role: "user", content: "Q2" }, { role: "assistant", content: "A2" }] },
    { id: "qa3", type: "qa", anchor: { quote: "q5" }, qa: "답만" },
    { id: "qa4", type: "qa", anchor: { quote: "q6" }, qa: { question: "물음", answer: "답" } },
  ]);
  assert.deepEqual(items.map(i => i.key), ["h1", "n1", "qa1", "qa2", "qa3", "qa4"]);
  assert.deepEqual(items[0], { key: "h1", quote: "routes each token", prefix: "p", suffix: "s", color: "yellow", note: "", q: "", a: "" });
  assert.equal(items[1].color, "");
  assert.equal(items[1].note, "메모");
  assert.deepEqual([items[2].q, items[2].a], ["왜?", "그래서"]);
  assert.deepEqual([items[3].q, items[3].a], ["Q1", "A2"]);
  assert.deepEqual([items[4].q, items[4].a], ["", "답만"]);
  assert.deepEqual([items[5].q, items[5].a], ["물음", "답"]);
  assert.deepEqual(er.shareItems("nope"), []);
  const many = er.shareItems(Array.from({ length: 250 }, (_, i) => ({ id: i, anchor: { quote: "x".repeat(2000), prefix: "p".repeat(500) } })));
  assert.equal(many.length, 200);
  assert.equal(many[0].quote.length, 1000);
  assert.equal(many[0].prefix.length, 200);
});
