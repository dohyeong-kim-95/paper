// sw.js를 가짜 서비스워커 환경(caches·fetch·이벤트)에서 실행해 캐시 규칙 확인
"use strict";
const { test, assert, ROOT } = require("./_runner");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(ROOT, "static/sw.js"), "utf8");
const urlOf = r => (typeof r === "string" ? r : r.url);
const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

class FakeCache {
  constructor() { this.m = new Map(); }
  async match(r, o = {}) {
    const u = urlOf(r);
    if (this.m.has(u)) return this.m.get(u).clone();
    if (o.ignoreSearch) for (const [k, v] of this.m) if (k.split("?")[0] === u.split("?")[0]) return v.clone();
    return undefined;
  }
  async put(r, res) { this.m.set(urlOf(r), res); }
  async keys() { return [...this.m.keys()].map(url => ({ url })); }
  async delete(r) { return this.m.delete(urlOf(r)); }
}

function loadSW({ extension } = {}) {
  const net = new Map(); // url -> () => Response (없으면 오프라인)
  const fetched = [];
  const stores = new Map();
  const handlers = {};
  const caches = {
    async open(n) { if (!stores.has(n)) stores.set(n, new FakeCache()); return stores.get(n); },
    async keys() { return [...stores.keys()]; },
    async delete(n) { return stores.delete(n); },
  };
  const sw = {
    console, URL, Response, Headers, Promise, setTimeout, clearTimeout, caches,
    location: new URL("http://app.test/"),
    fetch: async r => { const u = urlOf(r); fetched.push(u); const f = net.get(u); if (!f) throw new TypeError("offline"); return f(); },
    importScripts: () => { if (!extension) throw new Error("확장 없음"); vm.runInContext(extension, sw); },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: async () => {}, clients: { claim: async () => {} },
  };
  sw.self = sw;
  vm.createContext(sw);
  vm.runInContext(SRC, sw);
  return {
    sw, net, fetched, stores, caches,
    // fetch 이벤트 → respondWith에 넘긴 응답 (처리 안 하면 undefined)
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
      return JSON.parse(JSON.stringify(replies)); // vm 컨텍스트의 객체 → 이 쪽 객체로
    },
    async activate() { let p; handlers.activate({ waitUntil: x => { p = x; } }); await p; },
    async count(name) { return stores.has(name) ? (await stores.get(name).keys()).length : 0; },
  };
}
const png = () => new Response("PNG", { headers: { "Content-Type": "image/png" } });
const img = i => `https://arxiv.org/html/2401.00001v1/x${i}.png`;

test("오프라인 저장(precache)은 SAVED에 개수 제한 없이, 둘러본 그림(IMG 60개 제한)에 밀려나지 않음", async () => {
  const t = loadSW();
  for (let i = 0; i < 160; i++) t.net.set(img(i), png);
  const replies = await t.message({ type: "precache", urls: Array.from({ length: 70 }, (_, i) => img(i)) });
  assert.deepEqual(replies, [{ type: "precached", n: 70 }]);
  for (let i = 100; i < 160; i++) await t.get(img(i), { destination: "image", mode: "no-cors" });
  await t.get(img(99), { destination: "image", mode: "no-cors" });
  await tick(20);
  assert.equal(await t.count("paper-v2-saved"), 70);
  assert.ok(await t.count("paper-v2-img") <= 60);
  t.net.clear(); // 오프라인
  const before = t.fetched.length;
  const res = await t.get(img(5), { destination: "image", mode: "no-cors" });
  assert.equal(await res.text(), "PNG");
  assert.equal(t.fetched.length, before, "저장한 그림은 네트워크 없이");
  assert.deepEqual(await t.message({ type: "unsave", urls: [img(5)] }), [{ type: "unsaved", n: 1 }]);
  assert.equal(await t.count("paper-v2-saved"), 69);
});

test("activate는 SAVED와 확장이 PR_SW.keep으로 등록한 캐시를 지우지 않음", async () => {
  const t = loadSW({ extension: 'self.PR_SW.keep("ext-offline"); self.PR_SW.keep("ext-offline");' });
  for (const n of ["paper-v1-img", "paper-v2-saved", "paper-v2-api", "ext-offline", "other"]) await t.caches.open(n);
  await t.activate();
  assert.deepEqual((await t.caches.keys()).sort(), ["ext-offline", "paper-v2-api", "paper-v2-saved"]);
});

test("확장 번들(importScripts)을 못 읽으면 이 버전의 확장 캐시는 지우지 않음 (옛 버전 캐시만 정리)", async () => {
  const t = loadSW(); // importScripts가 던짐 = 설치 중 오프라인
  for (const n of ["paper-v1-img", "paper-v2-offline-save", "paper-v2-api", "other"]) await t.caches.open(n);
  await t.activate();
  assert.deepEqual((await t.caches.keys()).sort(), ["paper-v2-api", "paper-v2-offline-save"]);
});

test("GET /api/*: X-Offline-Cacheable 응답만 저장, '[오류]' 꼬리로 끝나는 텍스트(실패한 스트림)는 저장 안 함", async () => {
  const t = loadSW();
  const text = (body, cacheable = true) => () => new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8", ...(cacheable ? { "X-Offline-Cacheable": "1" } : {}) },
  });
  t.net.set("http://app.test/api/x/bad", text("부분\n\n[오류] 응답이 너무 길어 잘렸습니다 (max_tokens)."));
  t.net.set("http://app.test/api/x/good", text("## 요약\n본문의 [오류] 라는 단어는 괜찮음"));
  t.net.set("http://app.test/api/x/plain", text("저장 안 함", false));
  t.net.set("http://app.test/api/x/json", () => new Response('{"a":1}', { headers: { "Content-Type": "application/json", "X-Offline-Cacheable": "1" } }));
  for (const p of ["bad", "good", "plain", "json"]) assert.equal((await t.get(`http://app.test/api/x/${p}`)).status, 200);
  await tick(20);
  const keys = (await (await t.caches.open("paper-v2-api")).keys()).map(k => k.url.split("/").pop()).sort();
  assert.deepEqual(keys, ["good", "json"]);
  t.net.clear();
  assert.equal(await (await t.get("http://app.test/api/x/good")).text(), "## 요약\n본문의 [오류] 라는 단어는 괜찮음");
  assert.equal((await t.get("http://app.test/api/x/bad")).status, 503);
});
