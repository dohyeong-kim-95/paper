// overview 브라우저 확인: 카드 위치·미리 받기·펼치기, 인용 칩 점프, 그림 복제, '더 묻기', 메타 칩, 실패 → '다시'
//   node tests/browser/overview.browser.js <port>   (tests/test_browser.py가 전체 번들 서버로 실행)
"use strict";
const assert = require("node:assert/strict");

let chromium;
try { ({ chromium } = require("playwright")); } catch { console.log("SKIP playwright 없음"); process.exit(0); }

const BASE = `http://127.0.0.1:${process.argv[2]}`;
const PAPER = `${BASE}/paper/2401.00001`;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 5000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const OVERVIEW = `## 3줄 요약
- 토큰마다 **전문가 2개**만 쓰는 희소 MoE.
- 라우터가 게이트 점수로 고릅니다.
- 밀집 모델과 같은 성능입니다.

## 핵심 질문
### 무엇을 풀려고 하나?
밀집 모델의 계산량 문제입니다.
→ "dense computation grows as $x^{2}$ for a model of width"
### 핵심 아이디어는?
상위 두 전문가로 보냅니다.
→ "Each token is routed to two experts."
[[fig:S2.F1]]
### 한계와 남은 문제는?
메모리를 더 씁니다.
→ "A limitation of our approach is the extra memory required to store all experts"
→ "this sentence is not in the paper at all"

## 스냅샷
| 항목 | 내용 |
|---|---|
| 코드 | https://github.com/example/sparse-moe |`;
const META = { id: "2401.00001", version: "v2", published: "2024-01-02T12:00:00Z", updated: "2024-02-01T00:00:00Z",
  primary_category: "cs.CL", categories: ["cs.CL"], abs_url: "https://arxiv.org/abs/2401.00001" };

// CDN(marked·DOMPurify)은 막혀 있으므로 아주 작은 대체물: 제목·문단(줄바꿈 <br>)만
const SHIM = () => {
  const esc = s => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  window.DOMPurify = { sanitize: s => s };
  window.marked = {
    parse: src => src.split(/\n{2,}/).map(block => {
      const out = [], para = [];
      const flush = () => { if (para.length) out.push(`<p>${para.join("<br>")}</p>`); para.length = 0; };
      for (const line of block.split("\n")) {
        const m = line.match(/^(#{1,3})\s+(.*)$/);
        if (m) { flush(); out.push(`<h${m[1].length}>${esc(m[2])}</h${m[1].length}>`); } else if (line.trim()) para.push(esc(line));
      }
      flush();
      return out.join("");
    }).join(""),
  };
};

async function newPage(browser, { overview, method } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 800 }, serviceWorkers: "block" });
  await ctx.route(u => !u.href.startsWith(BASE), r => (r.request().resourceType() === "image"
    ? r.fulfill({ status: 200, body: '<svg xmlns="http://www.w3.org/2000/svg" width="598" height="300"/>', contentType: "image/svg+xml" })
    : r.fulfill({ status: 200, body: "", contentType: "text/plain" })));
  await ctx.route(`${BASE}/api/prewarm/**`, r => r.fulfill({ status: 200, body: '{"ok":true}', contentType: "application/json" }));
  const calls = [], asks = [];
  // overview·method는 본문 문자열을 돌려주는 함수(비동기 가능: 늦게 오는 응답)로 바꿀 수 있음
  await ctx.route(`${BASE}/api/overview/**`, async r => {
    const url = r.request().url();
    calls.push(url.slice(BASE.length));
    if (url.includes("/meta")) return r.fulfill({ status: 200, body: JSON.stringify(META), contentType: "application/json" });
    const body = url.includes("/method") ? (method ? await method(url, calls) : "### 단계별 설명\n1. 고르기\n[[fig:S2.F2]]")
      : (overview ? await overview(url, calls) : OVERVIEW);
    return r.fulfill({ status: 200, body, contentType: "text/plain; charset=utf-8" });
  });
  await ctx.route(`${BASE}/api/ask`, r => { asks.push(JSON.parse(r.request().postData())); return r.fulfill({ status: 200, body: "답", contentType: "text/plain" }); });
  await ctx.addInitScript(SHIM);
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", e => page.errors.push(String(e)));
  page.calls = calls;
  page.asks = asks;
  await page.goto(PAPER);
  await page.waitForFunction(() => window.PaperApp && PaperApp.has("overview") && document.readyState === "complete");
  return page;
}

