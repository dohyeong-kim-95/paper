// skim-highlights 브라우저 동작 (헤드리스 Chromium + Playwright, 전체 기능 번들). tests/test_browser.py가 실행:
//   node tests/browser/skim-highlights.browser.js <port>
// /api/skim-highlights/* 와 /api/ask 는 page.route로 가로챔. playwright나 Chromium이 없으면 "SKIP".
"use strict";
const assert = require("node:assert/strict");

let chromium;
try { ({ chromium } = require("playwright")); } catch { console.log("SKIP playwright 없음"); process.exit(0); }

const PORT = process.argv[2];
const BASE = `http://127.0.0.1:${PORT}`;
const PAPER = `${BASE}/paper/2401.00001`;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const Q = {
  goal: "We propose a sparse mixture of experts model that routes each token to two experts",
  novelty: "We introduce a top-two routing rule with a load balancing loss",
  method: "The training loss combines the task loss and a balancing term",
  result: "the sparse model improves accuracy by 2.3 points on MMLU",
  limit: "A limitation of our approach is the extra memory required to store all experts",
};
const JSONL = [
  { f: "goal", q: Q.goal, s: 3 }, { f: "novelty", q: Q.novelty, s: 2 }, { f: "method", q: Q.method, s: 1 },
  { f: "result", q: Q.result, s: 3 }, { f: "limit", q: Q.limit, s: 2 },
  { f: "result", q: "This sentence does not exist anywhere in the paper", s: 2 },
].map(o => JSON.stringify(o) + "\n").join("");

const IMG_SIZE = { "x1.png": [598, 300] };
async function newPage(browser, { skim = () => JSONL } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 800 }, serviceWorkers: "block" });
  await ctx.route(u => !u.href.startsWith(BASE), r => {
    if (r.request().resourceType() !== "image") return r.fulfill({ status: 200, body: "", contentType: "text/plain" });
    const [w, h] = IMG_SIZE[r.request().url().split("/").pop()] || [300, 200];
    return r.fulfill({ status: 200, body: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"/>`, contentType: "image/svg+xml" });
  });
  const asks = [], skims = [];
  await ctx.route(`${BASE}/api/ask`, async r => {
    asks.push(JSON.parse(r.request().postData() || "{}"));
    try { await r.fulfill({ status: 200, body: "답변입니다.", contentType: "text/plain; charset=utf-8" }); } catch { /* 중단 */ }
  });
  await ctx.route(u => u.href.startsWith(`${BASE}/api/skim-highlights/`), async r => {
    skims.push(r.request().url());
    const out = skim(skims.length), { body, delay = 0 } = typeof out === "string" ? { body: out } : out;
    if (delay) await new Promise(res => setTimeout(res, delay));
    try {
      await r.fulfill({ status: 200, body, contentType: "text/plain; charset=utf-8", headers: { "X-Offline-Cacheable": "1" } });
    } catch { /* 페이지가 닫힘 */ }
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  Object.assign(page, { asks, skims, errors });
  return page;
}
async function open(page) {
  await page.goto(PAPER);
  await page.waitForFunction(() => window.PaperApp && document.readyState === "complete" && PaperApp.has("skim-highlights"));
}
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 8000 });
const hl = page => page.evaluate(() => ["goal", "novelty", "method", "result", "limit"].filter(f => CSS.highlights.has(`sk-${f}`)));
// ⋯ 메뉴의 '핵심 문장'을 누름: 꺼져 있으면 켬, 켜져 있으면 목록 peek (DOM 비교를 위해 한 번에 동기로)
const viaMenu = page => page.evaluate(() => {
  const before = document.getElementById("paper").innerHTML;
  document.getElementById("bar-more").click();
  [...document.querySelectorAll(".pr-menu-item")].find(b => b.textContent.includes("핵심 문장")).click();
  return { same: document.getElementById("paper").innerHTML === before, marks: document.querySelectorAll("#paper mark").length };
});
// 띠(#status-strip)에는 다른 기능(용어·요약 등)의 칩도 함께 오르므로, 이 기능의 칩만 봄
const strip = page => page.evaluate(() => ({
  chip: document.querySelector('#status-strip .pr-status[data-key="skim-highlights"]')?.dataset.state || null,
}));

test("유휴 시간에 받아 두고 점 표시, 메뉴로 켜면 역할별로 칠함 (DOM 그대로), 켜져 있으면 메뉴가 목록을 열고 스위치로 끔", async browser => {
  const page = await newPage(browser);
  await open(page);
  await until(page, () => document.getElementById("bar-more").classList.contains("pr-dot"));
  assert.deepEqual(await hl(page), [], "기본은 꺼짐");
  assert.equal(page.skims.length, 1);
  assert.deepEqual(await viaMenu(page), { same: true, marks: 0 });
  assert.deepEqual(await hl(page), ["goal", "novelty", "method", "result", "limit"]);
  const st = await page.evaluate(() => ({
    on: JSON.parse(localStorage.getItem("pr:skim-highlights")).on,
    dot: document.getElementById("bar-more").classList.contains("pr-dot"),
    toast: document.getElementById("pr-toast").textContent,
    offline: PaperApp.offlineUrls().some(u => u.startsWith("/api/skim-highlights/")),
    bg: getComputedStyle(document.getElementById("S2.p3"), "::highlight(sk-result)").backgroundColor,
  }));
  assert.equal(st.on, true);
  assert.equal(st.dot, false);
  assert.match(st.toast, /핵심 문장 5개 표시/);
  assert.equal(st.offline, true);
  assert.match(st.bg, /rgba\(245, 158, 11/);
  const dark = await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "dark");
    const c = getComputedStyle(document.getElementById("S2.p3"), "::highlight(sk-result)").backgroundColor;
    document.documentElement.removeAttribute("data-theme");
    return c;
  });
  assert.match(dark, /rgba\(251, 191, 36/, "다크 모드 색");
  // 켜져 있으면 메뉴 = 목록 peek (언제든 들어갈 길). '목록' 토스트는 닫아서 다른 토스트를 막지 않음
  await viaMenu(page);
  await page.waitForSelector(".sk-legend-peek");
  assert.equal(await page.evaluate(() => document.getElementById("pr-toast").hidden), true, "'목록' 토스트 닫힘");
  const off = await page.evaluate(() => {
    const before = document.getElementById("paper").innerHTML;
    document.querySelector(".sk-switch").click();
    return {
      same: document.getElementById("paper").innerHTML === before, marks: document.querySelectorAll("#paper mark").length,
      sw: document.querySelector(".sk-switch").textContent,
    };
  });
  assert.deepEqual(off, { same: true, marks: 0, sw: "형광펜 꺼짐" });
  assert.deepEqual(await hl(page), []);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("pr:skim-highlights")).on), false);
  assert.equal(await page.evaluate(() => document.getElementById("bar-more").classList.contains("pr-dot")), true);
  assert.deepEqual(page.errors, []);
});

