// offline-save: 순수 함수 + 서비스워커 확장(offline-save.sw.js)을 실제 sw.js와 함께 가짜 SW 환경에서 실행
"use strict";
const { test, assert, load, ROOT } = require("./_runner");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const os = load("static/features/offline-save.js");
const SW = fs.readFileSync(path.join(ROOT, "static/sw.js"), "utf8");
const EXT = fs.readFileSync(path.join(ROOT, "static/features/offline-save.sw.js"), "utf8");

// ---------- 순수 함수 ----------
test("imageList: http(s)만, 중복 제거, src 없으면 url", () => {
  const a = "https://arxiv.org/html/2401.00001v1/x1.png";
  assert.deepEqual(os.imageList([
    { url: a, src: "https://arxiv.org/html/2401.00001v1/x1.png" }, { url: a, src: "dup" },
    { url: "data:image/png;base64,AAA", src: "data:" }, { url: "" }, null,
    { url: "https://ar5iv.labs.arxiv.org/x2.png" },
  ]), [
    { url: a, src: a },
    { url: "https://ar5iv.labs.arxiv.org/x2.png", src: "https://ar5iv.labs.arxiv.org/x2.png" },
  ]);
});

test("assetUrls: 같은 출처 /static·/features.js|css 와 jsDelivr만", () => {
  const o = "http://app.test";
  assert.deepEqual(os.assetUrls([
    "http://app.test/static/app.js?v=1a", "/static/style.css?v=2", "http://app.test/features.js?v=abc",
    "http://app.test/features.css?v=abc", "http://app.test/features.sw.js", "http://app.test/api/overview/1",
    "http://app.test/paper/2401.00001", "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/fonts/KaTeX_Main-Regular.woff2",
    "http://cdn.jsdelivr.net/npm/x.js", "https://arxiv.org/html/x1.png", "http://other.test/static/app.js", "not a url ::",
    "http://app.test/static/app.js?v=1a#frag",
  ], o), [
    "http://app.test/static/app.js?v=1a", "http://app.test/static/style.css?v=2", "http://app.test/features.js?v=abc",
    "http://app.test/features.css?v=abc", "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/fonts/KaTeX_Main-Regular.woff2",
  ]);
});

test("fmtBytes / fmtDate", () => {
  assert.equal(os.fmtBytes(0), "0 MB");
  assert.equal(os.fmtBytes(undefined), "0 MB");
  assert.equal(os.fmtBytes(20_000), "0.1 MB");
  assert.equal(os.fmtBytes(2_345_678), "2.3 MB");
  assert.equal(os.fmtBytes(123_456_789), "123 MB");
  assert.equal(os.fmtBytes(2_500_000_000), "2.5 GB");
  assert.equal(os.fmtDate(new Date(2026, 9, 23, 8).getTime()), "10월 23일");
  assert.equal(os.fmtDate("bad"), "");
});

test("resultText: 성공·일부·공간 부족·페이지 실패", () => {
  assert.equal(os.resultText({ page: true, images: 3, total: 3 }), "오프라인 저장 완료 · 그림 3개 저장됨");
  assert.equal(os.resultText({ page: true, images: 0, total: 0 }), "오프라인 저장 완료");
  assert.equal(os.resultText({ page: true, images: 2, total: 3 }), "오프라인 저장 완료 · 그림 2/3개 저장됨 · 일부 그림 실패");
  assert.equal(os.resultText({ page: true, images: 1, total: 3, offline: true }), "오프라인 저장 완료 · 그림 1/3개 저장됨 · 연결되면 다시 저장하세요");
  assert.equal(os.resultText({ page: true, images: 1, total: 3, quota: true }), "오프라인 저장 완료 · 그림 1/3개 저장됨 · 저장 공간 부족");
  assert.match(os.resultText({ page: false }), /페이지를 저장하지 못했습니다/);
  assert.match(os.resultText({ page: false, quota: true }), /저장 공간이 부족/);
});

