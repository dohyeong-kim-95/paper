// related-papers 브라우저 동작 (헤드리스 Chromium + Playwright, 전체 기능 번들). tests/test_browser.py가 실행:
//   node tests/browser/related-papers.browser.js <port>
// /api/related-papers/*는 page.route로 가로채고 바깥 네트워크는 막음. playwright·Chromium이 없으면 SKIP.
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

const item = (id, title, extra = {}) => ({
  id, title, year: 2023, authors: ["A. Author"], n_authors: 1, summary: "Short abstract.",
  abs_url: `https://arxiv.org/abs/${id}`, category: "cs.LG", ...extra,
});
const REL = {
  ts: 1, title: "Sparse Mixtures for Everyone: A Test Paper", terms: ["sparse", "mixtures", "everyone", "test"],
  cited: [
    item("2301.00001", "Sparse Mixtures of Experts for Everyone", { summary: "routing ".repeat(40), label: "[1]", bib_id: "bib.bib1", cites: 2 }),
    item("2302.00002", "Efficient Expert Routing", { label: "[4]", bib_id: "bib.bib4", cites: 1 }),
  ],
  similar: [item("2305.11111", "Scaling Sparse Mixtures"), item("2301.00001", "Sparse Mixtures of Experts for Everyone")],
};
const CITES = {
  ts: 1, total: 2, more: false, citing: [
    { id: "2501.01234", title: "A Survey of Mixture of Experts", year: 2025, citations: 120, abs_url: "https://arxiv.org/abs/2501.01234", s2_url: "https://www.semanticscholar.org/paper/a", doi: null },
    { id: null, title: "Sparse Routers in Production", year: 2024, citations: 7, abs_url: null, s2_url: "https://www.semanticscholar.org/paper/b", doi: "10.1/x" },
  ],
};

// 바깥 네트워크는 빈 응답, /api/related-papers/* 는 api(path, request)가 정한 JSON
async function newPage(browser, api) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 800 }, serviceWorkers: "block" });
  await ctx.route(u => !u.href.startsWith(BASE), r => r.fulfill({ status: 200, body: "", contentType: "text/plain" }));
  const calls = [];
  await ctx.route(u => u.href.startsWith(`${BASE}/api/related-papers/`), async r => {
    const u = new URL(r.request().url());
    calls.push({ path: u.pathname, search: u.search, body: r.request().postData() });
    const out = await api(u, r.request(), calls);
    await r.fulfill({ status: out.status || 200, body: JSON.stringify(out.json), contentType: "application/json" });
  });
  await ctx.addInitScript(() => {
    window.__range = (el, len) => {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode()) && (n.data.trim().length < 6 || n.parentElement.closest("a, math, .pr-ui"))) { /* 다음 */ }
      const i = n.data.search(/\S/), r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + len);
      return r;
    };
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.calls = calls;
  page.errors = errors;
  return page;
}
async function open(page) {
  await page.goto(PAPER);
  await page.waitForFunction(() => window.PaperApp && PaperApp.has("related-papers") && document.readyState === "complete");
}
const until = (page, fn, arg, timeout = 5000) => page.waitForFunction(fn, arg, { timeout });
const count = (page, path) => page.calls.filter(c => c.path === path).length;
const REL_PATH = "/api/related-papers/2401.00001";
const CITE_PATH = `${REL_PATH}/citations`;
const defaultApi = u => ({ json: u.pathname.endsWith("/citations") ? CITES : REL });

async function openMenuItem(page) {
  await page.click("#bar-more");
  await page.click(".pr-menu-item:has-text('관련 논문')");
}
async function openPanel(page) {
  await openMenuItem(page);
  await until(page, () => document.querySelectorAll(".rel-peek .rel-item").length > 0);
}
async function waitCalls(page, path, n, ms = 8000) {
  for (let t = 0; t < ms && count(page, path) < n; t += 50) await sleep(50);
  return count(page, path);
}
const tabs = page => page.$$eval(".rel-peek .rel-tab", bs => bs.map(b => [b.getAttribute("aria-label"), b.getAttribute("aria-selected")]));

