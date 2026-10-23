// vocab 브라우저 동작 확인 (헤드리스 Chromium + Playwright). tests/test_browser.py가 서버를 띄우고 전체 번들로 실행:
//   node tests/browser/vocab.browser.js <port>
"use strict";
const assert = require("node:assert/strict");

let chromium;
try { ({ chromium } = require("playwright")); } catch { console.log("SKIP playwright 없음"); process.exit(0); }

const PORT = process.argv[2];
const BASE = `http://127.0.0.1:${PORT}`;
const PAPER = `${BASE}/paper/2401.00001`;
const DAY = 864e5;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const MEANING_ANSWER = "### mixture of experts\n**희소 전문가 혼합**: 입력마다 일부 전문가만 쓰는 구조\n여러 모델을 섞는 기법\n\n근거: \"We propose a sparse mixture of experts model\"";

async function newPage(browser, { init, ask } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 800 }, serviceWorkers: "block" });
  await ctx.route(u => !u.href.startsWith(BASE), r => r.fulfill({ status: 200, body: "", contentType: "text/plain" }));
  const asks = [];
  await ctx.route(`${BASE}/api/ask`, async r => {
    const body = JSON.parse(r.request().postData() || "{}");
    asks.push(body);
    try { await r.fulfill({ status: 200, body: ask ? ask(body) : "답변입니다.", contentType: "text/plain; charset=utf-8" }); } catch { /* 중단 */ }
  });
  // 다른 기능의 백그라운드 요청은 빈 응답 (이 테스트는 vocab만 봄)
  await ctx.route(u => u.href.startsWith(`${BASE}/api/`) && u.pathname !== "/api/ask" && !u.pathname.startsWith("/api/prewarm/"),
    r => r.fulfill({ status: 404, body: "{}", contentType: "application/json" }));
  await ctx.addInitScript(() => {
    // 문단 안에서 phrase가 든 텍스트 노드를 찾아 그 부분만 선택
    window.__select = (id, phrase) => {
      const w = document.createTreeWalker(document.getElementById(id), NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode()) && !n.data.includes(phrase)) { /* 다음 */ }
      const r = document.createRange(), i = n.data.indexOf(phrase);
      r.setStart(n, i);
      r.setEnd(n, i + phrase.length);
      PaperApp.selectRange(r);
    };
  });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.asks = asks;
  page.errors = errors;
  return page;
}
async function open(page, url = PAPER) {
  await page.goto(url);
  await page.waitForFunction(() => window.PaperApp && document.readyState === "complete" && PaperApp.has("vocab"));
}
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 5000 });
const vocab = page => page.evaluate(() => JSON.parse(localStorage.getItem("pr:vocab") || "[]"));
const selIds = page => page.evaluate(() => [...document.querySelectorAll("#sel-bar button")].map(b => b.dataset.id));

