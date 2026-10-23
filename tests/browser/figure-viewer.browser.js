// figure-viewer 브라우저 확인 (헤드리스 Chromium + Playwright, 전체 번들). tests/test_browser.py가 서버를 띄우고 실행:
//   node tests/browser/figure-viewer.browser.js <port>
// playwright나 Chromium이 없으면 "SKIP"을 찍고 종료 코드 0.
"use strict";
const assert = require("node:assert/strict");

let chromium;
try { ({ chromium } = require("playwright")); } catch { console.log("SKIP playwright 없음"); process.exit(0); }

const PORT = process.argv[2];
const BASE = `http://127.0.0.1:${PORT}`;
const PAPER = `${BASE}/paper/2401.00001`;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 바깥 네트워크는 막고, 논문 그림은 width/height와 같은 비율의 SVG로 (실제 크기로 로드)
const IMG_SIZE = { "x1.png": [598, 300], "x2.png": [300, 200], "x3.svg": [300, 200] };
async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 800 }, serviceWorkers: "block", hasTouch: false });
  await ctx.route(u => !u.href.startsWith(BASE), r => {
    if (r.request().resourceType() !== "image") return r.fulfill({ status: 200, body: "", contentType: "text/plain" });
    const [w, h] = IMG_SIZE[r.request().url().split("/").pop()] || [300, 200];
    return r.fulfill({ status: 200, body: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"/>`, contentType: "image/svg+xml" });
  });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", e => page.errors.push(`${e}\n${e.stack || ""}`));
  return page;
}
async function open(page) {
  await page.goto(PAPER);
  await page.waitForFunction(() => window.PaperApp && PaperApp.has("figure-viewer") && document.readyState === "complete");
  await page.evaluate(() => Promise.all([...document.querySelectorAll("#paper img")].map(i => i.decode().catch(() => {}))));
}
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 5000 });
const viewer = page => page.evaluate(() => {
  const v = document.querySelector(".fv-viewer");
  if (!v) return null;
  const vis = sel => { const el = v.querySelector(sel); return !!el && !el.hidden; };
  return {
    title: v.querySelector(".fv-title").textContent, scale: Number(v.dataset.scale),
    cap: v.querySelector(".fv-cap").textContent.replace(/\s+/g, " ").trim(),
    img: v.querySelector(".fv-content img")?.getAttribute("src")?.split("/").pop() || null,
    clone: !!v.querySelector(".fv-content.fv-clone"), ids: v.querySelectorAll(".fv-content [id], .fv-cap [id]").length,
    share: vis(".fv-orig"), ai: vis(".fv-ai"), prev: vis(".fv-prev"), next: vis(".fv-next"),
  };
});
const tapImg = (page, id) => page.click(`[id="${id}"] img`);
// 무대(.fv-stage)에 합성 포인터 이벤트 (두 손가락 핀치 등 Playwright가 못 하는 입력)
const pointer = (page, list) => page.evaluate(async list => {
  const stage = document.querySelector(".fv-stage"), r = stage.getBoundingClientRect();
  const frame = () => new Promise(res => requestAnimationFrame(() => res()));
  for (const [type, id, x, y, wait] of list) {
    stage.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: "touch", isPrimary: id === 1, clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true }));
    if (wait) await frame();
  }
  await frame();
}, list);
const myErrors = page => page.errors.filter(e => e.includes("figure-viewer"));

