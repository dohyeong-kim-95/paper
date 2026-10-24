// highlights-notes 브라우저 확인 (헤드리스 Chromium + Playwright, 전체 기능 번들). tests/test_browser.py가 실행:
//   node tests/browser/highlights-notes.browser.js <port>
"use strict";
const assert = require("node:assert/strict");

let chromium;
try { ({ chromium } = require("playwright")); } catch { console.log("SKIP playwright 없음"); process.exit(0); }

const PORT = process.argv[2];
const BASE = `http://127.0.0.1:${PORT}`;
const PAPER = `${BASE}/paper/2401.00001`;
const KEY = "pr:highlights-notes:2401.00001", TKEY = "pr:highlights-notes:threads:2401.00001";
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 바깥 네트워크는 막고(그림은 같은 비율의 빈 SVG), /api/ask는 테스트가 정한 답
async function newPage(browser, { init, ask } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 800 }, serviceWorkers: "block" });
  await ctx.route(u => !u.href.startsWith(BASE), r => (r.request().resourceType() === "image"
    ? r.fulfill({ status: 200, body: '<svg xmlns="http://www.w3.org/2000/svg" width="598" height="300"/>', contentType: "image/svg+xml" })
    : r.fulfill({ status: 200, body: "", contentType: "text/plain" })));
  const asks = [];
  await ctx.route(`${BASE}/api/ask`, async r => {
    const body = JSON.parse(r.request().postData() || "{}");
    asks.push(body);
    const out = ask ? await ask(body, asks.length) : `답변 ${asks.length}`;
    try { await r.fulfill({ status: 200, body: out, contentType: "text/plain; charset=utf-8" }); } catch { /* 중단 */ }
  });
  await ctx.addInitScript(() => {
    // 요소 안에서 글자 a의 시작 ~ 글자 b의 끝 (텍스트 노드가 달라도 됨: 사이에 수식이 있는 선택)
    window.__span = (id, a, b = a) => {
      const w = document.createTreeWalker(document.getElementById(id), NodeFilter.SHOW_TEXT);
      const r = document.createRange();
      let n, started = false;
      while ((n = w.nextNode())) {
        if (!started && n.data.includes(a)) { r.setStart(n, n.data.indexOf(a)); started = true; }
        if (started && n.data.includes(b)) { r.setEnd(n, n.data.indexOf(b) + b.length); return r; }
      }
      return null;
    };
    window.__center = range => { const b = range.getClientRects()[0]; return { x: b.left + Math.min(10, b.width / 2), y: b.top + b.height / 2 }; };
  });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => { if (/highlights-notes/.test(String(e.stack || e))) errors.push(String(e.stack || e)); });
  page.on("console", m => { if (m.type() === "error" && /highlights-notes/.test(m.text())) errors.push(m.text()); });
  page.asks = asks;
  page.errors = errors;
  return page;
}
async function open(page) {
  await page.goto(PAPER);
  await page.waitForFunction(() => window.PaperApp && PaperApp.has("highlights-notes") && document.readyState === "complete");
}
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 5000 });
const stored = (page, key = KEY) => page.evaluate(k => JSON.parse(localStorage.getItem(k) || "[]"), key);

