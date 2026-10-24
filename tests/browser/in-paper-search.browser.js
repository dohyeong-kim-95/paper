// in-paper-search 브라우저 동작 (전체 기능 번들). tests/test_browser.py가 서버를 띄우고 실행:
//   node tests/browser/in-paper-search.browser.js <port>
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
const BTN = '#bar-actions [data-id="in-paper-search"]';

// 바깥 네트워크·다른 기능의 /api는 막고(빈 응답·404), /api/in-paper-search/locate는 테스트가 정한 JSON으로
async function newPage(browser, { locate } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 800 }, serviceWorkers: "block" });
  await ctx.route(u => !u.href.startsWith(BASE), r => (r.request().resourceType() === "image"
    ? r.fulfill({ status: 200, body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"/>', contentType: "image/svg+xml" })
    : r.fulfill({ status: 200, body: "", contentType: "text/plain" })));
  const calls = [];
  await ctx.route(`${BASE}/api/**`, async r => {
    const url = r.request().url();
    if (url.endsWith("/api/in-paper-search/locate")) {
      const body = JSON.parse(r.request().postData() || "{}");
      calls.push(body);
      return r.fulfill({ status: 200, body: JSON.stringify(locate ? locate(body) : []), contentType: "application/json" });
    }
    if (url.endsWith("/api/ask")) return r.fulfill({ status: 200, body: "답변입니다.", contentType: "text/plain; charset=utf-8" });
    return r.fulfill({ status: 404, body: "{}", contentType: "application/json" });
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
  await page.waitForFunction(() => window.PaperApp && PaperApp.has("in-paper-search") && document.readyState === "complete");
}
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 5000 });
const count = page => page.textContent(".ps-count");
const current = page => page.evaluate(() => {
  const hl = CSS.highlights.get("ps-current");
  return hl ? [...hl][0].toString() : null;
});
// 현재 결과가 화면 안(찾기 줄 아래)에 보일 때까지 (부드러운 스크롤)
const currentVisible = page => until(page, () => {
  const hl = CSS.highlights.get("ps-current");
  if (!hl) return false;
  const b = [...hl][0].getBoundingClientRect(), top = document.getElementById("top-stack").getBoundingClientRect().bottom;
  return b.height > 0 && b.top >= top && b.bottom <= innerHeight;
});
async function search(page, q) {
  await page.click(BTN);
  await until(page, () => document.activeElement === document.querySelector(".ps-input"));
  await page.fill(".ps-input", q);
  await until(page, q => PaperAnchor.normalize(document.querySelector(".ps-input").value) === PaperAnchor.normalize(q)
    && document.querySelector(".ps-count").textContent !== "", q);
  await sleep(250); // 디바운스
}

test("헤더 '검색' → 찾기 줄: 개수·전부 칠하기, ↓/↑로 순환하며 현재 결과가 화면에", async browser => {
  const page = await newPage(browser);
  await open(page);
  await search(page, "Experts");
  const n = await page.evaluate(() => PaperAnchor.index().text.match(/experts/gi).length);
  assert.ok(n >= 4);
  assert.equal(await count(page), `1/${n}`);
  assert.equal(await page.evaluate(() => CSS.highlights.get("ps-match").size), n);
  assert.equal((await current(page)).toLowerCase(), "experts");
  assert.equal(await page.getAttribute(BTN, "aria-pressed"), "true");
  await page.click('.ps-btn[aria-label="다음 결과"]');
  assert.equal(await count(page), `2/${n}`);
  await page.click('.ps-btn[aria-label="이전 결과"]');
  await page.click('.ps-btn[aria-label="이전 결과"]');
  assert.equal(await count(page), `${n}/${n}`);
  await currentVisible(page);
  // Enter = 다음, Shift+Enter = 이전 (입력칸에서)
  await page.focus(".ps-input");
  await page.keyboard.press("Enter");
  assert.equal(await count(page), `1/${n}`);
  await page.keyboard.press("Shift+Enter");
  assert.equal(await count(page), `${n}/${n}`);
  // 한 글자·없는 말
  await page.fill(".ps-input", "zzqx");
  await until(page, () => document.querySelector(".ps-count").textContent === "0/0");
  assert.equal(await page.evaluate(() => CSS.highlights.has("ps-match")), false);
  assert.ok(await page.evaluate(() => document.querySelector(".ps-ai").classList.contains("ps-hot")), "일치 없으면 AI로 찾기를 권함");
  // ✕ → 닫고 칠하기 지움, 헤더 버튼 해제
  await page.fill(".ps-input", "router");
  await until(page, () => document.querySelector(".ps-count").textContent !== "0/0");
  await page.click('.ps-btn[aria-label="검색 닫기"]');
  await sleep(100);
  assert.deepEqual(await page.evaluate(() => ({
    bar: !!document.querySelector(".ps-bar")?.isConnected, match: CSS.highlights.has("ps-match"), cur: CSS.highlights.has("ps-current"),
    recent: PaperStore.get("in-paper-search:recent"),
  })), { bar: false, match: false, cur: false, recent: ["router", "Experts"] });
  assert.equal(await page.getAttribute(BTN, "aria-pressed"), "false");
  // 다시 열면 지난 검색어 그대로 (전부 선택: 바로 덮어쓰기)
  await page.click(BTN);
  const m = await page.evaluate(() => PaperAnchor.index().text.match(/router/gi).length);
  await until(page, m => document.querySelector(".ps-count")?.textContent?.endsWith(`/${m}`), m);
  assert.equal(await page.inputValue(".ps-input"), "router");
  assert.equal(await page.evaluate(() => { const i = document.querySelector(".ps-input"); return [i.selectionStart, i.selectionEnd].join(); }), "0,6");
  assert.deepEqual(page.errors, []);
});

test("'문장만': 결과가 없는 문단만 흐림 (안쪽 문단은 두 번 흐려지지 않음), 끄면 원래대로", async browser => {
  const page = await newPage(browser);
  await open(page);
  await search(page, "experts");
  await page.click('.ps-chip:text("문장만")');
  const op = sel => page.evaluate(sel => getComputedStyle(document.querySelector(sel)).opacity, sel);
  await until(page, () => getComputedStyle(document.getElementById("S1.p3")).opacity === "0.25");
  assert.equal(await page.getAttribute('.ps-chip:text("문장만")', "aria-pressed"), "true");
  assert.equal(await op("#S1\\.p1"), "1");                // experts가 있는 문단
  assert.equal(await op("#S2\\.F1"), "1");                // 캡션에 있는 그림
  assert.equal(await op("#S2\\.T1"), "0.25");             // 없는 표
  assert.equal(await op("#S1\\.p2"), "0.25");             // 없는 바깥 문단
  assert.equal(await op("#S1\\.I1\\.i1\\.p1"), "1");      // 그 안쪽 문단은 자기 opacity 1 (곱해서 0.06이 되지 않게)
  assert.equal(await op(".ltx_abstract .ltx_p"), "1");
  assert.equal(await op(".ltx_abstract .ltx_p + .ltx_p"), "0.25");
  assert.equal(await op("#S2 > .ltx_title"), "1");        // 제목은 그대로 (위치 파악)
  await page.click('.ps-chip:text("문장만")');
  assert.deepEqual(await page.evaluate(() => [document.getElementById("paper").classList.contains("ps-declutter"),
    document.querySelectorAll(".ps-hit").length]), [false, 0]);
});

test("한글 질문 + Enter → AI로 찾기: 찾은 인용만 목록에, 탭하면 이동, ↓로 다음, 같은 질문은 다시 안 부름", async browser => {
  const page = await newPage(browser, {
    locate: () => [
      { q: "We minimize $\\mathcal{L}$ with AdamW and a learning rate of", why: "학습률 설정" },
      { q: "this quote does not exist anywhere in the paper at all", why: "없는 인용" },
      { q: "The balancing coefficient $\\alpha$ is set to 0.01", why: "균형 계수 값" },
    ],
  });
  await open(page);
  const Q = "학습률 얘기 어디 나와?";
  await search(page, Q);
  assert.equal(await count(page), "0/0");
  assert.ok(await page.evaluate(() => document.querySelector(".ps-ai").classList.contains("ps-hot")));
  await page.press(".ps-input", "Enter");
  await until(page, () => document.querySelectorAll(".ps-result").length === 2);
  assert.deepEqual(page.calls, [{ arxiv_id: "2401.00001", query: Q }]);
  assert.equal(await count(page), "2곳");
  assert.match(await page.textContent(".ps-info"), /AI가 찾은 위치 2곳/);
  assert.deepEqual(await page.$$eval(".ps-result b", els => els.map(e => e.textContent)), ["학습률 설정", "균형 계수 값"]);
  assert.match(await page.textContent(".ps-result .ps-sec"), /Training objective/);
  assert.equal(await page.evaluate(() => CSS.highlights.get("ps-match").size), 2);
  assert.equal(await page.evaluate(() => PaperStore.get("in-paper-search:recent")[0]), Q);
  await page.click(".ps-result >> nth=0");
  await currentVisible(page);
  assert.match(await current(page), /learning rate of/);
  assert.equal(await count(page), "1/2");
  assert.equal(await page.isVisible(".ps-results"), false, "고르면 목록을 접음");
  assert.match(await page.textContent(".ps-info"), /학습률 설정/);
  await page.click('.ps-btn[aria-label="다음 결과"]');
  assert.equal(await count(page), "2/2");
  assert.match(await current(page), /balancing coefficient/);
  await page.click('.ps-link:text("목록")');
  assert.equal(await page.isVisible(".ps-results"), true);
  // 목록은 본문 흐름 밖 덮개: 열고 닫아도 찾기 줄 높이(본문 위치)가 그대로
  const h1 = await page.evaluate(() => document.getElementById("top-stack").offsetHeight);
  await page.mouse.click(200, 700); // 목록 밖(본문)을 누르면 접힘
  assert.equal(await page.isVisible(".ps-results"), false);
  assert.equal(await page.evaluate(() => document.getElementById("top-stack").offsetHeight), h1);
  assert.match(await page.textContent(".ps-info"), /균형 계수 값/);
  // 같은 질문은 이 페이지에서 다시 부르지 않음
  await page.fill(".ps-input", "x");
  await page.fill(".ps-input", Q);
  await page.click(".ps-ai");
  await until(page, () => document.querySelectorAll(".ps-result").length === 2);
  assert.equal(page.calls.length, 1);
  // 검색어를 바꾸면 글자 검색으로 돌아감
  await page.fill(".ps-input", "AdamW");
  await until(page, () => document.querySelector(".ps-count").textContent === "1/1");
  assert.equal(await page.isVisible(".ps-results"), false);
  assert.deepEqual(page.errors, []);
});

test("AI 결과가 없으면 '찾지 못했습니다', 영어도 일치가 없으면 Enter로 AI", async browser => {
  const page = await newPage(browser, { locate: () => [] });
  await open(page);
  await search(page, "where are the limitations discussed");
  assert.equal(await count(page), "0/0");
  await page.press(".ps-input", "Enter");
  await until(page, () => /찾지 못했습니다/.test(document.querySelector(".ps-info").textContent));
  assert.equal(page.calls.length, 1);
});

test("질문 시트를 열어도 찾기 줄은 남고(keepOnSheet), Back은 시트 먼저 그다음 찾기 줄", async browser => {
  const page = await newPage(browser);
  await open(page);
  await search(page, "router");
  await page.evaluate(() => PaperApp.openSheet({ quote: "x", selection: "x" }));
  await sleep(100);
  const st = () => page.evaluate(() => ({ sheet: PaperApp.isSheetOpen(), bar: !!document.querySelector(".ps-bar")?.isConnected }));
  assert.deepEqual(await st(), { sheet: true, bar: true });
  await page.goBack();
  await sleep(200);
  assert.deepEqual(await st(), { sheet: false, bar: true });
  await page.goBack();
  await sleep(200);
  assert.deepEqual(await st(), { sheet: false, bar: false });
  assert.equal(await page.evaluate(() => CSS.highlights.has("ps-match")), false);
});

test("찾기 줄을 열고 닫아도 읽던 본문이 밀리지 않음 (스크롤 앵커링이 없는 Safari 흉내 포함)", async browser => {
  for (const anchoring of [true, false]) {
    const page = await newPage(browser);
    await open(page);
    if (!anchoring) await page.addStyleTag({ content: "* { overflow-anchor: none !important; }" });
    await page.evaluate(() => { document.getElementById("S2.p3").scrollIntoView({ block: "center" }); });
    await sleep(100);
    const top = () => page.evaluate(() => Math.round(document.getElementById("S2.p3").getBoundingClientRect().top));
    const y0 = await top();
    await page.click(BTN);
    await sleep(150);
    assert.ok(await page.evaluate(() => document.querySelector(".ps-bar").offsetHeight > 40));
    assert.ok(Math.abs(await top() - y0) <= 2, `열기: anchoring=${anchoring} ${y0} → ${await top()}`);
    await page.click('.ps-btn[aria-label="검색 닫기"]');
    await sleep(150);
    assert.ok(Math.abs(await top() - y0) <= 2, `닫기: anchoring=${anchoring} ${y0} → ${await top()}`);
  }
});

test("Ctrl+F → 찾기 줄을 열고 선택한 짧은 글자로 채움, Esc로 닫힘", async browser => {
  const page = await newPage(browser);
  await open(page);
  await page.evaluate(() => {
    const r = PaperAnchor.findQuote("routing rule");
    PaperApp.selectRange(r);
  });
  await page.keyboard.press("Control+f");
  await until(page, () => document.activeElement === document.querySelector(".ps-input"));
  assert.equal(await page.inputValue(".ps-input"), "routing rule");
  await until(page, () => document.querySelector(".ps-count").textContent === "1/1");
  await page.keyboard.press("Escape");
  await sleep(100);
  assert.equal(await page.evaluate(() => !!document.querySelector(".ps-bar")?.isConnected), false);
});

// 찾기 줄 아래에 (반 넘게) 보이는 첫 'experts' 결과의 번호 → '5/7' (결과 자체의 화면 위치 기준. 숨긴 결과는 대신 보이는 다음 형제)
const firstVisibleLabel = page => page.evaluate(() => {
  const idx = PaperAnchor.index(), hits = [];
  for (const m of idx.text.matchAll(/experts/gi)) hits.push({ start: m.index, end: m.index + m[0].length });
  const top = document.getElementById("top-stack").getBoundingClientRect().bottom;
  const i = hits.findIndex(h => {
    const r = PaperAnchor.rangeAt(h.start, h.end), rs = r.getClientRects(), b = rs[rs.length - 1];
    if (b) return (b.top + b.bottom) / 2 > top;
    let el = r.startContainer.parentElement;
    while (!el.parentElement.getClientRects().length) el = el.parentElement;
    return el.nextElementSibling.getBoundingClientRect().bottom > top;
  });
  return `${(i < 0 ? 0 : i) + 1}/${hits.length}`;
});
// y만큼 스크롤해 화면 위치(찾기 줄 아래 끝 기준)를 맞춤: fn은 페이지에서 '찾기 줄 아래 끝에 올 화면 y'를 돌려줌
async function scrollBarTo(page, fn) {
  await page.evaluate(fn => {
    const y = new Function(`return (${fn})()`)();
    scrollBy(0, y - document.getElementById("top-stack").getBoundingClientRect().bottom);
  }, String(fn));
  await sleep(100);
}
const LOCATE5 = () => [
  { q: "The model matches a dense baseline while using far fewer FLOPs per token", why: "요약의 주장" },
  { q: "Code and checkpoints are released to the community", why: "공개" },
  { q: "We introduce a top-two routing rule with a load balancing loss", why: "기여 1" },
  { q: "We minimize $\\mathcal{L}$ with AdamW and a learning rate of", why: "학습률 설정" },
  { q: "The balancing coefficient $\\alpha$ is set to 0.01", why: "균형 계수 값" },
];

test("첫 결과 = 지금 찾기 줄 아래 보이는 첫 일치 (문단 사이 빈 곳·긴 문단 중간·AI 목록이 열린 채·숨긴 원문), 위로 돌아가지 않음", async browser => {
  const typeExperts = async page => {
    await page.fill(".ps-input", "experts");
    await until(page, () => /^[1-9]\d*\/\d+$/.test(document.querySelector(".ps-count").textContent));
    return count(page);
  };
  // (1) 1절과 2절 사이 빈 곳이 찾기 줄 바로 아래 (찾기 줄 아래 한 점이 요소 없는 article에 닿아 논문 처음으로 가던 자리)
  let page = await newPage(browser);
  await open(page);
  await page.click(BTN);
  await sleep(100);
  await scrollBarTo(page, () => {
    const a = document.getElementById("S1").getBoundingClientRect().bottom, b = document.getElementById("S2").getBoundingClientRect().top;
    return (a + b) / 2 - 8;
  });
  assert.ok(await page.evaluate(() => {
    const top = document.getElementById("top-stack").getBoundingClientRect().bottom;
    return !document.elementFromPoint(innerWidth / 2, top + 8).closest(".ltx_para, .ltx_title, figure");
  }), "찾기 줄 바로 아래가 문단 사이 빈 곳");
  let want = await firstVisibleLabel(page);
  assert.notEqual(want, "1/7");
  assert.equal(await typeExperts(page), want, "문단 사이");
  // (2) 긴 문단 S1.p1의 두 결과 사이 (문단 시작이 화면 위에 있음)
  await page.fill(".ps-input", "");
  await sleep(250);
  await scrollBarTo(page, () => {
    const idx = PaperAnchor.index(), ms = [...idx.text.matchAll(/experts/gi)].map(m => PaperAnchor.rangeAt(m.index, m.index + 7));
    const inP = ms.filter(r => document.getElementById("S1.p1").contains(r.startContainer)).map(r => r.getBoundingClientRect());
    return (inP[0].bottom + inP[1].top) / 2;
  });
  want = await firstVisibleLabel(page);
  assert.ok(await page.evaluate(() => document.getElementById("S1.p1").getBoundingClientRect().top
    < document.getElementById("top-stack").getBoundingClientRect().bottom), "문단 시작이 찾기 줄 위");
  assert.equal(await typeExperts(page), want, "긴 문단 중간");
  await page.close();

  // (3) AI 결과 목록이 열린 채 (덮개가 화면 위쪽을 가림) 글자 검색으로
  page = await newPage(browser, { locate: LOCATE5 });
  await open(page);
  await search(page, "학습률 얘기");
  await page.press(".ps-input", "Enter");
  await until(page, () => document.querySelectorAll(".ps-result").length === 5);
  await scrollBarTo(page, () => document.getElementById("S2.p2").getBoundingClientRect().top);
  assert.equal(await page.isVisible(".ps-results"), true);
  want = await firstVisibleLabel(page);
  assert.notEqual(want, "1/7");
  assert.equal(await typeExperts(page), want, "AI 목록이 열린 채");
  await page.close();

  // (4) 번역 모드 흉내: 결과가 든 원문을 모두 숨기고 바로 뒤에 보이는 번역을 둠 → 화면의 번역에 해당하는 결과부터
  page = await newPage(browser);
  await open(page);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("#paper .ltx_abstract .ltx_p, #paper .ltx_para, #paper figcaption, #paper .ltx_listingline")) {
      if (el.parentElement.closest(".ltx_para")) continue;
      const ko = document.createElement("div");
      ko.className = "tr-ko pr-ui";
      ko.textContent = "번역된 문단입니다. ".repeat(12);
      el.after(ko);
      el.style.display = "none";
    }
  });
  await page.click(BTN);
  await sleep(100);
  await scrollBarTo(page, () => document.getElementById("S2.p3").nextElementSibling.getBoundingClientRect().top + 10);
  want = await firstVisibleLabel(page);
  const inP3 = await page.evaluate(() => {
    const idx = PaperAnchor.index(), ms = [...idx.text.matchAll(/experts/gi)];
    return ms.findIndex(m => document.getElementById("S2.p3").contains(PaperAnchor.rangeAt(m.index, m.index + 7).startContainer)) + 1;
  });
  assert.equal(want, `${inP3}/7`);
  assert.equal(await typeExperts(page), want, "숨긴 원문");
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("AI 결과 목록이 화면 가운데를 덮은 채 ✕로 닫아도 읽던 본문이 밀리지 않음 (스크롤 앵커링 없음 포함)", async browser => {
  for (const anchoring of [true, false]) {
    const page = await newPage(browser, { locate: LOCATE5 });
    await open(page);
    if (!anchoring) await page.addStyleTag({ content: "* { overflow-anchor: none !important; }" });
    await search(page, "학습률 얘기");
    await page.press(".ps-input", "Enter");
    await until(page, () => document.querySelectorAll(".ps-result").length === 5);
    await page.evaluate(() => { document.getElementById("S2.p3").scrollIntoView({ block: "center" }); });
    await sleep(150);
    assert.ok(await page.evaluate(() => !!document.elementFromPoint(innerWidth / 2, innerHeight / 2).closest(".ps-results")),
      "목록이 화면 가운데를 덮음");
    const top = () => page.evaluate(() => Math.round(document.getElementById("S2.p3").getBoundingClientRect().top));
    const y0 = await top();
    await page.click('.ps-btn[aria-label="검색 닫기"]');
    await sleep(150);
    assert.ok(Math.abs(await top() - y0) <= 2, `닫기: anchoring=${anchoring} ${y0} → ${await top()}`);
    await page.close();
  }
});

