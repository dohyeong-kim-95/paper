// smart-presets 브라우저 동작 (전체 기능 번들, 헤드리스 Chromium + Playwright). tests/test_browser.py가 실행:
//   node tests/browser/smart-presets.browser.js <port>
// playwright(NODE_PATH)나 Chromium이 없으면 "SKIP"을 찍고 종료 코드 0.
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
const MEANING_Q = "선택한 표현의 한국어 뜻을 사전처럼 알려줘";
const STYLE_SHORT = "\n\n<style>길이: 짧게(5문장 이내) · 독자: 대학원생</style>";

// 바깥 네트워크는 막고(그림은 같은 비율의 SVG), /api/ask는 기록 후 고정 답. 다른 /api/*는 빈 404 (다른 기능의 생성 호출 차단)
async function newPage(browser, { init } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 800 }, serviceWorkers: "block" });
  await ctx.route(u => !u.href.startsWith(BASE), r => (r.request().resourceType() === "image"
    ? r.fulfill({ status: 200, body: '<svg xmlns="http://www.w3.org/2000/svg" width="598" height="300"/>', contentType: "image/svg+xml" })
    : r.fulfill({ status: 200, body: "", contentType: "text/plain" })));
  await ctx.route(u => u.href.startsWith(`${BASE}/api/`) && !/\/api\/(ask|prewarm)/.test(u.pathname), r => r.fulfill({ status: 404, body: "{}", contentType: "application/json" }));
  const asks = [];
  await ctx.route(`${BASE}/api/ask`, async r => {
    asks.push(JSON.parse(r.request().postData() || "{}"));
    try { await r.fulfill({ status: 200, body: `답변 ${asks.length}`, contentType: "text/plain; charset=utf-8" }); } catch { /* 중단 */ }
  });
  await ctx.addInitScript(() => {
    // 요소 안에서 링크·수식·기능 UI 밖의, 글자가 있는 첫 텍스트 노드 / 그 안의 [from, from+len) 범위
    window.__text = (el, re) => {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode()) && (n.data.trim().length < 6 || n.parentElement.closest("a, math, .pr-ui") || (re && !re.test(n.data)))) { /* 다음 */ }
      return n;
    };
    window.__range = (el, len = 3, word = null) => {
      const n = __text(el, word ? new RegExp(word) : null), i = word ? n.data.indexOf(word) : n.data.search(/\S/), r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + len);
      return r;
    };
  });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", e => page.errors.push(String(e)));
  page.asks = asks;
  return page;
}
async function open(page) {
  await page.goto(PAPER);
  await page.waitForFunction(() => window.PaperApp && PaperApp.has("smart-presets") && document.readyState === "complete");
}
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 5000 });
// 프로그램 선택 뒤 앱의 selectionchange 디바운스(150ms)가 끝날 때까지 기다림 (사람 손보다 빠른 클릭 방지)
const select = async (page, sel, len, word) => {
  await page.evaluate(([sel, len, word]) => PaperApp.selectRange(__range(document.querySelector(sel), len, word)), [sel, len, word]);
  await sleep(250);
};
const selBar = page => page.evaluate(() => [...document.querySelectorAll("#sel-bar button")].map(b => b.dataset.id));
const clickSel = async (page, id) => { await until(page, id => !!document.querySelector(`#sel-bar [data-id="${id}"]`), id); await page.click(`#sel-bar [data-id="${id}"]`); };
async function textPoint(page, sel, word, y = 200) {
  return page.evaluate(([sel, word, y]) => {
    const r = __range(document.querySelector(sel), 3, word);
    window.scrollBy(0, r.getBoundingClientRect().top - y);
    const b = r.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, [sel, word, y]);
}
const selText = page => page.evaluate(() => (PaperApp.sel() || {}).text || null);

test("선택 버튼 줄: 설명·번역·문장 맞추기 순서, 한 단어 '설명' → 사전 카드 한 번에, 수식 '설명' → 수식 풀이(LaTeX 포함)", async browser => {
  const page = await newPage(browser);
  await open(page);
  await select(page, "#S1\\.p1", 5); // "Large"
  await until(page, () => !document.getElementById("sel-bar").hidden);
  assert.deepEqual(await selBar(page), ["ask", "smart-presets:explain", "smart-presets:translate", "smart-presets:snap"]);
  await clickSel(page, "smart-presets:explain");
  await until(page, () => PaperApp.session && PaperApp.session.history.length === 2);
  const a = page.asks[0];
  assert.ok(a.question.startsWith(MEANING_Q), a.question);
  assert.ok(a.question.endsWith("<style>독자: 대학원생</style>"), "뜻 카드는 자기 형식: 길이 없이 독자만");
  assert.equal(a.selection, "Large");
  const r = await page.evaluate(() => ({
    card: document.querySelector("#answer .turn:last-child").classList.contains("sp-card"),
    meta: PaperApp.session.meta[0].presetId, presets: [...document.querySelectorAll("#presets button")].map(b => b.dataset.id),
    shown: document.querySelector("#answer .turn .q").textContent.includes("<style>"),
  }));
  assert.deepEqual(r, { card: true, meta: "meaning", presets: ["meaning", "translate", "easy", "why", "smart-presets:add"], shown: false });

  await page.evaluate(() => { PaperApp.closeSheet(); const rg = document.createRange(); rg.selectNode(document.getElementById("S1.p1.m1")); PaperApp.selectRange(rg); });
  await clickSel(page, "smart-presets:explain");
  await until(page, () => PaperApp.session && PaperApp.session.history.length === 2);
  const m = page.asks[1];
  assert.ok(m.question.startsWith("이 수식을 풀어줘") && m.question.includes("수식: $x^{2}$"), m.question);
  assert.ok(m.question.endsWith("<style>길이: 보통(3문단 이내) · 독자: 대학원생</style>"), m.question);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("#presets button")].map(b => b.dataset.id).slice(0, 2)), ["equation", "intuition"]);
  assert.deepEqual(page.errors, []);
});