async function highlight(page, id, a, b) {
  await page.evaluate(([id, a, b]) => { const r = __span(id, a, b); r.startContainer.parentElement.scrollIntoView({ block: "center" }); PaperApp.selectRange(r); }, [id, a, b]);
  await page.click('#sel-bar button[data-id="highlights-notes:highlight"]');
  await until(page, () => document.querySelector(".hn-quick"));
  await sleep(450); // 방금 선택을 푼 탭은 선택용 처리기만 받음 (justSelected 400ms)
}
// 칠한 구간(이름)의 첫 줄을 탭 (text가 있으면 그 글을 담은 구간). top: 화면 위쪽에 두기 (시트가 열려 있을 때)
async function tapPainted(page, name, text = "", top = false) {
  const p = await page.evaluate(([n, t, top]) => {
    const r = [...CSS.highlights.get(n)].find(x => x.toString().includes(t));
    r.startContainer.parentElement.scrollIntoView({ block: top ? "start" : "center" });
    if (top) scrollBy(0, -120);
    return __center(r);
  }, [name, text, top]);
  await page.mouse.click(p.x, p.y);
}
// 선택 → 질문하기 → 질문 (선택은 풀고: 남아 있으면 선택 버튼 줄이 시트 위에 다시 뜸)
async function askAbout(page, id, text, q) {
  await page.evaluate(([id, t]) => PaperApp.selectRange(__span(id, t)), [id, text]);
  await page.click('#sel-bar button[data-id="ask"]');
  await page.evaluate(q => { document.getSelection().removeAllRanges(); PaperApp.ask(q); }, q);
  await until(page, () => PaperApp.session && PaperApp.session.history.length >= 2 && !PaperApp.streaming);
  await until(page, () => document.querySelector("#answer .turn:last-child .hn-save"));
  await sleep(450);
}

test("선택 → 하이라이트: 저장·칠하기·색 바꾸기, 새로고침·글자 크기 변경 뒤에도 수식 포함 인용이 같은 자리", async browser => {
  const page = await newPage(browser);
  await open(page);
  await highlight(page, "S1.p1", "grows as", "of width");
  const r1 = await page.evaluate(() => ({ yellow: CSS.highlights.has("hn-yellow"), collapsed: document.getSelection().isCollapsed }));
  assert.deepEqual(r1, { yellow: true, collapsed: true });
  let items = await stored(page);
  assert.equal(items.length, 1);
  assert.deepEqual(Object.keys(items[0].anchor).sort(), ["paraId", "prefix", "quote", "suffix"]);
  assert.equal(items[0].anchor.quote, "grows as $x^{2}$ for a model of width");
  assert.equal(items[0].anchor.paraId, "S1.p1");
  assert.deepEqual([items[0].type, items[0].color], ["hl", "yellow"]);

  await page.click('.hn-quick .hn-sw[data-c="green"]');
  items = await stored(page);
  assert.equal(items[0].color, "green");
  assert.deepEqual(await page.evaluate(() => [CSS.highlights.has("hn-yellow"), CSS.highlights.has("hn-green"),
    JSON.parse(localStorage.getItem("pr:highlights-notes:prefs")).color]), [false, true, "green"]);

  // 글자 크기를 바꾸고 새로고침 (reading-settings가 있으면 그 범위로 맞추므로 값은 '바뀌었는지'만)
  const size0 = await page.evaluate(() => getComputedStyle(document.getElementById("paper")).fontSize);
  await page.evaluate(() => localStorage.setItem("pr:reading-settings", JSON.stringify({ size: 22 })));
  await page.reload();
  await page.waitForFunction(() => window.PaperApp && document.readyState === "complete");
  await until(page, () => CSS.highlights.has("hn-green"));
  const q = await page.evaluate(() => [getComputedStyle(document.getElementById("paper")).fontSize,
    PaperAnchor.rangeToQuote([...CSS.highlights.get("hn-green")][0]).quote]);
  assert.notEqual(q[0], size0);
  assert.equal(q[1], "grows as $x^{2}$ for a model of width");
  assert.deepEqual(page.errors, []);
});

