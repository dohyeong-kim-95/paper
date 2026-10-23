// answer-tools 브라우저 확인 (전체 번들): 근거 칩 → 시트 내려두고 본문 점프·돌아가기, 복원된 턴, 읽어주기·자동 읽기, 복사·공유·👍👎
//   node tests/browser/answer-tools.browser.js <port>   (tests/test_browser.py가 실행. playwright·Chromium 없으면 SKIP)
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
const EV_MARK = '근거: "영어 원문 그대로';
const FOUND = "We propose a sparse mixture of experts model";
const IMG_SIZE = { "x1.png": [598, 300] };
const ANSWER = `MoE는 $x^2$ 비용을 줄입니다.\n근거: "${FOUND}"\n근거: "this sentence is certainly not in the paper"`;

// 바깥 네트워크는 막고(빈 응답, 그림은 크기만 맞춘 SVG), /api/ask는 정해진 답, /api/feedback은 기록만.
// 읽어주기(speechSynthesis)·클립보드·공유 시트는 가짜로 바꿔 무엇을 했는지 기록
async function newPage(browser, { ask } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 800 }, serviceWorkers: "block" });
  await ctx.route(u => !u.href.startsWith(BASE), r => {
    if (r.request().resourceType() !== "image") return r.fulfill({ status: 200, body: "", contentType: "text/plain" });
    const [w, h] = IMG_SIZE[r.request().url().split("/").pop()] || [300, 200]; // 자리 크기 그대로 (늦은 레이아웃 밀림 방지)
    return r.fulfill({ status: 200, body: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"/>`, contentType: "image/svg+xml" });
  });
  const asks = [], votes = [];
  await ctx.route(`${BASE}/api/ask`, async r => {
    const body = JSON.parse(r.request().postData() || "{}");
    asks.push(body);
    const out = ask ? await ask(body, asks.length) : ANSWER;
    try { await r.fulfill({ status: 200, body: out, contentType: "text/plain; charset=utf-8" }); } catch { /* 중단된 요청 */ }
  });
  await ctx.route(`${BASE}/api/feedback`, r => {
    votes.push(JSON.parse(r.request().postData() || "{}"));
    return r.fulfill({ status: 200, body: '{"ok":true}', contentType: "application/json" });
  });
  await ctx.addInitScript(() => {
    // 긴 본문 (점프가 실제로 스크롤하도록)
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#paper { padding-bottom: 3000px !important; }";
      document.head.append(st);
    });
    window.__spoken = [];
    let pending = [];
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    const synth = {
      speak(u) {
        __spoken.push(u.text);
        const t = setTimeout(() => { pending = pending.filter(x => x !== t); u.onend && u.onend(); }, 600); // 문장 하나 0.6초
        pending.push(t);
        setTimeout(() => u.onstart && u.onstart(), 0);
      },
      cancel() { pending.forEach(clearTimeout); pending = []; },
      getVoices: () => [],
    };
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async t => { window.__copied = t; } }, configurable: true });
    navigator.share = async d => { window.__shared = d; };
    window.SpeechRecognition = class {
      constructor() { window.__rec = this; }
      start() { setTimeout(() => this.onstart && this.onstart(), 0); }
      stop() { setTimeout(() => this.onend && this.onend(), 0); }
      abort() { setTimeout(() => this.onend && this.onend(), 0); }
    };
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  Object.assign(page, { asks, votes, errors });
  return page;
}
async function open(page, url = PAPER) {
  await page.goto(url);
  await page.waitForFunction(() => window.PaperApp && document.readyState === "complete");
}
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 5000 });
async function askAndWait(page, n, fn) {
  await page.evaluate(fn);
  await page.waitForFunction(k => PaperApp.session && PaperApp.session.history.length === k * 2 && !PaperApp.streaming, n, { timeout: 5000 });
}
const state = page => page.evaluate(() => ({
  sheet: !document.getElementById("sheet").hidden, pill: !document.getElementById("sheet-pill").hidden,
  back: !document.getElementById("back-chip").hidden,
}));
// 근거 인용이 화면 안에 보이는지
const quoteInView = (page, q) => page.evaluate(q => {
  const r = PaperAnchor.findQuote(q);
  const b = r && r.getBoundingClientRect();
  return !!b && b.top >= 0 && b.bottom <= innerHeight;
}, q);

