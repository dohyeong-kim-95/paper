// daily-feed 브라우저 확인 (홈): 분야 칩 → 피드 한 번만 요청(Claude 호출 없음), AND/OR 키워드 필터(목록·카드 모드), 칩 전환,
// 편집(추가·삭제 실행 취소, 8개 한도), 저자 팔로우, 첫 방문 서재 기반 분야(실패면 저장 안 함), 카드 모드, '새 논문' 표시,
// 옛 형식 id 링크, 입력칸 16px. tests/test_browser.py가 실행 (인자: 포트)
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
async function newPage(browser, { init, suggest = ["cs.CV"], suggestStatus = 200, items = ITEMS } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 800 }, serviceWorkers: "block" });
  await ctx.route(u => !u.href.startsWith(BASE), r => r.fulfill({ status: 200, body: "", contentType: "text/plain" }));
  const calls = [];
  await ctx.route(`${BASE}/api/daily-feed**`, r => {
    const u = new URL(r.request().url());
    calls.push(u.pathname + u.search);
    if (u.pathname.endsWith("/suggest")) {
      return r.fulfill(suggestStatus === 200
        ? { status: 200, body: JSON.stringify({ cats: suggest }), contentType: "application/json" }
        : { status: suggestStatus, body: JSON.stringify({ detail: "arXiv 조회 실패: ConnectError" }), contentType: "application/json" });
    }
    return r.fulfill({ status: 200, body: JSON.stringify(items), contentType: "application/json" });
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
// 실제로 보이는 카드 수 (hidden 속성이 아니라 계산된 display로)
const visible = page => page.$$eval(".df-card", cs => cs.filter(c => getComputedStyle(c).display !== "none").length);

test("기본 분야 칩, 첫 분야 피드만 한 번 요청, 날짜 묶음, 영어 제목·초록 그대로 (한국어 요청 없음)", async browser => {
  const page = await newPage(browser);
  await until(page, () => document.querySelectorAll(".df-card").length === 3);
  const r = await page.evaluate(() => ({
    section: document.querySelector('[data-section="daily-feed"] > h2').textContent,
    chips: [...document.querySelectorAll(".df-chip")].map(c => [c.textContent, c.getAttribute("aria-pressed")]),
    groups: [...document.querySelectorAll(".df-group")].map(g => g.textContent),
    open: document.querySelector(".df-card .df-open").getAttribute("href"),
    title: [document.querySelector(".df-card .df-title").textContent, document.querySelector(".df-card .df-title").getAttribute("href")],
    abs: document.querySelector(".df-card .df-abs p").textContent,
    authors: document.querySelector(".df-card .df-authors").textContent,
    tools: [...document.querySelectorAll(".df-tool")].map(b => b.textContent),
  }));
  assert.equal(r.section, "오늘의 새 논문");
  assert.deepEqual(r.chips.slice(0, 3), [["cs.CL", "true"], ["cs.LG", "false"], ["cs.AI", "false"]]);
  assert.equal(r.chips[3][0], "＋ 편집");
  assert.equal(r.groups[0].endsWith("· 2편"), true);
  assert.equal(r.groups.length, 2);
  assert.equal(r.open, "/paper/2610.00003");
  assert.deepEqual(r.title, ["Sparse Routing for Mixture of Experts", "/paper/2610.00003"]);
  assert.equal(r.abs, "We propose sparse routing for experts.");
  assert.match(r.authors, /Alice Kim.*Carol Park.*외 2명/);
  assert.deepEqual(r.tools, ["AND", "카드"]); // 한글 버튼 없음 (§8.1)
  await page.waitForTimeout(400); // 유휴 큐가 돌 시간을 줘도 추가 요청 없음
  assert.equal(await page.evaluate(() => document.querySelector(".df-status").hidden), true);
  assert.deepEqual(page.calls, ["/api/daily-feed?cat=cs.CL"]);
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

test("카드 모드에서도 키워드 필터가 카드를 숨김 (빈 결과면 안내만)", async browser => {
  const page = await newPage(browser);
  await until(page, () => document.querySelectorAll(".df-card").length === 3);
  await page.click('.df-tool:has-text("카드")');
  await page.fill(".df-q", "vision");
  await until(page, () => document.querySelector(".df-count").textContent === "1/3");
  assert.deepEqual(await page.$$eval(".df-card", cs => cs.map(c => [c.hidden, getComputedStyle(c).display])),
    [[true, "none"], [false, "flex"], [true, "none"]]);
  await page.fill(".df-q", "없는단어");
  await until(page, () => !!document.querySelector(".df-empty"));
  assert.equal(await visible(page), 0);
  await page.click('.df-tool:has-text("카드")'); // 목록 모드로
  assert.equal(await visible(page), 0);
  await page.fill(".df-q", "");
  await until(page, () => !document.querySelector(".df-empty"));
  assert.equal(await visible(page), 3);
  assert.deepEqual(page.errors, []);
});

test("칩 전환 → 그 분야만 요청, 고른 칩 저장", async browser => {
  const page = await newPage(browser);
  await until(page, () => document.querySelectorAll(".df-card").length === 3);
  await page.click('.df-chip:has-text("cs.LG")');
  await until(page, () => document.querySelector('.df-chip[aria-pressed="true"]').textContent === "cs.LG");
  await until(page, () => document.querySelectorAll(".df-card").length === 3);
  assert.equal((await titles(page))[0], "Sparse Routing for Mixture of Experts");
  assert.deepEqual(page.calls, ["/api/daily-feed?cat=cs.CL", "/api/daily-feed?cat=cs.LG"]);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("pr:daily-feed:prefs")));
  assert.equal(saved.active, "cat:cs.LG");
  assert.deepEqual(page.errors, []);
});

test("분야 8개 한도: 추가 칸은 안내하고 입력을 남김, 서재 추천은 빈 자리만큼 뒤에", async browser => {
  const EIGHT = ["cs.CL", "cs.LG", "cs.AI", "cs.CV", "cs.IR", "cs.RO", "cs.SE", "cs.CR"];
  const page = await newPage(browser, {
    suggest: ["stat.ML", "eess.AS"],
    init: () => {
      if (sessionStorage.getItem("x")) return;
      sessionStorage.setItem("x", "1");
      localStorage.setItem("pr:daily-feed:cats", JSON.stringify(["cs.CL", "cs.LG", "cs.AI", "cs.CV", "cs.IR", "cs.RO", "cs.SE", "cs.CR"]));
      localStorage.setItem("pr:library", JSON.stringify({ "2401.00001": { id: "2401.00001", opened: 1 } }));
    },
  });
  await until(page, () => document.querySelectorAll(".df-card").length === 3);
  await page.click(".df-chip-edit");
  await page.fill(".df-peek .df-input >> nth=0", "q-bio.NC");
  await page.click('.df-peek .df-add >> nth=0 >> button');
  await until(page, () => /8개까지/.test(document.querySelector("#pr-toast").textContent));
  assert.equal(await page.inputValue(".df-peek .df-input >> nth=0"), "q-bio.NC"); // 아무것도 안 들어갔으니 입력 유지
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("pr:daily-feed:cats"))), EIGHT);
  await page.click(".df-peek .df-lib");
  await until(page, () => /추천: stat\.ML · eess\.AS/.test(document.querySelector("#pr-toast").textContent));
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("pr:daily-feed:cats"))), EIGHT); // 있던 분야 그대로
  // 하나 지우면 추천 하나만 맨 뒤에
  await page.click('.df-peek [aria-label="cs.CR 삭제"]');
  await until(page, () => !localStorage.getItem("pr:daily-feed:cats").includes("cs.CR"));
  await page.click(".df-peek .df-lib");
  await until(page, () => JSON.parse(localStorage.getItem("pr:daily-feed:cats")).length === 8);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("pr:daily-feed:cats"))), [...EIGHT.slice(0, 7), "stat.ML"]);
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

