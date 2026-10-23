// section-study 브라우저 확인 (전체 번들, 헤드리스 Chromium + Playwright). tests/test_browser.py가 실행:
//   node tests/browser/section-study.browser.js <port>
"use strict";
const assert = require("node:assert/strict");

let chromium;
try { ({ chromium } = require("playwright")); } catch { console.log("SKIP playwright 없음"); process.exit(0); }

const PORT = process.argv[2];
const BASE = `http://127.0.0.1:${PORT}`;
const PAPER = `${BASE}/paper/2401.00001`;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const GISTS = { S1: "희소 MoE를 제안한다. 계산량 $x^{2}$ 문제를 다룬다.", S2: "라우터가 게이트 점수를 계산한다.", A1: "전문가별 부하를 보고한다." };
const QUIZ = [
  { q: "라우터는 무엇을 계산하나?", choices: ["게이트 점수", "학습률", "메모리", "배치 크기"], a: 0, why: "식 (1)이 게이트 점수다.", quote: "The training loss combines the task loss and a balancing term" },
  { q: "균형 항의 역할은?", choices: ["속도", "부하 균형", "정규화 없음", "출력 크기"], a: 1, why: "부하를 고르게 한다.", quote: "없는 문장입니다 정말로 본문에 없는 문장 여기 있음 끝" },
];
const json = body => ({ status: 200, body: JSON.stringify(body), contentType: "application/json", headers: { "X-Offline-Cacheable": "1" } });

