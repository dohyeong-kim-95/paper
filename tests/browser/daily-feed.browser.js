// daily-feed 브라우저 확인 (홈): 분야 칩 → 피드 한 번만 요청, 한국어 제목·요약 채움, AND/OR 키워드 필터, 칩 전환·한글 끄기,
// 편집(추가·삭제 실행 취소), 저자 팔로우, 첫 방문 서재 기반 분야, 카드 모드, '새 논문' 표시. tests/test_browser.py가 실행 (인자: 포트)
"use strict";
const assert = require("node:assert/strict");

let chromium;
try { ({ chromium } = require("playwright")); } catch { console.log("SKIP playwright 없음"); process.exit(0); }

const PORT = process.argv[2];
const BASE = `http://127.0.0.1:${PORT}`;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const iso = minAgo => new Date(Date.now() - minAgo * 60e3).toISOString().replace(/\.\d+Z$/, "Z");
const ITEMS = [
  { id: "2610.00003", title: "Sparse Routing for Mixture of Experts", authors: ["Alice Kim", "Bob Lee", "Carol Park"], n_authors: 5,
    summary: "We propose sparse routing for experts.", published: iso(1), updated: iso(1), cat: "cs.CL", comment: null },
  { id: "2610.00002", title: "Dense Vision Transformers", authors: ["Dan Choi"], n_authors: 1,
    summary: "A dense vision model for images.", published: iso(3), updated: iso(3), cat: "cs.CV", comment: null },
  { id: "2610.00001", title: "Agents that Plan", authors: ["Eve Han"], n_authors: 1,
    summary: "LLM agents with planning and routing.", published: iso(30 * 60), updated: iso(30 * 60), cat: "cs.AI", comment: null },
];
const KO = {
  "2610.00003": { t: "전문가 혼합을 위한 희소 라우팅", b: "토큰을 두 전문가로 보내는 라우팅 제안" },
  "2610.00002": { t: "조밀한 비전 트랜스포머", b: "이미지용 조밀 모델" },
  "2610.00001": { t: "계획하는 에이전트", b: "계획 단계를 둔 LLM 에이전트" },
};

async function newPage(browser, { init, suggest = ["cs.CV"] } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 800 }, serviceWorkers: "block" });
  await ctx.route(u => !u.href.startsWith(BASE), r => r.fulfill({ status: 200, body: "", contentType: "text/plain" }));
  const calls = [];
  await ctx.route(`${BASE}/api/daily-feed**`, r => {
    const u = new URL(r.request().url());
    calls.push(u.pathname + u.search);
    let body = ITEMS;
    if (u.pathname.endsWith("/ko")) body = KO;
    else if (u.pathname.endsWith("/suggest")) body = { cats: suggest };
    return r.fulfill({ status: 200, body: JSON.stringify(body), contentType: "application/json" });
  });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.calls = calls;
  page.errors = errors;
  await page.goto(BASE + "/");
  await page.waitForFunction(() => window.PaperApp && PaperApp.has("daily-feed") && document.readyState === "complete");
  return page;
}
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 5000 });
const titles = page => page.$$eval(".df-card:not([hidden]) .df-title", els => els.map(e => e.textContent));

test("기본 분야 칩, 첫 분야 피드만 한 번 요청, 날짜 묶음, 한국어 제목·요약 채움", async browser => {
  const page = await newPage(browser);
  await until(page, () => document.querySelectorAll(".df-card").length === 3);
  const r = await page.evaluate(() => ({
    section: document.querySelector('[data-section="daily-feed"] > h2').textContent,
    chips: [...document.querySelectorAll(".df-chip")].map(c => [c.textContent, c.getAttribute("aria-pressed")]),
    groups: [...document.querySelectorAll(".df-group")].map(g => g.textContent),
    open: document.querySelector(".df-card .df-open").getAttribute("href"),
    authors: document.querySelector(".df-card .df-authors").textContent,
  }));
  assert.equal(r.section, "오늘의 새 논문");
  assert.deepEqual(r.chips.slice(0, 3), [["cs.CL", "true"], ["cs.LG", "false"], ["cs.AI", "false"]]);
  assert.equal(r.chips[3][0], "＋ 편집");
  assert.equal(r.groups[0].endsWith("· 2편"), true);
  assert.equal(r.groups.length, 2);
  assert.equal(r.open, "/paper/2610.00003");
  assert.match(r.authors, /Alice Kim.*Carol Park.*외 2명/);
  await until(page, () => document.querySelector(".df-title").textContent === "전문가 혼합을 위한 희소 라우팅");
  const k = await page.evaluate(() => {
    const c = document.querySelector(".df-card");
    return { en: c.querySelector(".df-en-title").hidden, enText: c.querySelector(".df-en-title").textContent,
      blurb: c.querySelector(".df-blurb").textContent, status: document.querySelector(".df-status").hidden };
  });
  assert.deepEqual(k, { en: false, enText: "Sparse Routing for Mixture of Experts", blurb: "토큰을 두 전문가로 보내는 라우팅 제안", status: true });
  assert.deepEqual(page.calls, ["/api/daily-feed?cat=cs.CL", "/api/daily-feed/ko?cat=cs.CL"]);
  assert.deepEqual(page.errors, []);
});

