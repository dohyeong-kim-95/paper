// daily-feed 순수 함수: 분야·저자 정규화, 분야 개수 한도, 피드·논문 주소, AND/OR 키워드 필터, 날짜 묶음, 새 논문 표시, 서재 추천
"use strict";
process.env.TZ = "Asia/Seoul"; // 날짜 묶음은 현지 시각 기준
const { test, assert, load } = require("./_runner");
const F = load("static/features/daily-feed.js");

test("분야 이름 검증·정규화", () => {
  assert.equal(F.validCat("cs.CL"), true);
  assert.equal(F.validCat("cs.CL; drop"), false);
  assert.equal(F.validCat("CS.CL"), false);
  assert.equal(F.normCat(" CS.lg "), "cs.LG");
  assert.equal(F.normCat("physics.comp-ph"), "physics.comp-ph");
  assert.equal(F.normCat("q-bio.nc"), "q-bio.NC");
  assert.equal(F.normCat("hep-th"), "hep-th");
  assert.equal(F.normCat("cs.CL OR x"), null);
  assert.equal(F.normCat("cs.C1"), null);
});

test("parseCats: 구분자·중복·최대 개수", () => {
  assert.deepEqual(F.parseCats("cs.CL, cs.lg; stat.ML  bad! cs.C1 cs.CL"), ["cs.CL", "cs.LG", "stat.ML"]);
  assert.deepEqual(F.parseCats("a.b c.d e.f", 2), ["a.b", "c.d"]);
  assert.deepEqual(F.parseCats(""), []);
});

test("mergeCats: 빈 자리만큼 뒤에 붙이고 있던 분야는 밀어내지 않음", () => {
  const eight = ["cs.CL", "cs.LG", "cs.AI", "cs.CV", "cs.IR", "cs.RO", "cs.SE", "cs.CR"];
  assert.equal(F.MAX_CATS, 8);
  assert.deepEqual(F.mergeCats(eight, ["stat.ML", "eess.AS"]), { cats: eight, added: [], skipped: ["stat.ML", "eess.AS"] });
  const seven = eight.slice(0, 7);
  assert.deepEqual(F.mergeCats(seven, ["stat.ML", "cs.CL", "eess.AS"]),
    { cats: [...seven, "stat.ML"], added: ["stat.ML"], skipped: ["eess.AS"] });
  assert.deepEqual(F.mergeCats(["cs.CL"], ["cs.cl", "bad!", "q-bio.nc"]), { cats: ["cs.CL", "q-bio.NC"], added: ["q-bio.NC"], skipped: [] });
  assert.deepEqual(F.mergeCats(eight, []).cats, eight);
  assert.equal(F.parseCats("a.b c.d e.f g.h i.j k.l m.n o.p q.r", Infinity).length, 9);
});

test("normAuthor: 글자·공백·.'- 만", () => {
  assert.equal(F.normAuthor("  Yann   LeCun "), "Yann LeCun");
  assert.equal(F.normAuthor("José Müller-Lüdenscheidt"), "José Müller-Lüdenscheidt");
  assert.equal(F.normAuthor("김철수"), "김철수");
  assert.equal(F.normAuthor("O'Neil, J."), null); // 쉼표 불가
  assert.equal(F.normAuthor('x" OR cat:cs'), null);
  assert.equal(F.normAuthor("K"), null);
  assert.equal(F.normAuthor("1984"), null);
});

test("출처 키와 피드 주소", () => {
  assert.deepEqual(F.parseSrc("cat:cs.CL"), { type: "cat", value: "cs.CL" });
  assert.deepEqual(F.parseSrc("au:Alice Kim"), { type: "au", value: "Alice Kim" });
  assert.equal(F.parseSrc("cat:bad;x"), null);
  assert.equal(F.parseSrc("x:y"), null);
  assert.equal(F.srcKey({ type: "au", value: "Bob" }), "au:Bob");
  assert.equal(F.feedUrl({ type: "cat", value: "cs.CL" }), "/api/daily-feed?cat=cs.CL");
  assert.equal(F.feedUrl({ type: "au", value: "Alice Kim" }), "/api/daily-feed?author=Alice%20Kim");
});

test("paperHref: 새 형식 id는 리더, 옛 형식(cs/0112017)은 arXiv 초록 페이지", () => {
  assert.equal(F.readerId("2401.00001"), true);
  assert.equal(F.readerId("cs/0112017"), false);
  assert.equal(F.readerId("math.GT/0309136"), false);
  assert.equal(F.paperHref("2401.00001"), "/paper/2401.00001");
  assert.equal(F.paperHref("cs/0112017"), "https://arxiv.org/abs/cs/0112017");
});

