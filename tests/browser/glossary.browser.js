// glossary 브라우저 확인 (헤드리스 Chromium + Playwright, 전체 기능 번들). tests/test_browser.py가 서버를 띄우고 실행:
//   node tests/browser/glossary.browser.js <port>
// /api/glossary는 아래 GLOSSARY로 가로챔, 나머지 /api GET은 404 (다른 기능의 생성 요청과 무관하게)
"use strict";
const assert = require("node:assert/strict");

let chromium;
try { ({ chromium } = require("playwright")); } catch { console.log("SKIP playwright 없음"); process.exit(0); }

const PORT = process.argv[2];
const BASE = `http://127.0.0.1:${PORT}`;
const PAPER = `${BASE}/paper/2401.00001`;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const GLOSSARY = {
  terms: [
    { t: "mixture of experts", a: ["MoE"], ko: "전문가 혼합", d: "토큰마다 일부 전문가만 쓰는 구조", q: "We propose a sparse mixture of experts model that routes each token to two experts" },
    { t: "Knowledge distillation", a: ["KD"], ko: "지식 증류", d: "큰 모델의 지식을 작은 모델로 옮기는 학습", q: "Knowledge distillation (KD) compresses the router" },
    { t: "router", a: [], ko: "라우터", d: "토큰을 전문가에게 보내는 모듈", q: "The router computes gate scores as in Eq." },
    { t: "FLOPs", a: [], ko: "연산량", d: "부동소수점 연산 횟수", q: "" },
    { t: "AdamW", a: [], ko: "AdamW 최적화기", d: "가중치 감쇠를 분리한 Adam", q: "" },
  ],
  symbols: [
    { tex: "\\alpha", defs: [{ d: "균형 손실 계수", q: "is a small coefficient" }, { d: "균형 계수 (0.01로 고정)", q: "The balancing coefficient $\\alpha$ is set to 0.01" }] },
    { tex: "x", defs: [{ d: "모델 너비", q: "for a model of width $x$" }] },
    { tex: "f_{i}", defs: [{ d: "전문가 i가 받은 토큰 비율", q: "" }] },
    { tex: "N", defs: [{ d: "전문가 수", q: "" }] },
  ],
};
for (const e of [...GLOSSARY.terms, ...GLOSSARY.symbols]) {
  e.defs = e.defs || [{ d: e.d, q: e.q }];
  Object.assign(e, { d: e.defs[0].d, q: e.defs[0].q });
}
const PAINTED = ["mixture of experts", "FLOPs", "mixture of experts", "Knowledge distillation", "router", "FLOPs", "router", "AdamW"];