test("선택 버튼 '단어장': 1~4단어만, 문장·논문과 함께 저장 → '뜻 묻기'가 뜻 칸을 채움", async browser => {
  const page = await newPage(browser, { ask: () => MEANING_ANSWER });
  await open(page);
  await page.evaluate(() => __select("S1.p1", "We propose a sparse mixture of experts"));
  await until(page, () => !document.getElementById("sel-bar").hidden);
  assert.ok(!(await selIds(page)).includes("vocab"), "5단어 이상이면 숨김");

  await page.evaluate(() => __select("S1.p1", "mixture of experts"));
  await until(page, () => document.querySelector('#sel-bar button[data-id="vocab"]'));
  await page.click('#sel-bar button[data-id="vocab"]');
  let list = await vocab(page);
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].id, list[0].term, list[0].step, list[0].meaning, list[0].paperId],
    ["mixture of experts", "mixture of experts", 0, "", "2401.00001"]);
  assert.equal(list[0].sentence, "We propose a sparse mixture of experts model that routes each token to two experts [1, 2].");
  assert.ok(list[0].title && list[0].prefix.endsWith("We propose a sparse"), JSON.stringify(list[0]));
  assert.ok(Math.abs(list[0].due - Date.now()) < 60e3);
  assert.match(await page.textContent("#pr-toast"), /단어장에 추가: mixture of experts/);

  // 토스트의 '뜻 묻기' → 시트가 meaning 프리셋으로 물음 → 답이 끝나면 뜻 칸을 바로 채움
  await page.click("#pr-toast button");
  await until(page, () => document.querySelector('#answer .turn-slot[data-slot="vocab"] button'));
  assert.equal(page.asks.length, 1);
  assert.equal(page.asks[0].selection, "mixture of experts");
  assert.match(page.asks[0].question, /뜻/);
  assert.equal(await page.textContent('#answer .turn-slot[data-slot="vocab"] button'), "✓ 단어장 뜻 저장됨");
  list = await vocab(page);
  assert.equal(list.length, 1);
  assert.equal(list[0].meaning, "**희소 전문가 혼합**: 입력마다 일부 전문가만 쓰는 구조\n여러 모델을 섞는 기법");

  // 다시 선택하면 '이미 있음' (뜻이 있으니 '뜻 묻기' 없음)
  await page.evaluate(() => { PaperApp.closeSheet(); __select("S1.p1", "mixture of experts"); });
  await until(page, () => document.querySelector('#sel-bar button[data-id="vocab"]'));
  await page.click('#sel-bar button[data-id="vocab"]');
  await until(page, () => /이미 단어장에 있어요/.test(document.getElementById("pr-toast")?.textContent || ""));
  assert.equal(await page.$("#pr-toast button"), null);
  assert.deepEqual(page.errors, []);
});

test("'뜻' 답변 아래 '단어장에 추가' (presetId meaning만), 누르면 뜻·문장과 함께 저장", async browser => {
  const page = await newPage(browser, { ask: () => MEANING_ANSWER.replace("mixture of experts", "Knowledge distillation") });
  await open(page);
  await page.evaluate(() => {
    __select("S1.p1", "Knowledge distillation");
    const s = PaperApp.sel();
    PaperApp.openSheet({ quote: s.text, selection: s.text, context: s.context, selInfo: s, autoAsk: { q: "뜻?", label: "뜻 (이 논문에서)", id: "meaning" } });
  });
  await until(page, () => document.querySelector('#answer .turn-slot[data-slot="vocab"] button'));
  const btn = '#answer .turn-slot[data-slot="vocab"] button';
  assert.equal(await page.textContent(btn), "단어장에 추가");
  assert.deepEqual(await vocab(page), [], "누르기 전에는 저장 안 함");
  await page.click(btn);
  assert.equal(await page.textContent(btn), "✓ 단어장에 저장됨");
  const [c] = await vocab(page);
  assert.equal(c.term, "Knowledge distillation");
  assert.equal(c.sentence, "Knowledge distillation (KD) compresses the router, and the KD loss is cheap.");
  assert.match(c.meaning, /희소 전문가 혼합/);

  // 다른 프리셋 답변에는 버튼 없음
  await page.evaluate(() => PaperApp.ask("쉽게", { presetId: "easy", label: "쉽게 설명" }));
  await until(page, () => document.querySelectorAll("#answer .turn").length === 2 && !PaperApp.streaming);
  assert.equal(await page.$$eval('#answer .turn:last-child .turn-slot[data-slot="vocab"] button', b => b.length), 0);
  assert.deepEqual(page.errors, []);
});