test("스타일 칩·설정: '짧게'는 다음 질문부터, 후속 질문의 앞 턴은 바이트 같음, 관심 분야는 새 대화 첫 턴 context에만", async browser => {
  const page = await newPage(browser);
  await open(page);
  await select(page, "#S1\\.p1", 8);
  await clickSel(page, "ask");
  await until(page, () => PaperApp.isSheetOpen() && !!document.querySelector("#sheet-tools .sp-style"));
  await page.click('.sp-style [aria-label="답변 길이"] [data-v="short"]');
  await page.click(".sp-gear");
  await until(page, () => !!document.querySelector(".sp-peek input.sp-input"));
  await page.fill(".sp-peek input.sp-input", "컴퓨터 비전");
  await page.click('.sp-peek [aria-label="모드"] [data-v="guide"]');
  await page.click(".sp-peek .pr-peek-x");
  assert.equal(await page.evaluate(() => document.querySelector(".sp-gear-x").textContent), "학습·분야");
  await page.fill("#q", "Q1");
  await page.press("#q", "Enter");
  await until(page, () => PaperApp.session.history.length === 2);
  await page.evaluate(() => PaperStore.set("smart-presets:style", { ...PaperStore.get("smart-presets:style"), mode: "normal" }));
  await page.fill("#q", "Q2");
  await page.press("#q", "Enter");
  await until(page, () => PaperApp.session.history.length === 4);
  const [a, b] = page.asks;
  assert.ok(a.question.startsWith(`Q1\n\n<style>길이: 짧게(5문장 이내) · 독자: 대학원생 · 모드: 학습 가이드`), a.question);
  assert.equal(b.question, `Q2${STYLE_SHORT}`);
  assert.equal(b.history[0].content, a.question, "기록에는 보낸(바뀐) 질문 그대로");
  assert.ok(!a.context.includes("<reader>"), "열려 있던 대화에는 분야를 붙이지 않음");

  await page.evaluate(() => PaperApp.closeSheet());
  await select(page, "#S2\\.p1", 8);
  await clickSel(page, "ask");
  await page.fill("#q", "Q3");
  await page.press("#q", "Enter");
  await until(page, () => PaperApp.session.history.length === 2);
  await page.fill("#q", "Q4");
  await page.press("#q", "Enter");
  await until(page, () => PaperApp.session.history.length === 4);
  const [, , c, d] = page.asks;
  assert.ok(c.context.endsWith("<reader>관심 분야: 컴퓨터 비전 (관련 있으면 이 분야의 예·비유로 설명)</reader>"), c.context);
  assert.equal(d.context, c.context);
  assert.equal(d.history[0].content, c.question);
  assert.deepEqual(page.errors, []);
});