const fulfillGlossary = r => r.fulfill({ status: 200, body: JSON.stringify(GLOSSARY), contentType: "application/json" });
// glossary: (route, n번째 요청) => fulfill — 실패·지연 흉내
async function newPage(browser, { init, viewport, glossary } = {}) {
  const ctx = await browser.newContext({ viewport: viewport || { width: 412, height: 800 }, serviceWorkers: "block" });
  await ctx.route(u => !u.href.startsWith(BASE), r => {
    if (r.request().resourceType() !== "image") return r.fulfill({ status: 200, body: "", contentType: "text/plain" });
    return r.fulfill({ status: 200, body: '<svg xmlns="http://www.w3.org/2000/svg" width="598" height="300"/>', contentType: "image/svg+xml" });
  });
  const hits = { glossary: 0 };
  await ctx.route(`${BASE}/api/**`, r => {
    const url = r.request().url();
    if (url.includes("/api/glossary/")) { hits.glossary++; return glossary ? glossary(r, hits.glossary) : fulfillGlossary(r); }
    if (r.request().method() === "GET") return r.fulfill({ status: 404, body: '{"detail":"test"}', contentType: "application/json" });
    if (url.includes("/api/ask")) return r.fulfill({ status: 200, body: "답", contentType: "text/plain; charset=utf-8" });
    return r.continue();
  });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.errors = [];
  page.requests = [];
  // 다른 기능과 합쳐져도 이 기능의 오류만 셈 (스택의 sourceURL features/glossary.js)
  page.on("pageerror", e => { const s = String(e && e.stack || e); if (/glossary/.test(s)) page.errors.push(s); });
  page.on("request", r => page.requests.push(r.url()));
  page.hits = hits;
  return page;
}
async function open(page) {
  await page.goto(PAPER);
  await page.waitForFunction(() => window.PaperApp && document.readyState === "complete");
  await page.waitForFunction(() => CSS.highlights.has("gl-term") && document.querySelector("#paper math.gl-sym"), null, { timeout: 8000 });
}
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 5000 });
// 칠한 용어(n번째로 toString이 text인 것)를 화면 y 근처로 스크롤하고 가운데 좌표
const termPoint = (page, text, nth = 0, y = 300) => page.evaluate(([text, nth, y]) => {
  const r = [...CSS.highlights.get("gl-term")].filter(x => x.toString() === text)[nth];
  window.scrollBy(0, r.getBoundingClientRect().top - y);
  const b = r.getClientRects()[0];
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
}, [text, nth, y]);
const elPoint = (page, id, y = 300) => page.evaluate(([id, y]) => {
  const el = document.getElementById(id);
  window.scrollBy(0, el.getBoundingClientRect().top - y);
  const b = el.getBoundingClientRect();
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
}, [id, y]);
const peek = page => page.evaluate(() => {
  const p = [...document.querySelectorAll(".pr-peek")].pop();
  return p ? { title: p.querySelector(".pr-peek-head b").textContent, text: p.querySelector(".pr-peek-body").textContent, n: document.querySelectorAll(".pr-peek").length } : null;
});

test("밑줄: DOM은 그대로, 섹션마다 용어별 첫 출현만 칠함 (제목·링크·각주·수식 밖), 기호 있는 문단 수식만 표시", async browser => {
  const page = await newPage(browser);
  await open(page);
  const r = await page.evaluate(() => ({
    painted: [...CSS.highlights.get("gl-term")].map(x => x.toString()),
    wrapped: document.querySelectorAll("#paper ruby, #paper .gl-ruby, #paper [class^='gl-']:not(math)").length,
    sym: ["S1.p1.m2", "S2.p2.m1", "S2.E1.m1", "S2.E2.m2", "Thmtheorem1.p1.m1", "S2.SS1.p1.m2"].map(id => document.getElementById(id).classList.contains("gl-sym")),
    api: !!PaperApp.feature("glossary")?.lookup,
  }));
  assert.deepEqual(r.painted, PAINTED);
  assert.equal(r.wrapped, 0);
  assert.deepEqual(r.sym, [true, true, false, false, true, false]);
  assert.equal(r.api, true);
  assert.equal(page.hits.glossary, 1);
  assert.deepEqual(page.errors, []);
});

