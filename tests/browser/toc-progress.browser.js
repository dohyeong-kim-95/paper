// toc-progress 브라우저 확인 (헤드리스 Chromium + Playwright, 전체 기능 번들). tests/test_browser.py가 실행:
//   node tests/browser/toc-progress.browser.js <port>
"use strict";
const assert = require("node:assert/strict");

let chromium, devices;
try { ({ chromium, devices } = require("playwright")); } catch { console.log("SKIP playwright 없음"); process.exit(0); }

const PORT = process.argv[2];
const BASE = `http://127.0.0.1:${PORT}`;
const PAPER = `${BASE}/paper/2401.00001`;
const POS_KEY = "pr:toc-progress:pos:2401.00001";
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 바깥 네트워크는 막고, 논문 그림은 width/height와 같은 비율의 SVG로 (로드 뒤 레이아웃이 밀리지 않게).
// /api/*(다른 기능의 생성 요청)는 빈 실패로: 이 테스트는 목차만 봄
const IMG_SIZE = { "x1.png": [598, 300], "x2.png": [300, 200], "x3.svg": [300, 200] };
async function newPage(browser, { init, initArg, viewport, device } = {}) {
  const ctx = await browser.newContext({ viewport: viewport || { width: 412, height: 800 }, ...(device || {}), serviceWorkers: "block" });
  await ctx.route(u => !u.href.startsWith(BASE), r => {
    if (r.request().resourceType() !== "image") return r.fulfill({ status: 200, body: "", contentType: "text/plain" });
    const [w, h] = IMG_SIZE[r.request().url().split("/").pop()] || [300, 200];
    return r.fulfill({ status: 200, body: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"/>`, contentType: "image/svg+xml" });
  });
  await ctx.route(u => u.href.startsWith(`${BASE}/api/`) && !u.href.includes("/api/prewarm/"),
    r => r.fulfill({ status: 503, body: "{}", contentType: "application/json" }));
  if (init) await ctx.addInitScript(init, initArg);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.errors = errors;
  return page;
}
async function open(page, url = PAPER) {
  await page.goto(url);
  await page.waitForFunction(() => window.PaperApp && PaperApp.has("toc-progress") && document.readyState === "complete");
  await sleep(400); // 유휴 시간의 구조 모으기·위치 재기
}
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 5000 });
const toastText = page => page.evaluate(() => { const t = document.getElementById("pr-toast"); return t && !t.hidden ? t.textContent : ""; });
const savedPos = page => page.evaluate(k => JSON.parse(localStorage.getItem(k)), POS_KEY);
// 진짜 손가락 끌기 (CDP 터치): 마우스와 달리 브라우저가 스크롤로 가져가면 pointercancel이 옴
async function touchDrag(page, from, to, steps = 10) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove",
      touchPoints: [{ x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }] });
    await sleep(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

test("목차 버튼은 헤더 첫 자리, 서랍에 초록·섹션·하위 섹션(중첩)·부록·참고문헌, 누르면 그 섹션 제목이 띠 바로 아래로", async browser => {
  const page = await newPage(browser);
  await open(page);
  const first = await page.evaluate(() => document.querySelector("#bar-actions > button").textContent);
  assert.equal(first, "목차");
  await page.click("#bar-actions > button:first-child");
  await until(page, () => document.querySelector(".toc-drawer.toc-in"));
  const tree = await page.evaluate(() => {
    const walk = ul => [...ul.children].map(li => {
      const t = li.querySelector(":scope > .toc-item .toc-t").textContent;
      const sub = li.querySelector(":scope > ul");
      return sub ? [t, walk(sub)] : t;
    });
    return walk(document.querySelector(".toc-body > ul"));
  });
  assert.deepEqual(tree, ["Abstract", "1 Introduction", ["2 Method", ["2.1 Training objective"]], "Appendix A Additional results", "References"]);
  const info = await page.evaluate(() => document.querySelector(".toc-info").textContent);
  assert.match(info, /전체 0% · 끝까지 약 \d+분/);
  await page.click('.toc-item[data-id="S2"]');
  await sleep(900);
  const r = await page.evaluate(() => {
    const t = document.querySelector("#S2 > .ltx_title").getBoundingClientRect().top;
    const line = document.getElementById("top-stack").getBoundingClientRect().bottom;
    return { gap: Math.round(t - line), drawer: !!document.querySelector(".toc-drawer"), label: document.getElementById("bar-section").textContent,
      depth: PaperNav.depth, top: PaperUI.topLayer() && PaperUI.topLayer().kind };
  });
  assert.ok(Math.abs(r.gap - 6) <= 3, `제목과 띠 사이 ${r.gap}px`);
  assert.deepEqual([r.drawer, r.label, r.depth, r.top], [false, "2 Method", 1, "jump"]);
  // 시스템 뒤로가기: 점프 전 위치(맨 위)로
  await page.goBack();
  await sleep(300);
  assert.equal(await page.evaluate(() => [Math.round(scrollY), PaperNav.depth].join()), "0,0");
  assert.deepEqual(page.errors, []);
});

test("지금 섹션 표시: 스크롤하면 바뀌고(하위 섹션·부록), 40% 선이 첫 항목보다 위면 원래 제목. 이름을 누르면 서랍", async browser => {
  const page = await newPage(browser);
  await open(page);
  const at = async id => {
    await page.evaluate(id => {
      const el = document.getElementById(id).querySelector(".ltx_title");
      window.scrollTo(0, el.getBoundingClientRect().top + scrollY - (innerHeight * 0.4 - 20)); // 제목이 40% 선 바로 위
    }, id);
    await sleep(250);
    return page.evaluate(() => document.getElementById("bar-section").textContent);
  };
  // 맨 위: 40% 선이 초록 제목 아래면 'Abstract', 위면 원래 제목. 다른 기능이 저자 뒤에 카드(overview 요약 등)를
  // 넣거나 띠에 칩을 올리면 초록이 40% 선 아래로 밀릴 수 있으니, 실제 위치로 기대값을 정함
  const top0 = await page.evaluate(() => [document.querySelector(".ltx_abstract").getBoundingClientRect().top <= innerHeight * 0.4,
    document.getElementById("bar-section").textContent]);
  assert.equal(top0[1], top0[0] ? "Abstract" : "2401.00001");
  // 초록 제목이 40% 선 바로 위로 오면 'Abstract'
  await page.evaluate(() => {
    const el = document.querySelector(".ltx_abstract");
    window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + scrollY - (innerHeight * 0.4 - 20)));
  });
  await sleep(250);
  assert.equal(await page.evaluate(() => document.getElementById("bar-section").textContent), "Abstract");
  assert.equal(await at("S2.SS1"), "2.1 Training objective");
  assert.equal(await at("A1"), "Appendix A Additional results");
  assert.equal(await at("S1"), "1 Introduction");
  // 초록 위에 내용을 끼워 40% 선이 첫 항목보다 위에 오게 → 원래 제목(arXiv id)
  await page.evaluate(() => {
    const pad = document.createElement("div");
    pad.style.height = "900px";
    document.querySelector(".ltx_abstract").before(pad);
    window.scrollTo(0, 0);
  });
  await sleep(250);
  assert.equal(await page.evaluate(() => document.getElementById("bar-section").textContent), "2401.00001");
  await page.click("#bar-section");
  await until(page, () => document.querySelector(".toc-drawer"));
  // Esc로 닫힘, 포커스는 돌아감
  await page.keyboard.press("Escape");
  await sleep(100);
  assert.equal(await page.evaluate(() => !!document.querySelector(".toc-drawer")), false);
  assert.deepEqual(page.errors, []);
});

