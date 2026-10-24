// ref-peek 순수 함수: 참조 종류 판별, 문장 경계, 제목
"use strict";
const { test, assert, load } = require("./_runner");
const rp = load("static/features/ref-peek.js");

test("classifyHref: 브리프의 기본 대응", () => {
  assert.equal(rp.classifyHref("#S2.E1"), "equation");
  assert.equal(rp.classifyHref("#S2.F1"), "figure");
  assert.equal(rp.classifyHref("#S2.T1"), "figure");
  assert.equal(rp.classifyHref("#S1"), "section");
  assert.equal(rp.classifyHref("#bib.bib1"), null);
});

test("classifyHref: LaTeXML의 다른 id 모양 (번호 없는 식, 부록, 정리, 하위 그림, 알고리즘)", () => {
  const cases = {
    "#S2.Ex1": "equation", "#S2.EGx1": "equation", "#S2.E3": "equation", "#A1.E4": "equation", "#A1.E2": "equation",
    "#S2.F2.sf1": "figure", "#alg1": "figure", "#Thmtheorem1": "theorem", "#S3.Thmlemma2": "theorem",
    "#A1": "appendix", "#A1.SS1": "appendix", "#S2.SS1": "section", "#S2.SS1.SSS2": "section",
    "#footnote1": "footnote", "#S1.p1": "para", "#S1.I1.i1": "other", "#bib": null, "": null, "#": null,
  };
  for (const [href, kind] of Object.entries(cases)) assert.equal(rp.classifyHref(href), kind, href);
  assert.equal(rp.refKind("#S2.T1"), "table");
  assert.equal(rp.refKind("#alg1"), "algorithm");
  assert.equal(rp.classifyHref("S2.E1"), "equation", "# 없이도");
  assert.equal(rp.idFromHref("#S2%2EE1"), "S2.E1", "퍼센트 인코딩 풀기");
  assert.equal(rp.idFromHref("https://x/y#bib.bib3"), "bib.bib3");
});

test("sentenceBounds: 약어·수식 안의 마침표에서 끊지 않음", () => {
  const t = "Dense models are slow. The router computes gate scores as in Eq. (1). Figure 1 shows it. Next one.";
  const at = t.indexOf("(1)") + 1;
  const b = rp.sentenceBounds(t, at, at + 1);
  assert.equal(t.slice(b.start, b.end), "The router computes gate scores as in Eq. (1).");
  assert.equal(b.cutStart || b.cutEnd, false);
  const m = "We set $a. B$ here as shown in Table 1. Done.";
  const i = m.indexOf("Table 1");
  const s = rp.sentenceBounds(m, i, i + 7);
  assert.equal(m.slice(s.start, s.end), "We set $a. B$ here as shown in Table 1.");
  const al = "Prior work by Smith et al. (2020) uses Figure 2. Other.";
  const j = al.indexOf("Figure 2");
  const ab = rp.sentenceBounds(al, j, j + 8);
  assert.equal(al.slice(ab.start, ab.end), "Prior work by Smith et al. (2020) uses Figure 2.");
  const ko = "첫 문장입니다. 그림 1은 구조를 보여 줍니다. 끝.";
  const k = ko.indexOf("그림 1");
  const kb = rp.sentenceBounds(ko, k, k + 4);
  assert.equal(ko.slice(kb.start, kb.end), "그림 1은 구조를 보여 줍니다.");
});

test("sentenceBounds: 긴 문장은 참조 주변만 (낱말 경계, 잘렸음 표시)", () => {
  const long = "word ".repeat(200) + "see Figure 7 here " + "more ".repeat(200) + ".";
  const i = long.indexOf("Figure 7");
  const b = rp.sentenceBounds(long, i, i + 8, 120);
  assert.ok(b.end - b.start <= 120);
  assert.ok(b.start <= i && b.end >= i + 8);
  assert.equal(b.cutStart, true);
  assert.equal(b.cutEnd, true);
  assert.equal(long[b.start - 1], " ", "낱말 중간에서 시작하지 않음");
});

test("titleFrom: 꼬리표 우선, 없으면 링크 title 첫 부분", () => {
  assert.equal(rp.titleFrom({ kind: "equation", tag: "(3)" }), "식 (3)");
  assert.equal(rp.titleFrom({ kind: "equation", tag: "" }), "수식");
  assert.equal(rp.titleFrom({ kind: "figure", tag: "Figure 2: ", sub: "(a) " }), "Figure 2 (a)");
  assert.equal(rp.titleFrom({ kind: "figure", tag: "Table 1: " }), "Table 1");
  assert.equal(rp.titleFrom({ kind: "section", heading: "2.1 Training objective" }), "2.1 Training objective");
  assert.equal(rp.titleFrom({ kind: "footnote", tag: "1" }), "각주 1");
  assert.equal(rp.titleFrom({ kind: "figure", linkTitle: "Figure 1 ‣ 2 Method ‣ Paper", linkText: "1" }), "Figure 1");
  assert.equal(rp.titleFrom({ kind: "other" }), "참조");
});

test("titleFrom: 꼬리표 없는 그림 (figure*, 캡션 없는 float) → 링크 title, 위치뿐인 title은 건너뛰고 링크 글자", () => {
  assert.equal(rp.titleFrom({ kind: "figure", tag: "", noun: "그림", linkTitle: "Figure 3 ‣ 4 Results ‣ P", linkText: "3" }), "Figure 3");
  assert.equal(rp.titleFrom({ kind: "figure", noun: "그림", linkTitle: "In 4 Results ‣ P", linkText: "3" }), "그림 3", "'In …' title은 위치뿐");
  assert.equal(rp.titleFrom({ kind: "figure", noun: "표", linkText: "2" }), "표 2");
  assert.equal(rp.titleFrom({ kind: "figure", noun: "그림", linkText: "2(a)" }), "그림 2(a)");
  assert.equal(rp.titleFrom({ kind: "figure", noun: "그림", linkText: "A.1" }), "그림 A.1");
  assert.equal(rp.titleFrom({ kind: "figure", noun: "알고리즘", linkText: "Algorithm 1" }), "Algorithm 1", "글자가 이미 이름이면 그대로");
  assert.equal(rp.titleFrom({ kind: "figure", linkText: "2" }), "2", "noun을 모르면 글자 그대로");
  assert.equal(rp.titleFrom({ kind: "figure", tag: "Figure 2: ", linkTitle: "Other ‣ x" }), "Figure 2", "꼬리표가 있으면 링크는 안 봄");
  assert.equal(rp.titleFrom({ kind: "equation", linkTitle: "In 2 Method ‣ P", linkText: "1" }), "수식", "수식은 링크를 안 봄");
  assert.equal(rp.titleFrom({ kind: "theorem", linkTitle: "Lemma 2 ‣ 3 Theory ‣ P" }), "Lemma 2");
});

test("답변 속 참조는 범위 밖 (§8.1): 그 함수를 내보내지 않음", () => {
  for (const name of ["findMentions", "tagKeys", "bibKeys"]) assert.equal(rp[name], undefined, name);
});