test("목록 peek: 역할 칩 개수·토글, 밀도 슬라이더, 섹션별 목록을 누르면 그 문장으로 이동", async browser => {
  const page = await newPage(browser);
  await page.addInitScript(() => localStorage.setItem("pr:skim-highlights", JSON.stringify({ on: true })));
  await open(page);
  await until(page, () => CSS.highlights.has("sk-limit"));
  await viaMenu(page); // 켜져 있음 → 목록
  await page.waitForSelector(".sk-legend-peek");
  const info = await page.evaluate(() => ({
    chips: [...document.querySelectorAll(".sk-chip")].map(c => c.textContent),
    groups: [...document.querySelectorAll(".sk-group h4")].map(x => x.textContent),
    items: document.querySelectorAll(".sk-item").length,
    note: document.querySelector(".sk-note").textContent,
  }));
  assert.deepEqual(info.chips, ["목표 1", "새로움 1", "방법 1", "결과 1", "한계 1"]);
  assert.deepEqual(info.groups, ["초록", "1 Introduction", "2 Method"]);
  assert.equal(info.items, 5);
  assert.equal(info.note, "5개 · 누르면 그 위치로 이동 (본문에서 못 찾은 1개 제외)");

  await page.click('.sk-chip[data-sk="goal"]');
  assert.deepEqual(await hl(page), ["novelty", "method", "result", "limit"]);
  await page.evaluate(() => { const s = document.querySelector(".sk-density input"); s.value = "1"; s.dispatchEvent(new Event("input")); });
  assert.deepEqual(await hl(page), ["result"], "밀도 적게 = ★3만, 목표는 꺼 둠");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("pr:skim-highlights")));
  assert.deepEqual([saved.on, saved.facets.goal, saved.minScore], [true, false, 3]);
  assert.equal(await page.evaluate(() => document.querySelector(".sk-dens-val").textContent), "적게 · ★3 이상");

  await page.click(".sk-item");
  await until(page, () => !document.querySelector(".sk-legend-peek"));
  assert.equal(await page.evaluate(() => !document.getElementById("back-chip").hidden), true);
  await until(page, () => { const b = PaperAnchor.findQuote("the sparse model improves accuracy").getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; });
  assert.deepEqual(page.errors, []);
});