test("그림 탭 → 전체화면 뷰어: 버튼 확대·맞춤, 다음/이전·화살표, 패널 캡션, Esc로 닫힘", async browser => {
  const page = await newPage(browser);
  await open(page);
  await tapImg(page, "S2.F1");
  await until(page, () => document.querySelector(".fv-viewer"));
  let v = await viewer(page);
  assert.equal(v.title, "Figure 1 · 1 / 6");
  assert.equal(v.img, "x1.png");
  assert.equal(v.scale, 1);
  assert.match(v.cap, /Architecture of the sparse mixture layer/);
  assert.deepEqual([v.prev, v.next, v.share], [false, true, true]);
  assert.equal(v.ai, await page.evaluate(() => PaperApp.has("figure-explain")));
  // 맞춤 크기: 화면 너비에 꽉 (여백 8px), 가운데
  const fit = await page.evaluate(() => {
    const s = document.querySelector(".fv-stage").getBoundingClientRect(), c = document.querySelector(".fv-content").getBoundingClientRect();
    return { w: Math.round(c.width), sw: Math.round(s.width), mid: Math.round(c.top + c.height / 2 - (s.top + s.height / 2)) };
  });
  assert.equal(fit.w, fit.sw - 16);
  assert.ok(Math.abs(fit.mid) <= 1, JSON.stringify(fit));
  await page.click(".fv-top button[aria-label='확대']");
  assert.equal((await viewer(page)).scale, 1.5);
  await page.click(".fv-top button[aria-label='확대']");
  assert.equal((await viewer(page)).scale, 2.25);
  await page.click(".fv-top button[aria-label='축소']");
  assert.equal((await viewer(page)).scale, 1.5);
  await page.click(".fv-fit");
  assert.equal((await viewer(page)).scale, 1);
  await page.click(".fv-next");
  v = await viewer(page);
  assert.equal(v.title, "Figure 2 (a) · 2 / 6");
  assert.match(v.cap, /Training loss.*Training curves/);
  await page.keyboard.press("ArrowRight");
  assert.equal((await viewer(page)).title, "Figure 2 (b) · 3 / 6");
  await page.keyboard.press("ArrowRight");
  v = await viewer(page);
  assert.deepEqual([v.title, v.img, v.clone, v.share, v.ids], ["Figure 3 · 4 / 6", null, true, false, 0]);
  await page.keyboard.press("ArrowLeft");
  assert.equal((await viewer(page)).img, "x3.svg");
  await page.keyboard.press("Escape");
  await until(page, () => !document.querySelector(".fv-viewer") && !PaperUI.topLayer());
  assert.deepEqual(myErrors(page), []);
  await page.context().close();
});