test("하이라이트 탭 → peek: 메모 추가(미리보기), 색, ✎ 표시, 삭제 → 실행 취소", async browser => {
  const page = await newPage(browser);
  await open(page);
  await highlight(page, "S2.p3", "the sparse model improves accuracy");
  await tapPainted(page, "hn-yellow");
  await until(page, () => document.querySelector(".hn-peek .hn-quote"));
  assert.equal(await page.textContent(".hn-peek .hn-quote"), "the sparse model improves accuracy");
  await page.click(".hn-peek .hn-link");
  await page.fill(".hn-peek textarea", "**중요** 수치 $x$");
  await until(page, () => document.querySelector(".hn-peek .hn-preview").textContent.includes("중요"));
  await page.click(".hn-peek .hn-ed-actions .primary");
  let items = await stored(page);
  assert.deepEqual([items[0].note, items[0].type], ["**중요** 수치 $x$", "note"]);
  await until(page, () => document.querySelector(".hn-gutter .hn-badge")?.textContent === "✎");
  // 배지는 본문 오른쪽 여백 안 (가로 스크롤 없음)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.click(".pr-peek-actions button:has-text('삭제')");
  assert.equal((await stored(page)).length, 0);
  assert.equal(await page.evaluate(() => CSS.highlights.has("hn-yellow")), false);
  await page.click("#pr-toast button");
  items = await stored(page);
  assert.equal(items.length, 1);
  assert.equal(items[0].note, "**중요** 수치 $x$");
  assert.equal(await page.evaluate(() => CSS.highlights.has("hn-yellow")), true);
  // 하이라이트 밖 탭은 peek 없음
  await page.keyboard.press("Escape");
  const p = await page.evaluate(() => __center(__span("S2.p3", "Routing follows")));
  await page.mouse.click(p.x, p.y);
  await sleep(100);
  assert.equal(await page.evaluate(() => document.querySelectorAll(".hn-peek").length), 0);
  assert.deepEqual(page.errors, []);
});

test("답변 → '노트에 저장'(선택 자리), 질문 기록 자동 저장, 기록·하이라이트에서 이어 물으면 첫 턴이 같은 바이트", async browser => {
  const page = await newPage(browser);
  await open(page);
  await page.evaluate(() => PaperApp.selectRange(__span("S2.p3", "A limitation of our approach")));
  await page.click('#sel-bar button[data-id="ask"]');
  // 선택이 남아 있으면 선택 버튼 줄이 시트 위에 다시 뜸 (기반 동작) → 풀고 질문
  await page.evaluate(() => { document.getSelection().removeAllRanges(); PaperApp.ask("왜 한계야?"); });
  await sleep(400);
  await until(page, () => document.querySelector("#answer .hn-save"));
  const s1 = await page.evaluate(() => PaperApp.session.threadId);
  let threads = await stored(page, TKEY);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].id, s1);
  assert.equal(threads[0].anchor.quote, "A limitation of our approach");
  assert.equal(threads[0].history.length, 2);
  assert.equal(threads[0].endpoint, "/api/ask");
  assert.equal(threads[0].label, "왜 한계야?");

  await page.click("#answer .hn-save");
  let items = await stored(page);
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].type, items[0].thread, items[0].anchor.quote, items[0].qa], ["qa", s1, "A limitation of our approach", [{ q: "왜 한계야?", a: "답변 1" }]]);
  assert.match(await page.textContent("#answer .hn-save"), /저장됨/);

  // 닫고 → 패널 '질문 기록' → 이어서 질문
  await page.evaluate(() => PaperApp.closeSheet());
  await page.click("#bar-more");
  await page.click(".pr-menu-item:has-text('노트')");
  await page.click(".hn-tab:has-text('질문 기록')");
  await page.click(".hn-row-t .hn-row-main");
  await until(page, () => PaperApp.isSheetOpen() && PaperApp.session.continued);
  assert.equal(await page.evaluate(() => [PaperApp.session.threadId, document.querySelectorAll("#answer .turn").length].join()), `${s1},1`);
  await page.evaluate(() => PaperApp.ask("더 자세히"));
  await until(page, () => PaperApp.session.history.length === 4);
  const [a, b] = page.asks;
  assert.deepEqual([b.selection, b.context, b.section, b.history[0].content], [a.selection, a.context, a.section, a.question]);
  threads = await stored(page, TKEY);
  assert.deepEqual([threads.length, threads[0].id, threads[0].history.length], [1, s1, 4]);

  // 하이라이트(저장한 Q&A) 탭 → 저장한 답 표시 → '이어서 질문'은 같은 대화로
  await page.evaluate(() => PaperApp.closeSheet());
  await sleep(450);
  await tapPainted(page, "hn-yellow");
  await until(page, () => document.querySelector(".hn-peek .hn-qa-a"));
  assert.equal(await page.textContent(".hn-peek .hn-qa-a"), "답변 1");
  await page.click(".pr-peek-actions button:has-text('이어서 질문')");
  await until(page, () => PaperApp.isSheetOpen());
  assert.deepEqual(await page.evaluate(() => [PaperApp.session.threadId, PaperApp.session.history.length, document.querySelectorAll(".hn-peek").length]), [s1, 4, 0]);
  // 질문 기록 자리에 Q 표시
  await until(page, () => [...document.querySelectorAll(".hn-gutter .hn-badge")].some(b => b.textContent === "Q"));
  assert.deepEqual(page.errors, []);
});