test("키워드 필터: AND/OR 전환, 제외어, 개수 표시, 묶음 제목 숨김", async browser => {
  const page = await newPage(browser);
  await until(page, () => document.querySelectorAll(".df-card").length === 3);
  await page.fill(".df-q", "routing experts");
  await until(page, () => document.querySelector(".df-count").textContent === "1/3");
  assert.equal((await titles(page)).length, 1);
  await page.click(".df-mode");
  await until(page, () => document.querySelector(".df-count").textContent === "2/3");
  assert.equal(await page.textContent(".df-mode"), "OR");
  await page.fill(".df-q", "routing -agents");
  await until(page, () => document.querySelector(".df-count").textContent === "1/3");
  const groups = await page.$$eval(".df-group", gs => gs.map(g => g.hidden));
  assert.deepEqual(groups, [false, true]); // 어제 묶음은 카드가 모두 숨어 같이 숨음
  await page.fill(".df-q", "없는단어");
  await until(page, () => !!document.querySelector(".df-empty"));
  await page.fill(".df-q", "");
  await until(page, () => document.querySelector(".df-count").textContent === "" && !document.querySelector(".df-empty"));
  // 필터는 기억됨
  await page.fill(".df-q", "vision");
  await until(page, () => (JSON.parse(localStorage.getItem("pr:daily-feed:prefs")) || {}).q === "vision");
  assert.deepEqual(page.errors, []);
});

test("칩 전환 → 그 분야만 요청, 한글 끄면 영어 제목·한국어 요청 없음", async browser => {
  const page = await newPage(browser, { init: () => localStorage.setItem("pr:daily-feed:prefs", JSON.stringify({ ko: false })) });
  await until(page, () => document.querySelectorAll(".df-card").length === 3);
  await page.click('.df-chip:has-text("cs.LG")');
  await until(page, () => document.querySelector('.df-chip[aria-pressed="true"]').textContent === "cs.LG");
  await until(page, () => document.querySelectorAll(".df-card").length === 3);
  assert.equal((await titles(page))[0], "Sparse Routing for Mixture of Experts");
  assert.deepEqual(page.calls, ["/api/daily-feed?cat=cs.CL", "/api/daily-feed?cat=cs.LG"]);
  await page.click('.df-tool:has-text("한글")');
  await until(page, () => document.querySelector(".df-title").textContent === "전문가 혼합을 위한 희소 라우팅");
  assert.equal(page.calls[2], "/api/daily-feed/ko?cat=cs.LG");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("pr:daily-feed:prefs")));
  assert.equal(saved.active, "cat:cs.LG");
  assert.equal(saved.ko, true);
  assert.deepEqual(page.errors, []);
});

test("편집: 분야 추가(정규화)·삭제 후 실행 취소, 저장", async browser => {
  const page = await newPage(browser);
  await until(page, () => document.querySelectorAll(".df-card").length === 3);
  await page.click(".df-chip-edit");
  await page.fill(".df-peek .df-input >> nth=0", "cs.cv, bad!");
  await page.click('.df-peek .df-add >> nth=0 >> button');
  await until(page, () => JSON.stringify(JSON.parse(localStorage.getItem("pr:daily-feed:cats"))) === '["cs.CL","cs.LG","cs.AI","cs.CV"]');
  await page.click('.df-peek [aria-label="cs.LG 삭제"]');
  await until(page, () => !localStorage.getItem("pr:daily-feed:cats").includes("cs.LG"));
  assert.match(await page.textContent("#pr-toast"), /cs\.LG 삭제됨/);
  await page.click('#pr-toast button:has-text("실행 취소")');
  await until(page, () => localStorage.getItem("pr:daily-feed:cats") === '["cs.CL","cs.LG","cs.AI","cs.CV"]');
  await page.keyboard.press("Escape");
  const chips = await page.$$eval(".df-chips .df-chip:not(.df-chip-edit)", cs => cs.map(c => c.textContent));
  assert.deepEqual(chips, ["cs.CL", "cs.LG", "cs.AI", "cs.CV"]);
  assert.deepEqual(page.errors, []);
});