test("근거 칩: 질문에 근거 요청 한 번, 근거 줄은 칩으로, 탭하면 시트 내려두고 그 문장으로 점프 → 돌아가기·답변 보기", async browser => {
  const page = await newPage(browser);
  await open(page);
  assert.equal(await page.evaluate(() => PaperApp.has("answer-tools")), true);
  await askAndWait(page, 1, () => PaperApp.openSheet({ quote: "x", selection: "x", autoAsk: "Q" }));
  const q1 = page.asks[0].question;
  assert.ok(q1.startsWith("Q\n\n("), q1);
  assert.equal(q1.split(EV_MARK).length, 2, "근거 요청은 한 번");
  const ui = await page.evaluate(() => {
    const t = document.querySelector("#answer .turn");
    return {
      a: t.querySelector(".a").textContent,
      chips: [...t.querySelectorAll(".at-ev-chip")].map(b => b.getAttribute("aria-label")),
      miss: [...t.querySelectorAll(".at-ev-miss")].map(s => s.textContent),
      order: [...t.querySelectorAll(".turn-tools > .turn-slot")].map(s => s.dataset.slot).slice(0, 2),
      stored: PaperApp.session.history[1].content,
    };
  });
  assert.ok(ui.a.includes("MoE는") && !ui.a.includes("근거"), ui.a);
  assert.deepEqual(ui.chips, [`본문 보기: ${FOUND}`]);
  assert.deepEqual(ui.miss, ["근거 “this sentence is certainly not in the paper”"]);
  assert.deepEqual(ui.order, ["evidence-chips", "answer-actions"]);
  assert.equal(ui.stored, ANSWER, "기록에는 원래 답 그대로");

  await page.evaluate(() => { PaperApp.minimizeSheet(); scrollTo(0, 2000); });
  await sleep(150);
  assert.equal(await quoteInView(page, FOUND), false, "점프 전에는 화면 밖");
  await page.click("#pill-open");
  const y0 = await page.evaluate(() => Math.round(scrollY));
  await page.click(".at-ev-chip");
  assert.deepEqual(await state(page), { sheet: false, pill: true, back: true });
  assert.equal(await page.evaluate(() => !window.CSS.highlights || CSS.highlights.has("pa-flash")), true, "깜빡임");
  await until(page, q => { const b = PaperAnchor.findQuote(q).getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; }, FOUND);
  await sleep(700); // 부드러운 스크롤이 끝날 때까지

  await page.click("#back-chip");
  await until(page, y => Math.abs(scrollY - y) < 3, y0);
  assert.deepEqual(await state(page), { sheet: false, pill: true, back: false });
  await page.click("#pill-open");
  assert.deepEqual(await state(page), { sheet: true, pill: false, back: false });

  // 이어서 질문: 기록의 첫 질문은 보낸 그대로(근거 요청 포함), 새 질문에도 한 번
  await askAndWait(page, 2, () => PaperApp.ask("Q2"));
  const p2 = page.asks[1];
  assert.equal(p2.history[0].content, q1);
  assert.equal(p2.question.split(EV_MARK).length, 2);
  assert.equal(await page.evaluate(() => document.querySelectorAll("#answer .turn .at-ev-chip").length), 2);
  assert.deepEqual(page.errors, []);
});

test("복원: 새로고침 뒤 '답변 보기'의 지난 답도 근거 줄 대신 칩, 번역 프리셋에는 근거 요청 없음", async browser => {
  const page = await newPage(browser);
  await open(page);
  await askAndWait(page, 1, () => PaperApp.openSheet({ quote: "x", selection: "x", autoAsk: { q: "번역해줘", id: "translate", label: "번역" } }));
  assert.equal(page.asks[0].question, "번역해줘");
  await askAndWait(page, 2, () => PaperApp.ask("Q2"));
  await page.reload();
  await page.waitForFunction(() => window.PaperApp && document.readyState === "complete");
  await page.click("#pill-open");
  const r = await page.evaluate(() => [...document.querySelectorAll("#answer .turn")].map(t => ({
    raw: t.querySelector(".a").textContent.includes("근거:"),
    chips: t.querySelectorAll(".at-ev-chip").length,
    actions: t.querySelectorAll("[data-slot='answer-actions'] button").length > 0,
  })));
  assert.deepEqual(r, [{ raw: false, chips: 1, actions: true }, { raw: false, chips: 1, actions: true }]);
  assert.deepEqual(page.errors, []);
});

