// ref-peek 순수 함수: 참조 종류 판별, 꼬리표·인용 열쇠, 답변 속 참조 찾기, 문장 경계, 제목
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

test("tagKeys: 대상 꼬리표 → 열쇠", () => {
  assert.deepEqual(rp.tagKeys("figure", "Figure 1: "), ["fig:1"]);
  assert.deepEqual(rp.tagKeys("table", "Table 1: "), ["tab:1"]);
  assert.deepEqual(rp.tagKeys("float", "Algorithm 1 "), ["alg:1"]);
  assert.deepEqual(rp.tagKeys("theorem", "Theorem 1"), ["theorem:1"]);
  assert.deepEqual(rp.tagKeys("theorem", "Lemma 2.1"), ["lemma:2.1"]);
  assert.deepEqual(rp.tagKeys("equation", "(1)"), ["eq:1"]);
  assert.deepEqual(rp.tagKeys("equation", "(A.1)"), ["eq:a.1"]);
  assert.deepEqual(rp.tagKeys("section", "2.1 "), ["sec:2.1"]);
  assert.deepEqual(rp.tagKeys("section", "Appendix A "), ["sec:a"]);
  assert.deepEqual(rp.tagKeys("section", "A.1"), ["sec:a.1"]);
  assert.deepEqual(rp.tagKeys("bibitem", "[12]"), ["bib:12"]);
  assert.deepEqual(rp.tagKeys("figure", ""), []);
});

test("bibKeys: 번호·저자-연도, 연도만 있는 링크 글자는 버림", () => {
  assert.deepEqual(rp.bibKeys("[3]"), ["bib:3"]);
  assert.deepEqual(rp.bibKeys("Shazeer et al. (2017)"), ["cite:shazeer:2017", "cite:shazeer"]);
  assert.deepEqual(rp.bibKeys("Shazeer et al., 2017", false), ["cite:shazeer:2017", "cite:shazeer"]);
  assert.deepEqual(rp.bibKeys("van der Berg and Smith (2020)"), ["cite:berg:2020", "cite:berg"]);
  assert.deepEqual(rp.bibKeys("Ünal et al."), ["cite:unal"]);
  assert.deepEqual(rp.bibKeys("2017", false), []);
  assert.deepEqual(rp.bibKeys("1", false), []);
});

const keysOf = text => rp.findMentions(text).map(m => [text.slice(m.start, m.end), m.keys[0]]);

test("findMentions: 영어 참조", () => {
  assert.deepEqual(keysOf("See Figure 3 and Fig. 2(a), Table 2, Eq. (5), Section 4.2, Appendix A, Theorem 1, Algorithm 1."), [
    ["Figure 3", "fig:3"], ["Fig. 2(a)", "fig:2a"], ["Table 2", "tab:2"], ["Eq. (5)", "eq:5"],
    ["Section 4.2", "sec:4.2"], ["Appendix A", "sec:a"], ["Theorem 1", "theorem:1"], ["Algorithm 1", "alg:1"],
  ]);
  const sub = rp.findMentions("Fig. 2b");
  assert.deepEqual(sub[0].keys, ["fig:2b", "fig:2"], "하위 그림이 없으면 그림으로");
});

test("findMentions: 한국어 참조 (낱말 속 '표'·'식'은 아님)", () => {
  assert.deepEqual(keysOf("그림 3과 표 2, 식 (5)를 보면 4.2절과 §3, 부록 A, 정리 1, 보조정리 2, 알고리즘 1"), [
    ["그림 3", "fig:3"], ["표 2", "tab:2"], ["식 (5)", "eq:5"], ["4.2절", "sec:4.2"], ["§3", "sec:3"],
    ["부록 A", "sec:a"], ["정리 1", "theorem:1"], ["보조정리 2", "lemma:2"], ["알고리즘 1", "alg:1"],
  ]);
  assert.deepEqual(keysOf("(1)식에서"), [["(1)식", "eq:1"]]);
  assert.deepEqual(keysOf("이 방식 (2)와 발표 3, 대표 4"), [], "방식·발표·대표 속 글자");
});

test("findMentions: 인용 [n]·저자 et al.", () => {
  assert.deepEqual(keysOf("as in [1, 2] and [12]"), [["1", "bib:1"], ["2", "bib:2"], ["12", "bib:12"]]);
  assert.deepEqual(keysOf("range [0, 1] or [a]"), [], "0이 있으면 구간");
  const m = rp.findMentions("Shazeer et al. (2017) and Fedus 등은");
  assert.deepEqual(m.map(x => x.keys), [["cite:shazeer:2017", "cite:shazeer"], ["cite:fedus"]]);
  assert.deepEqual(rp.findMentions("OpenAI (2023)")[0].keys, ["cite:openai:2023"]);
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
