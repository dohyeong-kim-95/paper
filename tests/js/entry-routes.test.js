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

// 본문 색인(정규화)에서 세는 함수: 브라우저 쪽 shareSelection과 같게
const counter = text => { const norm = normalize(text); return s => er.countIn(norm, normalize(s)); };

test("countIn: 겹쳐도 세고 limit에서 멈춤, 빈 needle은 0", () => {
  assert.equal(er.countIn("aaaa", "aa"), 2);
  assert.equal(er.countIn("aaaa", "aa", 10), 3);
  assert.equal(er.countIn("abc", "x"), 0);
  assert.equal(er.countIn("abc", ""), 0);
});

test("textDirective: 본문에서 한 곳만 가리킬 때만, 짧으면 통째, 길면 한 번만 나오는 앞·끝 조각", () => {
  const doc = counter("Intro. We use a top-two routing, rule here. Gate scores $s_i$ are summed. a&b. " +
    "one two three four five six seven eight nine ten.");
  assert.equal(er.textDirective("top-two routing, rule", doc), "text=top%2Dtwo%20routing%2C%20rule");
  assert.equal(er.textDirective("one two three four five six seven eight nine ten", doc),
    "text=one%20two%20three%20four,seven%20eight%20nine%20ten");
  assert.equal(er.textDirective("gate scores $s_i$ are", doc), "");
  assert.equal(er.textDirective("", doc), "");
  assert.equal(er.textDirective("a&b", doc), "text=a%26b");
  // 셀 수 없으면(색인 없음)·본문에 없으면 붙이지 않음
  assert.equal(er.textDirective("top-two routing, rule"), "");
  assert.equal(er.textDirective("not in the text", doc), "");
});

test("textDirective: 인용이 여러 번 나오면 생략 (브라우저는 첫 등장으로 감)", () => {
  const doc = counter("The model routes tokens. Later the model routes tokens again.");
  assert.equal(er.textDirective("model routes tokens", doc), "");
  assert.equal(er.textDirective("again", doc), "text=again");
});

test("textDirective: 흔한 첫머리(초록에도 있는)면 앞 조각을 늘리고, 끝까지 겹치면 통째", () => {
  const abstract = "In this paper, we show that the router is stable. ";
  const body = "In this paper, we show that the router converges under mild noise and stays balanced.";
  const doc = counter(abstract + "More text here. " + body);
  const q = body.slice(0, -1);
  // 'In this paper, we' 'show that the router'까지 초록과 같음 → 'converges'까지 늘림. 끝 4단어는 한 번뿐
  assert.equal(er.textDirective(q, doc),
    "text=In%20this%20paper%2C%20we%20show%20that%20the%20router%20converges,noise%20and%20stays%20balanced");
  // 끝 조각도 흔하면 늘림
  const doc2 = counter("stays balanced and fine. noise and stays balanced. " + "alpha beta gamma delta eps zeta eta theta iota noise and stays balanced.");
  assert.equal(er.textDirective("alpha beta gamma delta eps zeta eta theta iota noise and stays balanced", doc2),
    "text=alpha%20beta%20gamma%20delta,iota%20noise%20and%20stays%20balanced");
  // 앞 조각을 늘리다 끝 조각과 만나면 범위 꼴을 포기하고 인용 통째 (본문에 한 번뿐이므로 맞는 곳)
  const doc3 = counter("w1 w2 w3 w4 w5 w6 w7 w8 x. w1 w2 w3 w4 w5 w6 w7 w8 w9 w10");
  assert.equal(er.textDirective("w1 w2 w3 w4 w5 w6 w7 w8 w9 w10", doc3), `text=${"w1 w2 w3 w4 w5 w6 w7 w8 w9 w10".replace(/ /g, "%20")}`);
  // 수식이 가운데에만 있으면 범위 꼴은 되고, 통째로 가야 하면 생략
  const doc4 = counter("we compute the gate $g(x)$ with a softmax over all experts at once.");
  assert.equal(er.textDirective("we compute the gate $g(x)$ with a softmax over all experts", doc4),
    "text=we%20compute%20the%20gate,softmax%20over%20all%20experts");
  const doc5 = counter("we compute the gate. we compute the gate $g(x)$ with a softmax over all experts. softmax over all experts");
  assert.equal(er.textDirective("we compute the gate $g(x)$ with a softmax over all experts", doc5), "");
});

test("deepLink → parseHash 왕복 (한글·&·#·수식·앞 문맥)", () => {
  const quotes = ["We introduce a top-two routing rule", "이 문단은 한국어 & #해시 50% 'x'", "scores $s_i = W x$ per token"];
  for (const q of quotes) {
    const url = er.deepLink("https://p.example", "2401.00001v2", q, "model that ", counter(q));
    assert.ok(url.startsWith("https://p.example/paper/2401.00001v2#q="));
    assert.ok(!url.includes(":~:"), "앞 문맥이 있으면(여러 번 나옴) 브라우저 지시자 없음");
    const hash = url.slice(url.indexOf("#"));
    const hp = er.parseHash(hash);
    assert.equal(hp.q, q);
    assert.equal(hp.p, "model that ");
    // 지시자가 붙은 해시(브라우저가 안 떼어 낸 경우)도 같게
    assert.deepEqual(er.parseHash(`${hash}:~:text=x`), hp);
  }
  assert.ok(er.deepLink("o", "1", "plain words here", "", counter("x plain words here y")).includes("#q=plain%20words%20here:~:text=plain%20words%20here"));
  assert.ok(!er.deepLink("o", "1", "plain words here").includes(":~:"));
  assert.ok(!er.deepLink("o", "1", "has $x$ math", "", counter("has $x$ math")).includes(":~:"));
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

test("cutHead·cutTail: 서로게이트 짝을 반으로 자르지 않음 (shareItems·shareText도)", () => {
  const e = "😀"; // 2 UTF-16 단위
  assert.equal(er.cutHead(`ab${e}`, 3), "ab");
  assert.equal(er.cutHead(`ab${e}`, 4), `ab${e}`);
  assert.equal(er.cutTail(`${e}ab`, 3), "ab");
  assert.equal(er.cutTail(`${e}ab`, 4), `${e}ab`);
  assert.equal(er.cutHead(null, 3), "");
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const [it] = er.shareItems([{ id: 1, type: "qa", note: "n".repeat(3999) + e, anchor: { quote: "q".repeat(999) + e, prefix: e + "p".repeat(199) }, qa: { q: "", a: "a".repeat(7999) + e } }]);
  for (const k of ["quote", "prefix", "note", "a"]) assert.doesNotMatch(it[k], lone, k);
  assert.equal(it.quote.length, 999);
  assert.equal(it.prefix, "p".repeat(199));
  assert.doesNotMatch(er.shareText("x".repeat(278) + e + "yyy"), lone);
  assert.doesNotMatch(er.clipQuote(e.repeat(100), 121), lone);
});

test("shareError: 413·429·507·422는 고칠 방법을, 나머지는 서버/네트워크", () => {
  assert.match(er.shareError(413), /너무 많아요/);
  assert.match(er.shareError(429), /잠시 뒤/);
  assert.match(er.shareError(507), /저장 공간/);
  assert.match(er.shareError(422), /보낼 수 없는/);
  assert.match(er.shareError(500), /서버 오류/);
  assert.match(er.shareError(0), /네트워크/);
  assert.equal(er.byteLength("a한😀"), 1 + 3 + 4);
  assert.equal(er.SHARE_MAX, 300000);
});