test("용어 탭: 네트워크 없이 바로 뜻 peek, '정의된 곳'은 점프, '알아요'는 모든 논문에서 숨김 + 실행 취소", async browser => {
  const page = await newPage(browser);
  await open(page);
  const n0 = page.requests.length;
  let p = await termPoint(page, "Knowledge distillation");
  await page.mouse.click(p.x, p.y);
  await until(page, () => document.querySelector(".gl-term-peek"));
  const pk = await peek(page);
  assert.equal(pk.title, "Knowledge distillation");
  assert.match(pk.text, /지식 증류/);
  assert.match(pk.text, /KD/);
  assert.match(pk.text, /큰 모델의 지식을 작은 모델로 옮기는 학습/);
  assert.match(pk.text, /3곳에서 사용/); // Knowledge distillation + KD 두 번
  // (다른 기능의 백그라운드 요청과 섞이지 않게 /api/glossary·/api/ask만 셈)
  assert.deepEqual(page.requests.slice(n0).filter(u => /\/api\/(glossary|ask)/.test(u)), [], "탭은 네트워크 요청 없이");

  await page.click(".gl-term-peek .gl-go");
  await until(page, () => !document.querySelector(".pr-peek") && !document.getElementById("back-chip").hidden);
  assert.equal(await page.evaluate(() => document.querySelector("#top-stack [data-slot='glossary'] .gl-chip")), null, "점프하면 뜻 칩 없음");
  await page.click("#back-chip");

  p = await termPoint(page, "Knowledge distillation");
  await page.mouse.click(p.x, p.y);
  await until(page, () => document.querySelector(".gl-term-peek"));
  await page.click(".gl-term-peek .pr-peek-actions button:has-text('알아요')");
  await until(page, () => CSS.highlights.get("gl-term").size === 7);
  assert.deepEqual(await page.evaluate(() => PaperStore.get("glossary:known")), ["knowledge distillation"]);
  await page.click("#pr-toast button:has-text('실행 취소')");
  await until(page, () => CSS.highlights.get("gl-term").size === 8);
  assert.deepEqual(await page.evaluate(() => PaperStore.get("glossary:known")), []);
  assert.deepEqual(page.errors, []);
});

test("'알아요'는 다음에 여는 논문에도 적용 (pr:glossary:known)", async browser => {
  const page = await newPage(browser, { init: () => localStorage.setItem("pr:glossary:known", JSON.stringify(["router", "flops"])) });
  await open(page);
  const painted = await page.evaluate(() => [...CSS.highlights.get("gl-term")].map(x => x.toString()));
  assert.deepEqual(painted, ["mixture of experts", "mixture of experts", "Knowledge distillation", "AdamW"]);
});

test("기호 탭: 위치에 맞는 정의 (섹션마다 다시 정의), 하위 기호 칩, 화면 밖 정의는 뜻 칩, display 수식은 안 받음", async browser => {
  const page = await newPage(browser, { viewport: { width: 412, height: 640 } });
  await open(page);
  let p = await elPoint(page, "S2.p2.m1");
  await page.mouse.click(p.x, p.y);
  await until(page, () => document.querySelector(".gl-sym-peek"));
  let pk = await peek(page);
  assert.match(pk.text, /균형 손실 계수/);
  assert.match(pk.text, /정의 2개/);
  await page.keyboard.press("Escape");

  p = await elPoint(page, "S2.SS1.p1.m3");
  await page.mouse.click(p.x, p.y);
  await until(page, () => document.querySelector(".gl-sym-peek"));
  pk = await peek(page);
  assert.match(pk.text, /0\.01로 고정/);
  await page.keyboard.press("Escape");

  p = await elPoint(page, "Thmtheorem1.p1.m1");
  await page.mouse.click(p.x, p.y);
  await until(page, () => document.querySelector(".gl-sym-peek .gl-subs"));
  const subs = await page.evaluate(() => [...document.querySelectorAll(".gl-sym-peek .gl-sub")].map(b => b.getAttribute("aria-pressed")));
  assert.deepEqual(subs, ["true", "false"]);
  assert.match((await peek(page)).text, /전문가 i가 받은 토큰 비율/);
  await page.click(".gl-sym-peek .gl-sub >> nth=1");
  assert.match((await peek(page)).text, /전문가 수/);
  await page.keyboard.press("Escape");

  // 정의(S1.p1)가 화면 밖인 기호 x: 알고리즘의 g(x)를 탭 → 닫으면 위쪽에 뜻 칩
  p = await elPoint(page, "alg1.l1.m1", 400);
  await page.mouse.click(p.x, p.y);
  await until(page, () => document.querySelector(".gl-sym-peek"));
  assert.match((await peek(page)).text, /모델 너비/);
  await page.click(".gl-sym-peek .pr-peek-x");
  await until(page, () => document.querySelector("#top-stack [data-slot='glossary'] .gl-chip"));
  assert.match(await page.evaluate(() => document.querySelector(".gl-chip").textContent), /모델 너비/);
  await page.click(".gl-chip .gl-chip-x");
  assert.equal(await page.evaluate(() => document.querySelector(".gl-chip")), null);

  p = await elPoint(page, "S2.E1.m1");
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(150);
  assert.equal(await peek(page), null, "display 수식은 equation-tools 몫");
  assert.deepEqual(page.errors, []);
});