test("문장 맞추기: 문장 중간 몇 글자 → 그 문장 전체, 처음 한 번 문장 선택 모드 안내", async browser => {
  const page = await newPage(browser);
  await open(page);
  await select(page, "#S1\\.p1", 11, "routes each");
  await clickSel(page, "smart-presets:snap");
  await until(page, () => (PaperApp.sel() || {}).text?.startsWith("We propose"));
  assert.equal(await selText(page), "We propose a sparse mixture of experts model that routes each token to two experts [1, 2].");
  await until(page, () => !document.getElementById("sel-bar").hidden);
  await until(page, () => (document.getElementById("pr-toast")?.textContent || "").includes("문장 선택 모드 켜기"));
  await page.click("#pr-toast button");
  assert.equal(await page.evaluate(() => [document.body.classList.contains("sp-sentence-on"), PaperStore.get("smart-presets:sentence-mode")].join()), "true,true");
  // 여러 문장에 걸친 선택 → 첫 문장 시작부터 마지막 문장 끝까지
  await page.evaluate(() => {
    const p = document.querySelector("#S1\\.p1 p"), r = document.createRange();
    const a = __text(p, /scale well/), b = __text(p, /compresses/);
    r.setStart(a, a.data.indexOf("scale")); r.setEnd(b, b.data.indexOf("compresses") + 4);
    PaperApp.selectRange(r);
  });
  await clickSel(page, "smart-presets:snap");
  await until(page, () => /^Large language.*the KD loss is cheap\.1$/.test((PaperApp.sel() || {}).text || "")); // 각주 번호까지 그 문장
  assert.deepEqual(page.errors, []);
});

test("문장 선택 모드: 탭 = 문장, 빠른 두 번 탭 = 문단, 천천히 다시 탭 = 해제, 시트가 열려 있으면 내려두기", async browser => {
  const page = await newPage(browser, { init: () => localStorage.setItem("pr:smart-presets:sentence-mode", "true") });
  await open(page);
  const p = await textPoint(page, "#S1\\.p1", "routes");
  await page.mouse.click(p.x, p.y);
  await until(page, () => (PaperApp.sel() || {}).text?.startsWith("We propose"));
  assert.equal(await selText(page), "We propose a sparse mixture of experts model that routes each token to two experts [1, 2].");
  await until(page, () => !document.getElementById("sel-bar").hidden);
  await sleep(400); // 이미 고른 문장을 나중에 두 번 탭해도 문단 (첫 탭의 해제는 두 번째 탭이 취소)
  await page.mouse.click(p.x, p.y);
  await page.mouse.click(p.x, p.y);
  await until(page, () => /^Large language models.*sparse-moe\.$/.test((PaperApp.sel() || {}).text || ""));
  await page.mouse.click(p.x, p.y); // 빠른 세 번째 탭: 문단 그대로
  await sleep(450);
  assert.ok(/^Large language models.*sparse-moe\.$/.test(await selText(page)));
  await page.mouse.click(p.x, p.y); // 천천히 다시 탭 → 해제
  await until(page, () => !PaperApp.sel() && document.getElementById("sel-bar").hidden);
  // 다른 문단·각주 번호 뒤 문장
  const q = await textPoint(page, "#S1\\.p1", "Our implementation");
  await page.mouse.click(q.x, q.y);
  await until(page, () => (PaperApp.sel() || {}).text?.startsWith("Our implementation"));
  // 시트가 열린 채 탭 → 문장을 고르지 않음: 첫 탭은 남아 있던 선택만 풀고(공용 규칙), 다음 탭은 내려두기
  await clickSel(page, "smart-presets:explain");
  await until(page, () => PaperApp.session && PaperApp.session.history.length === 2);
  const r = await textPoint(page, "#S2\\.p1", "router computes", 120);
  await page.mouse.click(r.x, r.y);
  await sleep(500);
  assert.ok(!((await selText(page)) || "").startsWith("The router"));
  await page.mouse.click(r.x, r.y);
  await until(page, () => !PaperApp.isSheetOpen() && !document.getElementById("sheet-pill").hidden);
  assert.equal(await selText(page), null);
  assert.deepEqual(page.errors, []);
});