test("bannerText / isReply", () => {
  assert.match(os.bannerText(true), /^오프라인 · 저장본/);
  assert.match(os.bannerText(false), /^오프라인 · 저장하지 않은/);
  assert.equal(os.isReply({ type: "precached", n: 2 }, "precached"), true);
  assert.equal(os.isReply({ type: "offline-save:save:done", id: "a" }, "offline-save:save:done", "a"), true);
  assert.equal(os.isReply({ type: "offline-save:save:done", id: "b" }, "offline-save:save:done", "a"), false);
  assert.equal(os.isReply({ type: "unsaved" }, "precached"), false);
  assert.equal(os.isReply(null, "precached"), false);
});

// ---------- 서비스워커: sw.js + offline-save.sw.js (tests/js/sw.test.js와 같은 가짜 환경) ----------
const urlOf = r => (typeof r === "string" ? r : r.url);
const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

class FakeCache {
  constructor() { this.m = new Map(); this.full = false; }
  async match(r) { const u = urlOf(r); return this.m.has(u) ? this.m.get(u).clone() : undefined; }
  async put(r, res) {
    if (this.full) throw Object.assign(new Error("quota"), { name: "QuotaExceededError" });
    // 실제 Cache처럼 본문을 다 읽어 저장 (불투명 표시는 유지)
    const opaque = res.type === "opaque" || res.__opaque;
    const body = await res.arrayBuffer();
    const copy = new Response(body, { status: res.status, headers: res.headers });
    if (opaque) Object.defineProperty(copy, "__opaque", { value: true });
    this.m.delete(urlOf(r)); // 실제 Cache처럼 같은 키를 다시 넣으면 맨 뒤로 (keys()는 넣은 순서)
    this.m.set(urlOf(r), copy);
  }
  async keys() { return [...this.m.keys()].map(url => ({ url })); }
  async delete(r) { return this.m.delete(urlOf(r)); }
}
// clone()해도 불투명 표시가 남도록
const origClone = Response.prototype.clone;
Object.defineProperty(Response.prototype, "type", { get() { return this.__opaque ? "opaque" : "default"; }, configurable: true });
Response.prototype.clone = function () { const c = origClone.call(this); if (this.__opaque) Object.defineProperty(c, "__opaque", { value: true }); return c; };

function loadSW() {
  const net = new Map(); // url -> (init) => Response (없으면 오프라인)
  const fetched = [];
  const stores = new Map();
  const handlers = {};
  const caches = {
    async open(n) { if (!stores.has(n)) stores.set(n, new FakeCache()); return stores.get(n); },
    async keys() { return [...stores.keys()]; },
    async delete(n) { return stores.delete(n); },
  };
  const sw = {
    console, URL, Response, Headers, Promise, setTimeout, clearTimeout, caches, Blob,
    location: new URL("http://app.test/"),
    fetch: async (r, init = {}) => {
      const u = urlOf(r);
      fetched.push(u);
      const f = net.get(u);
      if (!f) throw new TypeError("offline");
      const res = f(init);
      if (init.mode === "no-cors" && !u.startsWith("http://app.test/")) Object.defineProperty(res, "__opaque", { value: true });
      return res;
    },
    importScripts: () => vm.runInContext(EXT, sw),
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: async () => {}, clients: { claim: async () => {} },
  };
  sw.self = sw;
  vm.createContext(sw);
  vm.runInContext(SW, sw);
  return {
    net, fetched, stores,
    async get(url, extra = {}) {
      let p;
      handlers.fetch({ request: { url, method: "GET", mode: "cors", destination: "", ...extra }, respondWith: x => { p = x; } });
      const res = p && await p;
      await tick();
      return res;
    },
    async message(data) {
      let p;
      const replies = [];
      handlers.message({ data, source: { postMessage: m => replies.push(m) }, waitUntil: x => { p = x; } });
      if (p) await p;
      return JSON.parse(JSON.stringify(replies));
    },
    cache: name => caches.open(name),
  };
}

const PAGE = "http://app.test/paper/2401.00001";
const img = n => `https://arxiv.org/html/2401.00001v1/${n}`;
const proxy = u => `http://app.test/api/offline-save/img/2401.00001?u=${encodeURIComponent(u)}`;
const html = () => new Response("<html>paper</html>", { headers: { "Content-Type": "text/html" } });
const png = (body = "PNG") => () => new Response(body, { headers: { "Content-Type": "image/png" } });
const imgs = names => names.map(n => ({ url: img(n), src: img(n) }));
const doneOf = replies => replies.filter(x => /:done$/.test(x.type));