test("'더 묻기'는 그 용어의 문단·섹션을 문맥으로 시트를 열고 자동 질문", async browser => {
  const page = await newPage(browser);
  await open(page);
  const p = await termPoint(page, "router", 1);
  await page.mouse.click(p.x, p.y);
  await until(page, () => document.querySelector(".gl-term-peek"));
  await page.click(".gl-term-peek .pr-peek-actions button:has-text('더 묻기')");
  await until(page, () => PaperApp.session && PaperApp.session.history.length === 2);
  const s = await page.evaluate(() => ({ sel: PaperApp.session.selection, ctx: PaperApp.session.context, sec: PaperApp.session.section, q: PaperApp.session.history[0].content, peeks: document.querySelectorAll(".pr-peek").length }));
  assert.equal(s.sel, "router");
  assert.match(s.ctx, /^The router computes gate scores/);
  assert.equal(s.sec, "2 Method");
  assert.match(s.q, /'router' \(라우터\)/);
  assert.equal(s.peeks, 0);
});

test("루비 병기: 설정을 켜면 밑줄 친 용어 위에 한국어 (색인 텍스트 그대로), 끄면 원래대로", async browser => {
  const page = await newPage(browser);
  await open(page);
  const r = await page.evaluate(async () => {
    const text0 = PaperAnchor.index().text, html0 = document.getElementById("S1.p1").innerHTML;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    document.dispatchEvent(new CustomEvent("paper:settings", { detail: { key: "ruby", value: true } }));
    for (let i = 0; i < 50 && document.querySelectorAll("#paper ruby.gl-ruby").length < 8; i++) await sleep(50);
    const on = {
      rt: [...document.querySelectorAll("#paper ruby.gl-ruby > rt")].map(x => x.textContent),
      rtUi: [...document.querySelectorAll("#paper ruby.gl-ruby > rt")].every(x => x.classList.contains("pr-ui")),
      rubyUi: [...document.querySelectorAll("#paper ruby.gl-ruby")].some(x => x.classList.contains("pr-ui")),
      same: PaperAnchor.index().text === text0,
    };
    await sleep(50);
    on.painted = [...CSS.highlights.get("gl-term")].map(x => x.toString());
    document.dispatchEvent(new CustomEvent("paper:settings", { detail: { key: "ruby", value: false } }));
    await sleep(50);
    return { on, off: { n: document.querySelectorAll("#paper ruby, #paper rt").length, same: PaperAnchor.index().text === text0, html: document.getElementById("S1.p1").innerHTML === html0 } };
  });
  assert.deepEqual(r.on.rt, ["전문가 혼합", "연산량", "전문가 혼합", "지식 증류", "라우터", "연산량", "라우터", "AdamW 최적화기"]);
  assert.equal(r.on.rtUi, true);
  assert.equal(r.on.rubyUi, false);
  assert.equal(r.on.same, true);
  assert.deepEqual(r.on.painted, PAINTED);
  assert.deepEqual(r.off, { n: 0, same: true, html: true });
});

const openList = async page => {
  await page.click("#bar-more");
  await page.click(".pr-menu-item:has-text('용어')");
  await until(page, () => document.querySelector(".gl-list-peek .gl-item"));
};

