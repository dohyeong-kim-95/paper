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

// 바깥 네트워크는 전부 막고(빈 응답), /api/ask는 테스트가 정한 답으로. 논문 그림은 width/height 속성과 같은 비율의
// SVG로 (실제처럼 자리 크기 그대로 로드됨 — 빈 응답이면 깨진 그림으로 줄어들어 로드 뒤에 레이아웃이 밀림)
const IMG_SIZE = { "x1.png": [598, 300] };
async function newPage(browser, { init, ask, routes, viewport } = {}) {
  const ctx = await browser.newContext({ viewport: viewport || { width: 412, height: 800 }, serviceWorkers: "block" });
  await ctx.route(u => !u.href.startsWith(BASE), r => {
    if (r.request().resourceType() !== "image") return r.fulfill({ status: 200, body: "", contentType: "text/plain" });
    const [w, h] = IMG_SIZE[r.request().url().split("/").pop()] || [300, 200];
    return r.fulfill({ status: 200, body: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"/>`, contentType: "image/svg+xml" });
  });
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
  // 빈 곳(본문 왼쪽·오른쪽 여백)은 가장 가까운 글자로 붙지 않고 null → 칠한 줄 옆 여백 탭은 칠한 구간이 아님
  const margin = await page.evaluate(() => {
    const tb = __range(document.getElementById("S1.p1")).getBoundingClientRect(), y = tb.top + tb.height / 2;
    return [PaperAnchor.offsetAtPoint(3, y), PaperAnchor.offsetAtPoint(innerWidth - 3, y), PaperAnchor.paintedAt("t-zz", innerWidth - 3, y)];
  });
  assert.deepEqual(margin, [null, null, -1]);
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

test("아래쪽 줄: 좁은 화면에서도 돌아가기·답변 보기·FAB가 겹치지 않고, 선택 버튼 줄이 뜨면 함께 올라감", async browser => {
  for (const width of [412, 360, 320]) {
    const page = await newPage(browser, { viewport: { width, height: 760 } });
    await open(page);
    await page.evaluate(async () => {
      PaperUI.addFab({ id: "ask-paper", label: "논문에 질문", order: 10, onClick: () => { window.__fab = 1; } });
      PaperApp.openSheet({ quote: "x", selection: "x" });
      await PaperApp.ask("Q");
      PaperApp.minimizeSheet();
      PaperNav.jumpTo(document.getElementById("A1"), { smooth: false });
    });
    await sleep(100);
    const probe = () => page.evaluate(() => {
      const ids = ["back-chip", "pill-open", "pill-x"];
      const els = [...ids.map(id => document.getElementById(id)), document.querySelector(".pr-fab")];
      const rects = els.map(e => e.getBoundingClientRect());
      const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const groups = [rects[0], rects[1], rects[2], rects[3]];
      const pairs = [[0, 1], [0, 2], [0, 3], [1, 3], [2, 3]].filter(([i, j]) => overlap(groups[i], groups[j]));
      const hits = els.map((e, i) => { const b = rects[i]; return e.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)); });
      const selBar = document.getElementById("sel-bar");
      return { pairs, hits, bottom: Math.max(...rects.map(b => b.bottom)), selTop: selBar.hidden ? null : selBar.getBoundingClientRect().top };
    });
    const r = await probe();
    assert.deepEqual([r.pairs, r.hits], [[], [true, true, true, true]], `${width}px ${JSON.stringify(r)}`);
    await page.evaluate(() => PaperApp.selectRange(__range(document.getElementById("S1.p1"), 8)));
    await sleep(100);
    const s = await probe();
    assert.deepEqual([s.pairs, s.hits], [[], [true, true, true, true]], `${width}px 선택 중 ${JSON.stringify(s)}`);
    assert.ok(s.selTop != null && s.bottom <= s.selTop, `선택 버튼 줄 위로 ${JSON.stringify(s)}`);
    await page.context().close();
  }
});

test("CDN이 느려도 ⋯ 메뉴는 바로 열리고, 새로고침 후 '답변 보기' 복원도 CDN을 기다리지 않음", async browser => {
  const slow = async r => { await sleep(3000); try { await r.fulfill({ body: "", contentType: "text/javascript" }); } catch { /* 닫힘 */ } };
  const page = await newPage(browser, { routes: [[/marked\.min\.js/, slow]] });
  await page.goto(PAPER, { waitUntil: "commit" });
  await page.waitForFunction(() => window.PaperApp && !document.getElementById("bar-more").hidden && document.readyState !== "complete");
  await page.click("#bar-more");
  assert.deepEqual(await page.evaluate(() => [!!document.querySelector(".pr-menu-peek"), document.readyState === "complete"]), [true, false]);
  await page.waitForFunction(() => document.readyState === "complete", null, { timeout: 8000 });
  await page.evaluate(async () => {
    PaperUI.closeLayers(() => true);
    PaperApp.openSheet({ quote: "x", selection: "x" });
    await PaperApp.ask("Q");
  });
  await page.reload({ waitUntil: "commit" });
  await page.waitForFunction(() => window.PaperApp && document.getElementById("sheet-pill").hidden === false, null, { timeout: 2500 });
  assert.equal(await page.evaluate(() => document.readyState === "complete"), false, "CDN이 오기 전에 복원");
  assert.equal(await page.evaluate(() => PaperApp.session.history.length), 2);
});

test("시트가 열린 채 본문 해시 링크를 누르면 시트는 그대로, 점프로 처리 (뒤로가기: 점프 → 시트 순)", async browser => {
  const page = await newPage(browser);
  await open(page);
  await page.evaluate(async () => { PaperApp.openSheet({ quote: "x", selection: "x" }); await PaperApp.ask("Q"); });
  const len0 = await page.evaluate(() => history.length);
  const pt = await page.evaluate(() => {
    const a = document.querySelector('#paper a[href="#bib.bib1"]');
    a.scrollIntoView({ block: "start" });
    window.scrollBy(0, -120);
    const b = a.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await page.mouse.click(pt.x, pt.y);
  await sleep(150);
  const st = () => page.evaluate(() => ({ sheet: !document.getElementById("sheet").hidden, hash: location.hash, depth: PaperNav.depth }));
  assert.deepEqual(await st(), { sheet: true, hash: "", depth: 1 });
  assert.equal(await page.evaluate(() => history.length), len0, "history 항목을 더 쌓지 않음 (표지 하나 유지)");
  await page.goBack();
  await sleep(200);
  assert.deepEqual(await st(), { sheet: true, hash: "", depth: 0 });
  await page.goBack();
  await sleep(200);
  assert.deepEqual(await sheetState(page), { sheet: false, pill: true });
  // location.hash로 해시 이동(항목 추가)이 생겨도 레이어 Back으로 오인하지 않음
  await page.evaluate(() => { PaperApp.restoreSheet(); location.hash = "#S2"; });
  await sleep(200);
  assert.deepEqual(await sheetState(page), { sheet: true, pill: false });
  await page.goBack(); // #S2 → 표지
  await sleep(200);
  assert.deepEqual(await sheetState(page), { sheet: true, pill: false });
  await page.goBack(); // 표지 → 바탕: 시트 내려두기
  await sleep(200);
  assert.deepEqual(await sheetState(page), { sheet: false, pill: true });
});

test("peek는 열린 뷰어(z 30)·다른 peek 위로 쌓임", async browser => {
  const page = await newPage(browser);
  await open(page);
  const z = await page.evaluate(() => {
    const a = PaperUI.peek({ title: "a", body: "a" });
    PaperUI.layer(() => {}, { kind: "viewer" });
    const b = PaperUI.peek({ title: "b", body: "b" });
    const c = PaperUI.peek({ title: "c", body: "c" });
    return [a, b, c].map(p => Number(p.el.style.zIndex));
  });
  assert.deepEqual(z, [26, 32, 34]);
});

test("번역 모드: .tr-ko 글자 탭도 시트를 내려둠", async browser => {
  const page = await newPage(browser);
  await open(page);
  await page.evaluate(() => {
    const ko = document.createElement("div");
    ko.className = "tr-ko";
    ko.innerHTML = '<span class="t-s">번역된 문장입니다. 이것은 번역입니다.</span>';
    PaperAnchor.insertUI(document.getElementById("S1.p1"), ko);
    ko.scrollIntoView({ block: "start" });
    window.scrollBy(0, -120);
    PaperApp.openSheet({ quote: "x", selection: "x" });
  });
  await page.click(".tr-ko .t-s");
  assert.deepEqual(await sheetState(page), { sheet: false, pill: false }, "기록 없는 시트는 닫힘");
});

test("addLocalTurn: 질문 없이 로컬 내용을 턴으로 (기록·저장 없음), 시트 도구는 열 때마다·refresh로 다시 그림", async browser => {
  const page = await newPage(browser, { ask: () => "A" });
  await open(page);
  const r = await page.evaluate(async () => {
    window.__offline = false;
    PaperApp.addSheetTool({ id: "t:net", render: () => (__offline ? PaperUI.h("span", { id: "t-net", text: "네트워크 연결 필요" }) : null) });
    PaperApp.openSheet({ quote: "x", selection: "x" });
    const toolsA = document.getElementById("sheet-tools").hidden;
    __offline = true;
    PaperApp.refreshSheetTools();
    const toolsB = !!document.getElementById("t-net");
    const t = PaperApp.addLocalTurn({ shown: "번역", markdown: "캐시된 번역", actions: [{ label: "더 자세히", onClick: () => PaperApp.ask("더 자세히") }] });
    const local = { turn: t.turnEl.classList.contains("turn-local"), text: t.answerEl.textContent, hist: PaperApp.session.history.length,
      saved: PaperStore.session.get(`app:thread:${PaperApp.baseId}`).history.length };
    t.toolsEl.querySelector("button").click();
    await new Promise(r => setTimeout(r, 300));
    return { toolsA, toolsB, local, hist: PaperApp.session.history.map(x => x.content), turns: document.querySelectorAll("#answer .turn").length };
  });
  assert.deepEqual(r, { toolsA: true, toolsB: true, local: { turn: true, text: "캐시된 번역", hist: 0, saved: 0 }, hist: ["더 자세히", "A"], turns: 2 });
  const back = await page.evaluate(() => { __offline = false; PaperApp.minimizeSheet(); __offline = true; PaperApp.restoreSheet(); return !!document.getElementById("t-net"); });
  assert.equal(back, true, "다시 열면 도구를 다시 그림");
});

test("paint {raw: true}: 색인 밖(.tr-ko) Range도 칠하고 paintedAt으로 찾음", async browser => {
  const page = await newPage(browser);
  await open(page);
  const r = await page.evaluate(() => {
    const ko = document.createElement("div");
    ko.className = "tr-ko";
    ko.innerHTML = '<span id="t-k1">첫 번째 번역 문장.</span> <span id="t-k2">두 번째 번역 문장.</span>';
    PaperAnchor.insertUI(document.getElementById("S1.p1"), ko);
    ko.scrollIntoView({ block: "center" });
    const rg = document.createRange();
    rg.selectNodeContents(document.getElementById("t-k2"));
    PaperAnchor.paint("t-as", [rg], { raw: true, priority: 30 });
    const hl = CSS.highlights.get("t-as");
    const b = document.getElementById("t-k2").getBoundingClientRect(), b1 = document.getElementById("t-k1").getBoundingClientRect();
    return { n: hl.size, text: [...hl][0].toString(), hit: PaperAnchor.paintedAt("t-as", b.left + 3, b.top + b.height / 2),
      miss: PaperAnchor.paintedAt("t-as", b1.left + 3, b1.top + b1.height / 2) };
  });
  assert.deepEqual(r, { n: 1, text: "두 번째 번역 문장.", hit: 0, miss: -1 });
});

test("헤더 아래 띠: --bar-h는 실제 헤더 높이, 자리 순서는 표대로, 헤더를 숨기면 띠가 맨 위로", async browser => {
  const page = await newPage(browser);
  await open(page);
  const r = await page.evaluate(async () => {
    PaperUI.status("t", "용어", "loading");
    PaperUI.topSlot("glossary").textContent = "뜻";
    PaperUI.topSlot("toc-progress").textContent = "막대";
    PaperUI.topSlot("in-paper-search");
    window.scrollTo(0, 600);
    await new Promise(r => setTimeout(r, 100));
    const bar = document.getElementById("bar"), ts = document.getElementById("top-stack");
    const cssBar = getComputedStyle(document.documentElement).getPropertyValue("--bar-h").trim();
    const order = [...ts.children].filter(c => getComputedStyle(c).display !== "none").map(c => c.dataset.slot);
    const gap = Math.round(ts.getBoundingClientRect().top - bar.getBoundingClientRect().bottom);
    let ev = null;
    document.addEventListener("paper:bar", e => { ev = e.detail; });
    PaperUI.setBarHidden(true);
    await new Promise(r => setTimeout(r, 400));
    return { cssBar, barH: bar.offsetHeight + "px", order, gap, hiddenTop: Math.round(ts.getBoundingClientRect().top), ev, hidden: PaperUI.isBarHidden() };
  });
  assert.equal(r.cssBar, r.barH);
  assert.deepEqual(r.order, ["toc-progress", "app:status", "glossary"]);
  assert.equal(r.gap, 0, "띠가 헤더 밑에 바로 (겹치거나 뜨지 않음)");
  assert.deepEqual([r.hiddenTop, r.ev, r.hidden], [0, { hidden: true }, true]);
});

test("작은 계약들: selInfo.anchored, wrap은 pr-ui를 뗌, API 없는 기능은 feature() undefined, threadId는 이어가도 같음", async browser => {
  const page = await newPage(browser, { ask: () => "A" });
  await open(page);
  const r = await page.evaluate(async () => {
    const card = document.createElement("div");
    card.style.userSelect = "text";
    card.textContent = "기능이 넣은 개요 카드 글자입니다";
    PaperAnchor.insertUI(document.querySelector(".ltx_authors"), card);
    const rg = document.createRange();
    rg.setStart(card.firstChild, 0);
    rg.setEnd(card.firstChild, 6);
    PaperApp.selectRange(rg);
    const onCard = PaperApp.sel();
    PaperApp.selectRange(__range(document.getElementById("S1.p1"), 8));
    const onPaper = PaperApp.sel();
    const text0 = PaperAnchor.index().text;
    const o = PaperAnchor.offsetsOfElement(document.getElementById("S1.p1"));
    const els = PaperAnchor.wrap(o.start + 2, o.start + 9, () => { const s = document.createElement("span"); s.className = "pr-ui tr-ko gl-ruby"; return s; });
    PaperApp.registerFeature("t-none");
    let threw = false;
    try { PaperApp.feature("t-none")?.add?.({}); PaperApp.feature("t-none")?.add({}); } catch { threw = true; }
    document.getSelection().removeAllRanges();
    const s1 = PaperApp.openSheet({ quote: "q", selection: "S" });
    await PaperApp.ask("Q1");
    const { quote, selection, context, section, history, shown, meta, threadId } = PaperApp.session;
    PaperApp.closeSheet();
    const s2 = PaperApp.openSheet({ quote, selection, context, section, history, shown, meta, threadId });
    return {
      card: [onCard.anchored, onCard.start, onCard.inTranslation], paper: [onPaper.anchored, typeof onPaper.start],
      wrapped: [els.length > 0, els[0].className, PaperAnchor.index().text === text0],
      feature: [PaperApp.has("t-none"), PaperApp.feature("t-none"), threw],
      thread: [s2.threadId === s1.threadId, s2.id !== s1.id, s1.threadId === s1.id],
    };
  });
  assert.deepEqual(r, {
    card: [false, null, false], paper: [true, "number"], wrapped: [true, "gl-ruby", true],
    feature: [true, undefined, false], thread: [true, true, true],
  });
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
