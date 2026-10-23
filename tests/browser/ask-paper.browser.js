// ask-paper 브라우저 확인: FAB → 시작 질문 칩, 답변마다 후속 질문 칩 → 탭하면 질문, 새 질문이면 요청 중단, 복원 턴은 안 부름
//   node tests/browser/ask-paper.browser.js <port>   (tests/test_browser.py가 실행, 전체 기능 번들)
"use strict";
const assert = require("node:assert/strict");

let chromium;
try { ({ chromium } = require("playwright")); } catch { console.log("SKIP playwright 없음"); process.exit(0); }

const PORT = process.argv[2];
const BASE = `http://127.0.0.1:${PORT}`;
const PAPER = `${BASE}/paper/2401.00001`;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// 바깥 네트워크는 막고, /api/ask는 "A<n>", 후속 질문은 테스트가 정한 목록으로
async function newPage(browser, { followups } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 800 }, serviceWorkers: "block" });
  await ctx.route(u => !u.href.startsWith(BASE), r => {
    if (r.request().resourceType() !== "image") return r.fulfill({ status: 200, body: "", contentType: "text/plain" });
    return r.fulfill({ status: 200, body: '<svg xmlns="http://www.w3.org/2000/svg" width="598" height="300"/>', contentType: "image/svg+xml" });
  });
  const asks = [], fus = [];
  await ctx.route(`${BASE}/api/ask`, async r => {
    asks.push(JSON.parse(r.request().postData() || "{}"));
    try { await r.fulfill({ status: 200, body: `A${asks.length}`, contentType: "text/plain; charset=utf-8" }); } catch { /* 중단 */ }
  });
  await ctx.route(`${BASE}/api/ask-paper/followups`, async r => {
    const body = JSON.parse(r.request().postData() || "{}");
    fus.push(body);
    const out = followups ? followups(body, fus.length) : [`후속${fus.length}-a`, `후속${fus.length}-b`, `후속${fus.length}-c`];
    try { await r.fulfill({ status: 200, body: JSON.stringify(out), contentType: "application/json" }); } catch { /* 중단 */ }
  });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", e => page.errors.push(String(e)));
  page.asks = asks;
  page.fus = fus;
  return page;
}
async function open(page) {
  await page.goto(PAPER);
  await page.waitForFunction(() => window.PaperApp && document.readyState === "complete" && PaperApp.has("ask-paper"));
}
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 5000 });
const chips = page => page.$$eval("#answer .ap-followups .ap-chip", els => els.map(e => e.textContent));

test("FAB가 선택 없이 시트를 열고 시작 질문 칩 6개, 칩을 누르면 논문 전체 질문", async browser => {
  const page = await newPage(browser);
  await open(page);
  await page.click('#fab-stack [data-id="ask-paper"]');
  const st = await page.evaluate(() => ({
    sheet: !document.getElementById("sheet").hidden, quote: document.getElementById("quote").hidden,
    title: document.getElementById("sheet-title").textContent,
    presets: [...document.querySelectorAll("#presets button")].map(b => b.textContent),
    fab: getComputedStyle(document.getElementById("fab-stack")).display,
  }));
  assert.deepEqual(st, {
    sheet: true, quote: true, title: "논문에 질문", fab: "none",
    presets: ["핵심 기여는?", "한계점은?", "실험 설정 요약", "기존 연구와 차이", "내 연구에 어떻게 쓸까?", "저자 입장에서 약점 방어"],
  });
  await page.click("#presets button >> nth=0");
  await until(page, () => document.querySelectorAll("#answer .ap-chip").length === 3);
  const a = page.asks[0];
  assert.equal(a.selection, "");
  assert.ok(a.question.includes("핵심 기여"), a.question);
  // 후속 질문 요청: 같은 고정 필드 + 방금 끝난 턴까지, question 비움
  assert.equal(page.fus.length, 1);
  assert.deepEqual(page.fus[0].history, [{ role: "user", content: a.question }, { role: "assistant", content: "A1" }]);
  assert.equal(page.fus[0].question, "");
  assert.deepEqual(await chips(page), ["후속1-a", "후속1-b", "후속1-c"]);
  // 칩 탭 → 그 질문으로 이어서, 지난 칩은 사라지고 새 답 아래에 새 칩
  await page.click("#answer .ap-chip >> nth=1");
  await until(page, () => PaperApp.session.history.length === 4 && document.querySelectorAll("#answer .ap-chip").length === 3);
  assert.ok(page.asks[1].question.includes("후속1-b"));
  assert.equal(page.asks[1].history.length, 2);
  assert.deepEqual(await chips(page), ["후속2-a", "후속2-b", "후속2-c"]);
  assert.equal(await page.$$eval("#answer .turn", ts => ts[0].querySelectorAll(".ap-followups").length), 0);
  assert.equal(page.fus[1].history.length, 4);
  assert.deepEqual(page.errors, []);
});

test("답변 직후 새 질문이면 후속 질문 요청을 보내지 않음, 빈 목록이면 칩 줄 없음", async browser => {
  const page = await newPage(browser, { followups: () => [] });
  await open(page);
  await page.evaluate(() => {
    PaperApp.openSheet({ quote: "x", selection: "SEL", context: "CTX" });
    let once = false;
    PaperApp.on("answer-done", d => { if (!once && !d.restored) { once = true; PaperApp.ask("Q2"); } });
    PaperApp.ask("Q1");
  });
  await until(page, () => PaperApp.session.history.length === 4);
  await page.waitForTimeout(800);
  assert.equal(page.fus.length, 1, "두 번째 답변에 대해서만");
  assert.equal(page.fus[0].history.length, 4);
  assert.equal(page.fus[0].selection, "SEL");
  assert.equal(await page.$$eval("#answer .ap-followups", e => e.length), 0);
});

test("내려둔 논문 전체 대화는 FAB로 이어서 열림, 새로고침 복원 턴은 후속 질문을 다시 부르지 않음", async browser => {
  const page = await newPage(browser);
  await open(page);
  await page.click('#fab-stack [data-id="ask-paper"]');
  await page.click("#presets button >> nth=1");
  await until(page, () => document.querySelectorAll("#answer .ap-chip").length === 3);
  const id = await page.evaluate(() => { PaperApp.minimizeSheet(); return PaperApp.session.id; });
  await page.click('#fab-stack [data-id="ask-paper"]');
  assert.deepEqual(await page.evaluate(() => [PaperApp.isSheetOpen(), PaperApp.session.id, PaperApp.session.history.length]), [true, id, 2]);
  await page.evaluate(() => PaperApp.minimizeSheet());
  await page.reload();
  await page.waitForFunction(() => window.PaperApp && document.readyState === "complete" && PaperApp.session);
  await page.waitForTimeout(500);
  assert.equal(page.fus.length, 1);
  assert.equal(await page.$$eval("#answer .ap-followups", e => e.length), 0);
  // 복원된 대화도 origin이 남아 FAB가 이어서 엶 (시작 질문 칩도 그대로)
  await page.click('#fab-stack [data-id="ask-paper"]');
  assert.deepEqual(await page.evaluate(() => [PaperApp.isSheetOpen(), PaperApp.session.history.length, document.querySelectorAll("#presets button").length]), [true, 2, 6]);
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
  console.log(`ask-paper.browser.js: ${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