test("손가락: 핀치 확대, 확대 중 끌면 이동(넘기지 않음), 두 번 탭 2.5x↔1x, 맞춤에서 밀면 넘기기, 아래로 끌면 닫힘", async browser => {
  const page = await newPage(browser);
  await open(page);
  await tapImg(page, "S2.F1");
  await until(page, () => document.querySelector(".fv-viewer"));
  // 두 손가락 100px → 200px: 2배
  await pointer(page, [["pointerdown", 1, 100, 300], ["pointerdown", 2, 200, 300], ["pointermove", 2, 300, 300, true],
    ["pointermove", 1, 100, 300, true], ["pointerup", 2, 300, 300], ["pointerup", 1, 100, 300]]);
  let v = await viewer(page);
  assert.equal(v.scale, 2);
  assert.equal(v.title, "Figure 1 · 1 / 6");
  // 확대 중 한 손가락으로 왼쪽 끌기: 같은 그림, 위치만 바뀜
  const x0 = await page.evaluate(() => document.querySelector(".fv-content").getBoundingClientRect().left);
  await pointer(page, [["pointerdown", 1, 300, 300], ["pointermove", 1, 200, 300, true], ["pointermove", 1, 150, 300, true], ["pointerup", 1, 150, 300]]);
  const x1 = await page.evaluate(() => document.querySelector(".fv-content").getBoundingClientRect().left);
  v = await viewer(page);
  assert.equal(v.title, "Figure 1 · 1 / 6");
  assert.ok(x1 < x0 - 100, `${x0} → ${x1}`);
  // 두 번 탭: 확대 상태 → 맞춤, 다시 두 번 탭 → 2.5배
  const dbl = [["pointerdown", 1, 200, 200], ["pointerup", 1, 200, 200], ["pointerdown", 1, 202, 201], ["pointerup", 1, 202, 201]];
  await pointer(page, dbl);
  assert.equal((await viewer(page)).scale, 1);
  await pointer(page, dbl);
  assert.equal((await viewer(page)).scale, 2.5);
  await pointer(page, dbl);
  assert.equal((await viewer(page)).scale, 1);
  // 맞춤에서 왼쪽으로 밀기 → 다음 그림, 오른쪽 → 이전
  await pointer(page, [["pointerdown", 1, 300, 300], ["pointermove", 1, 200, 305, true], ["pointerup", 1, 150, 305]]);
  assert.equal((await viewer(page)).title, "Figure 2 (a) · 2 / 6");
  await pointer(page, [["pointerdown", 1, 100, 300], ["pointermove", 1, 200, 300, true], ["pointerup", 1, 250, 300]]);
  assert.equal((await viewer(page)).title, "Figure 1 · 1 / 6");
  // 첫 그림에서 더 이전으로 밀면 제자리
  await pointer(page, [["pointerdown", 1, 100, 300], ["pointerup", 1, 250, 300]]);
  assert.equal((await viewer(page)).title, "Figure 1 · 1 / 6");
  // 휠(트랙패드 핀치) = 확대
  const box = await page.evaluate(() => { const r = document.querySelector(".fv-stage").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(box.x, box.y);
  await page.mouse.wheel(0, -300);
  await until(page, () => Number(document.querySelector(".fv-viewer").dataset.scale) > 1.3);
  await page.click(".fv-fit");
  // 아래로 끌면 닫힘
  await pointer(page, [["pointerdown", 1, 200, 150], ["pointermove", 1, 205, 300, true], ["pointerup", 1, 205, 330]]);
  await until(page, () => !document.querySelector(".fv-viewer") && !PaperUI.topLayer());
  assert.deepEqual(myErrors(page), []);
  await page.context().close();
});

test("페이지 확대 막기: iOS gesture 이벤트 preventDefault, touch-action none (캡션만 세로 스크롤)", async browser => {
  const page = await newPage(browser);
  await open(page);
  await tapImg(page, "S2.F1");
  await until(page, () => document.querySelector(".fv-viewer"));
  const r = await page.evaluate(() => {
    const stage = document.querySelector(".fv-stage"), out = {};
    for (const t of ["gesturestart", "gesturechange"]) {
      const e = new Event(t, { bubbles: true, cancelable: true });
      stage.dispatchEvent(e);
      out[t] = e.defaultPrevented;
    }
    const ta = sel => getComputedStyle(document.querySelector(sel)).touchAction;
    return { ...out, viewer: ta(".fv-viewer"), stage: ta(".fv-stage"), cap: ta(".fv-cap"),
      z: getComputedStyle(document.querySelector(".fv-viewer")).zIndex };
  });
  assert.deepEqual(r, { gesturestart: true, gesturechange: true, viewer: "none", stage: "none", cap: "pan-y", z: "30" });
  await page.context().close();
});

test("시스템 Back으로 닫힘, AI 설명은 figure-explain이 있을 때만 → paper:figure-explain {figureEl}, 시트가 열리면 뷰어 닫힘", async browser => {
  const page = await newPage(browser);
  await open(page);
  const url = page.url();
  await tapImg(page, "S2.F1");
  await until(page, () => document.querySelector(".fv-viewer"));
  await page.goBack();
  await until(page, () => !document.querySelector(".fv-viewer"));
  assert.equal(page.url(), url);
  // figure-explain이 없으면(이 테스트에서) 등록만 해서 버튼이 보이는지 확인. 실제 기능의 처리기는 막고 이벤트만 받음
  await page.evaluate(() => {
    if (!PaperApp.has("figure-explain")) PaperApp.registerFeature("figure-explain");
    window.__fe = [];
    window.addEventListener("paper:figure-explain", e => { window.__fe.push(e.detail.figureEl.id); e.stopImmediatePropagation(); }, true);
  });
  await tapImg(page, "S2.F2.sf2");
  await until(page, () => document.querySelector(".fv-viewer"));
  const v = await viewer(page);
  assert.deepEqual([v.title, v.ai], ["Figure 2 (b) · 3 / 6", true]);
  await page.click(".fv-ai");
  assert.deepEqual(await page.evaluate(() => window.__fe), ["S2.F2"]);
  // 시트를 열면 기반이 뷰어를 닫음 (reason "sheet")
  await page.evaluate(() => PaperApp.openSheet({ quote: "Figure 2", selection: "Figure 2" }));
  await until(page, () => !document.querySelector(".fv-viewer") && PaperApp.isSheetOpen());
  assert.deepEqual(myErrors(page), []);
  await page.context().close();
});

test("📌 고정: 뷰어가 닫히고 id 없는 고정 창이 스크롤해도 화면 안, 끌어 옮기기(화면 안으로 제한), 누르면 뷰어, 시트 아래, ✕로 닫힘", async browser => {
  const page = await newPage(browser);
  await open(page);
  await tapImg(page, "S2.F1");
  await until(page, () => document.querySelector(".fv-viewer"));
  await page.click("text=📌 고정");
  await until(page, () => !document.querySelector(".fv-viewer") && document.querySelector(".fv-pin"));
  const rect = () => page.evaluate(() => {
    const r = document.querySelector(".fv-pin").getBoundingClientRect(), bar = document.getElementById("bar").getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, bar: bar.bottom, vw: innerWidth, vh: innerHeight };
  });
  let r = await rect();
  assert.equal(await page.evaluate(() => document.querySelectorAll(".fv-pin [id]").length), 0);
  assert.equal(await page.evaluate(() => document.querySelectorAll(".fv-pin").length), 1);
  assert.ok(r.t >= r.bar && r.r <= r.vw && r.l >= 0, JSON.stringify(r));
  assert.ok(Math.abs(r.w - 412 * 0.4) < 2, `40vw: ${r.w}`);
  await page.evaluate(() => window.scrollBy(0, 1200));
  await sleep(100);
  const r2 = await rect();
  assert.deepEqual([r2.l, r2.t], [r.l, r.t]);
  // 끌어서 옮기기
  const head = { x: r.l + 30, y: r.t + 10 };
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(head.x - 100, head.y + 200, { steps: 5 });
  await page.mouse.up();
  r = await rect();
  assert.ok(Math.abs(r.t - (r2.t + 200)) < 2 && Math.abs(r.l - (r2.l - 100)) < 2, JSON.stringify([r2, r]));
  // 화면 밖으로 끌어도 안쪽에 멈춤
  await page.mouse.move(r.l + 30, r.t + 10);
  await page.mouse.down();
  await page.mouse.move(-500, 2000, { steps: 5 });
  await page.mouse.up();
  r = await rect();
  assert.ok(r.l >= 8 && r.b <= r.vh - 7, JSON.stringify(r));
  // 시트(z 20)가 고정 창(z 15)을 덮음
  await page.evaluate(() => PaperApp.openSheet({ quote: "x", selection: "x" }));
  const covered = await page.evaluate(() => {
    const r = document.querySelector(".fv-pin").getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.bottom - 5)?.closest("#sheet") != null;
  });
  assert.ok(covered, "시트가 고정 창 위에 있어야 함");
  await page.evaluate(() => PaperApp.closeSheet());
  // 누르면 그 그림으로 뷰어
  await page.click(".fv-pin-body");
  await until(page, () => document.querySelector(".fv-viewer"));
  assert.equal((await viewer(page)).title, "Figure 1 · 1 / 6");
  await page.keyboard.press("Escape");
  await until(page, () => !document.querySelector(".fv-viewer"));
  // 다른 그림을 고정하면 바뀜 (하나만)
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("paper:open-figure", { detail: { figureEl: document.getElementById("S2.T1") } })));
  await until(page, () => document.querySelector(".fv-viewer"));
  await page.click("text=📌 고정");
  await until(page, () => !document.querySelector(".fv-viewer"));
  assert.deepEqual(await page.evaluate(() => [document.querySelectorAll(".fv-pin").length, document.querySelector(".fv-pin-head span").textContent,
    !!document.querySelector(".fv-pin-clone table")]), [1, "Table 1", true]);
  await page.click(".fv-pin-x");
  assert.equal(await page.evaluate(() => document.querySelectorAll(".fv-pin").length), 0);
  assert.deepEqual(myErrors(page), []);
  await page.context().close();
});