test("번역: section-translate 캐시가 덮으면 Claude 없이 쌍을 보여 주고 '더 자세히'로 질문, 없으면 바로 질문", async browser => {
  const page = await newPage(browser);
  await open(page);
  await page.evaluate(() => PaperApp.registerFeature("section-translate", {
    lookup: async s => (s.text.startsWith("Large") ? [{ en: "Large language models scale well.", ko: "대형 언어 모델은 잘 확장된다." }] : null),
  }));
  await select(page, "#S1\\.p1", 8);
  await clickSel(page, "smart-presets:translate");
  await until(page, () => !!document.querySelector("#answer .turn-local .sp-pairs"));
  assert.equal(await page.evaluate(() => document.querySelector(".sp-ko").textContent), "대형 언어 모델은 잘 확장된다.");
  assert.equal(page.asks.length, 0);
  await page.click('#answer .turn-local .turn-tools button');
  await until(page, () => PaperApp.session.history.length === 2);
  assert.equal(page.asks[0].question, "한국어로 번역해줘 (전문 용어는 처음 한 번만 영어 병기, 번역문만)", "번역은 기본 스타일이면 <style> 없음");
  await page.evaluate(() => PaperApp.closeSheet());
  await select(page, "#S2\\.p1", 8);
  await clickSel(page, "smart-presets:translate");
  await until(page, () => PaperApp.session && PaperApp.session.history.length === 2);
  assert.equal(page.asks.length, 2);
  assert.equal(await page.evaluate(() => PaperApp.session.meta[0].presetId), "translate");
  assert.deepEqual(page.errors, []);
});

test("내 프리셋: '+ 내 프리셋'으로 만들기 → 칩 → 템플릿 치환, 설정에서 ✕ 삭제 + 실행 취소", async browser => {
  const page = await newPage(browser);
  await open(page);
  await select(page, "#S1\\.p1", 8);
  await clickSel(page, "ask");
  await until(page, () => !!document.querySelector('#presets [data-id="smart-presets:add"]'));
  await page.click('#presets [data-id="smart-presets:add"]');
  await until(page, () => !!document.querySelector(".sp-peek textarea"));
  await page.fill(".sp-peek input.sp-input", "반론");
  await page.fill(".sp-peek textarea", "반론: ");
  await page.click('.sp-peek .sp-vars button[title="{selection}"]');
  await page.type(".sp-peek textarea", " / {section_title} / {paper_title}");
  await page.click('.sp-peek .pr-peek-actions button:text("저장")');
  await until(page, () => !document.querySelector(".sp-peek") && !!document.querySelector('#presets [data-id^="custom:"]'));
  await page.click('#presets [data-id^="custom:"]');
  await until(page, () => PaperApp.session.history.length === 2);
  assert.ok(page.asks[0].question.startsWith("반론: Large la / 1 Introduction / Sparse Mixtures for Everyone: A Test Paper\n\n<style>"), page.asks[0].question);
  assert.equal(page.asks[0].history.length, 0);
  assert.equal(await page.evaluate(() => PaperStore.get("smart-presets:custom").length), 1);
  await page.click(".sp-gear");
  await until(page, () => !!document.querySelector(".sp-peek .sp-x"));
  await page.click(".sp-peek .sp-x");
  assert.equal(await page.evaluate(() => PaperApp.presets().some(p => p.id.startsWith("custom:"))), false);
  await until(page, () => (document.getElementById("pr-toast")?.textContent || "").includes("실행 취소"));
  await page.click("#pr-toast button");
  assert.equal(await page.evaluate(() => PaperApp.presets().filter(p => p.id.startsWith("custom:")).map(p => p.label).join()), "반론");
  assert.equal(await page.evaluate(() => document.querySelectorAll(".sp-peek .sp-custom").length), 1);
  assert.deepEqual(page.errors, []);
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
  console.log(`smart-presets.browser.js: ${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
