// 공용 기반의 브라우저 동작 확인 (헤드리스 Chromium + Playwright). tests/test_browser.py가 서버를 띄우고 실행:
//   node tests/browser/foundation.browser.js <port>
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

// 바깥 네트워크는 전부 막고(빈 응답), /api/ask는 테스트가 정한 답으로
async function newPage(browser, { init, ask, routes } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 800 }, serviceWorkers: "block" });
  await ctx.route(u => !u.href.startsWith(BASE), r => r.fulfill({ status: 200, body: "", contentType: "text/plain" }));
  const asks = [];
  await ctx.route(`${BASE}/api/ask`, async r => {
    const body = JSON.parse(r.request().postData() || "{}");
    asks.push(body);
    const out = ask ? await ask(body, asks.length) : "답변입니다.";
    try { await r.fulfill({ status: 200, body: out, contentType: "text/plain; charset=utf-8" }); } catch { /* 중단된 요청 */ }
  });
  for (const [pattern, fn] of routes || []) await ctx.route(pattern, fn);
  // 공용 도우미: 요소 안에서 링크·수식·기능 UI 밖의, 글자가 있는 첫 텍스트 노드
  await ctx.addInitScript(() => {
    window.__text = el => {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode()) && (n.data.trim().length < 6 || n.parentElement.closest("a, math, .pr-ui"))) { /* 다음 */ }
      return n;
    };
    window.__range = (el, len = 3) => {
      const n = __text(el), i = n.data.search(/\S/), r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + len);
      return r;
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
  await page.waitForFunction(() => window.PaperApp && document.readyState === "complete");
}
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 5000 });

