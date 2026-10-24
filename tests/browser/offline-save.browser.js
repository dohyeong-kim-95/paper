// offline-save: 진짜 서비스워커로 '오프라인 저장' → 오프라인에서 다시 열기 (헤드리스 Chromium + Playwright)
//   node tests/browser/offline-save.browser.js <port>   (tests/test_browser.py가 서버를 띄우고 실행)
// 서비스워커가 보내는 요청(arXiv 그림 등)도 context.route로 가로채려면 이 실험 플래그가 필요 (Chromium만)
"use strict";
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";
const assert = require("node:assert/strict");

let chromium;
try { ({ chromium } = require("playwright")); } catch { console.log("SKIP playwright 없음"); process.exit(0); }

const PORT = process.argv[2];
const BASE = `http://127.0.0.1:${PORT}`;
const PAPER = `${BASE}/paper/2401.00001`;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const SIZE = { "x1.png": [598, 300], "x2.png": [300, 200], "x3.svg": [300, 200] };

async function newContext(browser) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 800 }, serviceWorkers: "allow" });
  const outside = [];
  // 바깥 네트워크는 막음 (빈 응답). 논문 그림은 같은 비율의 SVG로. CORS 헤더는 jsDelivr처럼 직접
  // (없으면 Playwright가 'Vary: Origin'을 붙여 Cache.match가 빗나감 — 실제 CDN과 다른 상황)
  const headers = { "access-control-allow-origin": "*" };
  await ctx.route(u => !u.href.startsWith(BASE), r => {
    const url = r.request().url();
    outside.push(url);
    const name = url.split("/").pop();
    if (SIZE[name]) {
      const [w, h] = SIZE[name];
      return r.fulfill({ status: 200, headers, body: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"/>`, contentType: "image/svg+xml" });
    }
    return r.fulfill({ status: 200, headers, body: "", contentType: "text/plain" });
  });
  ctx.outside = outside;
  return ctx;
}
async function open(page, url = PAPER) {
  await page.goto(url);
  await page.waitForFunction(() => window.PaperApp && document.readyState === "complete");
}
const until = (page, fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout });
const toastText = page => page.evaluate(() => document.getElementById("pr-toast")?.textContent || "");
async function menu(page, label) {
  await page.click("#bar-more");
  await page.locator(".pr-menu-item", { hasText: label }).click();
}

test("저장 → 오프라인에서 다시 열면 본문·그림·배너, 시트에 '네트워크 연결 필요', 안 연 논문은 오프라인 페이지", async browser => {
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e.stack || e)));
  await open(page);
  // 서비스워커가 이 페이지를 제어할 때까지 (activate → clients.claim)
  await until(page, () => navigator.serviceWorker && navigator.serviceWorker.controller);
  // 다른 기능이 생성을 끝낸 캐시 가능 GET (요약 등) 흉내: 저장 때 다시 받아 API 캐시에 넣는지
  let apiHits = 0;
  await ctx.route(`${BASE}/api/fake-overview/2401.00001`, r => {
    apiHits++;
    return r.fulfill({ status: 200, body: "## 요약\n저장된 요약", contentType: "text/plain; charset=utf-8", headers: { "X-Offline-Cacheable": "1" } });
  });
  await page.evaluate(() => PaperApp.addOfflineUrl("/api/fake-overview/2401.00001"));

  await menu(page, "오프라인 저장");
  await until(page, () => /오프라인 저장 완료/.test(document.getElementById("pr-toast")?.textContent || ""), null, 30000);
  assert.equal(await toastText(page), "오프라인 저장 완료 · 그림 3개 저장됨");
  const rec = await page.evaluate(() => PaperStore.paper("offline-save"));
  assert.equal(rec.n, 3);
  assert.ok(apiHits >= 1, "받아 둔 GET을 다시 받음");
  const label = await page.evaluate(() => { document.getElementById("bar-more").click(); return [...document.querySelectorAll(".pr-menu-item")].map(b => b.textContent); });
  assert.ok(label.includes("오프라인 저장됨"), label.join(","));
  await page.keyboard.press("Escape");

  // 오프라인
  await ctx.setOffline(true);
  const outsideBefore = ctx.outside.length;
  await page.reload();
  await page.waitForFunction(() => window.PaperApp && document.readyState === "complete");
  const r = await page.evaluate(async () => {
    const imgs = [...document.querySelectorAll("#paper img")];
    await Promise.all(imgs.map(i => (i.complete ? null : new Promise(res => { i.onload = i.onerror = res; }))));
    const api = await fetch("/api/fake-overview/2401.00001").then(x => x.text(), () => null);
    return {
      online: navigator.onLine,
      text: document.getElementById("paper").textContent.length > 500,
      imgs: imgs.map(i => i.naturalWidth > 0),
      banner: document.querySelector(".os-banner")?.textContent || "",
      api,
    };
  });
  assert.deepEqual(r, { online: false, text: true, imgs: [true, true, true], banner: "오프라인 · 저장본으로 읽는 중 · 질문은 연결 후 가능✕", api: "## 요약\n저장된 요약" });
  assert.equal(ctx.outside.length, outsideBefore, "오프라인 그림은 서비스워커 저장본에서 (바깥 요청 없음): " + ctx.outside.slice(outsideBefore).join(" "));

  // 질문 시트: '네트워크 연결 필요'
  const net = await page.evaluate(() => { PaperApp.openSheet({ quote: "q", selection: "S" }); return document.querySelector("#sheet-tools .os-net")?.textContent || ""; });
  assert.match(net, /^네트워크 연결 필요/);

  // 다시 연결: 배너가 사라지고 열린 시트의 안내도 다시 그려짐
  await ctx.setOffline(false);
  await until(page, () => !document.querySelector(".os-banner") && !document.querySelector("#sheet-tools .os-net"));

  // 안 연 논문은 오프라인 페이지
  await ctx.setOffline(true);
  const p2 = await ctx.newPage();
  await p2.goto(`${BASE}/paper/2301.00001`).catch(() => {});
  assert.match(await p2.textContent("body"), /오프라인입니다/);
  // paper.html의 window.PREWARM = fetch(...)는 오프라인이면 app.js가 .catch를 붙이기 전에 거부될 수 있음
  // (공용 기반의 처리 안 된 거부, 동작에는 영향 없음) → 그 인라인 스크립트에서 난 'Failed to fetch'만 뺌
  assert.deepEqual(errors.filter(e => !/^TypeError: Failed to fetch\n\s+at http:\/\/[^/]+\/paper\/2401\.00001:\d+:\d+$/.test(e)), []);
  await ctx.close();
});