test("저자 이름 탭 → 팔로우하고 논문 보기 → 저자 칩·author 요청", async browser => {
  const page = await newPage(browser);
  await until(page, () => document.querySelectorAll(".df-card").length === 3);
  await page.click('.df-au:has-text("Bob Lee")');
  await page.click('.pr-peek-actions button:has-text("팔로우하고 논문 보기")');
  await until(page, () => document.querySelector('.df-chip[aria-pressed="true"]').textContent === "👤 Bob Lee");
  await until(page, () => document.querySelectorAll(".df-card").length === 3);
  assert.ok(page.calls.includes("/api/daily-feed?author=Bob%20Lee"));
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("pr:daily-feed:authors"))), ["Bob Lee"]);
  assert.equal(await page.$(".pr-peek"), null);
  assert.deepEqual(page.errors, []);
});

test("첫 방문 + 서재 논문 → 추천 분야로 기본값, 피드는 그 분야로 한 번", async browser => {
  const page = await newPage(browser, {
    suggest: ["cs.CV", "eess.IV"],
    init: () => { if (!localStorage.getItem("pr:library")) localStorage.setItem("pr:library", JSON.stringify({ "2401.00001": { id: "2401.00001", opened: 1 } })); },
  });
  await until(page, () => document.querySelectorAll(".df-card").length === 3);
  const chips = await page.$$eval(".df-chips .df-chip:not(.df-chip-edit)", cs => cs.map(c => c.textContent));
  assert.deepEqual(chips, ["cs.CV", "eess.IV", "cs.CL"]);
  assert.deepEqual(page.calls.slice(0, 2), ["/api/daily-feed/suggest?ids=2401.00001", "/api/daily-feed?cat=cs.CV"]);
  assert.equal(page.calls.filter(c => c.startsWith("/api/daily-feed?")).length, 1);
  assert.equal(await page.evaluate(() => localStorage.getItem("pr:daily-feed:cats")), '["cs.CV","eess.IV","cs.CL"]');
  // 다시 열면 추천을 다시 묻지 않음
  await page.reload();
  await until(page, () => document.querySelectorAll(".df-card").length === 3);
  assert.equal(page.calls.filter(c => c.includes("/suggest")).length, 1);
  assert.deepEqual(page.errors, []);
});

test("카드 모드(scroll-snap)·초록 펼침, 지난 방문 이후 '새 논문' 표시", async browser => {
  const page = await newPage(browser, {
    init: () => { if (!sessionStorage.getItem("x")) { sessionStorage.setItem("x", "1"); localStorage.setItem("pr:daily-feed:seen", JSON.stringify({ "cat:cs.CL": new Date(Date.now() - 2 * 60e3).toISOString() })); } },
  });
  await until(page, () => document.querySelectorAll(".df-card").length === 3);
  assert.equal(await page.$$eval(".df-new", els => els.length), 1); // 2분 전 이후(1분 전) 논문만
  await page.click('.df-tool:has-text("카드")');
  const r = await page.evaluate(() => {
    const list = document.querySelector(".df-list"), card = document.querySelector(".df-card");
    return { brief: list.classList.contains("df-brief"), snap: getComputedStyle(list).scrollSnapType,
      open: [...document.querySelectorAll(".df-abs")].every(d => d.open), full: card.offsetHeight >= list.clientHeight - 1,
      group: getComputedStyle(document.querySelector(".df-group")).display };
  });
  assert.deepEqual(r, { brief: true, snap: "y mandatory", open: true, full: true, group: "none" });
  // seen이 최신 논문 시각으로 갱신되고, 이 탭에서 새로고침해도 표시는 유지
  await page.reload();
  await until(page, () => document.querySelectorAll(".df-card").length === 3);
  assert.equal(await page.$$eval(".df-new", els => els.length), 1);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("pr:daily-feed:seen"))["cat:cs.CL"]), ITEMS[0].published);
  assert.deepEqual(page.errors, []);
});

test("피드 실패 → 오류 줄과 '다시'", async browser => {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 800 }, serviceWorkers: "block" });
  await ctx.route(u => !u.href.startsWith(BASE), r => r.fulfill({ status: 200, body: "" }));
  let n = 0;
  await ctx.route(`${BASE}/api/daily-feed**`, r => (++n === 1
    ? r.fulfill({ status: 502, body: JSON.stringify({ detail: "arXiv 조회 실패: ConnectError" }), contentType: "application/json" })
    : r.fulfill({ status: 200, body: JSON.stringify(new URL(r.request().url()).pathname.endsWith("/ko") ? {} : ITEMS), contentType: "application/json" })));
  const page = await ctx.newPage();
  await page.goto(BASE + "/");
  await until(page, () => document.querySelector('.df-status[data-state="error"]'));
  assert.match(await page.textContent(".df-status"), /arXiv 조회 실패/);
  await page.click(".df-retry");
  await until(page, () => document.querySelectorAll(".df-card").length === 3);
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
  console.log(`daily-feed.browser.js: ${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
