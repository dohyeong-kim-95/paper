// 최소 서비스워커: 정적 파일만 캐시, 나머지는 네트워크 우선
const CACHE = "paper-v1";
const ASSETS = ["/static/style.css", "/static/app.js", "/static/icon-192.png"];

self.addEventListener("install", e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))));

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