test("진행 막대: 헤더 아래 띠 첫 줄, 섹션 경계 눈금, 스크롤하면 차고, 누르면 남은 시간 토스트", async browser => {
  const page = await newPage(browser);
  await open(page);
  const r0 = await page.evaluate(() => {
    const ts = document.getElementById("top-stack");
    const vis = [...ts.children].filter(c => getComputedStyle(c).display !== "none");
    const bar = document.querySelector(".toc-progress").getBoundingClientRect(), hd = document.getElementById("bar").getBoundingClientRect();
    return { first: vis[0].dataset.slot, ticks: document.querySelectorAll(".toc-tick").length,
      // 띠의 다른 줄(상태 칩 등)은 다른 기능 몫: 진행 막대 줄 자체가 3px만 차지하는지
      stackH: ts.querySelector('[data-slot="toc-progress"]').offsetHeight, overHeader: Math.round(hd.bottom - bar.top), barH: Math.round(bar.height) };
  });
  assert.equal(r0.first, "toc-progress");
  assert.ok(r0.ticks >= 2, `눈금 ${r0.ticks}개`);
  assert.equal(r0.stackH, 3, "띠는 3px만 차지");
  assert.deepEqual([r0.overHeader, r0.barH], [7, 10], "누르는 자리는 헤더 아래 여백으로 7px");
  await page.evaluate(() => {
    const el = document.getElementById("S2.p3");
    window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 70);
  });
  await sleep(300);
  const fill = await page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector(".toc-fill")).transform).a);
  assert.ok(fill > 0.1 && fill < 1, `채움 ${fill}`);
  await page.click(".toc-progress");
  const t = await toastText(page);
  assert.match(t, /^이 섹션 약 \d+분 · 전체 \d+% · 끝까지 약 \d+분$/);
  // 헤더 자동 숨김: 띠가 화면 맨 위로 → 막대는 맨 위, 누르는 자리 7px은 그 아래로 (화면 밖으로 나가지 않음), 띠 높이는 그대로 3px
  await page.evaluate(() => PaperUI.setBarHidden(true));
  await sleep(400);
  const r1 = await page.evaluate(() => {
    const b = document.querySelector(".toc-progress").getBoundingClientRect(), tr = document.querySelector(".toc-track").getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + 8);
    return { top: Math.round(b.top), h: Math.round(b.height), track: Math.round(tr.top - b.top),
      stackH: document.querySelector('#top-stack > [data-slot="toc-progress"]').offsetHeight,
      hit: !!(hit && hit.closest(".toc-progress")) };
  });
  assert.deepEqual(r1, { top: 0, h: 10, track: 0, stackH: 3, hit: true });
  await page.evaluate(() => PaperUI.setBarHidden(false));
  await sleep(400);
  assert.equal(await page.evaluate(() => Math.round(document.getElementById("bar").getBoundingClientRect().bottom - document.querySelector(".toc-progress").getBoundingClientRect().top)), 7);
  assert.deepEqual(page.errors, []);
});