test("루비 병기: '용어' 목록의 스위치로 켜고 끔 (pr:glossary:ruby, 다음에 열 때도), 위의 한국어(rt)를 눌러도 뜻 peek", async browser => {
  const page = await newPage(browser);
  await open(page);
  await openList(page);
  assert.equal(await page.isChecked(".gl-list-peek .gl-ruby-sw"), false);
  await page.evaluate(() => { window.__dc = 0; document.addEventListener("paper:dom-changed", () => window.__dc++); });
  await page.click(".gl-list-peek .gl-opt");
  await until(page, n => document.querySelectorAll("#paper ruby.gl-ruby").length === n, 8);
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => PaperStore.get("glossary:ruby")), true);
  assert.ok(await page.evaluate(() => window.__dc) <= 2, "감싸기마다가 아니라 몰아서 paper:dom-changed");
  await page.keyboard.press("Escape");

  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("#paper ruby.gl-ruby").length === 8, null, { timeout: 8000 });
  const p = await page.evaluate(() => {
    const rt = [...document.querySelectorAll("#paper ruby.gl-ruby > rt")].find(x => x.textContent === "라우터");
    window.scrollBy(0, rt.getBoundingClientRect().top - 300);
    const b = rt.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await page.mouse.click(p.x, p.y);
  await until(page, () => document.querySelector(".gl-term-peek"));
  assert.equal((await peek(page)).title, "router");
  await page.keyboard.press("Escape");
  await until(page, () => !document.querySelector(".pr-peek"));

  await openList(page);
  assert.equal(await page.isChecked(".gl-list-peek .gl-ruby-sw"), true);
  await page.click(".gl-list-peek .gl-opt");
  await until(page, () => !document.querySelector("#paper ruby, #paper rt"));
  assert.equal(await page.evaluate(() => PaperStore.get("glossary:ruby")), false);
  assert.deepEqual(page.errors, []);
});

test("루비: 스위치를 쓴 적 없으면 pr:reading-settings.ruby를 따름, 글자 선택 중엔 감싸기를 미루되 PaperApp.idle 줄은 막지 않음", async browser => {
  let release;
  const gate = new Promise(r => { release = r; });
  const page = await newPage(browser, {
    init: () => localStorage.setItem("pr:reading-settings", JSON.stringify({ ruby: true })),
    glossary: async r => { await gate; return fulfillGlossary(r); },
  });
  await page.goto(PAPER);
  await page.waitForFunction(() => window.PaperApp && document.readyState === "complete");
  await page.evaluate(() => {
    const s = getSelection(), r = document.createRange();
    r.selectNodeContents(document.getElementById("S1.p1"));
    s.removeAllRanges();
    s.addRange(r);
  });
  release();
  await page.waitForFunction(() => CSS.highlights.has("gl-term"), null, { timeout: 8000 });
  const r = await page.evaluate(async () => {
    const ran = await Promise.race([PaperApp.idle(() => "ran"), new Promise(r => setTimeout(() => r("blocked"), 2500))]);
    return { ran, rubies: document.querySelectorAll("#paper ruby.gl-ruby").length, sel: !getSelection().isCollapsed };
  });
  assert.deepEqual(r, { ran: "ran", rubies: 0, sel: true });
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.waitForFunction(() => document.querySelectorAll("#paper ruby.gl-ruby").length === 8, null, { timeout: 5000 });
  assert.deepEqual(page.errors, []);
});

test("상태 칩: 실패 뒤 '다시'가 400ms 안에 성공해도 '용어 ✕ 다시' 칩이 남지 않음", async browser => {
  const page = await newPage(browser, {
    glossary: (r, n) => (n === 1 ? r.fulfill({ status: 502, body: '{"detail":"잘림"}', contentType: "application/json" }) : fulfillGlossary(r)),
  });
  await page.goto(PAPER);
  await page.waitForFunction(() => document.querySelector(".pr-status[data-key=glossary][data-state=error] button"), null, { timeout: 8000 });
  await page.click(".pr-status[data-key=glossary] button");
  await page.waitForFunction(() => CSS.highlights.has("gl-term"), null, { timeout: 8000 });
  assert.equal(await page.evaluate(() => document.querySelector(".pr-status[data-key=glossary][data-state=error]")), null);
  await page.waitForFunction(() => !document.querySelector(".pr-status[data-key=glossary]"), null, { timeout: 5000 });
  assert.equal(page.hits.glossary, 2);
  assert.deepEqual(page.errors, []);
});

