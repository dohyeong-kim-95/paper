// 서비스워커: 앱 셸·논문 페이지·기능 번들 캐시 + 오프라인 읽기
// - GET /api/* 는 네트워크 우선. 응답에 'X-Offline-Cacheable: 1' 헤더가 있으면 저장해 두고 오프라인 때 사용
//   (기능은 sw.js를 고치지 말고 서버 응답에 헤더를 붙여 참여: core.offline_json / core.cached_stream).
//   text/plain 본문이 '[오류] …' 꼬리로 끝나면(실패한 스트림) 저장하지 않음
// - 그림: 보면서 받은 것은 IMG(최근 60개), 사용자가 '오프라인 저장'한 논문의 그림은 SAVED(개수 제한 없음, 먼저 찾음)
// - 기능별 확장은 static/features/<id>.sw.js → /features.sw.js 로 묶여 여기서 importScripts
const V = "paper-v2";
const SHELL = `${V}-shell`, PAGES = `${V}-pages`, API = `${V}-api`, CDN = `${V}-cdn`, IMG = `${V}-img`, SAVED = `${V}-saved`;
const KEEP = [SHELL, PAGES, API, CDN, IMG, SAVED];
const ERROR_TAIL = /\n\n\[오류\][^\n]*$/; // app.py error_tail, app.js ERROR_TAIL와 같은 규칙
const SHELL_URLS = ["/", "/static/style.css", "/static/store.js", "/static/ui.js", "/static/anchor.js", "/static/app.js",
  "/static/render.js", "/static/voice.js", "/static/icon-192.png", "/static/manifest.json", "/features.js", "/features.css"];
const IMG_MAX = 60; // 다른 출처 이미지는 불투명 응답이라 용량을 크게 차지 → 개수 제한
const PAGE_TIMEOUT = 3000;

// 기능 확장용: routes에 {test(url, request), handle(event)} 를 넣으면 기본 처리보다 먼저 검사.
// 확장이 자기 캐시를 쓰려면 이름을 `${V}-…`로 짓고 PR_SW.keep(name)으로 등록 (activate가 KEEP에 없는 캐시는 지움)
self.PR_SW = { V, SHELL, PAGES, API, CDN, IMG, SAVED, IMG_MAX, routes: [], onMessage: [],
  keep: name => { if (!KEEP.includes(name)) KEEP.push(name); } };
// 확장 번들을 못 읽었으면(새 SW 설치 중 네트워크 끊김 등) 아무도 keep()을 못 불렀으므로 이 버전(V-)의 캐시는 지우지 않음
let extLoaded = true;
try { importScripts("/features.sw.js"); } catch (e) { extLoaded = false; /* 오프라인 등 */ }

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_URLS)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => !KEEP.includes(k) && (extLoaded || !k.startsWith(`${V}-`))).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const timeout = ms => new Promise(resolve => setTimeout(resolve, ms));