test("save: 페이지는 PAGES에, 프록시로 받은 그림은 실제 크기 응답으로 SAVED에, 못 받은 그림은 rest → 기본 precache", async () => {
  const t = loadSW();
  t.net.set(PAGE, html);
  t.net.set(proxy(img("x1.png")), png("PROXIED"));
  t.net.set(proxy(img("x3.svg")), () => new Response('{"detail":"x"}', { status: 404, headers: { "Content-Type": "application/json" } }));
  t.net.set(img("x3.svg"), png("SVG-OPAQUE"));
  const msg = { type: "offline-save:save", id: "a1", arxivId: "2401.00001", pages: [PAGE, "https://evil.test/paper/x", "http://app.test/static/app.js"], images: imgs(["x1.png", "x3.svg"]) };
  const [r] = doneOf(await t.message(msg));
  assert.deepEqual(r, { type: "offline-save:save:done", id: "a1", pages: 1, images: 1, rest: [img("x3.svg")], quota: false });
  assert.ok(!t.fetched.includes("https://evil.test/paper/x"), "다른 출처·논문 아닌 페이지는 받지 않음");
  const saved = await t.cache("paper-v2-saved");
  const x1 = await saved.match(img("x1.png"));
  assert.equal(await x1.text(), "PROXIED");
  assert.equal(x1.type, "default", "불투명 응답이 아님");
  assert.equal(x1.headers.get("Content-Type"), "image/png");
  // 페이지가 이어서 보내는 기본 precache (불투명 저장)
  assert.deepEqual(await t.message({ type: "precache", urls: r.rest }), [{ type: "precached", n: 1 }]);
  assert.equal((await saved.match(img("x3.svg"))).type, "opaque");

  // 오프라인: 네비게이션은 저장된 페이지, 그림은 SAVED에서 (네트워크 없이)
  t.net.clear();
  const before = t.fetched.length;
  const nav = await t.get(PAGE, { mode: "navigate" });
  assert.equal(await nav.text(), "<html>paper</html>");
  const pic = await t.get(img("x1.png"), { destination: "image", mode: "no-cors" });
  assert.equal(await pic.text(), "PROXIED");
  assert.equal(t.fetched.length - before, 1, "네트워크 시도는 페이지 1번뿐 (그림은 저장본)");
  const miss = await t.get("http://app.test/paper/2301.00001", { mode: "navigate" });
  assert.equal(miss.status, 503, "안 연 논문은 오프라인 페이지");
});

test("save: 이미 있는 실제 크기 저장본은 다시 받지 않음, 불투명 저장본은 프록시로 바꾸고 실패해도 저장된 것으로 셈", async () => {
  const t = loadSW();
  const saved = await t.cache("paper-v2-saved");
  await saved.put(img("a.png"), new Response("REAL", { headers: { "Content-Type": "image/png" } }));
  const opaque = new Response("OPQ");
  Object.defineProperty(opaque, "__opaque", { value: true });
  await saved.put(img("b.png"), opaque);
  const opaque2 = new Response("OPQ2");
  Object.defineProperty(opaque2, "__opaque", { value: true });
  await saved.put(img("c.png"), opaque2);
  t.net.set(proxy(img("b.png")), png("UPGRADED"));
  const [r] = doneOf(await t.message({ type: "offline-save:save", id: "a2", arxivId: "2401.00001", pages: [], images: imgs(["a.png", "b.png", "c.png"]) }));
  assert.equal(r.images, 3);
  assert.deepEqual(r.rest, []);
  assert.ok(!t.fetched.includes(proxy(img("a.png"))));
  assert.equal(await (await saved.match(img("b.png"))).text(), "UPGRADED");
  assert.equal(await (await saved.match(img("c.png"))).text(), "OPQ2");
});

test("save: 오프라인이면 페이지는 기존 저장본으로 인정, 그림은 rest", async () => {
  const t = loadSW();
  await (await t.cache("paper-v2-pages")).put(PAGE, html());
  const [r] = doneOf(await t.message({ type: "offline-save:save", id: "a3", arxivId: "2401.00001", pages: [PAGE], images: imgs(["x1.png"]) }));
  assert.equal(r.pages, 1);
  assert.deepEqual(r.rest, [img("x1.png")]);
});