// 본문 텍스트(링크 밖)의 화면 좌표를 y 근처로 스크롤해서 반환
async function textPoint(page, selector, y = 150) {
  return page.evaluate(([sel, y]) => {
    const r = __range(document.querySelector(sel));
    window.scrollBy(0, r.getBoundingClientRect().top - y);
    const b = r.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, [selector, y]);
}
const sheetState = page => page.evaluate(() => ({
  sheet: !document.getElementById("sheet").hidden, pill: !document.getElementById("sheet-pill").hidden,
}));

test("기능 UI(.pr-ui) 버튼이 연 시트를 '내려두기'가 바로 닫지 않음, .pr-ui 글자 탭도 내려두지 않음", async browser => {
  const page = await newPage(browser);
  await open(page);
  await page.evaluate(() => {
    const box = document.createElement("div");
    box.innerHTML = '<button id="t-btn">더 묻기</button> <span id="t-text">기능이 넣은 요약 상자 글자</span>';
    box.querySelector("button").onclick = () => PaperApp.openSheet({ quote: "x", selection: "x", autoAsk: "Q" });
    PaperAnchor.insertUI(document.querySelector("#S1 .ltx_para"), box);
    box.scrollIntoView({ block: "start" });
    window.scrollBy(0, -100);
  });
  await page.click("#t-btn");
  await until(page, () => PaperApp.session && PaperApp.session.history.length === 2);
  assert.deepEqual(await sheetState(page), { sheet: true, pill: false });
  await page.click("#t-text");
  assert.deepEqual(await sheetState(page), { sheet: true, pill: false }, ".pr-ui 글자 탭");
  const p = await textPoint(page, "#S1\\.p1", 120);
  await page.mouse.click(p.x, p.y);
  assert.deepEqual(await sheetState(page), { sheet: false, pill: true }, "본문 빈 탭은 내려두기");
});

test("탭 처리기: .tr-ko 문장·번역 안 본문 링크(a.ltx_ref)는 처리기로, 기능 링크는 아님. offsetAtPoint는 색인 밖이면 null", async browser => {
  const page = await newPage(browser);
  await open(page);
  const r = await page.evaluate(async () => {
    window.__hits = [];
    PaperApp.addTapHandler({ id: "t:ref", priority: 80, test: e => e.target.closest('a[href^="#"]'), handle: () => __hits.push("ref") });
    PaperApp.addTapHandler({ id: "t:tr", priority: 40, test: e => e.target.closest(".tr-ko .t-s"), handle: () => __hits.push("tr") });
    const p = document.getElementById("S1.p1");
    const ko = document.createElement("div");
    ko.className = "tr-ko";
    ko.innerHTML = '<span class="t-s" id="t-s">번역된 문장입니다</span> <a class="ltx_ref" href="#S2.E1" id="t-ref">(1)</a>';
    PaperAnchor.insertUI(p, ko);
    const chip = document.createElement("div");
    chip.innerHTML = '<a href="#A1" id="t-chip">부록 보기</a>';
    PaperAnchor.insertUI(ko, chip);
    ko.scrollIntoView({ block: "center" });
    const at = el => { const b = el.getBoundingClientRect(); return PaperAnchor.offsetAtPoint(b.left + 4, b.top + b.height / 2); };
    const tr = __range(p);
    const tb = tr.getBoundingClientRect();
    const paperOff = PaperAnchor.offsetAtPoint(tb.left + 2, tb.top + tb.height / 2);
    PaperAnchor.paint("t-zz", [PaperAnchor.offsetsOf(tr)]);
    return {
      onKo: at(document.getElementById("t-s")), onChip: at(document.getElementById("t-chip")), paperOff,
      painted: PaperAnchor.paintedAt("t-zz", tb.left + 2, tb.top + tb.height / 2),
    };
  });
  assert.equal(r.onKo, null);
  assert.equal(r.onChip, null);
  assert.equal(typeof r.paperOff, "number");
  assert.equal(r.painted, 0);
  await page.click("#t-s");
  await page.click("#t-ref");
  assert.deepEqual(await page.evaluate(() => [location.hash, __hits]), ["", ["tr", "ref"]], "번역 문장·a.ltx_ref 탭은 처리기로 (기본 이동 없음)");
  await page.click("#t-chip");
  assert.deepEqual(await page.evaluate(() => [location.hash, __hits]), ["#A1", ["tr", "ref"]], "기능 링크는 처리기를 거치지 않고 기본 동작");
});

test("allowWithSelection 처리기만 선택이 있을 때도 받음 (문장 모드 두 번 탭)", async browser => {
  const page = await newPage(browser);
  await open(page);
  await page.evaluate(() => {
    window.__hits = [];
    PaperApp.addTapHandler({ id: "t:normal", priority: 30, test: () => true, handle: () => __hits.push("normal") });
    PaperApp.addTapHandler({ id: "t:sentence", priority: 20, allowWithSelection: true, test: () => true, handle: () => __hits.push("sentence") });
  });
  const p = await textPoint(page, "#S1\\.p1", 300);
  await page.mouse.click(p.x, p.y);
  await page.evaluate(() => PaperApp.selectRange(__range(document.getElementById("S1.p1"), 8)));
  await page.mouse.click(p.x, p.y);
  assert.deepEqual(await page.evaluate(() => __hits), ["normal", "sentence"]);
});

test("저장된 대화를 같은 고정 필드로 이어가면 세션 훅이 다시 돌지 않아 첫 턴이 같음 (meta도 복원)", async browser => {
  const page = await newPage(browser, { ask: (b, n) => `A${n}` });
  await open(page);
  await page.evaluate(() => {
    window.__hookRuns = 0;
    PaperApp.addSessionHook(s => { __hookRuns++; s.context += "\n<reader>R</reader>"; });
    PaperApp.openSheet({ quote: "q", selection: "SEL", context: "CTX", section: "2 Method" });
    PaperApp.ask("Q1", { presetId: "meaning", label: "뜻" });
  });
  await until(page, () => PaperApp.session.history.length === 2);
  const saved = await page.evaluate(() => {
    const s = PaperApp.session;
    return { quote: s.quote, selection: s.selection, context: s.context, section: s.section, history: s.history, shown: s.shown, meta: s.meta };
  });
  await page.evaluate(saved => {
    PaperApp.closeSheet();
    window.__restored = [];
    PaperApp.on("answer-done", d => d.restored && __restored.push(d.presetId));
    PaperApp.openSheet(saved);
    PaperApp.ask("Q2");
  }, saved);
  await until(page, () => PaperApp.session.history.length === 4);
  const [a, b] = page.asks;
  assert.equal(b.context, a.context);
  assert.equal(b.context, "CTX\n<reader>R</reader>");
  assert.deepEqual([b.selection, b.section, b.history[0].content], [a.selection, a.section, a.question]);
  assert.deepEqual(await page.evaluate(() => [__hookRuns, __restored, PaperApp.session.continued]), [1, ["meaning"], true]);
});

test("시트를 열면 그 위에 뜨는 오버레이(뷰어)는 닫힘, 점프·keepOnSheet 레이어는 남음", async browser => {
  const page = await newPage(browser);
  await open(page);
  const r = await page.evaluate(() => {
    const log = [];
    const ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;z-index:30;background:#0003";
    document.body.append(ov);
    PaperNav.jumpTo(document.getElementById("A1"), { smooth: false });
    PaperUI.layer(reason => log.push("find:" + reason), { kind: "find", keepOnSheet: true });
    PaperUI.layer(reason => { log.push("viewer:" + reason); ov.remove(); }, { kind: "viewer" });
    PaperUI.peek({ title: "p", body: "b", onClose: reason => log.push("peek:" + reason) });
    PaperApp.openSheet({ quote: "x", selection: "x" });
    const s = document.getElementById("sheet").getBoundingClientRect();
    const onTop = document.elementFromPoint(s.left + 20, s.top + 20);
    return { log, top: PaperUI.topLayer().kind, depth: PaperNav.depth, ovGone: !ov.isConnected, sheetOnTop: !!onTop.closest("#sheet") };
  });
  assert.deepEqual(r, { log: ["peek:sheet", "viewer:sheet"], top: "sheet", depth: 1, ovGone: true, sheetOnTop: true });
});

test("레이어 표지 항목: 새로고침해도 읽던 위치, 같은 문서 뒤로가기는 위치 유지", async browser => {
  const tall = () => document.addEventListener("DOMContentLoaded", () => {
    const st = document.createElement("style");
    st.textContent = "#paper { padding-bottom: 3000px !important; }";
    document.head.append(st);
  });
  const page = await newPage(browser, { init: tall });
  await open(page);
  const st = () => page.evaluate(() => ({ y: Math.round(scrollY), state: history.state, depth: PaperNav.depth }));
  await page.evaluate(() => { scrollTo(0, 500); PaperNav.jumpTo(document.getElementById("A1"), { smooth: false }); });
  await sleep(100);
  const jumped = await st();
  assert.equal(jumped.depth, 1);
  assert.deepEqual(jumped.state, { prLayer: 1 });
  await page.evaluate(() => scrollTo(0, 1800));
  await sleep(100);
  await page.reload();
  await page.waitForFunction(() => window.PaperApp && document.readyState === "complete");
  await sleep(300);
  const reloaded = await st();
  assert.ok(Math.abs(reloaded.y - 1800) < 5, `새로고침 후 위치 ${reloaded.y}`);
  assert.equal(reloaded.state, null, "남은 표지는 보통 항목으로");
  // 같은 문서 안: peek 열고 스크롤 → 뒤로가기 → 브라우저가 peek 연 시점 위치로 튀지 않음
  await page.evaluate(() => { scrollTo(0, 400); PaperUI.peek({ title: "t", body: "b" }); });
  await page.evaluate(() => scrollTo(0, 1200));
  await sleep(100);
  await page.goBack();
  await sleep(300);
  const back = await st();
  assert.equal(back.y, 1200);
  assert.equal(await page.evaluate(() => document.querySelectorAll(".pr-peek").length), 0);
});

test("토스트: 실행 취소 토스트는 다른 토스트에 밀려 사라지지 않고, 닫히면 다음 토스트", async browser => {
  const page = await newPage(browser);
  await open(page);
  const r = await page.evaluate(() => {
    let undone = 0;
    const text = () => document.querySelector("#pr-toast span")?.textContent;
    PaperUI.toast("일반 1");
    PaperUI.toast("삭제됨", { actionLabel: "실행 취소", onAction: () => undone++ });
    const a = text();
    PaperUI.toast("다른 알림");
    const b = text();
    document.querySelector("#pr-toast button").click();
    const c = text();
    PaperUI.toast("일반 2");
    return { a, b, c, d: text(), undone };
  });
  assert.deepEqual(r, { a: "삭제됨", b: "삭제됨", c: "다른 알림", d: "일반 2", undone: 1 });
});

test("이어서 받기: 마지막 실패 턴에서만, 다시 받는 동안 streaming 유지", async browser => {
  const page = await newPage(browser, {
    ask: async (b, n) => {
      if (n === 1) return "부분\n\n[오류] overloaded";
      if (n === 2) { await sleep(700); return "A2"; }
      if (n === 3) return "부분\n\n[오류] again";
      await sleep(300);
      return "A3 다시";
    },
  });
  await open(page);
  await page.evaluate(() => { PaperApp.openSheet({ quote: "x", selection: "x" }); PaperApp.ask("Q1"); });
  await until(page, () => document.querySelector(".pr-retry button"));
  await page.evaluate(() => { PaperApp.ask("Q2"); });
  await sleep(150);
  assert.deepEqual(await page.evaluate(() => [document.querySelectorAll(".pr-retry button").length, PaperApp.streaming]), [0, true],
    "새 턴이 시작되면 이전 실패 턴의 버튼은 사라짐");
  await until(page, () => PaperApp.session.history.length === 2);
  await page.evaluate(() => { PaperApp.ask("Q3"); });
  await until(page, () => document.querySelector(".pr-retry button"));
  await page.click(".pr-retry button");
  await sleep(100);
  assert.equal(await page.evaluate(() => PaperApp.streaming), true);
  await until(page, () => PaperApp.session.history.length === 4);
  assert.deepEqual(await page.evaluate(() => PaperApp.session.history.filter(t => t.role === "user").map(t => t.content)), ["Q2", "Q3"]);
  assert.equal(await page.evaluate(() => PaperApp.streaming), false);
});

test("Highlight API가 없을 때: 칠하기가 paper:dom-changed를 보내지 않음(무한 반복 없음), fallback:false는 안 칠함", async browser => {
  const page = await newPage(browser, { init: () => { window.Highlight = undefined; } });
  await open(page);
  const r = await page.evaluate(async () => {
    let n = 0;
    const el = document.getElementById("S1.p1");
    const o = PaperAnchor.offsetsOfElement(el);
    const item = { start: o.start + 1, end: o.start + 8 };
    document.addEventListener("paper:dom-changed", () => { if (++n < 50) PaperAnchor.paint("t-hn", [item]); });
    PaperAnchor.paint("t-hn", [item]);
    PaperAnchor.changed();
    await new Promise(r => setTimeout(r, 300));
    PaperAnchor.paint("t-gl", [item], { fallback: false });
    return { n, marks: document.querySelectorAll("mark.pa-mark-t-hn").length, gl: document.querySelectorAll("mark.pa-mark-t-gl").length };
  });
  assert.equal(r.n, 1);
  assert.ok(r.marks >= 1);
  assert.equal(r.gl, 0);
});

test("CDN 라이브러리보다 먼저 그린 답변은 라이브러리가 오면 다시 그림", async browser => {
  const page = await newPage(browser, {
    routes: [
      [/marked\.min\.js/, async r => { await sleep(800); await r.fulfill({ body: "window.marked = { parse: s => '<p>' + s + '</p>' };", contentType: "text/javascript" }); }],
      [/purify\.min\.js/, r => r.fulfill({ body: "window.DOMPurify = { sanitize: s => s };", contentType: "text/javascript" })],
    ],
  });
  await page.goto(PAPER, { waitUntil: "commit" });
  await page.waitForFunction(() => window.renderAnswerNow);
  const early = await page.evaluate(() => {
    const el = document.createElement("div");
    el.id = "t-card";
    document.body.append(el);
    renderAnswerNow(el, "**굵게**");
    return { html: el.innerHTML, marked: !!window.marked };
  });
  assert.deepEqual(early, { html: "**굵게**", marked: false });
  await page.waitForFunction(() => document.readyState === "complete");
  assert.equal(await page.evaluate(() => document.getElementById("t-card").innerHTML), "<p>**굵게**</p>");
});

test("읽기가 시작되면 마이크는 취소되고 말하던 중간을 질문으로 보내지 않음", async browser => {
  const page = await newPage(browser, {
    init: () => {
      window.SpeechRecognition = class {
        constructor() { window.__rec = this; }
        start() { setTimeout(() => this.onstart && this.onstart(), 0); }
        stop() { setTimeout(() => this.onend && this.onend(), 0); }
        abort() { this.aborted = true; setTimeout(() => this.onend && this.onend(), 0); }
      };
    },
  });
  await open(page);
  await page.evaluate(() => PaperApp.openSheet({ quote: "x", selection: "x" }));
  const say = text => page.evaluate(t => __rec.onresult({ results: [Object.assign([{ transcript: t }], { isFinal: true })] }), text);
  await page.click("#mic");
  await until(page, () => document.getElementById("mic").classList.contains("recording"));
  await say("이 수식에서 감마는");
  await page.evaluate(() => PaperApp.tts.speak("다른 기능 읽기", { owner: "t" }));
  await until(page, () => !document.getElementById("mic").classList.contains("recording"));
  await sleep(200);
  assert.equal(page.asks.length, 0);
  assert.equal(await page.evaluate(() => __rec.aborted), true);
  // 정상 경로: 말하고 마이크를 다시 누르면 질문 전송 (via=voice)
  await page.evaluate(() => PaperApp.tts.stop());
  await page.click("#mic");
  await until(page, () => document.getElementById("mic").classList.contains("recording"));
  await say("감마는 뭐야");
  await page.click("#mic");
  await until(page, () => PaperApp.session.history.length === 2);
  assert.equal(page.asks[0].question.startsWith("감마는 뭐야"), true);
});

test("KaTeX CSS가 느려도 본문 페인트·공용 스크립트가 기다리지 않음", async browser => {
  const page = await newPage(browser, {
    routes: [[/katex\.min\.css/, async r => { await sleep(4000); try { await r.fulfill({ body: ".katex{}", contentType: "text/css" }); } catch { /* 닫힘 */ } }]],
  });
  const t0 = Date.now();
  await page.goto(PAPER, { waitUntil: "commit" });
  await page.waitForFunction(() => window.PaperApp && performance.getEntriesByName("first-contentful-paint").length, null, { timeout: 2500 });
  assert.ok(Date.now() - t0 < 2500);
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
  console.log(`foundation.browser.js: ${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