test("칠한 문장 탭 → 작은 peek (역할·설명·번역·내 하이라이트로 저장), '설명'은 그 문장으로 질문", async browser => {
  const page = await newPage(browser);
  await page.addInitScript(() => localStorage.setItem("pr:skim-highlights", JSON.stringify({ on: true })));
  await open(page);
  await until(page, () => CSS.highlights.has("sk-result"));
  await page.evaluate(() => {
    window.__added = [];
    PaperApp.registerFeature("highlights-notes", { add: a => { __added.push(a); return "id1"; } });
  });
  const pt = async q => page.evaluate(q => {
    const r = PaperAnchor.findQuote(q);
    r.startContainer.parentElement.scrollIntoView({ block: "center" });
    const b = r.getClientRects()[0];
    return { x: b.left + Math.min(20, b.width / 2), y: b.top + b.height / 2 };
  }, q);
  let p = await pt(Q.result);
  await page.mouse.click(p.x, p.y);
  await page.waitForSelector(".sk-peek");
  const peek = await page.evaluate(() => ({
    title: document.querySelector(".sk-peek .pr-peek-head b").textContent,
    quote: document.querySelector(".sk-peek .sk-quote").textContent,
    actions: [...document.querySelectorAll(".sk-peek .pr-peek-actions button")].map(b => b.textContent),
  }));
  assert.deepEqual(peek, {
    title: "결과 · ★★★", quote: Q.result, actions: ["설명", "번역", "내 하이라이트로 저장", "다음 ↓", "목록"],
  });
  await page.click(".sk-peek .pr-peek-actions button:has-text('내 하이라이트로 저장')");
  const added = await page.evaluate(() => __added);
  assert.equal(added.length, 1);
  assert.equal(added[0].source, "skim-highlights");
  assert.equal(added[0].anchor.quote, Q.result);
  assert.equal(added[0].anchor.paraId, "S2.p3");

  p = await pt(Q.result);
  await page.mouse.click(p.x, p.y);
  await page.click(".sk-peek .pr-peek-actions button:has-text('설명')");
  await until(page, () => PaperApp.session && PaperApp.session.history.length === 2);
  const ask = page.asks[0];
  assert.equal(ask.selection, Q.result);
  assert.match(ask.question, /이 결과가 무엇을 뜻하고/);
  assert.equal(ask.section, "2 Method");
  assert.ok(ask.context.includes("A limitation of our approach"), "문단 문맥");
  assert.equal(await page.evaluate(() => !!document.querySelector(".sk-peek")), false);

  await page.evaluate(() => PaperApp.closeSheet());
  p = await pt(Q.limit);
  await page.mouse.click(p.x, p.y);
  await page.waitForSelector(".sk-peek");
  assert.equal(await page.evaluate(() => document.querySelector(".sk-peek .pr-peek-head b").textContent), "한계 · ★★☆");
  await page.click(".sk-peek .pr-peek-actions button:has-text('번역')");
  await until(page, () => PaperApp.session && PaperApp.session.history.length === 2);
  assert.equal(page.asks[1].selection, Q.limit);
  assert.match(page.asks[1].question, /번역/);
  await page.evaluate(() => PaperApp.closeSheet());

  // 칠하지 않은 본문 탭은 peek를 열지 않음 (시트 내려두기로)
  const plain = await page.evaluate(() => {
    const r = PaperAnchor.findQuote("Routing follows");
    r.startContainer.parentElement.scrollIntoView({ block: "center" });
    const b = r.getClientRects()[0];
    return { x: b.left + 5, y: b.top + b.height / 2 };
  });
  await page.mouse.click(plain.x, plain.y);
  assert.equal(await page.evaluate(() => !!document.querySelector(".sk-peek")), false);
  assert.deepEqual(page.errors, []);
});

test("실패 꼬리 → 상태 칩 오류 + '다시'(retry=1), 도착한 문장은 칠함", async browser => {
  const page = await newPage(browser, {
    skim: n => (n === 1 ? JSON.stringify({ f: "goal", q: Q.goal, s: 3 }) + "\n\n\n[오류] 응답이 너무 길어 잘렸습니다 (max_tokens)." : JSONL),
  });
  await page.addInitScript(() => localStorage.setItem("pr:skim-highlights", JSON.stringify({ on: true })));
  await open(page);
  await page.waitForSelector('.pr-status[data-key="skim-highlights"][data-state="error"]');
  assert.deepEqual(await hl(page), ["goal"]);
  await viaMenu(page);
  await page.waitForSelector(".sk-legend-peek");
  assert.equal(await page.evaluate(() => document.querySelector(".sk-note").textContent), "불러오지 못했습니다다시");
  await page.evaluate(() => PaperUI.closeLayers(() => true));
  assert.equal(await page.evaluate(() => PaperApp.offlineUrls().filter(u => u.startsWith("/api/skim-highlights/")).length), 0,
    "실패한 응답은 오프라인 목록에 안 넣음 (overview 등 다른 기능의 주소는 따로)");
  await page.click('.pr-status[data-key="skim-highlights"] button');
  await until(page, () => CSS.highlights.has("sk-limit"));
  assert.match(page.skims[1], /\?retry=1$/);
  assert.deepEqual(page.errors, []);
});