test("parseQuery: 따옴표 구절·제외어", () => {
  assert.deepEqual(F.parseQuery('LLM "in-context learning" -survey -"position paper" llm'),
    { inc: ["llm", "in-context learning"], exc: ["survey", "position paper"] });
  assert.deepEqual(F.parseQuery("  "), { inc: [], exc: [] });
  assert.deepEqual(F.parseQuery('"unclosed - x'), { inc: ["unclosed", "x"], exc: [] });
});

const item = {
  id: "2401.00001", title: "Sparse Mixtures of Experts for LLMs", summary: "We route each token to two experts in a world model.",
  authors: ["Alice Kim"], cat: "cs.CL",
};

test("matchItem: AND/OR, 단어 시작 일치, 제외어", () => {
  assert.equal(F.matchItem(item, ""), true);
  assert.equal(F.matchItem(item, "sparse experts"), true);
  assert.equal(F.matchItem(item, "sparse vision"), false);
  assert.equal(F.matchItem(item, "sparse vision", "or"), true);
  assert.equal(F.matchItem(item, "llm"), true); // LLMs의 앞부분
  assert.equal(F.matchItem(item, "rl"), false); // world 안의 rl은 아님
  assert.equal(F.matchItem(item, "sparse -token"), false);
  assert.equal(F.matchItem(item, "-survey"), true);
  assert.equal(F.matchItem(item, "alice"), true); // 저자
  assert.equal(F.matchItem(item, "cs.cl"), true); // 분야
  assert.equal(F.matchItem(item, "전문가"), false);
  assert.equal(F.matchItem({ ...item, title: "희소 전문가 혼합" }, "전문가"), true); // 한글은 부분 문자열
  assert.equal(F.matchItem(item, F.parseQuery("token two"), "and"), true);
});

test("dayLabel·groupByDay (현지 날짜)", () => {
  const now = new Date("2026-10-23T09:00:00+09:00");
  assert.equal(F.dayLabel("2026-10-22T20:00:00Z", now), "오늘"); // 서울 10/23 05:00
  assert.equal(F.dayLabel("2026-10-22T10:00:00Z", now), "어제");
  assert.equal(F.dayLabel("2026-10-20T10:00:00Z", now), "10월 20일 (화)");
  assert.equal(F.dayLabel("nope", now), "날짜 없음");
  const g = F.groupByDay([
    { id: "a", published: "2026-10-22T20:00:00Z" }, { id: "b", published: "2026-10-22T16:00:00Z" },
    { id: "c", published: "2026-10-22T10:00:00Z" }, { id: "d", published: "2026-10-20T10:00:00Z" },
  ], now);
  assert.deepEqual(g.map(x => [x.label, x.items.map(i => i.id).join("")]), [["오늘", "ab"], ["어제", "c"], ["10월 20일 (화)", "d"]]);
});

test("isNew·newest: 지난 방문 이후", () => {
  const list = [{ published: "2026-10-22T10:00:00Z" }, { published: "2026-10-22T18:00:00Z" }, { published: "bad" }];
  assert.equal(F.newest(list), "2026-10-22T18:00:00Z");
  assert.equal(F.newest([]), "");
  assert.equal(F.isNew(list[1], "2026-10-22T12:00:00Z"), true);
  assert.equal(F.isNew(list[0], "2026-10-22T12:00:00Z"), false);
  assert.equal(F.isNew(list[1], ""), false); // 첫 방문엔 표시 없음
});

test("libraryIds·withDefaults: 서재 기반 기본 분야", () => {
  const lib = {
    "2401.00001": { id: "2401.00001", opened: 5 }, "2302.00002": { id: "2302.00002", opened: 9 },
    "x": { id: "bad" }, "y": null, "2301.00001": { id: "2301.00001" },
  };
  assert.deepEqual(F.libraryIds(lib), ["2302.00002", "2401.00001", "2301.00001"]);
  assert.deepEqual(F.libraryIds(lib, 1), ["2302.00002"]);
  assert.deepEqual(F.libraryIds(null), []);
  assert.deepEqual(F.withDefaults(["cs.CV"]), ["cs.CV", "cs.CL", "cs.LG"]);
  assert.deepEqual(F.withDefaults(["cs.CV", "eess.IV", "cs.RO", "cs.CL"]), ["cs.CV", "eess.IV", "cs.RO", "cs.CL"]);
  assert.deepEqual(F.withDefaults([]), F.DEFAULT_CATS);
});