test("위치 저장: 스크롤하면 1초 안에 {paraId, ratio, pct, ts}, 병합은 더 최근 ts", async browser => {
  const page = await newPage(browser);
  await open(page);
  await page.evaluate(() => {
    const el = document.getElementById("S2.SS1.p1");
    const line = document.getElementById("top-stack").getBoundingClientRect().bottom;
    window.scrollTo(0, el.getBoundingClientRect().top + scrollY - line + 5);
  });
  await sleep(1400);
  const pos = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), POS_KEY);
  assert.equal(pos.paraId, "S2.SS1.p1");
  assert.ok(pos.ratio > 0 && pos.ratio < 0.5, `ratio ${pos.ratio}`);
  assert.ok(pos.pct > 3 && pos.pct <= 100, `pct ${pos.pct}`);
  assert.ok(Date.now() - pos.ts < 10000);
  const merged = await page.evaluate(() => [
    PaperStore.merge("pr:toc-progress:pos:9", { pct: 1, ts: 5 }, { pct: 9, ts: 3 }).pct,
    PaperStore.merge("pr:toc-progress:pos:9", { pct: 1, ts: 5 }, { pct: 9, ts: 8 }).pct,
  ]);
  assert.deepEqual(merged, [1, 9]);
  assert.deepEqual(page.errors, []);
});