test("save: 저장 공간 부족이면 quota 표시하고 나머지는 시도하지 않음", async () => {
  const t = loadSW();
  t.net.set(PAGE, html);
  for (const n of ["p1.png", "p2.png", "p3.png", "p4.png", "p5.png", "p6.png"]) t.net.set(proxy(img(n)), png());
  (await t.cache("paper-v2-saved")).full = true;
  const [r] = doneOf(await t.message({ type: "offline-save:save", id: "a4", arxivId: "2401.00001", pages: [PAGE], images: imgs(["p1.png", "p2.png", "p3.png", "p4.png", "p5.png", "p6.png"]) }));
  assert.equal(r.quota, true);
  assert.equal(r.images, 0);
  assert.equal(r.rest.length, 6);
  assert.ok(t.fetched.filter(u => u.includes("/api/offline-save/img/")).length <= 4, "동시 요청 수(4) 이후로는 프록시를 부르지 않음");
});

test("save: 바로 start로 답하고(확장 있음 표시) 페이지 뒤·그림마다 진행 상황, 마지막에 done", async () => {
  const t = loadSW();
  t.net.set(PAGE, html);
  t.net.set(proxy(img("x1.png")), png());
  t.net.set(proxy(img("x2.png")), png());
  const replies = await t.message({ type: "offline-save:save", id: "p1", arxivId: "2401.00001", pages: [PAGE], images: imgs(["x1.png", "x2.png"]) });
  assert.deepEqual(replies.map(x => x.type), ["offline-save:save:start", "offline-save:save:progress", "offline-save:save:progress", "offline-save:save:progress", "offline-save:save:done"]);
  assert.ok(replies.every(x => x.id === "p1"));
  assert.deepEqual(replies[0], { type: "offline-save:save:start", id: "p1", total: 2 });
  assert.deepEqual(replies[1], { type: "offline-save:save:progress", id: "p1", pages: 1, images: 0, done: 0, total: 2 });
  assert.deepEqual(replies[3], { type: "offline-save:save:progress", id: "p1", pages: 1, images: 2, done: 2, total: 2 });
});

