// offline-save: 오프라인 읽기 — '오프라인 저장'(페이지·그림·받아 둔 요약 등), 오프라인 배너, 시트의 '네트워크 연결 필요'
(function () {
  "use strict";
  // ---------- 순수 함수 (node 테스트 대상) ----------
  // 본문 그림 목록 → [{url: 절대 주소(SW 캐시 키), src: 속성값(서버 프록시 검증용)}]. http(s)만, 중복 제거
  function imageList(items) {
    const seen = new Set(), out = [];
    for (const it of items || []) {
      const url = String((it && it.url) || "");
      if (!/^https?:\/\//.test(url) || seen.has(url)) continue;
      seen.add(url);
      out.push({ url, src: String((it && it.src) || url) });
    }
    return out;
  }

  // 다시 받아 SW 캐시에 넣을 정적 파일: 같은 출처 /static/*·/features.js|css, jsDelivr (KaTeX 글꼴 포함)
  function assetUrls(urls, origin) {
    const out = new Set();
    for (const raw of urls || []) {
      let u;
      try { u = new URL(raw, origin); } catch { continue; }
      const ok = u.origin === origin
        ? /^\/(static\/|features\.(js|css)$)/.test(u.pathname)
        : u.protocol === "https:" && u.hostname === "cdn.jsdelivr.net";
      if (ok) out.add(u.href.split("#")[0]);
    }
    return [...out];
  }

  function fmtBytes(n) {
    if (!(n > 0)) return "0 MB";
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
    const mb = n / 1e6;
    return `${mb < 10 ? Math.max(0.1, mb).toFixed(1) : Math.round(mb)} MB`;
  }

  const fmtDate = ts => { const d = new Date(ts); return Number.isNaN(d.getTime()) ? "" : `${d.getMonth() + 1}월 ${d.getDate()}일`; };

  // 저장 결과 → 토스트 문구
  function resultText({ page, images = 0, total = 0, quota = false, offline = false } = {}) {
    if (!page) return quota ? "저장 공간이 부족해 저장하지 못했습니다" : "페이지를 저장하지 못했습니다 · 연결을 확인해 주세요";
    let s = "오프라인 저장 완료";
    if (total) s += ` · 그림 ${images >= total ? total : `${images}/${total}`}개 저장됨`;
    if (quota) s += " · 저장 공간 부족";
    else if (images < total) s += offline ? " · 연결되면 다시 저장하세요" : " · 일부 그림 실패";
    return s;
  }

  const bannerText = saved => (saved
    ? "오프라인 · 저장본으로 읽는 중 · 질문은 연결 후 가능"
    : "오프라인 · 저장하지 않은 그림·요약은 안 보일 수 있어요");

  // SW 답 메시지인지: id가 없는 기본 답({type: "precached", n})도 받음
  const isReply = (d, type, id) => !!d && d.type === type && (id == null || d.id === id);

  const api = { imageList, assetUrls, fmtBytes, fmtDate, resultText, bannerText, isReply };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;
  if (document.body.dataset.page !== "paper") return;
  PaperApp.registerFeature("offline-save", api);

  // ---------- 화면 ----------
  const UI = PaperUI, h = UI.h, NS = "offline-save";
  const sw = "serviceWorker" in navigator ? navigator.serviceWorker : null;
  const record = () => PaperStore.paper(NS, null); // {ts, n}
  const pageUrl = () => location.href.split("#")[0];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const UNDO_MS = 6000; // 되돌리기 토스트(5초)보다 조금 길게
  let busy = false, seq = 0;

  const btn = UI.addBarButton({ id: NS, label: "오프라인 저장", onClick: () => (busy ? UI.toast("저장 중입니다…") : record() ? manage() : save()) });
  const syncLabel = () => btn.setLabel(busy ? "오프라인 저장 중…" : record() ? "오프라인 저장됨" : "오프라인 저장");
  syncLabel();

  // 메시지를 받을 SW: 제어 중인 것, 아니면 (첫 방문 직후) 활성화된 것
  async function worker() {
    if (!sw) return null;
    if (sw.controller) return sw.controller;
    try { const reg = await Promise.race([sw.ready, sleep(3000)]); return (reg && reg.active) || null; } catch { return null; }
  }
  // SW에 보내고 답을 기다림 (시간 넘으면 null)
  function request(target, msg, replyType, ms) {
    return new Promise(resolve => {
      const on = e => { if (isReply(e.data, replyType, msg.id)) done(e.data); };
      const done = v => { clearTimeout(timer); sw.removeEventListener("message", on); resolve(v); };
      const timer = setTimeout(() => done(null), ms);
      sw.addEventListener("message", on);
      try { sw.startMessages && sw.startMessages(); target.postMessage(msg); } catch { done(null); }
    });
  }

  // 본문 그림만 (기능이 넣은 .pr-ui 안의 그림은 빼고)
  const images = () => imageList([...document.querySelectorAll("#paper img")].filter(img => !img.closest(".pr-ui"))
    .map(img => ({ url: img.currentSrc || img.src, src: img.getAttribute("src") })));
  const resources = () => [
    ...(performance.getEntriesByType ? performance.getEntriesByType("resource").map(e => e.name) : []),
    ...[...document.querySelectorAll("script[src], link[rel=stylesheet][href]")].map(el => el.src || el.href),
  ];
  // 페이지에서 다시 요청 → 제어 중인 SW가 자기 규칙대로 저장 (API는 X-Offline-Cacheable 응답만, 정적 파일·CDN은 캐시)
  async function refetch(urls) {
    await Promise.all(urls.map(async u => {
      try { const r = await fetch(u); await r.blob(); } catch { /* 오프라인 등은 건너뜀 */ }
    }));
  }
  const cachedAnywhere = async u => { try { return !!(await caches.match(u)); } catch { return false; } };

  async function save() {
    if (busy) return;
    busy = true; // SW를 기다리는 동안 두 번 눌러도 한 번만
    const target = await worker();
    if (!target) { busy = false; UI.toast("이 브라우저에서는 오프라인 저장을 쓸 수 없습니다"); return; }
    pendingUnsave = null; // 해제 대기 중이던 그림은 지우지 않음
    syncLabel();
    UI.status(NS, "오프라인 저장", "loading");
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist().catch(() => {}); } catch { /* 무시 */ }
    let page = false, n = 0, quota = false;
    const imgs = images();
    try {
      // 1) 페이지 HTML + 그림(같은 출처 프록시, 실제 크기)
      const msg = { type: "offline-save:save", id: `os${Date.now()}-${++seq}`, arxivId: PaperApp.arxivId, pages: [pageUrl()], images: imgs };
      const r = await request(target, msg, "offline-save:save:done", 90000);
      const ext = r && !r.error;
      const rest = ext ? r.rest || [] : imgs.map(x => x.url);
      n = ext ? r.images || 0 : 0;
      quota = !!(ext && r.quota);
      page = ext ? r.pages > 0 : await cachedAnywhere(pageUrl()); // 확장이 없는 옛 SW: 둘러보며 저장된 페이지가 있는지
      // 2) 프록시로 못 받은 그림은 기본 precache (불투명 응답, 없으면 둘러보며 받은 것 복사)
      if (rest.length && !quota) {
        const p = await request(target, { type: "precache", urls: rest }, "precached", 90000);
        n += (p && p.n) || 0;
      }
      // 3) 다른 기능이 받아 둔 GET(요약·용어 …)과 정적 파일: 사용자가 안 연 기능은 새로 생성하지 않음
      if (sw.controller) await refetch([...PaperApp.offlineUrls(), ...assetUrls(resources(), location.origin)]);
    } catch (e) {
      console.error("[offline-save]", e);
    } finally {
      busy = false;
    }
    if (page) PaperStore.setPaper(NS, { ts: Date.now(), n });
    syncLabel();
    UI.status(NS, "오프라인 저장", page ? "ready" : "error", { onRetry: save });
    UI.toast(resultText({ page, images: n, total: imgs.length, quota, offline: !navigator.onLine }));
    renderBanner();
  }

  // 저장 해제: 기록은 바로 지우고, 그림 저장본은 '실행 취소' 시간이 지난 뒤 지움 (오프라인에서도 되돌릴 수 있게)
  let pendingUnsave = null;
  function flushUnsave() {
    const urls = pendingUnsave;
    pendingUnsave = null;
    if (!urls || record() || !sw || !sw.controller) return; // 그사이 다시 저장했으면 그대로 둠
    try { sw.controller.postMessage({ type: "unsave", urls }); } catch { /* 무시 */ }
  }
  function unsave() {
    const rec = record();
    PaperStore.delPaper(NS);
    syncLabel();
    renderBanner();
    pendingUnsave = images().map(x => x.url);
    const timer = setTimeout(flushUnsave, UNDO_MS);
    UI.toast("오프라인 저장을 해제했습니다", {
      actionLabel: "실행 취소",
      onAction: () => { clearTimeout(timer); pendingUnsave = null; if (rec) PaperStore.setPaper(NS, rec); syncLabel(); renderBanner(); },
    });
  }
  window.addEventListener("pagehide", flushUnsave);

  // 저장된 논문: 상태(실제 캐시 확인)·저장 공간 + 다시 저장 / 저장 해제
  function manage() {
    const rec = record() || {};
    const head = h("p", { text: `${fmtDate(rec.ts)} 저장 · 그림 ${rec.n || 0}개` });
    const info = h("div", { class: "os-info" }, head);
    const note = text => info.append(h("p", { class: "os-muted", text }));
    UI.peek({
      title: "오프라인 저장",
      body: info,
      actions: [
        { label: "다시 저장", primary: true, onClick: ({ close }) => { close(); save(); } },
        { label: "저장 해제", onClick: ({ close }) => { close(); unsave(); } },
      ],
    });
    (async () => {
      const target = await worker();
      const imgs = images();
      const st = target && await request(target, { type: "offline-save:status", id: `os${Date.now()}-${++seq}`, pages: [pageUrl()], images: imgs },
        "offline-save:status:done", 5000);
      if (st && !st.error) {
        head.textContent = `${fmtDate(rec.ts)} 저장 · 그림 ${st.images}/${imgs.length}개`;
        if (!st.pages) note("페이지 저장본이 지워졌습니다 · '다시 저장'을 눌러 주세요");
      }
      const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate().catch(() => null) : null;
      if (est && est.usage != null) note(`이 앱이 쓰는 저장 공간: ${fmtBytes(est.usage)}${est.quota ? ` / ${fmtBytes(est.quota)}` : ""}`);
      const kept = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => null) : null;
      if (kept === false) note("공간이 부족하면 브라우저가 지울 수 있어요 · 홈 화면에 추가하면 더 오래 보관됩니다");
    })();
  }

  // ---------- 오프라인 알림: 헤더 아래 배너 + 시트의 '네트워크 연결 필요' ----------
  const slot = UI.topSlot(NS);
  let dismissed = false, wasOffline = !navigator.onLine;
  function renderBanner() {
    if (!slot) return;
    if (navigator.onLine || dismissed) { slot.replaceChildren(); return; }
    slot.replaceChildren(h("div", { class: "os-banner", role: "status" },
      h("span", { text: bannerText(!!record()) }),
      h("button", { type: "button", class: "os-x", "aria-label": "배너 닫기", text: "✕", onclick: () => { dismissed = true; renderBanner(); } })));
  }
  function onNetwork() {
    dismissed = false;
    renderBanner();
    PaperApp.refreshSheetTools();
    if (navigator.onLine && wasOffline) UI.toast("다시 연결되었습니다");
    wasOffline = !navigator.onLine;
  }
  window.addEventListener("online", onNetwork);
  window.addEventListener("offline", onNetwork);
  renderBanner();

  PaperApp.addSheetTool({
    id: NS, order: 20,
    render: () => (navigator.onLine ? null : h("div", { class: "os-net", role: "note" },
      h("b", { text: "네트워크 연결 필요" }), h("span", { text: " · 오프라인에서는 질문할 수 없어요. 연결되면 다시 보내 주세요." }))),
  });
})();