test("'용어' 목록: ⋯ 메뉴에서 열고, 영어·한국어로 검색, 항목을 누르면 뜻 peek가 위에", async browser => {
  const page = await newPage(browser);
  await open(page);
  await page.click("#bar-more");
  await page.click(".pr-menu-item:has-text('용어')");
  await until(page, () => document.querySelector(".gl-list-peek .gl-item"));
  const all = await page.evaluate(() => [...document.querySelectorAll(".gl-list-peek h3")].map(x => x.textContent));
  assert.deepEqual(all, ["용어 5", "기호 4"]);
  await page.fill(".gl-list-peek .gl-q", "증류");
  const found = await page.evaluate(() => [...document.querySelectorAll(".gl-list-peek .gl-item b")].map(x => x.textContent));
  assert.deepEqual(found, ["Knowledge distillation"]);
  await page.click(".gl-list-peek .gl-item");
  await until(page, () => document.querySelector(".gl-term-peek"));
  assert.equal((await peek(page)).n, 2);
  await page.click(".gl-term-peek .pr-peek-actions button:has-text('알아요')");
  await until(page, () => [...document.querySelectorAll(".gl-list-peek h3")].some(x => x.textContent === "알고 있는 용어 1"));
  await page.click(".gl-list-peek .gl-unknow");
  await until(page, () => ![...document.querySelectorAll(".gl-list-peek h3")].some(x => x.textContent.startsWith("알고 있는")));
  const look = await page.evaluate(() => {
    const g = PaperApp.feature("glossary");
    return [g.lookup("kd")?.term, g.lookup("Routers")?.ko, g.lookup("\\alpha")?.d, g.lookup("없는 말")];
  });
  assert.deepEqual(look, ["Knowledge distillation", "라우터", "균형 손실 계수", null]);
});

test("CSS Highlight API가 없으면 밑줄 없이 (본문 그대로), 목록은 그대로 동작", async browser => {
  const page = await newPage(browser, { init: () => { try { Object.defineProperty(CSS, "highlights", { value: undefined }); } catch { /* 무시 */ } } });
  await page.goto(PAPER);
  await page.waitForFunction(() => document.querySelector("#paper math.gl-sym"), null, { timeout: 8000 });
  const r = await page.evaluate(() => ({ marks: document.querySelectorAll("#paper mark").length, hl: !!CSS.highlights }));
  assert.deepEqual(r, { marks: 0, hl: false });
  await page.click("#bar-more");
  await page.click(".pr-menu-item:has-text('용어')");
  await until(page, () => document.querySelectorAll(".gl-list-peek .gl-item").length === 9);
  assert.deepEqual(page.errors, []);
});

test("Highlight API가 없어도 루비로 감싼 용어는 탭하면 뜻 peek", async browser => {
  const page = await newPage(browser, {
    init: () => {
      try { Object.defineProperty(CSS, "highlights", { value: undefined }); } catch { /* 무시 */ }
      localStorage.setItem("pr:glossary:ruby", "true");
    },
  });
  await page.goto(PAPER);
  await page.waitForFunction(() => document.querySelectorAll("#paper ruby.gl-ruby").length === 8, null, { timeout: 8000 });
  const p = await page.evaluate(() => {
    const rb = [...document.querySelectorAll("#paper ruby.gl-ruby")].find(x => x.firstChild.textContent === "Knowledge distillation");
    window.scrollBy(0, rb.getBoundingClientRect().top - 300);
    const g = document.createRange();
    g.selectNodeContents(rb.firstChild);
    const b = g.getClientRects()[0];
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await page.mouse.click(p.x, p.y);
  await until(page, () => document.querySelector(".gl-term-peek"));
  assert.match((await peek(page)).text, /지식 증류/);
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
  console.log(`glossary.browser.js: ${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
