// related-papers 순수 함수: 초록 자르기, 저자·정보 줄, 검색 주소, Google Scholar 검색어
"use strict";
const { test, assert, load } = require("./_runner");
const rp = load("static/features/related-papers.js");

test("clip: 140자 근처 단어 경계에서 자르고 …, 짧으면 그대로", () => {
  assert.equal(rp.clip("  short   text "), "short text");
  const long = "word ".repeat(60);
  const c = rp.clip(long);
  assert.ok(c.length <= 141 && c.endsWith("…"), c);
  assert.ok(!c.includes("wo…"), "단어 중간에서 자르지 않음");
  assert.equal(rp.clip("a".repeat(200), 10), "aaaaaaaaaa…"); // 공백이 없으면 그냥 자름
  assert.equal(rp.clip("one two, three four", 9), "one two…"); // 끝 문장부호 정리
  assert.equal(rp.clip(null), "");
});

test("authorsLine: 3명 + 외 n명", () => {
  assert.equal(rp.authorsLine(["A", "B", "C"], 5), "A, B, C 외 2명");
  assert.equal(rp.authorsLine(["A", "B"], 2), "A, B");
  assert.equal(rp.authorsLine(["A"]), "A");
  assert.equal(rp.authorsLine([], 4), "");
  assert.equal(rp.authorsLine(undefined), "");
});

test("metaLine: 종류별 정보 줄", () => {
  const cited = { year: 2023, authors: ["A. Author"], n_authors: 2, label: "[1]", cites: 3 };
  assert.equal(rp.metaLine(cited, "cited"), "2023 · A. Author 외 1명 · [1] · 본문 인용 3회");
  assert.equal(rp.metaLine({ ...cited, cites: 0, year: null }, "cited"), "A. Author 외 1명 · [1]");
  assert.equal(rp.metaLine({ year: 2024, authors: [] }, "similar"), "2024");
  assert.equal(rp.metaLine({ year: 2025, citations: 1234 }, "citing"), "2025 · 피인용 1,234");
  assert.equal(rp.metaLine({ citations: 0 }, "citing"), "피인용 0");
});

test("searchUrl: 검색어마다 t= (인코딩)", () => {
  assert.equal(rp.searchUrl("2401.00001", ["mixture of experts", "kd&x"]),
    "/api/related-papers/2401.00001/search?t=mixture%20of%20experts&t=kd%26x");
});

test("scholarQuery: 짧은 구절은 그대로(수식 제외), 긴 구절은 검색어", () => {
  assert.equal(rp.scholarQuery("sparse mixture of $x^2$ experts"), "sparse mixture of experts");
  const long = "We propose a sparse mixture of experts model that routes each token to two experts with a learned router.";
  assert.equal(rp.scholarQuery(long, ["mixture of experts", "routing"]), '"mixture of experts" routing');
  assert.equal(rp.scholarQuery(long, []).split(" ").length, 19); // 검색어가 없으면 구절 (최대 30단어)
  assert.equal(rp.scholarQuery("w ".repeat(50), []).split(" ").length, 30);
  assert.equal(rp.scholarUrl('"a b" c'), "https://scholar.google.com/scholar?q=%22a%20b%22%20c");
});

test("tabLabel: 개수를 모르면 이름만", () => {
  assert.equal(rp.tabLabel("참고한 논문", 3), "참고한 논문 3");
  assert.equal(rp.tabLabel("참고한 논문", 0), "참고한 논문 0");
  assert.equal(rp.tabLabel("인용한 논문", "1000+"), "인용한 논문 1000+");
  assert.equal(rp.tabLabel("비슷한 논문", null), "비슷한 논문");
});

test("libraryBadge: 읽기 진행(status)으로, 연 적만 있으면 '열어 본 논문'", () => {
  assert.equal(rp.libraryBadge(null), null);
  assert.equal(rp.libraryBadge({ status: "done", opened: 1 }), "읽은 논문");
  assert.equal(rp.libraryBadge({ status: "reading", opened: 1 }), "읽는 중");
  assert.equal(rp.libraryBadge({ status: "to-read", opened: 1 }), "읽을 목록");
  assert.equal(rp.libraryBadge({ star: true }), "즐겨찾기");
  assert.equal(rp.libraryBadge({ opened: 1 }), "열어 본 논문");
});
