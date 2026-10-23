"use strict";
const { test, assert, load } = require("./_runner");
const { makeStore, memoryStorage, mergeDefault, baseIdOf } = load("static/store.js");

const fresh = (baseId = "2401.04088v2") => makeStore(memoryStorage(), () => baseId);

test("get/set/del: JSON, 'pr:' 접두사, 기본값", () => {
  const s = fresh();
  assert.equal(s.get("x", 7), 7);
  assert.equal(s.set("x", { a: 1 }), true);
  assert.deepEqual(s.get("x"), { a: 1 });
  assert.deepEqual(s.get("pr:x"), { a: 1 }, "전체 키로도 같은 값");
  s.del("x");
  assert.equal(s.get("x", null), null);
});

test("깨진 JSON은 기본값", () => {
  const mem = memoryStorage();
  mem.setItem("pr:bad", "{nope");
  assert.equal(makeStore(mem).get("bad", "fb"), "fb");
});

test("논문별 키: pr:<ns>:<버전 뗀 id>", () => {
  const s = fresh("2401.04088v2");
  assert.equal(baseIdOf("2401.04088v12"), "2401.04088");
  assert.equal(s.paperKey("toc-progress:pos"), "pr:toc-progress:pos:2401.04088");
  s.setPaper("highlights-notes", [1]);
  assert.deepEqual(s.get("highlights-notes:2401.04088"), [1]);
  assert.deepEqual(s.paper("highlights-notes"), [1]);
  assert.deepEqual(s.paper("toc-progress:pos", { pct: 0 }, "2999.00001"), { pct: 0 }, "다른 논문 id 지정");
});

test("용량 초과: set은 false, throw 하지 않음, onFull 호출", () => {
  let full = 0;
  const broken = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); }, removeItem() {}, key: () => null, length: 0 };
  const s = makeStore(broken, () => "", () => full++);
  assert.equal(s.set("x", 1), false);
  assert.equal(full, 1);
});

test("keys(prefix)와 update", () => {
  const s = fresh();
  s.set("library", {});
  s.set("library:bib", []);
  s.set("vocab", []);
  assert.deepEqual(s.keys("library"), ["pr:library", "pr:library:bib"]);
  assert.equal(s.update("count", n => n + 1, 0), 1);
  assert.equal(s.update("count", n => n + 1, 0), 2);
});

test("mergeDefault: 배열은 id 합집합(ts 큰 쪽), id 객체 맵은 키별, 설정은 로컬 유지", () => {
  const arr = mergeDefault([{ id: 1, ts: 1, v: "old" }, { id: 2, ts: 5 }], [{ id: 1, ts: 9, v: "new" }, { id: 3, ts: 1 }]);
  assert.deepEqual(arr.map(x => x.id).sort(), [1, 2, 3]);
  assert.equal(arr.find(x => x.id === 1).v, "new");
  const map = mergeDefault({ a: { opened: 5, t: "local" } }, { a: { opened: 1, t: "old" }, b: { opened: 2 } });
  assert.equal(map.a.t, "local");
  assert.ok(map.b);
  assert.deepEqual(mergeDefault({ size: 18 }, { size: 20 }), { size: 18 });
  assert.deepEqual(mergeDefault(null, { size: 20 }), { size: 20 });
  assert.deepEqual(mergeDefault(["a"], ["b", "a"]).sort(), ["a", "b"]);
});

test("addMerger: 가장 긴 접두사 규칙 우선, exportAll/importAll", () => {
  const s = fresh();
  s.set("vocab", [{ term: "KD", step: 2, ts: 5 }]);
  s.set("reading-settings", { size: 18 });
  s.addMerger("vocab", (local, inc) => [...local, ...inc.filter(c => !local.some(l => l.term === c.term))]);
  const n = s.importAll({ "pr:vocab": [{ term: "KD", step: 0 }, { term: "MoE" }], "pr:reading-settings": { size: 22 }, "other": 1 });
  assert.equal(n, 2);
  assert.deepEqual(s.get("vocab").map(c => c.term), ["KD", "MoE"]);
  assert.equal(s.get("vocab")[0].step, 2);
  assert.deepEqual(s.get("reading-settings"), { size: 18 });
  assert.deepEqual(Object.keys(s.exportAll()).sort(), ["pr:reading-settings", "pr:vocab"]);
});