// ---------- 페이지 쪽: trackSave (느린 저장 vs 확장이 없는 SW) ----------
function bus() {
  const fns = new Set(), sent = [];
  return {
    sent, emit: d => [...fns].forEach(f => f(d)), size: () => fns.size,
    listen: fn => { fns.add(fn); return () => fns.delete(fn); },
    post: m => sent.push(m),
  };
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const MSG = { type: "offline-save:save", id: "j1" };

test("trackSave: start가 없으면(확장 없는 SW) ackMs 뒤 null → 그때만 기본 precache", async () => {
  const b = bus();
  const r = await os.trackSave(b.listen, b.post, MSG, { ackMs: 20, idleMs: 1000, maxMs: 2000 });
  assert.equal(r, null);
  assert.deepEqual(b.sent, [MSG]);
  assert.equal(b.size(), 0, "리스너 해제");
});

test("trackSave: start 뒤엔 진행 메시지마다 타이머를 다시 걸어 오래 걸려도 done을 기다림, 다른 id는 무시", async () => {
  const b = bus(), seen = [];
  const p = os.trackSave(b.listen, b.post, MSG, { ackMs: 30, idleMs: 60, maxMs: 5000, onProgress: x => seen.push(x.done) });
  b.emit({ type: "offline-save:save:start", id: "j1", total: 3 });
  for (let i = 1; i <= 3; i++) { await wait(40); b.emit({ type: "offline-save:save:progress", id: "j1", pages: 1, images: i, done: i, total: 3 }); }
  b.emit({ type: "offline-save:save:done", id: "other", pages: 0, images: 0, rest: ["x"] });
  await wait(40);
  b.emit({ type: "offline-save:save:done", id: "j1", pages: 1, images: 3, rest: [], quota: false });
  const r = await p;
  assert.equal(r.images, 3);
  assert.ok(!r.late);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(b.size(), 0);
});

test("trackSave: start 뒤 소식이 끊기면 마지막 진행 상황 + late (rest 없음 → 불투명 precache로 다시 보내지 않음)", async () => {
  const b = bus();
  const p = os.trackSave(b.listen, b.post, MSG, { ackMs: 20, idleMs: 40, maxMs: 5000 });
  b.emit({ type: "offline-save:save:start", id: "j1", total: 5 });
  b.emit({ type: "offline-save:save:progress", id: "j1", pages: 1, images: 2, done: 2, total: 5 });
  const r = await p;
  assert.deepEqual(r, { pages: 1, images: 2, done: 2, total: 5, rest: [], quota: false, late: true });
  // 전체 한도(maxMs)도 지킴
  const b2 = bus();
  const p2 = os.trackSave(b2.listen, b2.post, MSG, { ackMs: 20, idleMs: 30, maxMs: 80 });
  b2.emit({ type: "offline-save:save:start", id: "j1", total: 5 });
  const iv = setInterval(() => b2.emit({ type: "offline-save:save:progress", id: "j1", pages: 1, images: 1, done: 1, total: 5 }), 10);
  const r2 = await p2;
  clearInterval(iv);
  assert.equal(r2.late, true);
});

test("resultText: late면 '계속 저장 중일 수 있어요'", () => {
  assert.equal(os.resultText({ page: true, images: 2, total: 5, late: true }), "오프라인 저장 완료 · 그림 2/5개 저장됨 · 나머지 그림은 계속 저장 중일 수 있어요");
});

test("status: 지금 캐시에 있는 페이지·그림 수", async () => {
  const t = loadSW();
  await (await t.cache("paper-v2-pages")).put(PAGE, html());
  await (await t.cache("paper-v2-saved")).put(img("x1.png"), new Response("P"));
  const [r] = doneOf(await t.message({ type: "offline-save:status", id: "s1", pages: [PAGE], images: imgs(["x1.png", "x2.png"]) }));
  assert.deepEqual(r, { type: "offline-save:status:done", id: "s1", pages: 1, images: 1 });
  assert.deepEqual(await t.message({ type: "unknown" }), [], "다른 메시지는 무시");
});

test("둘러본 그림(IMG): 꺼내 쓴 그림은 맨 뒤로 → 60개 넘으면 가장 오래 안 쓴 것부터 지움 (LRU), SAVED가 먼저", async () => {
  const t = loadSW();
  const N = 60;
  for (let i = 0; i <= N; i++) t.net.set(img(`b${i}.png`), png(`B${i}`));
  const view = name => t.get(img(name), { destination: "image", mode: "no-cors" });
  for (let i = 0; i < N; i++) await view(`b${i}.png`);
  await tick(20);
  const cache = await t.cache("paper-v2-img");
  assert.equal((await cache.keys()).length, N);
  t.net.delete(img("b0.png"));
  assert.equal(await (await view("b0.png")).text(), "B0", "저장본에서 (네트워크 없이)");
  await tick(20);
  await view(`b${N}.png`); // 61번째 → 하나 지움
  await tick(40);
  const keys = (await cache.keys()).map(k => k.url);
  assert.equal(keys.length, N);
  assert.ok(keys.includes(img("b0.png")), "방금 본 b0은 남음");
  assert.ok(!keys.includes(img("b1.png")), "가장 오래 안 본 b1이 지워짐");
  // 사용자가 저장한 그림이 먼저
  await (await t.cache("paper-v2-saved")).put(img("b5.png"), new Response("SAVED", { headers: { "Content-Type": "image/png" } }));
  assert.equal(await (await view("b5.png")).text(), "SAVED");
  // arXiv가 아닌 그림·그림이 아닌 요청은 이 라우트가 받지 않음
  assert.equal(await t.get("https://example.com/x.png", { destination: "image", mode: "no-cors" }), undefined);
});

test("둘러본 그림(IMG): 저장 공간 부족이면 절반으로 줄이고 응답은 그대로", async () => {
  const t = loadSW();
  for (let i = 0; i < 40; i++) t.net.set(img(`q${i}.png`), png(`Q${i}`));
  for (let i = 0; i < 39; i++) await t.get(img(`q${i}.png`), { destination: "image", mode: "no-cors" });
  await tick(20);
  const cache = await t.cache("paper-v2-img");
  cache.full = true;
  const res = await t.get(img("q39.png"), { destination: "image", mode: "no-cors" });
  assert.equal(await res.text(), "Q39");
  await tick(40);
  assert.equal((await cache.keys()).length, 30, "IMG_MAX(60)의 절반만 남김");
});