test("이어 읽기: 저장 위치가 3%를 넘으면 토스트, '이동'은 글자 크기가 바뀌어도 같은 문단의 같은 자리로", async browser => {
  const seed = () => {
    localStorage.setItem("pr:toc-progress:pos:2401.00001", JSON.stringify({ paraId: "S2.p3", ratio: 0.5, pct: 50, ts: 1 }));
    localStorage.setItem("pr:reading-settings", JSON.stringify({ size: 22 }));
  };
  const page = await newPage(browser, { init: seed });
  await open(page);
  await until(page, () => /이어 읽기/.test(document.getElementById("pr-toast")?.textContent || ""));
  // 공용 토스트는 폭이 화면 절반까지 → 412px 폰에서는 '§번호'로 줄여 '이동' 버튼이 두 줄로 꺾이지 않게
  assert.equal(await toastText(page), "이어 읽기 · §2이동");
  assert.ok(await page.evaluate(() => document.querySelector("#pr-toast button").getBoundingClientRect().height < 30), "'이동'이 한 줄");
  assert.equal(await page.evaluate(() => Math.round(scrollY)), 0);
  await page.click("#pr-toast button");
  await sleep(200);
  const r = await page.evaluate(() => {
    const b = document.getElementById("S2.p3").getBoundingClientRect();
    const line = document.getElementById("top-stack").getBoundingClientRect().bottom;
    return { off: Math.round(b.top + 0.5 * b.height - line), depth: PaperNav.depth, fs: getComputedStyle(document.getElementById("paper")).fontSize };
  });
  assert.equal(r.fs, "22px");
  assert.ok(Math.abs(r.off) <= 2, `기준선과 문단 가운데 차이 ${r.off}px`);
  assert.equal(r.depth, 1, "'↩ 돌아가기'로 맨 위로 돌아갈 수 있음");
  // 안내 중에는 저장된 자리를 덮지 않았고, 이동 뒤에는 새 자리로 저장
  await page.evaluate(() => window.scrollBy(0, 1));
  await sleep(1300);
  const pos = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), POS_KEY);
  assert.equal(pos.paraId, "S2.p3");
  assert.ok(Math.abs(pos.ratio - 0.5) < 0.05, `ratio ${pos.ratio}`);
  assert.deepEqual(page.errors, []);
});

test("이어 읽기 문구: 넓은 화면에서는 섹션 제목 그대로", async browser => {
  const seed = () => localStorage.setItem("pr:toc-progress:pos:2401.00001", JSON.stringify({ paraId: "S2.p3", ratio: 0.5, pct: 50, ts: 1 }));
  const page = await newPage(browser, { init: seed, viewport: { width: 1000, height: 800 } });
  await open(page);
  await until(page, () => /이어 읽기/.test(document.getElementById("pr-toast")?.textContent || ""));
  assert.equal(await toastText(page), "이어 읽기 · 2 Method이동");
  assert.ok(await page.evaluate(() => document.querySelector("#pr-toast button").getBoundingClientRect().height < 30));
  assert.deepEqual(page.errors, []);
});

test("이어 읽기 안내가 다른 기능의 '실행 취소' 토스트 뒤에 줄 서도, 실제로 떠 있는 동안은 저장 자리를 덮지 않고 사라진 뒤 저장", async browser => {
  const seed = () => {
    localStorage.setItem("pr:toc-progress:pos:2401.00001", JSON.stringify({ paraId: "S2.p3", ratio: 0.2, pct: 50, ts: 1 }));
    document.addEventListener("DOMContentLoaded", () => PaperUI.toast("삭제됨", { actionLabel: "실행 취소", ms: 5000 }));
  };
  const page = await newPage(browser, { init: seed });
  await open(page);
  assert.equal(await toastText(page), "삭제됨실행 취소");
  await page.waitForFunction(() => /이어 읽기/.test(document.getElementById("pr-toast")?.textContent || ""), null, { timeout: 9000 });
  // 안내가 뜬 지 4초 (안내를 낸 때로부터는 8초가 넘음): 아직 떠 있고, 스크롤해도 저장 자리 그대로
  await sleep(4000);
  await page.evaluate(() => window.scrollTo(0, 30));
  await sleep(1300);
  assert.match(await toastText(page), /^이어 읽기/);
  assert.equal((await savedPos(page)).pct, 50);
  // 안내가 사라지면 다시 저장
  await page.waitForFunction(() => document.getElementById("pr-toast").hidden, null, { timeout: 5000 });
  await page.evaluate(() => window.scrollTo(0, 40));
  await sleep(1300);
  assert.ok((await savedPos(page)).pct < 3, "안내가 사라진 뒤에는 새 자리로 저장");
  assert.deepEqual(page.errors, []);
});