test("같은 자리 하이라이트에 답변 저장은 합쳐짐(대화 여럿도), 질문 기록 자리 탭은 가로채지 않고 Q 표시로 엶", async browser => {
  const page = await newPage(browser);
  await open(page);
  await highlight(page, "S2.p3", "the sparse model improves accuracy");
  await page.mouse.click(5, 400);
  await askAbout(page, "S2.p3", "the sparse model improves accuracy", "근거는?");
  await page.click("#answer .hn-save");
  let items = await stored(page);
  assert.equal(items.length, 1, "새 항목 대신 기존 하이라이트에 Q&A");
  assert.deepEqual([items[0].type, items[0].color, items[0].thread, items[0].qa.length], ["qa", "yellow", await page.evaluate(() => PaperApp.session.threadId), 1]);

  await askAbout(page, "S1.p1", "Large language models", "무슨 모델?");
  const t2 = await page.evaluate(() => PaperApp.session.threadId);
  assert.equal((await stored(page, TKEY)).length, 2);
  // 시트가 열린 채 그 문장(질문 기록 밑줄) 탭 → 내려두기 (대화는 그대로)
  await tapPainted(page, "hn-q", "Large language models", true);
  await until(page, () => !PaperApp.isSheetOpen() && !document.getElementById("sheet-pill").hidden);
  assert.equal(await page.evaluate(() => PaperApp.session.threadId), t2);
  // 닫고 다시 탭 → 질문 기록 자리는 탭을 가로채지 않음 (§5.4: 저장한 하이라이트만, 용어·각주 탭이 그대로)
  await page.evaluate(() => PaperApp.closeSheet());
  await sleep(450);
  await tapPainted(page, "hn-q", "Large language models");
  await sleep(300);
  assert.equal(await page.evaluate(() => PaperApp.isSheetOpen()), false);
  // 그 줄의 Q 표시 → 그 대화를 기록과 함께 다시 엶
  await page.evaluate(() => {
    const r = [...CSS.highlights.get("hn-q")].find(x => x.toString().includes("Large language models"));
    const y = r.getClientRects()[0].top + scrollY;
    const qs = [...document.querySelectorAll(".hn-gutter .hn-badge-q")];
    qs.sort((a, b) => Math.abs(parseFloat(a.style.top) - y) - Math.abs(parseFloat(b.style.top) - y))[0].click();
  });
  await until(page, () => PaperApp.isSheetOpen() && PaperApp.session.continued);
  assert.deepEqual(await page.evaluate(() => [PaperApp.session.threadId, PaperApp.session.history.length]), [t2, 2]);
  await page.evaluate(() => PaperApp.closeSheet());

  // 같은 자리에서 두 번째 대화를 저장해도 같은 항목에 붙음 (탭 한 번으로 둘 다)
  await sleep(450);
  await askAbout(page, "S2.p3", "the sparse model improves accuracy", "두번째 대화");
  const t3 = await page.evaluate(() => PaperApp.session.threadId);
  await page.click("#answer .hn-save");
  items = await stored(page);
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].qa.length, items[0].thread, items[0].threads.length], [2, t3, 2]);
  await page.evaluate(() => PaperApp.closeSheet());

  // 패널: 섹션 제목 (문서 순서), 내보내기에도
  await page.evaluate(() => { PaperUI.download = (name, text) => { window.__dl = text; }; });
  await page.click("#bar-more");
  await page.click(".pr-menu-item:has-text('노트')");
  assert.deepEqual(await page.$$eval(".hn-list .hn-sec", els => els.map(e => e.textContent)), ["2 Method"]);
  await page.click(".hn-tab:has-text('질문 기록')");
  assert.deepEqual(await page.$$eval(".hn-list .hn-sec", els => els.map(e => e.textContent)), ["1 Introduction", "2 Method"]);
  await page.click(".hn-btn:has-text('.md 다운로드')");
  assert.ok((await page.evaluate(() => window.__dl)).includes("### 2 Method\n\n> the sparse model improves accuracy"));
  await page.keyboard.press("Escape");

  // 항목 peek에서 메모를 쓰다 바깥으로 닫아도 저장 (입력칸은 바로 포커스)
  await sleep(450);
  await tapPainted(page, "hn-yellow");
  await until(page, () => document.querySelector(".hn-peek .hn-qa-a"));
  await page.click(".hn-peek .hn-link:has-text('메모 추가')");
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains("hn-ta")), true);
  await page.keyboard.type("나중에 다시");
  await page.keyboard.press("Escape");
  items = await stored(page);
  assert.equal(items[0].note, "나중에 다시");
  // 선택 → '메모': peek가 열린 뒤에도 입력칸에 포커스 (iOS 키보드)
  await page.evaluate(() => PaperApp.selectRange(__span("S1.p1", "Knowledge distillation")));
  await page.click('#sel-bar button[data-id="highlights-notes:note"]');
  await sleep(120);
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains("hn-ta")), true);
  assert.deepEqual(page.errors, []);
});