test("오프라인 AI로 찾기: '!'·'다시'·AI 버튼이 남고, Enter·'다시'로 재시도, 연결이 돌아오면 저절로 다시", async browser => {
  const page = await newPage(browser, { locate: LOCATE5 });
  await open(page);
  await search(page, "학습률 얘기 어디?");
  const ctx = page.context();
  await ctx.setOffline(true);
  await page.press(".ps-input", "Enter");
  await until(page, () => /오프라인/.test(document.querySelector(".ps-info").textContent));
  const st = () => page.evaluate(() => ({ count: document.querySelector(".ps-count").textContent,
    ai: !document.querySelector(".ps-ai").hidden, link: document.querySelector(".ps-link")?.textContent || "" }));
  assert.deepEqual(await st(), { count: "!", ai: true, link: "다시" });
  await page.press(".ps-input", "Enter");      // 아직 오프라인: 그대로, 부르지 않음
  await page.click('.ps-link:text("다시")');
  await sleep(100);
  assert.deepEqual(await st(), { count: "!", ai: true, link: "다시" });
  assert.equal(page.calls.length, 0);
  await ctx.setOffline(false);                // 'online' → 저절로 다시
  await until(page, () => document.querySelectorAll(".ps-result").length === 5);
  assert.equal(page.calls.length, 1);
  assert.equal(await count(page), "5곳");
  assert.equal(await page.isVisible(".ps-ai"), false);
  await page.press(".ps-input", "Enter");      // 이제 Enter는 결과 사이 이동
  assert.equal(await count(page), "1/5");
  assert.deepEqual(page.errors, []);
});