test("이어 읽기 안내 없음: #q= 딥 링크, 새로고침, 3% 이하. 안내 중 맨 위를 잠깐 봐도 저장 자리를 덮지 않음", async browser => {
  const seed = pct => localStorage.setItem("pr:toc-progress:pos:2401.00001", JSON.stringify({ paraId: "S2.p3", ratio: 0.2, pct, ts: 1 }));
  let page = await newPage(browser, { init: seed, initArg: 50 });
  await open(page, `${PAPER}#q=router`);
  await sleep(1200);
  assert.equal(/이어 읽기/.test(await toastText(page)), false);
  page = await newPage(browser, { init: seed, initArg: 2 });
  await open(page);
  await sleep(1200);
  assert.equal(/이어 읽기/.test(await toastText(page)), false);
  page = await newPage(browser, { init: seed, initArg: 50 });
  await open(page);
  await until(page, () => /이어 읽기/.test(document.getElementById("pr-toast")?.textContent || ""));
  await page.evaluate(() => window.scrollTo(0, 30));
  await sleep(1300);
  assert.equal(await page.evaluate(k => JSON.parse(localStorage.getItem(k)).pct, POS_KEY), 50);
  // 새로고침은 브라우저가 자리를 되살리므로 안내하지 않음
  await page.reload();
  await page.waitForFunction(() => window.PaperApp && document.readyState === "complete");
  await sleep(1200);
  assert.equal(/이어 읽기/.test(await toastText(page)), false);
  assert.deepEqual(page.errors, []);
});

test("서랍은 레이어: 시트를 열면 닫히고, 뒤로가기도 서랍만 닫음 (스크롤 그대로)", async browser => {
  const page = await newPage(browser);
  await open(page);
  await page.evaluate(() => window.scrollTo(0, 500));
  await page.click("#bar-actions > button:first-child");
  await until(page, () => document.querySelector(".toc-drawer"));
  await page.goBack();
  await sleep(300);
  assert.deepEqual(await page.evaluate(() => [!!document.querySelector(".toc-drawer"), Math.round(scrollY), location.pathname]),
    [false, 500, "/paper/2401.00001"]);
  await page.click("#bar-actions > button:first-child");
  await until(page, () => document.querySelector(".toc-drawer"));
  await page.evaluate(() => PaperApp.openSheet({ quote: "q", selection: "q" }));
  await sleep(100);
  assert.deepEqual(await page.evaluate(() => [!!document.querySelector(".toc-drawer"), PaperApp.isSheetOpen(), PaperUI.topLayer().kind]),
    [false, true, "sheet"]);
  assert.deepEqual(page.errors, []);
});

test("구조도: paper:gists 요약 첫 문장 + 섹션별 그림·표·알고리즘, 접고 펴기, 그림을 누르면 그 그림으로", async browser => {
  const page = await newPage(browser);
  await open(page);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("paper:gists", { detail: { map: {
    S1: "희소 전문가 모델을 제안한다. 둘째 문장.", S2: "라우터와 손실을 설명한다.", "S2.SS1": "AdamW로 학습한다.",
  } } })));
  await page.click("#bar-actions > button:first-child");
  await until(page, () => document.querySelector(".toc-drawer"));
  await page.click('.toc-tab[data-tab="map"]');
  const r = await page.evaluate(() => {
    const node = id => document.querySelector(`.toc-map .toc-item[data-id="${id}"]`).closest("li");
    const kids = li => li.querySelector(":scope > .toc-kids");
    const s2 = node("S2");
    return {
      gists: [...document.querySelectorAll(".toc-gist")].map(b => b.textContent),
      figs: [...kids(s2).querySelectorAll(":scope > li > .toc-fig")].map(b => b.textContent),
      s2Open: !kids(s2).hidden, ssOpen: !kids(node("S2.SS1")).hidden,
      pressed: document.querySelector('.toc-tab[data-tab="map"]').getAttribute("aria-pressed"),
    };
  });
  assert.deepEqual(r.gists, ["희소 전문가 모델을 제안한다.", "라우터와 손실을 설명한다.", "AdamW로 학습한다."]);
  assert.deepEqual(r.figs, [
    "▣Figure 1 · Architecture of the sparse mixture layer. Each token is rou…",
    "▣Figure 2 · Training curves: (a) loss and (b) expert load over steps.",
    "▣Figure 3 · A TikZ diagram of the router.",
    "▦Table 1 · Results on two benchmarks.",
    "≡Algorithm 1 · Top-two routing",
  ]);
  assert.deepEqual([r.s2Open, r.ssOpen, r.pressed], [true, false, "true"]);
  await page.click('.toc-map .toc-item[data-id="S2.SS1"] >> xpath=preceding-sibling::button');
  assert.equal(await page.evaluate(() => document.querySelector('.toc-map .toc-item[data-id="S2.SS1"]').closest("li").querySelector(":scope > .toc-kids").hidden), false);
  await page.click(".toc-fig >> text=Table 1");
  await sleep(700);
  const j = await page.evaluate(() => {
    const b = document.getElementById("S2.T1").getBoundingClientRect();
    return { drawer: !!document.querySelector(".toc-drawer"), inView: b.top >= 0 && b.top < innerHeight, depth: PaperNav.depth };
  });
  assert.deepEqual(j, { drawer: false, inView: true, depth: 1 });
  assert.deepEqual(page.errors, []);
});