test("⋯ → 관련 논문: 세 탭, 앱에서 열기·arXiv 링크, 인용한 논문은 그 탭을 열 때만, Back으로 닫힘", async browser => {
  const page = await newPage(browser, defaultApi);
  await open(page);
  await openPanel(page);
  assert.deepEqual(await tabs(page), [["참고한 논문 2", "true"], ["비슷한 논문 2", "false"], ["인용한 논문", "false"]]);
  const first = await page.$eval(".rel-peek .rel-item", li => ({
    title: li.querySelector(".rel-title").textContent, meta: li.querySelector(".rel-meta").textContent,
    open: li.querySelector("a.rel-open").getAttribute("href"),
    arxiv: [...li.querySelectorAll(".rel-actions a")].map(a => [a.textContent, a.target]),
    abs: li.querySelector(".rel-abs span").textContent.length,
  }));
  assert.deepEqual(first, {
    title: "Sparse Mixtures of Experts for Everyone", meta: "2023 · A. Author · [1] · 본문 인용 2회", open: "/paper/2301.00001",
    arxiv: [["이 앱에서 열기", ""], ["arXiv", "_blank"]], abs: first.abs,
  });
  assert.ok(first.abs <= 141, "초록은 140자 근처까지");
  await page.click(".rel-peek .rel-more");
  assert.ok(await page.$eval(".rel-peek .rel-abs span", s => s.textContent.length > 200), "더보기 → 전체 초록");
  assert.equal(count(page, CITE_PATH), 0, "인용한 논문은 아직 안 받음");

  await page.click(".rel-peek .rel-tab[data-tab='similar']");
  const badges = await page.$$eval(".rel-peek .rel-item", lis => lis.map(li => li.querySelector(".rel-badge")?.textContent || null));
  assert.deepEqual(badges, [null, "참고문헌 [1]"]);

  await page.click(".rel-peek .rel-tab[data-tab='citing']");
  await until(page, () => document.querySelector(".rel-peek .rel-tab[data-tab='citing']").getAttribute("aria-label") === "인용한 논문 2");
  await page.setViewportSize({ width: 320, height: 800 });
  assert.ok(await page.$eval(".rel-peek .rel-tabs", el => el.scrollWidth <= el.clientWidth &&
    [...el.querySelectorAll(".rel-tab, .rel-tab span")].every(b => b.scrollWidth <= b.clientWidth + 1)), "좁은 폭에서도 세 탭이 잘리지 않음");
  await page.setViewportSize({ width: 412, height: 800 });
  const citing = await page.$$eval(".rel-peek .rel-item", lis => lis.map(li =>
    [li.querySelector(".rel-meta").textContent, [...li.querySelectorAll(".rel-actions a")].map(a => a.textContent)]));
  assert.deepEqual(citing, [
    ["2025 · 피인용 120", ["이 앱에서 열기", "arXiv"]],
    ["2024 · 피인용 7", ["Semantic Scholar"]],
  ]);
  assert.ok(await page.$eval(".rel-peek .rel-foot a", a => a.href.startsWith("https://scholar.google.com/scholar?q=")));
  assert.equal(count(page, CITE_PATH), 1);

  await page.goBack();
  await until(page, () => !document.querySelector(".rel-peek"));
  // 다시 열면 받아 둔 것을 씀 (같은 페이지에서 다시 요청하지 않음)
  await openPanel(page);
  await page.click(".rel-peek .rel-tab[data-tab='citing']");
  await sleep(100);
  assert.deepEqual([count(page, REL_PATH), count(page, CITE_PATH)], [1, 1]);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("arXiv 오류 응답은 기억하지 않고 '다시'로 다시 받음, 참고한 논문이 없으면 비슷한 논문 탭으로", async browser => {
  let down = true; // 미리 받기가 먼저 실패 응답을 가져가도 패널이 다시 받으므로 순서와 무관
  const page = await newPage(browser, u => {
    if (u.pathname.endsWith("/citations")) return { json: { citing: [], total: 0, error: "rate_limited" } };
    return { json: down ? { cited: [], similar: [], error: "arXiv에 연결하지 못했습니다." } : { ...REL, cited: [] } };
  });
  await open(page);
  await openMenuItem(page);
  await until(page, () => document.querySelector(".rel-peek .rel-msg button"));
  assert.match(await page.textContent(".rel-peek .rel-msg"), /arXiv에 연결하지 못했습니다/);
  down = false;
  await page.click(".rel-peek .rel-msg button");
  await until(page, () => document.querySelectorAll(".rel-peek .rel-item").length === 2);
  assert.deepEqual(await tabs(page), [["참고한 논문 0", "false"], ["비슷한 논문 2", "true"], ["인용한 논문", "false"]]);
  await page.click(".rel-peek .rel-tab[data-tab='citing']");
  await until(page, () => /잠시 막혔습니다/.test(document.querySelector(".rel-peek .rel-msg")?.textContent || ""));
  await page.click(".rel-peek .rel-tab[data-tab='cited']");
  await page.click(".rel-peek .rel-tab[data-tab='citing']");
  await sleep(100);
  assert.equal(count(page, CITE_PATH), 1, "실패 뒤 탭 전환만으로는 다시 부르지 않음");
  await page.click(".rel-peek .rel-msg button");
  assert.equal(await waitCalls(page, CITE_PATH, 2), 2);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("선택 '관련 연구': 3단어 이상에서만, 검색어 칩 → arXiv 결과, 칩을 끄면 다시 검색, Google Scholar 링크", async browser => {
  const page = await newPage(browser, u => {
    if (u.pathname.endsWith("/terms")) return { json: { terms: ["language models", "dense computation"], ai: true } };
    if (u.pathname.endsWith("/search")) {
      const t = u.searchParams.getAll("t");
      return { json: { terms: t, hits: t.length > 1 ? [item("2305.11111", "Scaling"), item("2301.00001", "Sparse")] : [item("2306.22222", "Dense")] } };
    }
    return { json: REL };
  });
  await open(page);
  await page.evaluate(() => PaperApp.selectRange(__range(document.getElementById("S1.p1"), 11))); // "Large langu" (2단어)
  await until(page, () => !document.getElementById("sel-bar").hidden);
  assert.equal(await page.$("#sel-bar button[data-id='related-papers']"), null, "2단어 선택에는 없음");
  await page.evaluate(() => PaperApp.selectRange(__range(document.getElementById("S1.p1"), 60)));
  await until(page, () => document.querySelector("#sel-bar button[data-id='related-papers']"));
  assert.equal(await page.textContent("#sel-bar button[data-id='related-papers']"), "관련 연구");
  await page.click("#sel-bar button[data-id='related-papers']");
  await until(page, () => document.querySelectorAll(".rel-peek .rel-item").length === 2);
  const terms = page.calls.find(c => c.path.endsWith("/terms"));
  assert.match(JSON.parse(terms.body).q, /^Large language models scale well/);
  assert.deepEqual(await page.$$eval(".rel-peek .rel-term", bs => bs.map(b => [b.textContent, b.getAttribute("aria-pressed")])),
    [["language models", "true"], ["dense computation", "true"]]);
  assert.match(await page.$eval(".rel-peek .rel-scholar", a => a.href), /^https:\/\/scholar\.google\.com\/scholar\?q=Large%20language%20models/);
  const search1 = page.calls.filter(c => c.path.endsWith("/search"));
  assert.equal(search1.length, 1);
  assert.equal(search1[0].search, "?t=language%20models&t=dense%20computation");
  await page.click(".rel-peek .rel-term >> nth=1");
  await until(page, () => document.querySelectorAll(".rel-peek .rel-item").length === 1);
  assert.equal(page.calls.filter(c => c.path.endsWith("/search")).pop().search, "?t=language%20models");
  assert.equal(await page.getAttribute(".rel-peek .rel-term >> nth=1", "aria-pressed"), "false");
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("참고문헌이 보이면 한가할 때 미리 받아 두고, 패널은 그것을 씀", async browser => {
  const page = await newPage(browser, defaultApi);
  await open(page);
  await page.evaluate(() => document.querySelector("#paper .ltx_bibliography").scrollIntoView());
  assert.equal(await waitCalls(page, REL_PATH, 1), 1, "미리 받음");
  await openPanel(page);
  assert.equal(count(page, REL_PATH), 1, "패널은 받아 둔 것을 씀");
  assert.deepEqual(page.errors, []);
  await page.context().close();
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
  console.log(`related-papers.browser.js: ${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
