"use strict";
const { test, assert, load } = require("./_runner");
const T = load("static/features/toc-progress.js");

const ids = nodes => nodes.map(n => (n.children.length ? [n.id, ids(n.children)] : n.id));

test("buildToc: h3는 앞의 h2 아래로, 다음 h2에서 다시 위로 (숫자·'h2' 둘 다)", () => {
  const tree = T.buildToc([
    { id: "abstract", level: 2, title: "Abstract" },
    { id: "S1", level: "h2", title: "1 Introduction" },
    { id: "S2", level: 2, title: "2 Method" },
    { id: "S2.SS1", level: "h3", title: "2.1 Objective" },
    { id: "S2.SS2", level: 3, title: "2.2 Router" },
    { id: "A1", level: 2, title: "Appendix A" },
    { id: "bib", level: 2, title: "References" },
  ]);
  assert.deepEqual(ids(tree), ["abstract", "S1", ["S2", ["S2.SS1", "S2.SS2"]], "A1", "bib"]);
  assert.equal(tree[2].children[0].title, "2.1 Objective");
  assert.equal(tree[2].children[0].level, 3);
});

test("buildToc: 첫 항목이 h3여도, 단계를 건너뛰어도 잃지 않음", () => {
  assert.deepEqual(ids(T.buildToc([{ id: "a", level: 3 }, { id: "b", level: 2 }, { id: "c", level: 4 }, { id: "d", level: 3 }])),
    ["a", ["b", ["c", "d"]]]);
  assert.deepEqual(T.buildToc([]), []);
  assert.deepEqual(T.buildToc(null), []);
});

test("minutesLeft: 800단어 / 160wpm = 5분, 남은 게 있으면 최소 1분, 속도는 80~400으로", () => {
  assert.equal(T.minutesLeft(800, 160), 5);
  assert.equal(T.minutesLeft(10, 160), 1);
  assert.equal(T.minutesLeft(0, 160), 0);
  assert.equal(T.minutesLeft(-5, 160), 0);
  assert.equal(T.minutesLeft(800, 10000), 2); // 400으로
  assert.equal(T.minutesLeft(800), 5);        // 기본 160
  assert.equal(T.fmtMinutes(5), "약 5분");
  assert.equal(T.fmtMinutes(65), "약 1시간 5분");
  assert.equal(T.fmtMinutes(120), "약 2시간");
});

test("updateWpm: EMA, 표본은 80~400으로 자르고 터무니없는 표본은 버림, 결과도 80~400", () => {
  assert.equal(T.updateWpm(160, 200), 168);
  assert.equal(T.updateWpm(160, 1000), 208);   // 400으로 잘라 반영
  assert.equal(T.updateWpm(160, 50), 144);     // 80으로 잘라 반영
  assert.equal(T.updateWpm(160, 10000), 160);  // 넘겨 보기: 버림
  assert.equal(T.updateWpm(160, 5), 160);      // 멍하니: 버림
  assert.equal(T.updateWpm(160, NaN), 160);
  assert.equal(T.updateWpm(9999, 200), 360);   // 저장값이 깨져도 400에서 시작
  assert.equal(T.updateWpm(undefined, 160), 160);
  let w = 160;
  for (let i = 0; i < 100; i++) w = T.updateWpm(w, 399);
  assert.ok(w <= 400 && w >= 395);
});

test("meterStep: 활동 1분마다 표본, 90초 넘는 공백·점프는 새 구간", () => {
  let r = T.meterStep(null, 0, 1000);
  assert.equal(r.sample, null);
  r = T.meterStep(r.m, 30000, 1100);
  assert.equal(r.sample, null);
  r = T.meterStep(r.m, 60000, 1200);
  assert.equal(r.sample, 200);                 // 200단어 / 1분
  assert.deepEqual(r.m, { w0: 1200, lastT: 60000, lastW: 1200, active: 0 });
  // 90초 넘게 멈춤: 그 시간은 빼고 새로 시작
  r = T.meterStep(r.m, 60000 + 91000, 1300);
  assert.equal(r.sample, null);
  assert.equal(r.m.active, 0);
  assert.equal(r.m.w0, 1300);
  // 점프 (목차·검색): 새 구간
  r = T.meterStep({ w0: 0, lastT: 0, lastW: 0, active: 50000 }, 20000, 5000);
  assert.deepEqual([r.sample, r.m.w0, r.m.active], [null, 5000, 0]);
  // 뒤로만 갔으면 표본 없음
  r = T.meterStep({ w0: 500, lastT: 0, lastW: 400, active: 59000 }, 2000, 300);
  assert.equal(r.sample, null);
  assert.equal(r.m.active, 0);
});