// 바깥 네트워크 차단, /api/ask는 고정 답, section-study API는 테스트가 정한 응답
async function newPage(browser, { gists, quiz } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 800 }, serviceWorkers: "block" });
  await ctx.route(u => !u.href.startsWith(BASE), r => (r.request().resourceType() === "image"
    ? r.fulfill({ status: 200, body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"/>', contentType: "image/svg+xml" })
    : r.fulfill({ status: 200, body: "", contentType: "text/plain" })));
  const asks = [], hits = [];
  await ctx.route(`${BASE}/api/ask`, async r => {
    asks.push(JSON.parse(r.request().postData() || "{}"));
    try { await r.fulfill({ status: 200, body: "답변입니다.", contentType: "text/plain; charset=utf-8" }); } catch { /* 중단 */ }
  });
  await ctx.route(u => u.pathname.startsWith("/api/section-study/"), async r => {
    const url = new URL(r.request().url());
    hits.push(url.pathname + url.search);
    const fn = url.pathname.endsWith("/gists") ? gists : quiz;
    await r.fulfill(await (fn ? fn(url, hits.length) : json(url.pathname.endsWith("/gists") ? GISTS : QUIZ)));
  });
  await ctx.addInitScript(() => {
    window.__gists = [];
    document.addEventListener("paper:gists", e => window.__gists.push(e.detail.map));
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  Object.assign(page, { asks, hits, errors });
  return page;
}
async function open(page) {
  await page.goto(PAPER);
  await page.waitForFunction(() => window.PaperApp && document.readyState === "complete");
}
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 5000 });
const chip = (sid, label) => `[id="${sid}"] > .ss-head .ss-chip:text-is("${label}")`;

test("칩 줄은 제목 바로 뒤(.pr-ui), 퀴즈 칩은 최상위만, 색인에 안 들어감 · idle에 요약을 받아 paper:gists", async browser => {
  const page = await newPage(browser);
  await open(page);
  await until(page, () => window.__gists.length === 1);
  const r = await page.evaluate(() => {
    const heads = [...document.querySelectorAll("#paper .ss-head")];
    return {
      ids: heads.map(h => h.parentElement.id),
      afterTitle: heads.every(h => h.previousElementSibling.classList.contains("ltx_title") && h.classList.contains("pr-ui")),
      quiz: heads.filter(h => [...h.querySelectorAll(".ss-chip")].some(b => b.textContent === "퀴즈")).map(h => h.parentElement.id),
      inIndex: PaperAnchor.index().text.includes("요약"),
      tocTitle: PaperAnchor.textOf(document.querySelector("#S2 > .ltx_title")),
      hiddenNoGist: document.querySelector('[id="S2.SS1"] > .ss-head').hidden,
      map: Object.keys(window.__gists[0]),
      offline: PaperApp.offlineUrls(),
    };
  });
  assert.deepEqual(r, {
    ids: ["S1", "S2", "S2.SS1", "A1"], afterTitle: true, quiz: ["S1", "S2", "A1"], inIndex: false, tocTitle: "2 Method",
    hiddenNoGist: true, map: ["S1", "S2", "A1"], offline: ["/api/section-study/2401.00001/gists"],
  });
  assert.deepEqual(page.hits, ["/api/section-study/2401.00001/gists"]);
  assert.deepEqual(page.errors, []);
});

test("'요약' 칩 → 요약 상자(즉시) → '이 섹션 더 묻기'가 시트를 열고 자동 질문 (칩 탭이 시트를 내려두지 않음)", async browser => {
  const page = await newPage(browser);
  await open(page);
  await until(page, () => window.__gists.length === 1);
  await page.click(chip("S2", "요약"));
  const box = await page.evaluate(() => {
    const b = document.querySelector("#S2 > .ss-head .ss-box");
    return { hidden: b.hidden, text: b.querySelector(".ss-gist").textContent, exp: document.querySelector("#S2 > .ss-head .ss-chip").getAttribute("aria-expanded") };
  });
  assert.deepEqual(box, { hidden: false, text: "라우터가 게이트 점수를 계산한다.", exp: "true" });
  await page.click('#S2 > .ss-head button:text-is("이 섹션 더 묻기")');
  await until(page, () => PaperApp.session && PaperApp.session.history.length === 2);
  const s = await page.evaluate(() => ({ open: PaperApp.isSheetOpen(), quote: PaperApp.session.quote, presets: [...document.querySelectorAll("#presets button")].map(b => b.textContent) }));
  assert.deepEqual(s, { open: true, quote: "2 Method", presets: ["예시로", "논문 흐름에서", "이 섹션 퀴즈"] });
  assert.equal(page.asks[0].question, "2 Method 섹션을 쉽게 풀어줘");
  assert.equal(page.asks[0].section, "2 Method");
  assert.equal(page.asks[0].context, "섹션 요약: 라우터가 게이트 점수를 계산한다.");
  // 시트가 열린 채로 다른 칩 탭(칩이 시트 아래에 깔릴 수 있어 click 이벤트로): 기능 컨트롤이라 '내려두기'가 안 됨
  const after = await page.evaluate(() => {
    document.querySelector("#S1 > .ss-head .ss-chip").click();
    return { sheet: PaperApp.isSheetOpen(), box: !document.querySelector("#S1 > .ss-head .ss-box").hidden };
  });
  assert.deepEqual(after, { sheet: true, box: true });
  assert.deepEqual(page.errors, []);
});

test("퀴즈: 한 문항씩, 오답 표시·해설, 근거 보기 → 점프 + '퀴즈로' 토스트로 이어서, 결과·점수 토스트", async browser => {
  const page = await newPage(browser);
  await open(page);
  await page.click(chip("S2", "퀴즈"));
  await page.waitForSelector(".ss-quiz .ss-choice");
  assert.equal(await page.textContent(".ss-quiz .ss-progress"), "1 / 2");
  await page.click(".ss-quiz .ss-choice >> nth=2");
  const rev = await page.evaluate(() => ({
    right: [...document.querySelectorAll(".ss-choice")].map(b => b.className.replace("ss-choice", "").trim()),
    verdict: document.querySelector(".ss-reveal b").textContent,
    why: document.querySelector(".ss-why").textContent,
    buttons: [...document.querySelectorAll(".ss-reveal button")].map(b => b.textContent),
  }));
  assert.deepEqual(rev, { right: ["ss-right", "", "ss-wrong", ""], verdict: "오답 · 정답은 ①", why: "식 (1)이 게이트 점수다.", buttons: ["근거 보기", "다음 문제"] });
  await page.click('.ss-reveal button:text-is("근거 보기")');
  const j = await page.evaluate(() => ({ peek: !!document.querySelector(".ss-quiz"), depth: PaperNav.depth, toast: document.getElementById("pr-toast").textContent }));
  assert.deepEqual(j, { peek: false, depth: 1, toast: "근거 문장으로 이동했어요퀴즈로" });
  await page.click('#pr-toast button:text-is("퀴즈로")');
  await page.waitForSelector(".ss-quiz .ss-reveal");
  assert.equal(await page.textContent(".ss-quiz .ss-progress"), "1 / 2", "같은 문항으로 이어서");
  await page.click('.ss-reveal button:text-is("다음 문제")');
  assert.equal(await page.textContent(".ss-quiz .ss-progress"), "2 / 2");
  await page.click(".ss-quiz .ss-choice >> nth=1");
  // 근거 문장을 본문에서 못 찾으면 '근거 보기' 없음
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".ss-reveal button")].map(b => b.textContent)), ["결과 보기"]);
  await page.click('.ss-reveal button:text-is("결과 보기")');
  const res = await page.evaluate(() => ({
    score: document.querySelector(".ss-score").textContent,
    marks: [...document.querySelectorAll(".ss-review-item > span:first-child")].map(s => s.textContent),
    toast: document.getElementById("pr-toast").textContent,
  }));
  assert.deepEqual(res, { score: "2문제 중 1개 정답", marks: ["✕", "✓"], toast: "2문제 중 1개 정답" });
  await page.click('.ss-quiz button:text-is("다시 풀기")');
  assert.equal(await page.textContent(".ss-quiz .ss-progress"), "1 / 2");
  assert.deepEqual(page.hits.filter(x => x.includes("/quiz/")), ["/api/section-study/2401.00001/quiz/S2"], "한 번만 받음");
  assert.deepEqual(page.errors, []);
});

