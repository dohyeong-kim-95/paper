"use strict";
const { test, assert, load } = require("./_runner");
const { quoteOf, parseQuoteLines, prepare, streamView, gistOf, sectionsOf, toMarkdown, codeLinks, metaChips } =
  load("static/features/overview.js");

const SAMPLE = `## 3줄 요약
- **희소 MoE**로 토큰마다 전문가 2개만 씁니다.
- 라우터가 게이트 점수로 고릅니다.
- 밀집 모델과 같은 성능을 냅니다.

## 핵심 질문
### 무엇을 풀려고 하나?
밀집 모델의 계산량 문제.
→ "dense computation grows as $x^{2}$ for a model of width"
### 핵심 아이디어는?
상위 두 전문가로 보냅니다.
→ "We propose a sparse mixture of experts model that routes each token to two experts."
[[fig:S2.F1]]
### 한계와 남은 문제는?
메모리.
→ "this sentence is not in the paper at all"

## 스냅샷
| 항목 | 내용 |
|---|---|
| 코드 | https://github.com/example/sparse-moe |`;

test("parseQuoteLines: '→ \"…\"' 줄에서 인용만 뽑음", () => {
  const qs = parseQuoteLines(SAMPLE);
  assert.deepEqual(qs.map(x => x.quote), [
    "dense computation grows as $x^{2}$ for a model of width",
    "We propose a sparse mixture of experts model that routes each token to two experts.",
    "this sentence is not in the paper at all",
  ]);
  assert.equal(SAMPLE.split("\n")[qs[0].line].startsWith("→"), true);
});

test("quoteOf: 목록 기호·강조·굽은 따옴표·->·닫는 따옴표 뒤 마침표", () => {
  assert.equal(quoteOf('- → “Each token is routed to two experts”.'), "Each token is routed to two experts");
  assert.equal(quoteOf('-> *"router is trained jointly"*'), "router is trained jointly");
  assert.equal(quoteOf("> → 'single quoted text here'"), "single quoted text here");
  assert.equal(quoteOf("결과 → 정확도 향상"), null);
  assert.equal(quoteOf('→ ""'), null);
  assert.equal(quoteOf(undefined), null);
});

test("prepare: 찾은 인용은 자리표시, 못 찾은 인용 줄은 삭제, 그림 토큰은 따로 떨어진 문단", () => {
  const { md, quotes, figs } = prepare(SAMPLE, q => !q.startsWith("this sentence"));
  assert.equal(quotes.length, 2);
  assert.deepEqual(figs, ["S2.F1"]);
  assert.match(md, /밀집 모델의 계산량 문제\.\n%%OVQ0%%\n/);
  assert.match(md, /%%OVQ1%%\n\n%%OVF0%%\n\n### 한계/);
  assert.doesNotMatch(md, /not in the paper/);
  assert.doesNotMatch(md, /→|\[\[fig:/);
  assert.match(md, /메모리\.\n\n## 스냅샷/);
});

test("prepare: [오류] 꼬리는 버림", () => {
  assert.equal(prepare("본문\n\n[오류] boom").md, "본문");
});

test("streamView: 완성·작성 중인 그림 토큰을 숨김", () => {
  assert.equal(streamView("a\n[[fig:S2.F1]]\nb"), "a\n\nb");
  assert.equal(streamView("a\n[[fig:S2"), "a\n");
  assert.equal(streamView("링크 [x](y)"), "링크 [x](y)");
});

test("gistOf: 3줄 요약 첫 줄 (강조 제거), 스트리밍 중엔 끝난 줄만", () => {
  assert.equal(gistOf(SAMPLE), "희소 MoE로 토큰마다 전문가 2개만 씁니다.");
  assert.equal(gistOf("## 3줄 요약\n- 쓰는 중", false), "");
  assert.equal(gistOf("## 3줄 요약\n- 끝난 줄\n- 다음", false), "끝난 줄");
  assert.equal(gistOf("## 핵심 질문\n- x"), "");
  assert.equal(gistOf("## 3줄 요약\n\n## 핵심 질문\n- x"), "");
});

test("sectionsOf: ### 질문마다 본문 (인용·그림 줄 제외)", () => {
  const s = sectionsOf(SAMPLE);
  assert.deepEqual(s.map(x => x.heading), ["무엇을 풀려고 하나?", "핵심 아이디어는?", "한계와 남은 문제는?"]);
  assert.equal(s[0].body, "밀집 모델의 계산량 문제.");
  assert.equal(s[1].body, "상위 두 전문가로 보냅니다.");
  assert.equal(s[2].body, "메모리.");
});

test("toMarkdown: 제목·주소·본문·방법론, 그림 토큰·오류 꼬리 제거", () => {
  const md = toMarkdown({ title: "T", url: "https://arxiv.org/abs/1", text: "a\n[[fig:S1.F1]]\nb", method: "m\n\n[오류] x" });
  assert.equal(md, "# T\n\nhttps://arxiv.org/abs/1\n\na\n\nb\n\n## 방법론 자세히\n\nm\n");
  assert.equal(toMarkdown({ text: "x" }), "x\n");
});

test("codeLinks: github/gitlab 저장소만, 정규화·중복 제거", () => {
  assert.deepEqual(codeLinks([
    "https://github.com/example/sparse-moe",
    "https://github.com/example/sparse-moe/tree/main/src",
    "http://www.GitHub.com/Example/sparse-moe.git",
    "https://gitlab.com/group/proj",
    "https://github.com/onlyowner",
    "https://example.com/github.com/a/b",
    "#S2",
  ]), ["https://github.com/example/sparse-moe", "https://gitlab.com/group/proj"]);
});

test("metaChips: 버전·제출/수정일·분야·DOI, 옛 버전을 열었으면 최신 알림", () => {
  const meta = { version: "v3", published: "2024-01-02T12:00:00Z", updated: "2024-03-05T00:00:00Z",
    primary_category: "cs.CL", categories: ["cs.CL", "cs.LG"], doi: "10.1/x", abs_url: "https://arxiv.org/abs/2401.00001" };
  const chips = metaChips(meta, "2401.00001v1");
  assert.deepEqual(chips.map(c => c.label), ["v1 · 최신 v3", "2024-01-02 제출 · 2024-03-05 수정", "cs.CL", "DOI"]);
  assert.equal(chips[0].href, "https://arxiv.org/abs/2401.00001");
  assert.equal(chips[3].href, "https://doi.org/10.1/x");
  assert.equal(metaChips({ ...meta, updated: meta.published, doi: null }, "2401.00001")
    .map(c => c.label).join("|"), "v3|2024-01-02 제출|cs.CL");
  assert.deepEqual(metaChips({ ...meta, doi: null, comment: "12 pages, 4 figures. Accepted at ICLR 2025; code soon" })
    .map(c => c.label).slice(3), ["Accepted at ICLR 2025"]);
  assert.equal(metaChips({ ...meta, doi: null, comment: "12 pages, 4 figures" }).length, 3);
  assert.deepEqual(metaChips(null), []);
  assert.deepEqual(metaChips({ id: "x" }), []);
});
