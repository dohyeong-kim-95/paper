// offline-save: 서비스워커 확장 (sw.js가 importScripts("/features.sw.js")로 읽음, sw.js는 고치지 않음)
// 페이지의 '오프라인 저장'이 보내는 메시지 (답: e.source에 {type: "<type>:done", id, ...}):
// - {type: "offline-save:save", id, arxivId, pages: [url], images: [{url, src}]}
//   pages: 논문 페이지 HTML을 PAGES에 (첫 방문은 SW가 제어하기 전에 열려 저장되지 않았을 수 있음)
//   images: 같은 출처 프록시(/api/offline-save/img)로 받아 '실제 크기' 응답으로 SAVED에 (키는 원래 arXiv 주소).
//   다른 출처 no-cors 응답(불투명)은 크롬이 개당 약 7MB로 계산 → 용량 초과·출처 전체 삭제 위험.
//   프록시로 못 받은 그림(SVG·큰 그림·실패)은 rest로 돌려줌 → 페이지가 기본 {type: "precache"}로 보냄 (불투명 저장)
//   → {pages: 저장된 페이지 수, images: SAVED에 있는 그림 수, rest: [url], quota: bool}
// - {type: "offline-save:status", id, pages, images} → {pages, images}: 지금 캐시에 있는 수 (지워졌는지 확인용)
// 라우트: arXiv 그림은 SAVED → IMG(최근 사용 순 60개, LRU) → 네트워크 (기본 처리를 대신함, 아래 image())
(function () {
  "use strict";
  const S = self.PR_SW;
  if (!S) return;
  const PROXY = "/api/offline-save/img/";
  const LIMIT = 4; // 그림 동시 요청 수
  const list = x => (Array.isArray(x) ? x : []);
  const isQuota = e => !!e && (e.name === "QuotaExceededError" || e.code === 22);
  // 같은 출처의 논문 페이지만 (메시지는 같은 출처 페이지만 보낼 수 있지만 그래도 좁게)
  const pageOk = u => { try { const x = new URL(u, location.origin); return x.origin === location.origin && x.pathname.startsWith("/paper/"); } catch (e) { return false; } };

  async function pool(items, fn) {
    let i = 0;
    const run = async () => { while (i < items.length) await fn(items[i++]); };
    await Promise.all(Array.from({ length: Math.min(LIMIT, items.length) }, run));
  }

  async function savePages(urls, out) {
    const cache = await caches.open(S.PAGES);
    for (const u of urls.filter(pageOk)) {
      try {
        const res = await fetch(u, { credentials: "same-origin" });
        if (res.ok) { await cache.put(u, res); out.pages++; continue; }
      } catch (e) { if (isQuota(e)) out.quota = true; }
      if (await cache.match(u)) out.pages++; // 오프라인·서버 오류: 이미 저장본이 있으면 됨
    }
  }

  async function saveImages(arxivId, images, out) {
    const cache = await caches.open(S.SAVED);
    await pool(images.filter(x => x && x.url), async ({ url, src }) => {
      const hit = await cache.match(url);
      if (hit && hit.type !== "opaque") { out.images++; return; }
      if (!out.quota) {
        try {
          const res = await fetch(new URL(`${PROXY}${encodeURIComponent(arxivId)}?u=${encodeURIComponent(src || url)}`, location.origin).href);
          const type = res.headers.get("Content-Type") || "";
          if (res.ok && type.startsWith("image/")) {
            // 새 Response로 감싸 저장: 실제 크기로 계산되고, <img>(no-cors) 요청에 그대로 돌려줄 수 있음
            await cache.put(url, new Response(await res.blob(), { headers: { "Content-Type": type } }));
            out.images++;
            return;
          }
        } catch (e) { if (isQuota(e)) out.quota = true; }
      }
      if (hit) out.images++; // 불투명 저장본은 그대로 둠
      else out.rest.push(url);
    });
  }

  async function save(m) {
    const out = { pages: 0, images: 0, rest: [], quota: false };
    await savePages(list(m.pages), out);
    await saveImages(String(m.arxivId || ""), list(m.images), out);
    return out;
  }

  async function status(m) {
    const pages = await caches.open(S.PAGES), saved = await caches.open(S.SAVED);
    let p = 0, n = 0;
    for (const u of list(m.pages).filter(pageOk)) if (await pages.match(u)) p++;
    for (const x of list(m.images)) if (x && x.url && await saved.match(x.url)) n++;
    return { pages: p, images: n };
  }

  // 둘러보며 받은 arXiv 그림(IMG, 60개): 기본 trim은 넣은 순서(FIFO)로 지움 → 꺼내 쓸 때 다시 넣어(put은 맨 뒤로) 최근 본
  // 그림이 남게 (LRU). 쓰기를 줄이려고 오래된 절반에 있을 때만 다시 넣음 (SW가 새로 뜨면 순번을 모르니 한 번 다시 넣음).
  // 저장 공간 부족이면 IMG를 절반으로 줄이고 넘어감
  let seq = 0;
  const putAt = new Map(); // url → 넣은 순번
  async function trimImg(cache, max) {
    const keys = await cache.keys();
    for (const k of keys.slice(0, Math.max(0, keys.length - max))) { putAt.delete(k.url); await cache.delete(k); }
  }
  async function keepImg(cache, req, res) {
    putAt.set(req.url, ++seq);
    try { await cache.put(req, res); }
    catch (e) { putAt.delete(req.url); if (isQuota(e)) await trimImg(cache, Math.floor(S.IMG_MAX / 2)).catch(() => {}); }
  }
  async function image(req) {
    const saved = await (await caches.open(S.SAVED)).match(req);
    if (saved) return saved; // 사용자가 저장한 그림이 먼저 (개수 제한 없음)
    const cache = await caches.open(S.IMG);
    const hit = await cache.match(req);
    if (hit) {
      const at = putAt.get(req.url);
      if (at == null || seq - at >= S.IMG_MAX / 2) keepImg(cache, req, hit.clone());
      return hit;
    }
    const res = await fetch(req);
    if (res.ok || res.type === "opaque") keepImg(cache, req, res.clone()).then(() => trimImg(cache, S.IMG_MAX)).catch(() => {});
    return res;
  }
  S.routes.push({
    test: (url, req) => req.destination === "image" && /(^|\.)arxiv\.org$/.test(url.hostname),
    handle: e => image(e.request),
  });

  S.onMessage.push(e => {
    const m = e.data || {};
    const job = m.type === "offline-save:save" ? save(m) : m.type === "offline-save:status" ? status(m) : null;
    if (!job) return;
    e.waitUntil(job.catch(() => ({ error: true })).then(r => {
      if (e.source) e.source.postMessage({ type: `${m.type}:done`, id: m.id, ...r });
    }));
  });
})();
