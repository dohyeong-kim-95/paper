"use strict";
const { test, assert, load } = require("./_runner");
const G = load("static/features/glossary.js");
const { findTermMatches, firstPer, normTex, texTokens, symbolsIn, pickDef, searchEntries, groupUses, runAt, normTerm, isAcronym } = G;

const words = (text, ms) => ms.map(m => text.slice(m.start, m.end));

test("findTermMatches: 단어 전체만 ('kd-loss'의 kd는 아님), 약어는 대소문자 구분", () => {
  const text = "We use KD and kd-loss";
  const ms = findTermMatches(text, [{ t: "KD" }]);
  assert.equal(ms.length, 1);
  assert.deepEqual(words(text, ms), ["KD"]);
  assert.deepEqual(findTermMatches("KDE and xKD and KD.", [{ t: "KD" }]).map(m => m.start), [16]);
});

test("findTermMatches: 일반 용어는 대소문자 무시, 복수형, 띄어쓰기·하이픈 변형", () => {
  const text = "Knowledge distillation helps. The expert-level router uses experts and load-balancing losses.";
  const terms = [{ t: "knowledge distillation" }, { t: "expert" }, { t: "load balancing loss" }];
  const ms = findTermMatches(text, terms);
  assert.deepEqual(words(text, ms), ["Knowledge distillation", "experts", "load-balancing losses"]);
  assert.deepEqual(ms.map(m => m.i), [0, 1, 2]);
});

test("findTermMatches: 약어(a)도 같은 용어 번호, 겹치면 긴 것", () => {
  const text = "A mixture of experts (MoE) layer; each expert in the MoE is small.";
  const terms = [{ t: "expert" }, { t: "mixture of experts", a: ["MoE"] }];
  const ms = findTermMatches(text, terms);
  assert.deepEqual(words(text, ms), ["mixture of experts", "MoE", "expert", "MoE"]);
  assert.deepEqual(ms.map(m => m.i), [1, 1, 0, 1]);
});

test("findTermMatches: 정규식 특수문자·한 글자 용어", () => {
  const text = "We report F1 (macro) and C++ speed; a k-NN baseline.";
  assert.deepEqual(words(text, findTermMatches(text, [{ t: "F1 (macro)" }, { t: "C++" }, { t: "k-NN" }, { t: "a" }])), ["F1 (macro)", "C++", "k-NN"]);
});

test("isAcronym / normTerm", () => {
  assert.equal(isAcronym("KD"), true);
  assert.equal(isAcronym("LLaMA"), true);
  assert.equal(isAcronym("Transformer"), false);
  assert.equal(isAcronym("Large LM"), false);
  assert.equal(normTerm("  Load-Balancing\tLoss "), "load balancing loss");
});

test("firstPer: 섹션마다 용어별 첫 출현만", () => {
  const ms = [{ i: 0, s: "a" }, { i: 1, s: "a" }, { i: 0, s: "a" }, { i: 0, s: "b" }, { i: 1, s: "b" }, { i: 1, s: "b" }];
  assert.deepEqual(firstPer(ms, m => m.s).map(m => `${m.s}${m.i}`), ["a0", "a1", "b0", "b1"]);
});

test("normTex: 공백·중괄호·\\displaystyle 차이는 같은 기호", () => {
  assert.equal(normTex("\\theta _i"), normTex("\\theta_i"));
  assert.equal(normTex("x_{i}^{t}"), normTex("x_i^t"));
  assert.equal(normTex("\\displaystyle\\mathcal{L}"), normTex("\\mathcal L"));
  assert.equal(normTex("$W_{g}$"), normTex("W_g"));
  assert.equal(normTex("\\mathcal{L}_{\\text{bal}}"), normTex("\\mathcal{L}_\\mathrm{bal}"));
  assert.notEqual(normTex("\\mathcal{L}"), normTex("L"));
  assert.notEqual(normTex("\\alpha x"), normTex("\\alphax"));
  assert.deepEqual(texTokens("\\mathrm{soft max}(W_{g}x)"), ["\\text{softmax}", "(", "W", "_", "g", "x", ")"]);
});

test("symbolsIn: 토큰 단위로만 (\\max 안의 x, softmax 안의 x, \\mathcal{L} 안의 L은 아님), 구체적인 기호 먼저", () => {
  const symbols = [{ tex: "x" }, { tex: "L" }, { tex: "\\alpha" }, { tex: "x_{i}" }, { tex: "\\mathcal{L}" }, { tex: "W_g" }];
  assert.deepEqual(symbolsIn("\\max_{i} y", symbols), []);
  assert.deepEqual(symbolsIn("g(x)=\\mathrm{softmax}(W_{g}x)", symbols), [5, 0]);
  assert.deepEqual(symbolsIn("\\displaystyle=\\mathcal{L}_{\\text{task}}+\\alpha\\mathcal{L}_{\\text{bal}}", symbols), [4, 2]);
  assert.deepEqual(symbolsIn("x_{i}^{t}+x", symbols), [3, 0]);
  assert.deepEqual(symbolsIn("\\alphabet", symbols), []);
});

test("pickDef: 탭한 곳 앞의 가장 가까운 정의, 없으면 가장 이른 정의, 위치 없으면 첫 정의", () => {
  const defs = [{ at: 500 }, { at: 100 }, { at: null }, { at: 900 }];
  assert.equal(pickDef(defs, 600), 0);
  assert.equal(pickDef(defs, 100), 1);
  assert.equal(pickDef(defs, 950), 3);
  assert.equal(pickDef(defs, 50), 1);
  assert.equal(pickDef(defs, null), 0);
  assert.equal(pickDef([{ at: null }, { at: null }], 10), 0);
  assert.equal(pickDef([], 10), -1);
});

test("searchEntries: 영어·약어·한국어·정의 어디든, 빈 질의는 전부", () => {
  const list = [{ t: "Knowledge distillation", a: ["KD"], ko: "지식 증류", d: "작은 모델로 옮김" }, { t: "router", a: [], ko: "라우터", d: "토큰 배정" }];
  const f = t => [t.t, ...t.a, t.ko, t.d];
  assert.deepEqual(searchEntries(list, "", f), [0, 1]);
  assert.deepEqual(searchEntries(list, "kd", f), [0]);
  assert.deepEqual(searchEntries(list, "증류", f), [0]);
  assert.deepEqual(searchEntries(list, " ROUTER ", f), [1]);
  assert.deepEqual(searchEntries(list, "없는말", f), []);
});

test("groupUses: 섹션 순서대로 개수와 첫 출현", () => {
  const g = groupUses([{ s: "S1", n: 1 }, { s: "S1", n: 2 }, { s: "S2", n: 3 }, { s: "S1", n: 4 }], x => x.s);
  assert.deepEqual(g.map(x => [x.key, x.n, x.first.n]), [["S1", 3, 1], ["S2", 1, 3]]);
});

test("runAt: 구간을 통째로 담은 run만", () => {
  const runs = [{ start: 0, end: 10 }, { start: 15, end: 30 }];
  assert.equal(runAt(runs, 2, 8), runs[0]);
  assert.equal(runAt(runs, 8, 12), null);
  assert.equal(runAt(runs, 12, 14), null);
  assert.equal(runAt(runs, 15, 30), runs[1]);
  assert.equal(runAt([], 0, 1), null);
});