test("답변 도구: 읽어주기(근거·수식 기호 없이)·두 번째 탭은 멈춤, 음성 질문은 자동 읽기, 복사·공유·👎", async browser => {
  const page = await newPage(browser);
  await open(page);
  await askAndWait(page, 1, () => PaperApp.openSheet({ quote: "x", selection: "x", autoAsk: { q: "Q", id: "easy", label: "쉽게 설명" } }));
  const tts = ".turn .at-tts";
  await page.click(tts);
  const on = await page.evaluate(sel => ({
    spoken: __spoken.slice(), owner: PaperApp.tts.owner,
    pressed: document.querySelector(sel).getAttribute("aria-pressed"), label: document.querySelector(sel).textContent,
  }), tts);
  assert.deepEqual(on, { spoken: ["MoE는 수식 비용을 줄입니다."], owner: "answer-tools", pressed: "true", label: "■ 그만 읽기" });
  await page.click(tts);
  assert.deepEqual(await page.evaluate(sel => [PaperApp.tts.owner, document.querySelector(sel).getAttribute("aria-pressed")], tts), [null, "false"]);
  // 끝까지 읽으면 버튼이 돌아옴
  await page.click(tts);
  await until(page, sel => document.querySelector(sel).getAttribute("aria-pressed") === "false" && !PaperApp.tts.owner, tts);

  await page.click(".turn [data-slot='answer-actions'] button:text-is('복사')");
  assert.equal(await page.evaluate(() => window.__copied), ANSWER);
  await page.click(".turn [data-slot='answer-actions'] button:text-is('공유')");
  const shared = await page.evaluate(() => window.__shared);
  assert.ok(shared.text.startsWith("Q. Q\n\nMoE는"), shared.text);
  await page.click(".turn .pr-fb[data-vote='down']");
  await until(page, () => document.querySelector(".turn .pr-fb[data-vote='down']").getAttribute("aria-pressed") === "true");
  await sleep(100);
  const threadId = await page.evaluate(() => PaperApp.session.threadId);
  assert.equal(page.votes.length, 1);
  const v = page.votes[0];
  assert.deepEqual([v.kind, v.vote, v.target, v.label, v.question, v.answer_len, v.arxiv_id],
    ["answer", "down", `${threadId}:0`, "easy", "Q", ANSWER.length, "2401.00001"]);

  // 음성 질문 (마이크 → 인식 끝 → via=voice로 전송) → 답이 끝나면 자동으로 읽음
  await page.evaluate(() => { __spoken.length = 0; });
  await page.click("#mic");
  await page.evaluate(() => __rec.onresult({ results: [Object.assign([{ transcript: "음성 질문" }], { isFinal: true })] }));
  await page.evaluate(() => __rec.stop());
  await until(page, () => PaperApp.session.history.length === 4 && !PaperApp.streaming);
  const auto = await page.evaluate(() => ({
    spoken: __spoken.filter(t => t.trim()), owner: PaperApp.tts.owner,
    pressed: [...document.querySelectorAll(".turn .at-tts")].map(b => b.getAttribute("aria-pressed")),
  }));
  assert.deepEqual(auto, { spoken: ["MoE는 수식 비용을 줄입니다."], owner: "answer-tools", pressed: ["false", "true"] });
  assert.equal(page.asks[1].question.split(EV_MARK).length, 2);
  // 시트를 닫으면 읽기도 멈춤
  await page.click("#close");
  assert.equal(await page.evaluate(() => PaperApp.tts.owner), null);
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
  console.log(`answer-tools.browser.js: ${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