test("번역 모드: paper:translations 뒤 section-translate.titleFor 제목 (번호는 유지), 원문으로 돌아가면 원래 제목", async browser => {
  const page = await newPage(browser);
  await open(page);
  await page.evaluate(() => {
    PaperApp.registerFeature("section-translate", { titleFor: id => ({ S2: "방법", "S2.SS1": "2.1 학습 목표" })[id] || null });
    const el = document.querySelector("#S2 > .ltx_title");
    window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 100);
  });
  await sleep(250);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("paper:translations", { detail: { mode: "ko" } })));
  assert.equal(await page.evaluate(() => document.getElementById("bar-section").textContent), "2 방법");
  await page.click("#bar-actions > button:first-child");
  await until(page, () => document.querySelector(".toc-drawer"));
  const titles = await page.evaluate(() => [...document.querySelectorAll(".toc-body .toc-t")].map(x => x.textContent));
  assert.deepEqual(titles, ["초록", "1 Introduction", "2 방법", "2.1 학습 목표", "Appendix A Additional results", "References"]);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("paper:translations", { detail: { mode: "orig" } })));
  assert.equal(await page.evaluate(() => document.getElementById("bar-section").textContent), "2 Method");
  assert.deepEqual(page.errors, []);
});

test("터치로 서랍을 왼쪽으로 밀면 목록 위에서도 닫힘 (항목으로 이동하지 않음), 세로로 끌면 그대로", async browser => {
  const page = await newPage(browser, { device: devices["Pixel 7"] });
  await open(page);
  const openDrawer = async () => {
    await page.tap("#bar-actions > button:first-child");
    await until(page, () => document.querySelector(".toc-drawer.toc-in"));
    await sleep(250);
  };
  const at = sel => page.evaluate(s => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.left + r.width * 0.8, y: r.top + r.height / 2 }; }, sel);
  await openDrawer();
  let p = await at('.toc-item[data-id="S1"]');
  await touchDrag(page, p, { x: p.x, y: p.y + 120 });
  await sleep(300);
  assert.equal(await page.evaluate(() => !!document.querySelector(".toc-drawer")), true, "세로로 끌면 닫히지 않음");
  p = await at('.toc-item[data-id="S1"]');
  await touchDrag(page, p, { x: p.x - 200, y: p.y + 10 });
  await sleep(500);
  assert.deepEqual(await page.evaluate(() => [!!document.querySelector(".toc-drawer"), Math.round(scrollY), PaperNav.depth]), [false, 0, 0]);
  // 위쪽 탭·안내 줄에서도
  await openDrawer();
  p = await at(".toc-info");
  await touchDrag(page, p, { x: p.x - 200, y: p.y });
  await sleep(500);
  assert.equal(await page.evaluate(() => !!document.querySelector(".toc-drawer")), false);
  assert.deepEqual(page.errors, []);
});