test("sectionLeft / prefixSums / tickFrac / resumeY", () => {
  const cum = T.prefixSums([100, 200, 300]);
  assert.deepEqual(cum, [0, 100, 300, 600]);
  assert.equal(T.sectionLeft(cum, 1, 3, 0), 500);     // 아직 안 들어감 → 섹션 전체
  assert.equal(T.sectionLeft(cum, 1, 3, 350), 250);
  assert.equal(T.sectionLeft(cum, 1, 3, 700), 0);
  assert.equal(T.sectionLeft(cum, 2, 2, 0), 0);       // 문단 없는 섹션 (참고문헌)
  assert.equal(T.tickFrac(1400, 400, 2000), 0.5);
  assert.equal(T.tickFrac(100, 400, 2000), 0);
  assert.equal(T.tickFrac(9999, 400, 2000), 1);
  assert.equal(T.resumeY(1000, 200, 0.5, 60), 1040);
  assert.equal(T.resumeY(1000, 400, 0.5, 60), 1140);  // 글자가 커져 문단이 길어져도 같은 비율
  assert.equal(T.resumeY(10, 100, 0, 60), 0);
  assert.equal(T.resumeY(1000, 200, 5, 0), 1000 + 0.999 * 200);
});

test("shouldOfferResume: 3% 넘고 주소에 #…가 없을 때만", () => {
  assert.equal(T.shouldOfferResume({ pct: 37, paraId: "S2.p1" }, ""), true);
  assert.equal(T.shouldOfferResume({ pct: 3 }, ""), false);
  assert.equal(T.shouldOfferResume({ pct: 50 }, "#q=hello"), false);
  assert.equal(T.shouldOfferResume({ pct: 50 }, "#S2"), false);
  assert.equal(T.shouldOfferResume({ pct: 50 }, "#"), true);
  assert.equal(T.shouldOfferResume(null, ""), false);
  assert.equal(T.shouldOfferResume("x", ""), false);
});

test("mergePos: 더 최근 ts가 이김, 한쪽이 없으면 다른 쪽", () => {
  const a = { paraId: "S1.p1", ratio: 0, pct: 10, ts: 5 }, b = { paraId: "S2.p1", ratio: 0.5, pct: 40, ts: 9 };
  assert.equal(T.mergePos(a, b), b);
  assert.equal(T.mergePos(b, a), b);
  assert.equal(T.mergePos(null, a), a);
  assert.equal(T.mergePos(a, undefined), a);
  assert.equal(T.mergePos(a, { ...a, ts: 5, pct: 99 }), a); // 같으면 로컬
});

test("firstSentence / figLabel", () => {
  assert.equal(T.firstSentence("라우터가 토큰을 두 전문가로 보낸다. 성능은 같다."), "라우터가 토큰을 두 전문가로 보낸다.");
  assert.equal(T.firstSentence("Accuracy improves by 2.3 points. Next."), "Accuracy improves by 2.3 points.");
  assert.equal(T.firstSentence("마침표 없는 요약"), "마침표 없는 요약");
  assert.equal(T.firstSentence("가".repeat(200), 10), "가".repeat(9) + "…");
  assert.equal(T.firstSentence(null), "");
  assert.equal(T.figLabel("Figure 1: ", "Figure 1: Architecture of the layer."), "Figure 1 · Architecture of the layer.");
  assert.equal(T.figLabel("Table 1:", "Results."), "Table 1 · Results.");
  assert.equal(T.figLabel("", "Only caption"), "Only caption");
  assert.equal(T.figLabel("Algorithm 1", ""), "Algorithm 1");
  assert.ok(T.figLabel("Figure 2:", "x".repeat(100), 20).endsWith("…"));
});

test("buildMap: 목차 트리 + 요약 첫 문장 + 섹션별 그림, 하위 섹션 유지", () => {
  const tree = T.buildToc([
    { id: "S1", level: 2, title: "1 Intro" }, { id: "S2", level: 2, title: "2 Method" }, { id: "S2.SS1", level: 3, title: "2.1 Obj" },
  ]);
  const map = T.buildMap(tree, { S1: "도입이다. 둘째 문장.", "S2.SS1": { gist: "목표 함수다." }, X: "모르는 id" }, [
    { id: "S2.F1", sec: "S2", label: "Figure 1 · Arch", kind: "figure" },
    { id: "S2.T1", sec: "S2", label: "Table 1 · Res", kind: "table" },
  ]);
  assert.deepEqual(map.map(n => [n.id, n.gist, n.figs.map(f => f.id)]), [["S1", "도입이다.", []], ["S2", "", ["S2.F1", "S2.T1"]]]);
  assert.deepEqual(map[1].children.map(n => [n.id, n.gist, n.title]), [["S2.SS1", "목표 함수다.", "2.1 Obj"]]);
  assert.equal(T.buildMap(tree, null, null)[0].gist, "");
});

test("wordCount: 공백 기준 (수식 $…$는 한 덩어리)", () => {
  assert.equal(T.wordCount("We minimize $\\mathcal{L}$ with AdamW."), 5);
  assert.equal(T.wordCount("  "), 0);
  assert.equal(T.wordCount(null), 0);
  assert.equal(T.levelNum("h3"), 3);
  assert.equal(T.levelNum("x"), 2);
});