test("저장 해제: '실행 취소'(오프라인에서도)로 그대로 되돌림, 취소 안 하면 잠시 뒤 그림 저장본을 지움", async browser => {
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  await open(page);
  await until(page, () => navigator.serviceWorker && navigator.serviceWorker.controller);
  await menu(page, "오프라인 저장");
  await until(page, () => /오프라인 저장 완료/.test(document.getElementById("pr-toast")?.textContent || ""), null, 30000);
  const savedCount = () => page.evaluate(async () => (await (await caches.open("paper-v2-saved")).keys()).length);
  assert.equal(await savedCount(), 3);
  const unsave = async () => {
    await menu(page, "오프라인 저장됨");
    await until(page, () => /그림 3\/3개/.test(document.querySelector(".os-info")?.textContent || ""));
    await page.locator(".pr-peek-actions button", { hasText: "저장 해제" }).click();
    await until(page, () => /해제했습니다/.test(document.getElementById("pr-toast")?.textContent || ""));
    assert.equal(await page.evaluate(() => PaperStore.paper("offline-save")), null);
  };

  await ctx.setOffline(true);
  await unsave();
  await page.locator("#pr-toast button", { hasText: "실행 취소" }).click();
  assert.equal((await page.evaluate(() => PaperStore.paper("offline-save"))).n, 3);
  await page.waitForTimeout(6500);
  assert.equal(await savedCount(), 3, "되돌린 뒤에는 지우지 않음");
  await ctx.setOffline(false);

  await unsave();
  assert.equal(await savedCount(), 3, "되돌리기 시간 동안은 남겨 둠");
  await until(page, async () => (await (await caches.open("paper-v2-saved")).keys()).length === 0, null, 10000);
  await ctx.close();
});

test("프록시로 받은 그림(같은 출처, 실제 크기 Response)도 <img>(no-cors) 요청에 그대로 쓰임", async browser => {
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  await open(page);
  await until(page, () => navigator.serviceWorker && navigator.serviceWorker.controller);
  await open(page); // SW가 제어하는 상태로 한 번 더 열어 페이지·정적 파일을 캐시에 (둘러보기 저장)
  // offline-save.sw.js가 저장하는 모양 그대로: arXiv 주소 키에 새로 만든 Response (불투명 아님)
  await page.evaluate(async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="111" height="77"/>';
    const c = await caches.open("paper-v2-saved");
    await c.put("https://arxiv.org/html/2401.00001v1/x1.png", new Response(new Blob([svg]), { headers: { "Content-Type": "image/svg+xml" } }));
  });
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => window.PaperApp && document.readyState === "complete");
  const w = await page.evaluate(async () => {
    const i = document.querySelector("#paper img");
    if (!i.complete) await new Promise(res => { i.onload = i.onerror = res; });
    return i.naturalWidth;
  });
  assert.equal(w, 111);
  await ctx.close();
});

(async () => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { console.log("SKIP Chromium 실행 불가:", String(e).split("\n")[0]); process.exit(0); }
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn(browser);
      console.log(`  ok   ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL ${t.name}\n${e && e.stack ? e.stack : e}`);
    }
  }
  await browser.close();
  console.log(`offline-save.browser.js: ${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
