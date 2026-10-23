// cite-cards 브라우저 확인: [1] 탭 → 참고문헌 카드가 응답 전에 바로, 보강 후 서지·버튼, '여기서 왜 인용?' → /api/ask,
// .bib 담기, GitHub 링크 미리보기, 인용이 든 선택의 질문 문맥. tests/test_browser.py가 서버를 띄우고 실행 (인자: 포트)
"use strict";
const assert = require("node:assert/strict");

let chromium;
try { ({ chromium } = require("playwright")); } catch { console.log("SKIP playwright 없음"); process.exit(0); }

const PORT = process.argv[2];
const BASE = `http://127.0.0.1:${PORT}`;
const PAPER = `${BASE}/paper/2401.00001`;
const WHY_Q = "인용된 논문이 무엇이고 이 문장에서 왜 인용됐는지 한국어로 3문장 이내로 설명해줘";
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CARD1 = {
  bib_id: "bib.bib1", label: "[1]", bib_text: "A. Author and B. Author. Sparse mixtures of experts for everyone. arXiv preprint arXiv:2301.00001 , 2023.",
  arxiv_id: "2301.00001", doi: null, title_guess: "Sparse mixtures of experts for everyone.", partial: false,
  enriched: {
    title: "Sparse Mixtures of Experts for Everyone", authors: ["A. Author", "B. Author"], n_authors: 2, year: 2023,
    summary: "We study sparse mixtures of experts. ".repeat(12).trim(), arxiv_id: "2301.00001", doi: null,
    venue: "ICML", citations: 42, tldr: "Two experts per token match dense models.", sources: ["arxiv", "s2"],
  },
};

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 800 }, serviceWorkers: "block" });
  await ctx.route(u => !u.href.startsWith(BASE), r => r.fulfill({ status: 200, body: "", contentType: "text/plain" }));
  const asks = [], cites = [];
  await ctx.route(`${BASE}/api/ask`, r => {
    asks.push(JSON.parse(r.request().postData() || "{}"));
    return r.fulfill({ status: 200, body: "인용 이유입니다.", contentType: "text/plain; charset=utf-8" });
  });
  await ctx.route(`${BASE}/api/cite-cards/2401.00001/**`, async r => {
    const id = decodeURIComponent(r.request().url().split("/").pop());
    cites.push(id);
    await sleep(600); // 느린 보강: 카드는 그 전에 떠야 함
    const body = id === "bib.bib1" ? CARD1 : { bib_id: id, label: "", bib_text: "", enriched: null, partial: false };
    return r.fulfill({ status: 200, body: JSON.stringify(body), contentType: "application/json" });
  });
  await ctx.route(`${BASE}/api/cite-cards/github**`, r => r.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ full_name: "example/sparse-moe", description: "Sparse MoE 구현", stars: 1234, language: "Python",
      pushed_at: new Date().toISOString(), topics: ["moe"], archived: false, license: "MIT", homepage: null }),
  }));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.asks = asks;
  page.cites = cites;
  page.errors = errors;
  await page.goto(PAPER);
  await page.waitForFunction(() => window.PaperApp && document.readyState === "complete" && PaperApp.has("cite-cards"));
  return page;
}
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 5000 });

