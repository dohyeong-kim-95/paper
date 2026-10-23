// figure-explain 순수 함수
"use strict";
const { test, assert, load } = require("./_runner");
const fe = load("static/features/figure-explain.js");

const BASE = "https://arxiv.org/html/2401.00001v1/";

test("figureKind: 알고리즘·표·코드·그림", () => {
  assert.equal(fe.figureKind("ltx_float ltx_float_algorithm ltx_framed_top", true), "algorithm");
  assert.equal(fe.figureKind("ltx_table"), "table");
  assert.equal(fe.figureKind("ltx_float ltx_float_lstlisting"), "listing");
  assert.equal(fe.figureKind("ltx_figure", true), "listing");
  assert.equal(fe.figureKind("ltx_figure"), "figure");
  assert.equal(fe.figureKind(null), "figure");
});

test("presetsFor: 첫 프리셋(자동 질문)과 비전 프리셋은 이미지가 있을 때만", () => {
  const fig = fe.presetsFor("figure", { hasImage: true });
  assert.equal(fig[0].label, "이 그림이 보여주는 것");
  assert.match(fig[0].q, /무엇을 보여주는지 → 핵심 메시지 → 주의할 점·한계 → 확장 아이디어/);
  assert.deepEqual(fig.map(p => p.label), ["이 그림이 보여주는 것", "축·범례 읽는 법", "그림 속 글자 번역"]);
  assert.ok(fig.every(p => p.id.startsWith("figure-explain:") && p.q));
  assert.ok(!fe.presetsFor("figure").some(p => p.label === "그림 속 글자 번역"));
  const table = fe.presetsFor("table").map(p => p.label);
  assert.equal(table[0], "이 표가 보여주는 것");
  assert.ok(table.includes("표 수치 해석"));
  assert.ok(!table.includes("그림 속 글자 번역"));
  assert.ok(fe.presetsFor("table", { hasImage: true }).some(p => p.label === "그림 속 글자 번역")); // 이미지로 된 표
  const alg = fe.presetsFor("algorithm", { hasImage: true }).map(p => p.label);
  assert.equal(alg[0], "알고리즘 한 줄씩 풀이");
  assert.ok(!alg.includes("그림 속 글자 번역"));
  assert.equal(fe.presetsFor("listing")[0].label, "코드 한 줄씩 풀이");
  const panel = fe.presetsFor("figure", { hasImage: true, panel: "(b)" });
  assert.equal(panel[0].label, "(b) 패널이 보여주는 것");
  assert.match(panel[0].q, /^\(b\) 패널만 보고/);
});

test("isFetchable: http(s) 그림만, svg는 서버가 못 쓰므로 제외", () => {
  assert.ok(fe.isFetchable(BASE + "x1.png"));
  assert.ok(fe.isFetchable(BASE + "x1.png?w=1&h=2"));
  assert.ok(!fe.isFetchable(BASE + "x3.svg"));
  assert.ok(!fe.isFetchable(BASE + "x3.SVG?v=1"));
  assert.ok(!fe.isFetchable("data:image/png;base64,AAAA"));
  assert.ok(!fe.isFetchable(""));
});

test("pickPanels: 큰 것부터 4개, 문서 순서 유지, 못 보낸 수", () => {
  const imgs = [1, 9, 3, 7, 5, 8].map((a, i) => ({ src: `${BASE}p${i}.png`, area: a }));
  const r = fe.pickPanels(imgs);
  assert.deepEqual(r.urls, [1, 3, 4, 5].map(i => `${BASE}p${i}.png`));
  assert.equal(r.skipped, 2);
  const two = fe.pickPanels([{ src: BASE + "a.png", area: 0 }, { src: BASE + "b.svg", area: 9 }]);
  assert.deepEqual(two, { urls: [BASE + "a.png"], skipped: 1 });
  assert.deepEqual(fe.pickPanels([]), { urls: [], skipped: 0 });
  assert.equal(fe.pickPanels(imgs, 2).urls.length, 2);
});

test("tableText: 열은 ' | ', 빈 줄 제외", () => {
  const t = fe.tableText([["Model", "MMLU", "GSM8K"], ["", " ", ""], ["Dense", "61.2", " 40.1 "]]);
  assert.equal(t, "Model | MMLU | GSM8K\nDense | 61.2 | 40.1");
  assert.equal(fe.tableText([]), "");
});

test("panelLabel: 캡션 태그 또는 순서 글자", () => {
  assert.equal(fe.panelLabel("(a)", 5), "(a)");
  assert.equal(fe.panelLabel("(iii) ", 0), "(iii)");
  assert.equal(fe.panelLabel("", 1), "(b)");
  assert.equal(fe.panelLabel(null, 0), "(a)");
  assert.equal(fe.panelLabel("", -1), "(패널)");
});

test("buildContext: 메모 → 그림 본문 → 언급 문단, 2500자 이하", () => {
  const ctx = fe.buildContext({
    note: "[첨부: 원본 이미지 1장]", label: "표 내용", content: "Model | MMLU\nDense | 61.2",
    refs: [{ text: "Table 1 shows that the sparse model improves accuracy.", needle: "1" }],
  });
  assert.equal(ctx, "[첨부: 원본 이미지 1장]\n\n[표 내용]\nModel | MMLU\nDense | 61.2\n\n[이 그림을 언급한 본문]\n- Table 1 shows that the sparse model improves accuracy.");
  assert.equal(fe.buildContext({}), "");
  // 긴 입력: 상한을 지키고 언급 부분이 남음
  const long = "x".repeat(5000);
  const para = "y".repeat(3000) + " Figure 3 shows the key result. " + "z".repeat(3000);
  const big = fe.buildContext({ note: "n", content: long, refs: [{ text: para, needle: "Figure 3" }, { text: para, needle: "Figure 3" }, { text: para }, { text: para }] });
  assert.ok(big.length <= 2500, big.length);
  assert.ok(big.includes("Figure 3 shows the key result."));
  assert.equal((big.match(/^- /gm) || []).length, 3); // 문단은 최대 3개
  assert.ok(fe.buildContext({ content: long }).length <= 2500);
});

test("around: 언급 위치 둘레를 자름", () => {
  const s = "a".repeat(100) + "NEEDLE" + "b".repeat(100);
  const r = fe.around(s, "NEEDLE", 40);
  assert.ok(r.includes("NEEDLE"));
  assert.ok(r.startsWith("…") && r.endsWith("…"));
  assert.equal(fe.around("short", "x", 40), "short");
});

test("fitScale: 긴 변 1000 이하, 작은 그림은 최대 4배", () => {
  assert.equal(fe.fitScale(80, 40), 4);
  assert.equal(fe.fitScale(2000, 500), 0.5);
  assert.equal(fe.fitScale(500, 250), 2);
  assert.ok(fe.fitScale(0, 0) <= 4);
});