test("Highlight API가 없어도(<mark> 칠하기) 글자마다 본문 normMap을 다시 만들지 않음", async browser => {
  const page = await newPage(browser);
  await page.addInitScript(() => { delete window.Highlight; });
  await open(page);
  assert.equal(await page.evaluate(() => typeof Highlight), "undefined");
  await page.evaluate(() => {
    const orig = PaperAnchor.normMap, len = PaperAnchor.index().text.length;
    window.__builds = 0;
    PaperAnchor.normMap = t => { if (t.length === len) window.__builds++; return orig(t); };
  });
  await page.click(BTN);
  for (const q of ["ex", "exp", "expe", "exper", "expert", "experts"]) { await page.fill(".ps-input", q); await sleep(220); }
  await page.click('.ps-btn[aria-label="다음 결과"]');
  await page.click('.ps-btn[aria-label="다음 결과"]');
  await page.fill(".ps-input", "router");
  await sleep(220);
  assert.match(await count(page), /^1\/\d+$/);
  assert.equal(await page.evaluate(() => document.querySelectorAll("mark.pa-mark-ps-current").length > 0), true);
  assert.ok(await page.evaluate(() => window.__builds) <= 1, `normMap ${await page.evaluate(() => window.__builds)}번`);
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
  console.log(`in-paper-search.browser.js: ${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