test("번역 모드(원문 숨김): 숨은 초록 문단을 읽은 것으로 치지 않고, 목차·이어 읽기 점프는 보이는 번역 쪽을 대상으로", async browser => {
  const seed = () => localStorage.setItem("pr:toc-progress:pos:2401.00001", JSON.stringify({ paraId: "S2.p3", ratio: 0.5, pct: 50, ts: 1 }));
  const page = await newPage(browser, { init: seed });
  await open(page);
  await until(page, () => /이어 읽기/.test(document.getElementById("pr-toast")?.textContent || ""));
  // section-translate 계약의 DOM: 영어 단위(p.ltx_p·제목)에 tr-hide, 바로 뒤에 .tr-ko 형제
  await page.evaluate(() => {
    const st = document.createElement("style");
    st.textContent = ".tr-hide{display:none!important}";
    document.head.append(st);
    const paper = document.getElementById("paper");
    for (const u of paper.querySelectorAll("p.ltx_p, section > .ltx_title, .ltx_abstract > .ltx_title")) {
      const ko = document.createElement(u.localName === "p" ? "div" : u.localName);
      ko.className = "tr-ko pr-ui";
      ko.textContent = u.localName === "p" ? "한국어 번역 문장입니다. ".repeat(Math.max(2, Math.round(u.textContent.length / 40))) : "번역 제목";
      u.classList.add("tr-hide");
      u.after(ko);
    }
    window.__reveals = [];
    document.addEventListener("paper:reveal", e => __reveals.push(e.detail.el));
    document.dispatchEvent(new CustomEvent("paper:translations", { detail: { mode: "ko" } }));
  });
  await sleep(400);
  // 이어 읽기 '이동': 문단(S2.p3) 안의 보이는 번역을 대상으로 → 숨은 원문을 꺼내지 않고, 문단 가운데가 기준선에
  await page.click("#pr-toast button");
  await sleep(200);
  const r = await page.evaluate(() => {
    const b = document.getElementById("S2.p3").getBoundingClientRect();
    const line = document.getElementById("top-stack").getBoundingClientRect().bottom;
    const t = __reveals[0];
    return { off: Math.round(b.top + 0.5 * b.height - line), ko: t.classList.contains("tr-ko"), inPara: document.getElementById("S2.p3").contains(t) };
  });
  assert.ok(Math.abs(r.off) <= 2, `기준선과 문단 가운데 차이 ${r.off}px`);
  assert.deepEqual([r.ko, r.inPara], [true, true]);
  // 맨 위 (초록 번역 위): 저장 자리가 1장 첫 문단으로 건너뛰지 않고, 초록은 '읽음'이 아님
  await page.evaluate(() => window.scrollTo(0, 5));
  await sleep(1300);
  const pos = await savedPos(page);
  assert.notEqual(pos.paraId, "S1.p1");
  assert.ok(pos.ratio === 0 && pos.pct < 3, JSON.stringify(pos));
  // 초록 두 번째 문단(의 번역) 중간에 기준선 → 그 문단 안 비율로
  await page.evaluate(() => {
    const ko = document.querySelectorAll(".ltx_abstract > .tr-ko")[2];
    const line = document.getElementById("top-stack").getBoundingClientRect().bottom;
    const b = ko.getBoundingClientRect();
    window.scrollTo(0, b.top + scrollY - line + b.height / 2);
  });
  await sleep(1300);
  const pos2 = await savedPos(page);
  assert.ok(pos2.ratio > 0.3 && pos2.ratio < 0.7, JSON.stringify(pos2));
  await page.click("#bar-actions > button:first-child");
  await until(page, () => document.querySelector(".toc-drawer"));
  assert.equal(await page.evaluate(() => document.querySelector('.toc-item[data-id="abstract"]').classList.contains("toc-read")), false);
  // 목차 이동: 섹션 전체가 아니라 보이는 (번역) 제목만 paper:reveal 대상
  await page.evaluate(() => { __reveals.length = 0; });
  await page.click('.toc-item[data-id="S2.SS1"]');
  await sleep(700);
  const j = await page.evaluate(() => __reveals.map(el => `${el.localName}.${[...el.classList].filter(c => c !== "pa-flash").join(" ")}`));
  assert.deepEqual(j, ["h3.tr-ko pr-ui"]);
  assert.deepEqual(page.errors, []);
});

test("찾기 정리 화면(ps-declutter)에서는 위치를 저장하지 않고, 끝나면 다시 저장", async browser => {
  const page = await newPage(browser);
  await open(page);
  await page.evaluate(() => {
    const paper = document.getElementById("paper");
    paper.classList.add("ps-declutter");
    for (const p of paper.querySelectorAll(".ltx_para")) if (p.id !== "S2.p3") p.style.display = "none";
    window.scrollTo(0, 200);
  });
  await sleep(1300);
  assert.equal(await savedPos(page), null);
  await page.evaluate(() => {
    const paper = document.getElementById("paper");
    paper.classList.remove("ps-declutter");
    for (const p of paper.querySelectorAll(".ltx_para")) p.style.display = "";
    const el = document.getElementById("S2.SS1.p1");
    window.scrollTo(0, el.getBoundingClientRect().top + scrollY - document.getElementById("top-stack").getBoundingClientRect().bottom + 5);
  });
  await sleep(1300);
  assert.equal((await savedPos(page)).paraId, "S2.SS1.p1");
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
  console.log(`toc-progress.browser.js: ${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