test("홈: 단어장 복습 (N) — 뜻 보기 → 알아요/몰라요로 간격 반복, 전체 목록 삭제·실행 취소", async browser => {
  const page = await newPage(browser, {
    init: () => {
      if (localStorage.getItem("pr:vocab")) return;
      const now = Date.now(), D = 864e5;
      localStorage.setItem("pr:vocab", JSON.stringify([
        { id: "router", term: "router", sentence: "The router picks two experts.", paperId: "2401.00001", title: "Sparse MoE", prefix: "The ", meaning: "**라우터**: 토큰을 전문가에 배정", due: now - 2 * D, step: 1, ts: now - 2 * D, added: 1, reviews: 1 },
        { id: "kd", term: "KD", sentence: "", paperId: "2401.00001", title: "Sparse MoE", meaning: "", due: now - 60e3, step: 0, ts: now, added: 2 },
        { id: "flops", term: "FLOPs", sentence: "", paperId: "2401.00001", title: "Sparse MoE", meaning: "연산량", due: now + 3 * D, step: 2, ts: now, added: 3 },
      ]));
    },
  });
  await open(page, `${BASE}/`);
  const sec = '[data-section="vocab"]';
  assert.equal(await page.textContent(`${sec} h2`), "단어장 복습 (2)");
  assert.equal(await page.textContent(`${sec} .vo-term`), "router");
  assert.equal(await page.$(`${sec} .vo-got`), null, "뜻을 보기 전에는 채점 버튼 없음");

  await page.click(`${sec} .vo-reveal`);
  // 바깥 CDN(marked)을 막아 두어 Markdown은 일반 텍스트로 그려짐
  assert.match(await page.textContent(`${sec} .vo-meaning`), /라우터(\*\*)?: 토큰을 전문가에 배정/);
  assert.equal(await page.textContent(`${sec} .vo-sentence b`), "router");
  assert.equal(await page.getAttribute(`${sec} .vo-src`, "href"), "/paper/2401.00001#q=router&p=The%20");
  assert.equal((await page.textContent(`${sec} .vo-got`)).replace(/\s+/g, " "), "알아요 3일");
  await page.click(`${sec} .vo-got`);
  let list = await vocab(page);
  const router = list.find(c => c.id === "router");
  assert.equal(router.step, 2);
  assert.ok(Math.abs(router.due - (Date.now() + 3 * DAY)) < 60e3);

  assert.equal(await page.textContent(`${sec} h2`), "단어장 복습 (1)");
  assert.equal(await page.textContent(`${sec} .vo-term`), "KD");
  await page.click(`${sec} .vo-reveal`);
  assert.match(await page.textContent(`${sec} .vo-meaning`), /아직 뜻이 없어요/);
  await page.click(`${sec} .vo-forgot`);
  list = await vocab(page);
  const kd = list.find(c => c.id === "kd");
  assert.equal(kd.step, 0);
  assert.ok(Math.abs(kd.due - (Date.now() + DAY)) < 60e3);
  assert.equal(await page.textContent(`${sec} h2`), "단어장 복습");
  assert.equal(await page.textContent(`${sec} .vo-done-msg`), "오늘 복습 끝! 다음 복습은 1일 뒤");

  // 전체 목록: 최근에 넣은 것부터, ✕ → '삭제됨' 토스트의 실행 취소로 되돌림
  await page.click(`${sec} .vo-link`);
  assert.deepEqual(await page.$$eval(`${sec} .vo-row-term`, els => els.map(e => e.textContent)), ["FLOPs", "KD", "router"]);
  await page.click(`${sec} .vo-del[aria-label="FLOPs 삭제"]`);
  assert.equal((await vocab(page)).length, 2);
  assert.equal(await page.$$eval(`${sec} .vo-row`, els => els.length), 2);
  assert.match(await page.textContent("#pr-toast"), /삭제됨/);
  await page.click("#pr-toast button");
  assert.equal((await vocab(page)).length, 3);
  assert.equal(await page.$$eval(`${sec} .vo-row`, els => els.length), 3);
  assert.deepEqual(page.errors, []);
});

test("홈: 단어가 없으면 안내 문구만", async browser => {
  const page = await newPage(browser);
  await open(page, `${BASE}/`);
  assert.equal(await page.textContent('[data-section="vocab"] h2'), "단어장 복습");
  assert.match(await page.textContent('[data-section="vocab"] .vo-empty'), /'단어장'을 누르면/);
  assert.equal(await page.$('[data-section="vocab"] .vo-link'), null);
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
  console.log(`vocab.browser.js: ${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