function offlinePage() {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>오프라인</title><body style="font:17px/1.6 -apple-system,sans-serif;padding:24px">
<h1>오프라인입니다</h1><p>이 페이지는 아직 저장되지 않았습니다. 한 번 열어 본 논문은 오프라인에서도 열립니다.</p><p><a href="/">홈으로</a></p>`;
  return new Response(html, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// 페이지: 네트워크 우선, 3초 넘게 걸리고 저장본이 있으면 저장본
async function page(req) {
  const cache = await caches.open(PAGES);
  const net = fetch(req).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  const hit = await cache.match(req);
  if (!hit) return net.catch(() => offlinePage());
  return Promise.race([net.then(r => (r.ok ? r : hit), () => hit), timeout(PAGE_TIMEOUT).then(() => hit)]);
}

// 같은 경로의 옛 버전(?v=)은 지우고 저장
async function putLatest(cache, req, res) {
  const path = new URL(req.url).pathname;
  for (const k of await cache.keys()) if (new URL(k.url).pathname === path && k.url !== req.url) cache.delete(k);
  return cache.put(req, res);
}

// /static, /features.*: 버전(?v=)이 붙은 주소는 바뀌지 않으므로 캐시 우선, 아니면 네트워크 우선
async function asset(req, url) {
  const cache = await caches.open(SHELL);
  if (url.searchParams.has("v")) {
    const hit = await cache.match(req);
    if (hit) return hit;
  }
  try {
    const res = await fetch(req);
    if (res.ok) putLatest(cache, req, res.clone());
    return res;
  } catch (e) {
    return (await cache.match(req, { ignoreSearch: true })) || Response.error();
  }
}

// 실패 꼬리로 끝나는 텍스트 스트림(core.cached_stream 실패)은 저장하지 않음
async function storeApi(cache, req, res) {
  try {
    if ((res.headers.get("Content-Type") || "").startsWith("text/plain")) {
      const text = await res.text();
      if (ERROR_TAIL.test(text)) return;
      return await cache.put(req, new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers }));
    }
    return await cache.put(req, res);
  } catch (e) { /* 저장 실패는 무시 */ }
}

// GET /api/*: 네트워크 우선, 기능이 허락한 응답(X-Offline-Cacheable: 1)만 저장
async function api(req) {
  const cache = await caches.open(API);
  try {
    const res = await fetch(req);
    if (res.ok && res.headers.get("X-Offline-Cacheable") === "1") storeApi(cache, req, res.clone());
    return res;
  } catch (e) {
    return (await cache.match(req)) || new Response(JSON.stringify({ detail: "오프라인입니다" }),
      { status: 503, headers: { "Content-Type": "application/json" } });
  }
}

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") cache.put(req, res.clone());
  return res;
}

async function trim(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(k);
}

async function image(req) {
  const saved = await (await caches.open(SAVED)).match(req);
  if (saved) return saved;
  try { return await cacheFirst(req, IMG); }
  finally { trim(IMG, IMG_MAX); }
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  for (const r of self.PR_SW.routes) {
    try { if (r.test(url, req)) return e.respondWith(r.handle(e)); } catch (err) { /* 확장 오류는 무시 */ }
  }
  if (url.origin === location.origin) {
    if (req.mode === "navigate") return e.respondWith(page(req));
    if (url.pathname.startsWith("/api/")) return e.respondWith(api(req));
    if (url.pathname.startsWith("/static/") || url.pathname.startsWith("/features.")) return e.respondWith(asset(req, url));
    return;
  }
  if (url.hostname === "cdn.jsdelivr.net") return e.respondWith(cacheFirst(req, CDN));
  if (req.destination === "image" && /(^|\.)arxiv\.org$/.test(url.hostname)) return e.respondWith(image(req));
});

// 페이지에서 그림 오프라인 저장: navigator.serviceWorker.controller.postMessage({type: 'precache', urls})
// → SAVED 캐시(개수 제한·자동 삭제 없음, 이미 IMG에 있으면 복사). 지우기: {type: 'unsave', urls}
self.addEventListener("message", e => {
  const msg = e.data || {};
  for (const fn of self.PR_SW.onMessage) { try { fn(e); } catch (err) { /* 무시 */ } }
  if (!Array.isArray(msg.urls)) return;
  if (msg.type === "unsave") {
    e.waitUntil((async () => {
      const cache = await caches.open(SAVED);
      for (const u of msg.urls) await cache.delete(u);
      if (e.source) e.source.postMessage({ type: "unsaved", n: msg.urls.length });
    })());
    return;
  }
  if (msg.type !== "precache") return;
  e.waitUntil((async () => {
    const cache = await caches.open(SAVED), seen = await caches.open(IMG);
    let n = 0;
    for (const u of msg.urls) {
      try {
        if (!(await cache.match(u))) await cache.put(u, (await seen.match(u)) || await fetch(u, { mode: "no-cors" }));
        n++;
      } catch (err) { /* 실패한 그림은 건너뜀 */ }
    }
    if (e.source) e.source.postMessage({ type: "precached", n });
  })());
});
