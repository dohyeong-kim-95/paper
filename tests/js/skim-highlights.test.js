// skim-highlights 순수 함수: JSONL 파싱(스트림 조각), 밀도·역할 필터, 개수, 섹션 묶기, 설정 기본값
"use strict";
const { test, assert, load } = require("./_runner");
const sk = load("static/features/skim-highlights.js");

const Q = "We propose a sparse mixture of experts model";
const line = o => JSON.stringify(o);

test("cleanItem: 역할·인용·중요도 검증", () => {
  assert.deepEqual(sk.cleanItem({ f: "Limitations", q: `  ${Q}\n…`, s: 9 }), { f: "limit", q: Q, s: 3 });
  assert.deepEqual(sk.cleanItem({ facet: "goal", quote: Q, s: "x" }), { f: "goal", q: Q, s: 2 });
  assert.equal(sk.cleanItem({ f: "bogus", q: Q }), null);
  assert.equal(sk.cleanItem({ f: "constructor", q: Q }), null, "프로토타입 이름은 역할이 아님");
  assert.equal(sk.cleanItem({ f: "goal", q: "two words" }), null);
  assert.equal(sk.cleanItem({ f: "goal", q: ["a", "b", "c"] }), null);
  assert.equal(sk.cleanItem(null), null);
});

test("parseLine: 펜스·쉼표·통째 items·여러 객체·깨진 줄", () => {
  assert.equal(sk.parseLine("```jsonl").length, 0);
  assert.equal(sk.parseLine(`[${line({ f: "goal", q: Q, s: 3 })},`).length, 1);
  assert.equal(sk.parseLine(line({ items: [{ f: "goal", q: Q }, { f: "bogus", q: Q }] })).length, 1);
  assert.equal(sk.parseLine(`${line({ f: "goal", q: Q })}, ${line({ f: "result", q: Q })}`).length, 2);
  assert.deepEqual(sk.parseLine('{"f": "goal", "q": "We propose'), []);
  assert.deepEqual(sk.parseLine("[오류] boom"), []);
});

test("makeParser: 조각난 줄을 이어 붙이고 같은 인용은 한 번, 오류 꼬리 인식", () => {
  const p = sk.makeParser();
  const a = line({ f: "goal", q: Q, s: 3 }), b = line({ f: "result", q: "accuracy improves by two points", s: 2 });
  assert.deepEqual(p.push(a.slice(0, 10)), []);
  assert.deepEqual(p.push(a.slice(10) + "\n" + b.slice(0, 5)), [{ f: "goal", q: Q, s: 3 }]);
  assert.deepEqual(p.push(b.slice(5) + "\n" + line({ f: "goal", q: Q.toUpperCase(), s: 1 }) + "\n"), [
    { f: "result", q: "accuracy improves by two points", s: 2 },
  ]);
  const end = p.end(line({ f: "limit", q: "memory cost is the main limitation" }));
  assert.deepEqual(end, { items: [{ f: "limit", q: "memory cost is the main limitation", s: 2 }], error: null });

  const p2 = sk.makeParser();
  assert.equal(p2.push(a + "\n").length, 1);
  assert.deepEqual(p2.end("\n\n[오류] 응답이 너무 길어 잘렸습니다 (max_tokens)."),
    { items: [], error: "[오류] 응답이 너무 길어 잘렸습니다 (max_tokens)." });
});

test("makeParser: 최대 30개", () => {
  const p = sk.makeParser();
  const text = Array.from({ length: 40 }, (_, i) => line({ f: "method", q: `method sentence number ${i}`, s: 2 })).join("\n") + "\n";
  assert.equal(p.push(text).length, sk.MAX_ITEMS);
});

const items = [
  { f: "goal", q: "g3", s: 3, start: 10 }, { f: "goal", q: "g1", s: 1, start: 50 },
  { f: "method", q: "m2", s: 2, start: 30 }, { f: "result", q: "r3", s: 3, start: 70 },
  { f: "limit", q: "l1", s: 1, start: 90 },
];
const qs = list => list.map(it => it.q);

test("filterByDensity: 역할 토글(맵·배열)과 최소 중요도", () => {
  assert.deepEqual(qs(sk.filterByDensity(items, {})), ["g3", "g1", "m2", "r3", "l1"]);
  assert.deepEqual(qs(sk.filterByDensity(items, { minScore: 2 })), ["g3", "m2", "r3"]);
  assert.deepEqual(qs(sk.filterByDensity(items, { minScore: 3 })), ["g3", "r3"]);
  assert.deepEqual(qs(sk.filterByDensity(items, { facets: { goal: false, limit: true }, minScore: 1 })), ["m2", "r3", "l1"]);
  assert.deepEqual(qs(sk.filterByDensity(items, { facets: ["goal", "limit"], minScore: 1 })), ["g3", "g1", "l1"]);
  assert.deepEqual(qs(sk.filterByDensity(items, { facets: { result: false }, minScore: 3 })), ["g3"]);
  assert.deepEqual(sk.filterByDensity(null, {}), []);
});

test("countByFacet: 모든 역할 0으로 시작", () => {
  assert.deepEqual(sk.countByFacet(items), { goal: 2, novelty: 0, method: 1, result: 1, limit: 1 });
  assert.deepEqual(sk.countByFacet([]), { goal: 0, novelty: 0, method: 0, result: 0, limit: 0 });
});

test("groupBySection: 본문 순서로 이어지는 섹션끼리, 위치 없는 항목 제외", () => {
  const g = sk.groupBySection([
    { q: "b", start: 40, secId: "S2", sec: "2 Method" }, { q: "a", start: 5, secId: "", sec: "초록" },
    { q: "c", start: 45, secId: "S2", sec: "2 Method" }, { q: "x", start: null, secId: "S1" },
    { q: "d", start: 80, secId: "A1", sec: "Appendix A" },
  ]);
  assert.deepEqual(g.map(x => [x.title, qs(x.items)]), [["초록", ["a"]], ["2 Method", ["b", "c"]], ["Appendix A", ["d"]]]);
});

test("normSettings: 기본은 꺼짐·모든 역할·중요도 1, 잘못된 값 보정", () => {
  const all = { goal: true, novelty: true, method: true, result: true, limit: true };
  assert.deepEqual(sk.normSettings(null), { on: false, facets: all, minScore: 1 });
  assert.deepEqual(sk.normSettings({ on: true, facets: { limit: false }, minScore: 3 }),
    { on: true, facets: { ...all, limit: false }, minScore: 3 });
  assert.equal(sk.normSettings({ minScore: 9 }).minScore, 1);
  assert.equal(sk.normSettings({ on: "yes" }).on, false);
});

test("densityLabel, nextAfter, 역할별 설명 질문", () => {
  assert.equal(sk.densityLabel(1), "많이 · ★1 이상");
  assert.equal(sk.densityLabel(3), "적게 · ★3 이상");
  assert.equal(sk.nextAfter(items, 30).q, "g1");
  assert.equal(sk.nextAfter(items, 90), null);
  for (const f of sk.FACETS) assert.ok(sk.EXPLAIN[f.id], f.id);
});