test("'내 메모 참고': 선택 없는 세션의 첫 턴 context에만 <my-notes>, 이어 가도 같은 바이트", async browser => {
  const page = await newPage(browser);
  await open(page);
  await highlight(page, "S1.p1", "sparse mixture of experts");
  await page.click("#bar-more");
  await page.click(".pr-menu-item:has-text('노트')");
  await page.click(".hn-toggle:has-text('내 메모 참고') input");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("pr:highlights-notes:prefs")).useNotes), true);
  await page.evaluate(() => { PaperApp.openSheet({ title: "논문에 질문" }); PaperApp.ask("핵심이 뭐야?"); });
  await until(page, () => PaperApp.session.history.length === 2);
  await page.evaluate(() => PaperApp.ask("더"));
  await until(page, () => PaperApp.session.history.length === 4);
  await page.evaluate(() => { PaperApp.openSheet({ quote: "x", selection: "x", context: "CTX" }); PaperApp.ask("선택 질문"); });
  await until(page, () => PaperApp.session.history.length === 2);
  const [a, b, c] = page.asks;
  assert.match(a.context, /^<my-notes>\n- "sparse mixture of experts"\n<\/my-notes>$/);
  assert.equal(b.context, a.context);
  assert.equal(c.context, "CTX");
  assert.deepEqual(page.errors, []);
});