test("그림·표 모아보기: ⋯ 메뉴 → 격자 5칸, 표 누르면 뷰어(복제본, 공유 숨김), 닫으면 격자로, 본문 위치로 → 점프", async browser => {
  const page = await newPage(browser);
  await open(page);
  await page.click("#bar-more");
  await page.click(".pr-menu-item:has-text('그림·표 모아보기')");
  await until(page, () => document.querySelector(".fv-grid-peek"));
  const tiles = await page.evaluate(() => [...document.querySelectorAll(".fv-tile")].map(t => [t.querySelector("b").textContent, t.querySelector(".fv-thumb img") ? "img" : "mini"]));
  assert.deepEqual(tiles, [["Figure 1", "img"], ["Figure 2", "img"], ["Figure 3", "mini"], ["Table 1", "mini"], ["Algorithm 1", "mini"]]);
  assert.equal(await page.evaluate(() => document.querySelectorAll(".fv-grid [id], .fv-grid a").length), 0);
  await page.click(".fv-tile:has-text('Table 1')");
  await until(page, () => document.querySelector(".fv-viewer"));
  let v = await viewer(page);
  assert.deepEqual([v.title, v.clone, v.share, v.ids], ["Table 1 · 5 / 6", true, false, 0]);
  assert.match(v.cap, /Results on two benchmarks/);
  assert.ok(await page.evaluate(() => !!document.querySelector(".fv-content table")));
  await page.keyboard.press("Escape");
  await until(page, () => !document.querySelector(".fv-viewer"));
  assert.ok(await page.evaluate(() => !!document.querySelector(".fv-grid-peek")), "뷰어를 닫으면 격자가 남아 있음");
  await page.click(".fv-tile:has-text('Figure 2')");
  await until(page, () => document.querySelector(".fv-viewer"));
  assert.equal((await viewer(page)).title, "Figure 2 (a) · 2 / 6");
  await page.click("text=본문 위치로");
  await until(page, () => !document.querySelector(".fv-viewer") && !document.querySelector(".fv-grid-peek") && !document.getElementById("back-chip").hidden);
  await sleep(600);
  const inView = await page.evaluate(() => { const r = document.getElementById("S2.F2.sf1").getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; });
  assert.ok(inView, "본문의 그림으로 이동");
  assert.deepEqual(myErrors(page), []);
  await page.context().close();
});

test("paper:open-figure {figureEl | img}: 그 그림·패널에서 열림", async browser => {
  const page = await newPage(browser);
  await open(page);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("paper:open-figure", { detail: { figureEl: document.getElementById("S2.F2") } })));
  await until(page, () => document.querySelector(".fv-viewer"));
  assert.equal((await viewer(page)).title, "Figure 2 (a) · 2 / 6");
  // 열린 채로 다른 그림을 요청하면 같은 뷰어에서 바뀜
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("paper:open-figure", { detail: { img: document.querySelector('[id="S2.F2.sf2"] img') } })));
  await until(page, () => document.querySelector(".fv-title").textContent.startsWith("Figure 2 (b)"));
  assert.equal(await page.evaluate(() => document.querySelectorAll(".fv-viewer").length), 1);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("paper:open-figure", { detail: { figureEl: document.getElementById("alg1") } })));
  await until(page, () => document.querySelector(".fv-title").textContent === "Algorithm 1 · 6 / 6");
  assert.deepEqual(myErrors(page), []);
  await page.context().close();
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
  console.log(`figure-viewer.browser.js: ${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