test("카드 위치·메타 칩·미리 받은 3줄 요약 미리보기, 색인은 그대로", async browser => {
  const page = await newPage(browser);
  await until(page, () => !document.querySelector(".ov-teaser").classList.contains("ov-pending")
    && document.querySelector(".ov-meta").textContent.includes("v2"));
  const r = await page.evaluate(() => {
    const ov = document.querySelector("#paper .ov");
    return {
      prev: ov.previousElementSibling.className, next: ov.nextElementSibling.className, prUi: ov.classList.contains("pr-ui"),
      chips: [...ov.querySelectorAll(".ov-mchip")].map(c => c.textContent),
      pdf: ov.querySelector('a[download]').getAttribute("href"),
      teaser: ov.querySelector(".ov-teaser").textContent, expanded: ov.querySelector(".ov-toggle").getAttribute("aria-expanded"),
      indexed: PaperAnchor.index().text.includes("한눈에 보기"),
      offline: PaperApp.offlineUrls(),
    };
  });
  assert.equal(r.prev, "ltx_authors");
  assert.equal(r.next, "ltx_abstract");
  assert.equal(r.prUi, true);
  assert.deepEqual(r.chips, ["arXiv ↗", "PDF ↓", "코드 · sparse-moe ↗", "v2", "2024-01-02 제출 · 2024-02-01 수정", "cs.CL"]);
  assert.equal(r.pdf, "/api/overview/2401.00001/pdf");
  assert.equal(r.teaser, "토큰마다 전문가 2개만 쓰는 희소 MoE.");
  assert.equal(r.expanded, "false");
  assert.equal(r.indexed, false);
  // 다른 기능도 offlineUrls에 더할 수 있으므로 포함 여부만
  for (const u of ["/api/overview/2401.00001", "/api/overview/2401.00001/meta"]) assert.ok(r.offline.includes(u), u);
  assert.deepEqual(page.errors, []);
});