test("패널: 문서 순서·색 필터, .md 내보내기, add() API (번역문은 null), 형광펜 모드", async browser => {
  const page = await newPage(browser);
  await open(page);
  await highlight(page, "S2.p3", "extra memory required");
  await page.click('.hn-quick .hn-sw[data-c="blue"]');
  await page.mouse.click(5, 400);
  await highlight(page, "S1.p1", "Large language models");
  const api = await page.evaluate(() => {
    const f = PaperApp.feature("highlights-notes");
    const ko = document.createElement("div");
    ko.className = "tr-ko";
    ko.textContent = "번역된 문장입니다 아주 길게";
    PaperAnchor.insertUI(document.getElementById("S2.p1"), ko);
    const r = document.createRange();
    r.selectNodeContents(ko);
    const id1 = f.add({ range: __span("S2.p1", "The router computes gate scores"), source: "audio-summary" });
    const toast = document.querySelector("#pr-toast button")?.textContent;
    const id2 = f.add({ anchor: { quote: "routes each token to two experts", prefix: "", suffix: "", paraId: "S1.p1" }, source: "skim-highlights", color: "pink" });
    return { id1: typeof id1, id2: typeof id2, ko: f.add({ range: r }), bad: f.add({ anchor: { quote: "없는 문장입니다 정말로" } }), toast };
  });
  assert.deepEqual(api, { id1: "string", id2: "string", ko: null, bad: null, toast: "실행 취소" });
  const items = await stored(page);
  assert.deepEqual(items.map(i => i.source || "").sort(), ["", "", "audio-summary", "skim-highlights"]);

  await page.evaluate(() => { window.__dl = null; PaperUI.download = (name, text, type) => { window.__dl = { name, text, type }; }; });
  await page.click("#bar-more");
  await page.click(".pr-menu-item:has-text('노트')");
  const quotes = await page.$$eval(".hn-list .hn-row-quote", els => els.map(e => e.textContent));
  assert.deepEqual(quotes, ["Large language models", "routes each token to two experts", "The router computes gate scores", "extra memory required"]);
  // 색을 고르면 그 색이 다음 펜 색 (파랑으로 바꾼 뒤의 하이라이트·add()도 파랑), add({color})는 그 색
  const shown = () => page.$$eval(".hn-list .hn-row-quote", els => els.map(e => e.textContent));
  await page.click(".hn-chip[data-c='pink']");
  assert.deepEqual(await shown(), ["routes each token to two experts"]);
  await page.click(".hn-chip[data-c='blue']");
  assert.deepEqual(await shown(), ["Large language models", "The router computes gate scores", "extra memory required"]);
  await page.click(".hn-btn:has-text('.md 다운로드')");
  const dl = await page.evaluate(() => window.__dl);
  assert.equal(dl.name, "notes-2401.00001.md");
  assert.equal(dl.type, "text/markdown");
  assert.ok(dl.text.startsWith("# Sparse Mixtures for Everyone"), dl.text.slice(0, 80));
  assert.ok(dl.text.includes("arXiv: https://arxiv.org/abs/2401.00001"));
  const order = ["> Large language models", "> routes each token", "> The router computes", "> extra memory required"].map(s => dl.text.indexOf(s));
  assert.ok(order.every((v, i) => v > 0 && (!i || v > order[i - 1])), String(order));

  // 형광펜 모드: 선택하면 선택 버튼 줄 없이 바로 칠함
  await page.click(".hn-toggle:has-text('형광펜 모드') input");
  await page.keyboard.press("Escape");
  await page.evaluate(() => PaperApp.selectRange(__span("A1.p1", "We report the per-expert load")));
  await sleep(250);
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("sel-bar")).display), "none");
  await until(page, () => JSON.parse(localStorage.getItem("pr:highlights-notes:2401.00001")).length === 5);
  assert.equal(await page.evaluate(() => document.getSelection().isCollapsed), true);
  await until(page, () => document.querySelector(".hn-quick > button:last-child")?.textContent === "펜 끄기");
  await page.click(".hn-quick button:has-text('펜 끄기')");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("pr:highlights-notes:prefs")).highlighter), false);
  assert.deepEqual(page.errors, []);
});