test("꺼 둔 채 미리 받다 실패하면 조용히 (띠에 칩 없음), 켜면 retry=1로 다시 받아 칠함", async browser => {
  const page = await newPage(browser, {
    skim: n => (n === 1 ? { body: "\n\n[오류] 핵심 문장을 찾지 못했습니다 (응답 형식 오류)", delay: 700 } : JSONL),
  });
  await open(page);
  for (let i = 0; i < 160 && !page.skims.length; i++) await page.waitForTimeout(50);
  assert.equal(page.skims.length, 1, "유휴 시간에 미리 받기 시작");
  await page.waitForTimeout(500); // 느린 생성 (400ms 넘음)
  assert.deepEqual(await strip(page), { chip: null }, "생성 중에도 칩 없음");
  await page.waitForTimeout(600); // 실패 도착
  assert.equal(page.skims.length, 1);
  assert.deepEqual(await strip(page), { chip: null }, "실패해도 칩 없음");
  assert.equal(await page.evaluate(() => document.getElementById("bar-more").classList.contains("pr-dot")), false);
  await viaMenu(page); // 켬 → 다시 생성
  await until(page, () => CSS.highlights.has("sk-limit"));
  assert.match(page.skims[1], /\?retry=1$/);
  assert.deepEqual(page.errors, []);
});

test("되풀이된 문장은 앞 항목 다음 자리에, 이미 칠한 자리뿐인 문장은 '못 찾은' 수에 넣지 않음", async browser => {
  const intro = "Large language models scale well, but dense computation grows";
  const again = "We propose a sparse mixture of experts model that routes each token"; // 초록·서론에 모두 있음
  const page = await newPage(browser, {
    skim: () => [
      { f: "goal", q: Q.goal, s: 3 }, { f: "method", q: intro, s: 2 }, { f: "novelty", q: again, s: 2 },
      { f: "result", q: "routes each token to two experts", s: 2 }, // 두 자리 모두 이미 칠함 → 버림
    ].map(o => JSON.stringify(o) + "\n").join(""),
  });
  await open(page);
  await until(page, () => document.getElementById("bar-more").classList.contains("pr-dot"));
  await viaMenu(page);
  await page.click("#pr-toast button"); // '목록'
  await page.waitForSelector(".sk-legend-peek");
  const info = await page.evaluate(() => ({
    groups: [...document.querySelectorAll(".sk-group")].map(g => [g.querySelector("h4").textContent, g.querySelectorAll(".sk-item").length]),
    note: document.querySelector(".sk-note").textContent,
    novelty: [...CSS.highlights.get("sk-novelty")].map(r => r.startContainer.parentElement.closest(".ltx_para, .ltx_abstract").id || "abstract"),
    result: CSS.highlights.has("sk-result"),
  }));
  assert.deepEqual(info.groups, [["초록", 1], ["1 Introduction", 2]]);
  assert.equal(info.note, "3개 · 누르면 그 위치로 이동");
  assert.deepEqual(info.novelty, ["S1.p1"]);
  assert.equal(info.result, false);
  assert.deepEqual(page.errors, []);
});

test("Highlight API가 없으면 텍스트 노드 하나 안의 문장만 <mark>로 (색인 텍스트 그대로), 탭도 동작", async browser => {
  const multi = "Routing follows Algorithm 1 and builds on efficient routers";
  const page = await newPage(browser, {
    skim: () => [{ f: "result", q: Q.result, s: 3 }, { f: "method", q: multi, s: 2 }].map(o => JSON.stringify(o) + "\n").join(""),
  });
  await page.addInitScript(() => {
    localStorage.setItem("pr:skim-highlights", JSON.stringify({ on: true }));
    Object.defineProperty(CSS, "highlights", { get: () => undefined, configurable: true });
  });
  await open(page);
  const text0 = await page.evaluate(() => PaperAnchor.index().text);
  await until(page, () => document.querySelector("#paper mark.pa-mark-sk-result"));
  const r = await page.evaluate(() => ({
    result: [...document.querySelectorAll("#paper mark.pa-mark-sk-result")].map(m => m.textContent).join(""),
    method: document.querySelectorAll("#paper mark.pa-mark-sk-method").length,
    text: PaperAnchor.index().text,
  }));
  assert.equal(r.result, Q.result);
  assert.equal(r.method, 0, "링크에 걸친 문장은 건너뜀");
  assert.equal(r.text, text0);
  const p = await page.evaluate(() => {
    const m = document.querySelector("#paper mark.pa-mark-sk-result");
    m.scrollIntoView({ block: "center" });
    const b = m.getClientRects()[0];
    return { x: b.left + 10, y: b.top + b.height / 2 };
  });
  await page.mouse.click(p.x, p.y);
  await page.waitForSelector(".sk-peek");
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
  console.log(`skim-highlights.browser.js: ${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