test("선택 → 질문하기 → '이 섹션 퀴즈' 프리셋은 최상위 섹션 퀴즈를 엶 (하위 섹션 선택도)", async browser => {
  const page = await newPage(browser);
  await open(page);
  await page.evaluate(() => {
    const n = document.querySelector('[id="S2.SS1.p1"] .ltx_p').firstChild, r = document.createRange();
    r.setStart(n, 3); r.setEnd(n, 11);
    PaperApp.selectRange(r);
  });
  await page.click('#sel-bar button[data-id="ask"]');
  await page.click('#presets button[data-id="section-study:quiz"]');
  await page.waitForSelector(".ss-quiz .ss-choice");
  assert.ok((await page.textContent(".ss-quiz-peek .pr-peek-head b")).includes("2 Method"));
  assert.ok(page.hits.includes("/api/section-study/2401.00001/quiz/S2"));
  assert.equal(page.asks.length, 0, "질문 대신 퀴즈");
});

test("요약 받기 실패: 상태 칩 '다시'와 상자 안 '다시' → 다시 받으면 칩이 사라지고 요약 표시", async browser => {
  let fail = true;
  const page = await newPage(browser, { gists: () => (fail ? { status: 502, body: '{"detail":"x"}', contentType: "application/json" } : json(GISTS)) });
  await open(page);
  await until(page, () => document.querySelector('#status-strip [data-key="section-study"][data-state="error"]'));
  await page.click(chip("S1", "요약"));
  assert.equal(await page.textContent("#S1 > .ss-head .ss-note"), "요약을 불러오지 못했습니다.");
  fail = false;
  await page.click('#S1 > .ss-head button:text-is("다시")');
  await page.waitForSelector("#S1 > .ss-head .ss-gist");
  const r = await page.evaluate(() => ({ chip: !!document.querySelector('#status-strip [data-key="section-study"]'), n: window.__gists.length }));
  assert.deepEqual(r, { chip: false, n: 1 });
  assert.ok(page.hits.includes("/api/section-study/2401.00001/gists?retry=1"));
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
  console.log(`section-study.browser.js: ${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