test("같은 문구가 여러 번: 항목에서 연 질문은 그 항목 자리에, add()는 내 메모·색을 덮지 않음, 수식으로 시작하는 하이라이트도 탭", async browser => {
  const page = await newPage(browser);
  await open(page);
  // 'router'가 처음 나오는 곳(S1.p1)이 아닌 S2.p1의 'router'를 칠하고 → 질문하기 → 노트에 저장
  await highlight(page, "S2.p1", "router");
  await page.mouse.click(5, 400);
  await sleep(450);
  await tapPainted(page, "hn-yellow", "router");
  await until(page, () => document.querySelector(".hn-peek"));
  await page.click(".pr-peek-actions button:has-text('질문하기')");
  await until(page, () => PaperApp.isSheetOpen());
  await page.evaluate(() => PaperApp.ask("뭐야?"));
  await until(page, () => document.querySelector("#answer .hn-save"));
  await page.click("#answer .hn-save");
  const items = await stored(page), threads = await stored(page, TKEY);
  assert.equal(items.length, 1, "새 항목을 다른 'router'에 만들지 않음");
  assert.deepEqual([items[0].type, items[0].anchor.paraId, items[0].qa.length], ["qa", "S2.p1", 1]);
  assert.equal(threads[0].anchor.paraId, "S2.p1");
  await page.evaluate(() => PaperApp.closeSheet());

  // 공개 add(): 같은 자리에 다시 오면 내 메모는 남기고 덧붙임, 색은 그대로
  const r = await page.evaluate(() => {
    const f = PaperApp.feature("highlights-notes");
    const a = f.add({ range: __span("S1.p1", "Knowledge distillation"), note: "내 메모: 중요" });
    const it = JSON.parse(localStorage.getItem("pr:highlights-notes:2401.00001")).find(x => x.id === a);
    const b = f.add({ anchor: it.anchor, note: "공유받은 남의 메모", color: "pink" });
    const after = JSON.parse(localStorage.getItem("pr:highlights-notes:2401.00001")).find(x => x.id === a);
    return { same: a === b, note: after.note, color: after.color };
  });
  assert.deepEqual(r, { same: true, note: "내 메모: 중요\n\n---\n\n공유받은 남의 메모", color: "yellow" });

  // 수식으로 시작하는 하이라이트: 그 수식을 탭해도 열림
  await page.evaluate(() => {
    const m = document.getElementById("S1.p1.m1"), end = __span("S1.p1", "of width");
    const r = document.createRange();
    r.setStartBefore(m);
    r.setEnd(end.endContainer, end.endOffset);
    PaperApp.feature("highlights-notes").add({ range: r });
    m.scrollIntoView({ block: "center" });
  });
  await sleep(450);
  const c = await page.evaluate(() => { const b = document.getElementById("S1.p1.m1").getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
  await page.mouse.click(c.x, c.y);
  await until(page, () => document.querySelector(".hn-peek .hn-quote") && document.querySelector(".hn-peek .hn-quote").textContent.includes("of width"));
  assert.deepEqual(page.errors, []);
});

test("저장소를 못 쓰는 환경(사생활 모드)에서도 오류 없이 동작", async browser => {
  const page = await newPage(browser, {
    init: () => { Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } }); },
  });
  const all = [];
  page.on("pageerror", e => all.push(String(e)));
  await open(page);
  await highlight(page, "S1.p1", "Knowledge distillation");
  assert.equal(await page.evaluate(() => CSS.highlights.has("hn-yellow")), true);
  await page.click("#bar-more");
  await page.click(".pr-menu-item:has-text('노트')");
  assert.equal(await page.evaluate(() => document.querySelectorAll(".hn-list .hn-row").length), 1);
  assert.deepEqual(all.filter(e => /highlights-notes|PaperStore/.test(e)), []);
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
  console.log(`highlights-notes.browser.js: ${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