test("첫 방문 추천이 실패(502)하면 기본값을 저장하지 않고 다음 방문에 다시 물음", async browser => {
  const page = await newPage(browser, {
    suggestStatus: 502,
    init: () => { if (!localStorage.getItem("pr:library")) localStorage.setItem("pr:library", JSON.stringify({ "2401.00001": { id: "2401.00001", opened: 1 } })); },
  });
  await until(page, () => document.querySelectorAll(".df-card").length === 3);
  const chips = await page.$$eval(".df-chips .df-chip:not(.df-chip-edit)", cs => cs.map(c => c.textContent));
  assert.deepEqual(chips, ["cs.CL", "cs.LG", "cs.AI"]);
  assert.equal(await page.evaluate(() => localStorage.getItem("pr:daily-feed:cats")), null);
  await page.reload();
  await until(page, () => document.querySelectorAll(".df-card").length === 3);
  assert.equal(page.calls.filter(c => c.includes("/suggest")).length, 2);
  assert.deepEqual(page.errors, []);
});

test("옛 형식 id(cs/0112017): 제목은 arXiv 초록 페이지, '열기'·'나중에 읽기' 없음", async browser => {
  const old = { id: "cs/0112017", title: "An Old Paper", authors: ["Alice Kim"], n_authors: 1, summary: "Old.",
    published: "2001-12-15T00:00:00Z", updated: "2001-12-15T00:00:00Z", cat: "cs.CL", comment: null };
  const page = await newPage(browser, { items: [ITEMS[0], old] });
  await until(page, () => document.querySelectorAll(".df-card").length === 2);
  await page.evaluate(() => { // 서재가 있을 때도 옛 id는 담지 않음 (카드를 다시 그려야 버튼이 생김)
    PaperApp.registerFeature("library", { add() {} });
    for (const c of document.querySelectorAll(".df-card")) c.dataset.stale = "1";
  });
  await page.click('.df-chip:has-text("cs.LG")');
  await until(page, () => document.querySelectorAll(".df-card:not([data-stale])").length === 2);
  const r = await page.$$eval(".df-card", cs => cs.map(c => ({
    href: c.querySelector(".df-title").getAttribute("href"), target: c.querySelector(".df-title").getAttribute("target"),
    open: !!c.querySelector(".df-open"), later: [...c.querySelectorAll("button.df-link")].some(b => b.textContent === "나중에 읽기"),
  })));
  assert.deepEqual(r, [
    { href: "/paper/2610.00003", target: null, open: true, later: true },
    { href: "https://arxiv.org/abs/cs/0112017", target: "_blank", open: false, later: false },
  ]);
  assert.deepEqual(page.errors, []);
});

test("입력칸 글자 16px 이상 (iOS 포커스 확대 방지)", async browser => {
  const page = await newPage(browser);
  await until(page, () => document.querySelectorAll(".df-card").length === 3);
  assert.equal(await page.$eval(".df-q", e => parseFloat(getComputedStyle(e).fontSize)) >= 16, true);
  await page.click(".df-chip-edit");
  const sizes = await page.$$eval(".df-peek .df-input", es => es.map(e => parseFloat(getComputedStyle(e).fontSize)));
  assert.equal(sizes.length, 2);
  assert.equal(sizes.every(s => s >= 16), true);
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
    : r.fulfill({ status: 200, body: JSON.stringify(ITEMS), contentType: "application/json" })));
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