test("펼치기: 인용 칩(못 찾은 줄은 삭제)·그림 복제·'더 묻기', 칩은 본문으로 점프", async browser => {
  const page = await newPage(browser);
  await page.click(".ov-toggle");
  await until(page, () => document.querySelector(".ov-text").dataset.final === "1");
  const r = await page.evaluate(() => {
    const t = document.querySelector(".ov-text");
    return {
      chips: t.querySelectorAll(".ov-chip").length, asks: [...t.querySelectorAll("h3 .ov-ask")].length,
      missing: t.textContent.includes("not in the paper"), token: /\[\[fig:|%%OV|→/.test(t.textContent),
      fig: !!t.querySelector(".ov-fig img"), figures: document.querySelectorAll("#paper .ov figure").length,
      figInP: !!t.querySelector("p .ov-fig"), firstTitle: t.querySelector(".ov-chip").title,
    };
  });
  assert.deepEqual(r, { chips: 3, asks: 3, missing: false, token: false, fig: true, figures: 0, figInP: false,
    firstTitle: "dense computation grows as $x^{2}$ for a model of width" });

  await page.click(".ov-text .ov-chip >> nth=2");
  await until(page, () => PaperNav.depth === 1);
  const jumped = await page.evaluate(() => [window.scrollY > 300, CSS.highlights.has("pa-flash")]);
  assert.deepEqual(jumped, [true, true]);
  await page.evaluate(() => PaperNav.back());

  await page.click(".ov-text h3 >> nth=1 >> .ov-ask");
  await until(page, () => PaperApp.session && PaperApp.session.history.length === 2);
  const s = await page.evaluate(() => ({ title: PaperApp.session.title, quote: PaperApp.session.quote, open: PaperApp.isSheetOpen() }));
  assert.deepEqual(s, { title: "한눈에 보기", quote: "핵심 아이디어는?", open: true });
  // 다른 기능의 ask/session 훅이 지시문·맥락을 덧붙일 수 있으므로 앞부분만 (FEATURES.md §8)
  assert.ok(page.asks[0].question.startsWith("핵심 아이디어는? 더 자세히 설명해줘"), page.asks[0].question);
  assert.ok(page.asks[0].context.startsWith("상위 두 전문가로 보냅니다."), page.asks[0].context);
  assert.equal(page.asks[0].section, "한눈에 보기 (AI 요약)");
  assert.deepEqual(page.errors, []);
});

test("헤더 ⋯ '요약'은 카드를 펼침, '방법론 자세히'는 그때 받음", async browser => {
  const page = await newPage(browser);
  await page.evaluate(() => window.scrollTo(0, 2000));
  await page.click("#bar-more");
  await page.click(".pr-menu-item:has-text('요약')");
  await until(page, () => document.querySelector(".ov-toggle").getAttribute("aria-expanded") === "true");
  assert.equal(page.calls.some(u => u.includes("/method")), false);
  await page.click(".ov-foot .ov-btn:has-text('방법론 자세히')");
  await until(page, () => document.querySelector(".ov-method .ov-text").dataset.final === "1");
  const r = await page.evaluate(() => ({
    text: document.querySelector(".ov-method").textContent.includes("고르기"),
    fig: document.querySelectorAll(".ov-method .ov-fig img").length,
    nested: document.querySelectorAll(".ov-method .ov-fig figure, .ov-method .ov-fig figcaption").length,
  }));
  assert.deepEqual(r, { text: true, fig: 2, nested: 0 });
  assert.deepEqual(page.errors, []);
});

test("실패한 본문([오류] 꼬리) → 상태 칩 '다시' → ?retry=1", async browser => {
  const page = await newPage(browser, { overview: url => (url.includes("retry=1") ? OVERVIEW : "## 3줄\n\n[오류] boom") });
  await until(page, () => document.querySelector('.pr-status[data-key="overview"][data-state="error"] button'));
  await page.click(".ov-toggle");
  assert.equal(await page.evaluate(() => document.querySelector(".ov-text .ov-error").textContent.includes("boom")), true);
  await page.click('.pr-status[data-key="overview"] button');
  await until(page, () => document.querySelector(".ov-text").dataset.final === "1");
  assert.ok(page.calls.includes("/api/overview/2401.00001?retry=1"));
  assert.equal(await page.evaluate(() => document.querySelectorAll(".ov-text .ov-chip").length), 3);
  assert.deepEqual(page.errors, []);
});

test("늦게 온 요약·메타에도 카드 높이 그대로 (미리보기 자리표시, 메타 칩 한 줄)", async browser => {
  const page = await newPage(browser, { overview: async () => { await sleep(700); return OVERVIEW; } });
  const before = await page.evaluate(() => ({
    h: document.querySelector("#paper .ov").getBoundingClientRect().height,
    teaser: document.querySelector(".ov-teaser").textContent,
  }));
  assert.equal(before.teaser, "요약 준비 중…");
  await until(page, () => !document.querySelector(".ov-teaser").classList.contains("ov-pending")
    && document.querySelector(".ov-meta").textContent.includes("v2"));
  const after = await page.evaluate(() => document.querySelector("#paper .ov").getBoundingClientRect().height);
  assert.equal(after, before.h);
  assert.deepEqual(page.errors, []);
});

test("펼친 채로 실패: 오류 상자·'다시'가 남음 (요약·방법론), 방법론 '다시' → ?retry=1", async browser => {
  const page = await newPage(browser, {
    overview: async () => { await sleep(600); return "## 3줄 요약\n- 하나\n\n[오류] boom"; },
    method: async url => { await sleep(300); return url.includes("retry=1") ? "### 단계\n다시 받은 설명" : "### 단계\n부분\n\n[오류] boom-method"; },
  });
  await page.click(".ov-toggle");
  await until(page, () => document.querySelector(".ov-text .ov-error"));
  await sleep(150); // 대기 중이던 rAF 그리기가 있었다면 여기서 덮어씀
  const ov = await page.evaluate(() => ({
    err: !!document.querySelector(".ov-body > .ov-text .ov-error button"),
    raw: document.querySelector(".ov-body > .ov-text").textContent.includes("[오류]"),
    teaser: document.querySelector(".ov-teaser").textContent,
  }));
  assert.deepEqual(ov, { err: true, raw: false, teaser: "하나" });
  await page.click(".ov-foot .ov-btn:has-text('방법론 자세히')");
  await until(page, () => document.querySelector(".ov-method .ov-error"));
  await sleep(150);
  assert.equal(await page.evaluate(() => !!document.querySelector(".ov-method .ov-error button")
    && !document.querySelector(".ov-method").textContent.includes("[오류]")), true);
  await page.click(".ov-method .ov-error button");
  await until(page, () => document.querySelector(".ov-method .ov-text").dataset.final === "1");
  assert.ok(page.calls.includes("/api/overview/2401.00001/method?retry=1"));
  assert.equal(await page.evaluate(() => document.querySelector(".ov-method").textContent.includes("다시 받은 설명")), true);
  assert.deepEqual(page.errors, []);
});

test("그림 복제 속 캡션 링크는 글자만: 한 번 탭 = 그림으로 한 번 점프", async browser => {
  const page = await newPage(browser);
  await page.evaluate(() => {
    const cap = document.getElementById("S2.F1").querySelector("figcaption");
    const a = document.createElement("a");
    a.className = "ltx_ref"; a.href = "#bib.bib1"; a.textContent = "[1]";
    cap.append(" ", a);
  });
  await page.click(".ov-toggle");
  await until(page, () => document.querySelector(".ov-text").dataset.final === "1");
  assert.equal(await page.evaluate(() => document.querySelectorAll(".ov-fig a").length), 0);
  await page.click(".ov-fig .ov-a");
  await until(page, () => PaperNav.depth === 1);
  // 부드러운 스크롤이 끝나면 원래 그림이 화면 안 (참고문헌으로 두 번째 점프가 없었음)
  await until(page, () => { const t = document.getElementById("S2.F1").getBoundingClientRect().top; return t > 0 && t < innerHeight; });
  await sleep(300);
  assert.equal(await page.evaluate(() => PaperNav.depth), 1);
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
  console.log(`overview.browser.js: ${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