test("[1] 탭: 참고문헌 카드가 응답 전에 즉시, 보강 뒤 서지·버튼, '여기서 왜 인용?' → /api/ask", async browser => {
  const page = await newPage(browser);
  const first = await page.evaluate(() => {
    const a = document.querySelector('#paper a[href="#bib.bib1"]');
    a.scrollIntoView({ block: "center" });
    const t0 = performance.now();
    a.click();
    const peek = document.querySelector(".cc-peek");
    return {
      ms: performance.now() - t0, open: !!peek, title: peek && peek.querySelector(".pr-peek-head b").textContent,
      bib: peek && peek.querySelector(".cc-bib").textContent, loading: !!(peek && peek.querySelector(".cc-loading")),
      ids: peek ? peek.querySelectorAll(".cc-bib [id], .cc-bib > [id]").length : -1, hash: location.hash,
    };
  });
  assert.ok(first.open, "탭 처리기 안에서 바로 peek");
  assert.ok(first.ms < 100, `peek까지 ${first.ms}ms`);
  assert.equal(first.title, "참고문헌 [1]");
  assert.match(first.bib, /Sparse mixtures of experts for everyone/);
  assert.ok(first.loading, "보강 전에는 불러오는 중 표시");
  assert.equal(first.ids, 0, "복제본에 id 없음 (cloneClean)");
  assert.equal(first.hash, "", "#bib.bib1 로 이동하지 않음");
  await until(page, () => document.querySelector(".cc-peek .cc-title"));
  const filled = await page.evaluate(() => {
    const p = document.querySelector(".cc-peek");
    return {
      title: p.querySelector(".cc-title").textContent, tldr: p.querySelector(".cc-tldr").textContent,
      abs: p.querySelector(".cc-abs").textContent, more: !!p.querySelector(".cc-more"),
      open: p.querySelector("a.cc-open")?.getAttribute("href"),
      labels: [...p.querySelectorAll(".cc-row > button, .cc-row > a")].map(x => x.textContent),
    };
  });
  assert.equal(filled.title, "Sparse Mixtures of Experts for Everyone");
  assert.match(filled.tldr, /Two experts per token/);
  assert.ok(filled.abs.length <= 301 && filled.abs.endsWith("…"), "초록은 300자 + 더보기");
  assert.ok(filled.more);
  assert.equal(filled.open, "/paper/2301.00001");
  for (const l of ["여기서 왜 인용?", "이 앱에서 열기", "arXiv", "Scholar 검색", "초록 번역", "★ 나중에 읽기", ".bib에 담기"]) {
    assert.ok(filled.labels.includes(l), `버튼 ${l}`);
  }
  // 더보기 펼치기
  await page.click(".cc-peek .cc-more");
  assert.ok((await page.textContent(".cc-peek .cc-abs")).length > 400);
  // .bib에 담기 → pr:cite-cards:bib
  await page.click(".cc-peek .cc-chips button:has-text('.bib에 담기')");
  const basket = await page.evaluate(() => JSON.parse(localStorage.getItem("pr:cite-cards:bib")));
  assert.equal(basket.length, 1);
  assert.equal(basket[0].id, "arxiv:2301.00001");
  assert.equal(basket[0].key, "author2023sparse");
  assert.match(basket[0].bibtex, /^@inproceedings\{author2023sparse,\n[\s\S]*booktitle = \{ICML\}/); // 게재처 ICML → 학회 형식
  // 왜 인용? → 시트 + /api/ask (인용 문장이 선택, 서지·초록이 문맥)
  await page.click(".cc-peek .cc-row > button.primary");
  await until(page, () => !document.getElementById("sheet").hidden && !document.querySelector(".cc-peek"));
  await until(page, () => document.querySelector("#answer .a")?.textContent.includes("인용 이유"));
  assert.equal(page.asks.length, 1);
  const body = page.asks[0];
  assert.ok(body.question.includes(WHY_Q));
  assert.equal(body.selection, "We propose a sparse mixture of experts model that routes each token to two experts [1, 2].");
  assert.match(body.context, /^인용 \[1\]: A\. Author/);
  assert.match(body.context, /제목: Sparse Mixtures of Experts for Everyone/);
  assert.match(body.context, /초록: We study sparse/);
  assert.equal(body.section, "1 Introduction");
  assert.deepEqual(page.cites, ["bib.bib1"]);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("다시 탭하면 이번 세션의 카드로 바로 (재요청 없음), 바구니 peek에서 삭제·실행 취소", async browser => {
  const page = await newPage(browser);
  const tap = () => page.evaluate(() => document.querySelector('#paper a[href="#bib.bib1"]').click());
  await tap();
  await until(page, () => document.querySelector(".cc-peek .cc-title"));
  await page.click(".cc-peek .cc-chips button:has-text('.bib에 담기')");
  await page.keyboard.press("Escape");
  await until(page, () => !document.querySelector(".cc-peek"));
  await tap();
  assert.ok(await page.evaluate(() => !!document.querySelector(".cc-peek .cc-title")), "캐시된 카드는 바로 서지까지");
  assert.equal(page.cites.length, 1);
  await page.click(".cc-peek .cc-basket-link");
  await until(page, () => document.querySelectorAll(".cc-bitem").length === 1);
  await page.click(".cc-bitem button");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("pr:cite-cards:bib")).length), 0);
  await page.click("#pr-toast button");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("pr:cite-cards:bib")).length), 1);
  assert.equal(await page.evaluate(() => document.querySelectorAll(".cc-bitem").length), 1);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("GitHub 링크 탭: 떠나지 않고 저장소 미리보기 peek", async browser => {
  const page = await newPage(browser);
  await page.evaluate(() => document.querySelector('#paper a[href="https://github.com/example/sparse-moe"]').click());
  await until(page, () => document.querySelector(".cc-repo .cc-abs"));
  const r = await page.evaluate(() => ({
    url: location.href, title: document.querySelector(".pr-peek-head b").textContent,
    text: document.querySelector(".cc-repo").textContent,
    actions: [...document.querySelectorAll(".pr-peek-actions button")].map(b => b.textContent),
  }));
  assert.equal(r.url, `${PAPER}`);
  assert.equal(r.title, "example/sparse-moe");
  assert.match(r.text, /Sparse MoE 구현/);
  assert.match(r.text, /★ 1,234 · Python · MIT · 오늘 업데이트/);
  assert.deepEqual(r.actions, ["열기", "링크 복사"]);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("인용이 든 선택으로 질문하면 그 인용의 서지(+불러온 제목·초록)가 문맥에", async browser => {
  const page = await newPage(browser);
  await page.evaluate(() => document.querySelector('#paper a[href="#bib.bib1"]').click());
  await until(page, () => document.querySelector(".cc-peek .cc-title"));
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const p = document.getElementById("S1.p1");
    const cite = p.querySelector("cite");
    const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode()) && !n.data.includes("routes each token")) { /* 다음 */ }
    const r = document.createRange();
    r.setStart(n, n.data.indexOf("routes"));
    r.setEndAfter(cite);
    PaperApp.selectRange(r);
  });
  await until(page, () => !document.getElementById("sel-bar").hidden);
  await page.click('#sel-bar button[data-id="ask"]');
  await page.fill("#q", "[1]은 어떤 논문이야?");
  await page.press("#q", "Enter");
  await until(page, () => document.querySelector("#answer .a")?.textContent.includes("인용 이유"));
  const ctx = page.asks[0].context;
  assert.match(ctx, /<cited-papers>\n\[1\]: A\. Author and B\. Author\. Sparse mixtures/);
  assert.match(ctx, /제목: Sparse Mixtures of Experts for Everyone\n초록: We study sparse/);
  assert.match(ctx, /\[2\]: C\. Writer and D\. Reader\. Attention mechanisms revisited/);
  assert.ok(ctx.endsWith("</cited-papers>"));
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
  console.log(`cite-cards.browser.js: ${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
