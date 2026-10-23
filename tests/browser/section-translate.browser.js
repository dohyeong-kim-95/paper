// section-translate 브라우저 확인 (전체 번들, 헤드리스 Chromium). tests/test_browser.py가 서버를 띄우고 실행:
//   node tests/browser/section-translate.browser.js <port>
// /api/section-translate는 page.route로 가로채 서버 응답 모양(서버 unit_source·split_sentences·fingerprint 결과)을 돌려줌.
"use strict";
const assert = require("node:assert/strict");

let chromium;
try { ({ chromium } = require("playwright")); } catch { console.log("SKIP playwright 없음"); process.exit(0); }

const PORT = process.argv[2];
const BASE = `http://127.0.0.1:${PORT}`;
const PAPER = `${BASE}/paper/2401.00001`;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// 서버(features/section_translate.py)가 이 픽스처에서 만드는 en·ph·fp + 가짜 한국어
const UNITS = {
  "doc.title": { en: ["Sparse Mixtures for Everyone: A Test Paper"], ko: ["모두를 위한 희소 혼합: 시험 논문"], ph: [], fp: "sparsemixturesforeveryoneatestpa" },
  "abs.0": {
    en: ["We propose a sparse mixture of experts model that routes each token to two experts.", "The model matches a dense baseline while using far fewer FLOPs per token."],
    ko: ["각 토큰을 두 전문가로 보내는 희소 전문가 혼합 모델을 제안합니다.", "이 모델은 토큰당 훨씬 적은 FLOPs로 밀집 기준 모델과 같은 성능을 냅니다."],
    ph: [], fp: "weproposeasparsemixtureofexperts",
  },
  "S1.title": { en: ["⟦0⟧Introduction"], ko: ["⟦0⟧서론"], ph: [{ k: "tag", text: "1" }], fp: "1introduction" },
  "S1.p1#0": {
    en: ["Large language models scale well, but dense computation grows as ⟦0⟧ for a model of width ⟦1⟧.",
      "We propose a sparse mixture of experts model that routes each token to two experts ⟦2⟧.",
      "Knowledge distillation (KD) compresses the router, and the KD loss is cheap.⟦3⟧",
      "Our implementation is available at ⟦4⟧."],
    ko: ["대규모 언어 모델은 잘 확장되지만, 너비 ⟦1⟧인 모델에서 밀집 계산은 ⟦0⟧로 늘어납니다.",
      "각 토큰을 두 전문가로 보내는 희소 전문가 혼합 모델을 제안합니다 ⟦2⟧.",
      "지식 증류(KD)가 라우터를 압축하며, KD 손실은 저렴합니다.⟦3⟧",
      "구현은 ⟦4⟧에서 볼 수 있습니다."],
    ph: [{ k: "math", tex: "x^{2}" }, { k: "math", tex: "x" }, { k: "cite", text: "[1, 2]" }, { k: "note", id: "footnote1", text: "1" },
      { k: "ref", href: "https://github.com/example/sparse-moe", text: "https://github.com/example/sparse-moe" }],
    fp: "largelanguagemodelsscalewellbutd",
  },
  "S1.p2#0": { en: ["Our contributions are as follows:"], ko: ["우리의 기여는 다음과 같습니다:"], ph: [], fp: "ourcontributionsareasfollows" },
  "S1.I1.i2.p1#0": {
    en: ["We show that the model matches a dense baseline on ⟦0⟧ benchmarks while using fewer FLOPs."],
    ko: ["더 적은 FLOPs로 ⟦0⟧개 벤치마크에서 밀집 기준 모델과 같은 성능을 보입니다."],
    ph: [{ k: "math", tex: "5" }], fp: "weshowthatthemodelmatchesadenseb",
  },
  "S2.F1.cap": {
    en: ["⟦0⟧Architecture of the sparse mixture layer.", "Each token is routed to two experts."],
    ko: ["⟦0⟧희소 혼합 레이어의 구조.", "각 토큰은 두 전문가로 보내집니다."],
    ph: [{ k: "tag", text: "Figure 1:" }], fp: "figure1architectureofthesparsemi",
  },
  // 모델이 자리표시를 빠뜨린 단위 → 서버가 걸렀어야 하지만 클라이언트도 검사해서 '번역 실패' 칩
  "S2.p2#1": { en: ["where ⟦0⟧ is a small coefficient.", "The layer output is the gated sum"], ko: ["작은 계수입니다.", "레이어 출력은 게이트 합입니다"], ph: [{ k: "math", tex: "\\alpha" }], fp: "wherealphaisasmallcoefficientthe" },
};

async function newPage(browser, { mode = "both", fail = false } = {}, ctx = null) {
  ctx = ctx || await browser.newContext({ viewport: { width: 412, height: 800 }, serviceWorkers: "block" });
  await ctx.route(u => !u.href.startsWith(BASE), r => {
    if (r.request().resourceType() !== "image") return r.fulfill({ status: 200, body: "", contentType: "text/plain" });
    return r.fulfill({ status: 200, body: '<svg xmlns="http://www.w3.org/2000/svg" width="598" height="300"/>', contentType: "image/svg+xml" });
  });
  const calls = [];
  await ctx.route(`${BASE}/api/section-translate/**`, async r => {
    const body = JSON.parse(r.request().postData() || "{}");
    calls.push(body);
    if (ctx.fail) return r.fulfill({ status: 502, body: '{"detail":"x"}', contentType: "application/json" });
    const out = {};
    for (const id of body.ids) {
      const u = UNITS[id];
      out[id] = u ? { s: u.en.map((e, i) => [e, u.ko[i]]), ph: u.ph, fp: u.fp } : { skip: true };
    }
    return r.fulfill({ status: 200, body: JSON.stringify(out), contentType: "application/json" });
  });
  ctx.fail = fail;
  await ctx.addInitScript(m => { try { if (!sessionStorage.getItem("t-init")) { localStorage.setItem("pr:section-translate:mode", JSON.stringify(m)); sessionStorage.setItem("t-init", "1"); } } catch { /* 무시 */ } }, mode);
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", e => page.errors.push(String(e)));
  page.calls = calls;
  page.ctx = ctx;
  return page;
}
async function open(page) {
  await page.goto(PAPER);
  await page.waitForFunction(() => window.PaperApp && document.readyState === "complete");
}
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 5000 });
const ko = id => `.tr-ko[data-unit="${id}"]`;

test("둘다: 보이기 전에 번역됨, 수식·인용·각주·링크 복제, 제목은 .ltx_title 바로 뒤, 묶음 ≤ 6", async browser => {
  const page = await newPage(browser);
  await open(page);
  await until(page, sel => !!document.querySelector(sel), ko("S1.I1.i2.p1#0"));
  await until(page, () => !document.querySelector(".tr-pending"));
  const r = await page.evaluate(() => {
    const p1 = document.getElementById("S1.p1").querySelector("p.ltx_p");
    const k = p1.nextElementSibling;
    const below = document.querySelector('.tr-ko[data-unit="S1.I1.i2.p1#0"]');
    const t = document.querySelector("#S1 > .ltx_title");
    return {
      sibling: k.matches('.tr-ko.pr-ui[data-unit="S1.p1#0"][lang="ko"]'),
      sentences: k.querySelectorAll(".tr-s").length,
      maths: [...k.querySelectorAll("math")].map(m => m.getAttribute("alttext")),
      cite: !!k.querySelector('cite a.ltx_ref[href="#bib.bib1"]'),
      note: !!k.querySelector(".ltx_note .ltx_note_mark"),
      link: !!k.querySelector('a.ltx_ref[href="https://github.com/example/sparse-moe"]'),
      ids: document.querySelectorAll(".tr-ko [id]").length,
      belowFold: below.getBoundingClientRect().top > innerHeight,
      title: [t.nextElementSibling.matches('h2.tr-ko[data-unit="S1.title"]'), t.nextElementSibling.textContent],
      english: !p1.classList.contains("tr-hide"),
      pending: document.querySelectorAll(".tr-pending").length,
      korean: !!document.querySelector('.tr-ko[data-unit="S1.p3#0"]'),
      index: PaperAnchor.index().text.includes("대규모"),
      mode: [document.getElementById("paper").classList.contains("tr-mode-both"), document.querySelector('.pr-bar-btn[data-id="section-translate"]').getAttribute("aria-pressed")],
    };
  });
  assert.deepEqual(r, {
    sibling: true, sentences: 4, maths: ["x", "x^{2}"], cite: true, note: true, link: true, ids: 0, belowFold: true,
    title: [true, "1 서론"], english: true, pending: 0, korean: false, index: false, mode: [true, "true"],
  });
  assert.ok(page.calls.length >= 1 && page.calls.every(c => c.ids.length <= 6 || c.ids.every(i => i.endsWith(".title"))), JSON.stringify(page.calls));
  assert.ok(page.calls[0].ids.includes("abs.0") || page.calls[0].ids.includes("doc.title"), "가까운 것부터");
  assert.ok(!page.calls.flatMap(c => c.ids).includes("S1.p3#0"), "한국어 문단은 요청하지 않음");
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("한국어 문장 탭 → 영어 원문 한 줄 + tr-align, 다시 탭하면 닫힘. 복제 링크는 그대로 링크", async browser => {
  const page = await newPage(browser);
  await open(page);
  await until(page, sel => !!document.querySelector(sel), ko("S1.p1#0"));
  const pt = await page.evaluate(() => {
    const s = document.querySelector('.tr-ko[data-unit="S1.p1#0"] .tr-s[data-i="1"]');
    s.scrollIntoView({ block: "center" });
    const r = s.getClientRects()[0];
    return { x: r.left + 8, y: r.top + r.height / 2 };
  });
  await page.mouse.click(pt.x, pt.y);
  const r = await page.evaluate(() => {
    const s = document.querySelector('.tr-ko[data-unit="S1.p1#0"] .tr-s[data-i="1"]');
    const en = s.nextElementSibling;
    const hl = CSS.highlights.get("tr-align");
    const [enR, koR] = hl ? [...hl] : [];
    return {
      en: en && en.matches(".tr-en") ? en.firstChild.textContent : null,
      hl: [enR ? enR.toString().slice(0, 30) : null, koR ? koR.toString().slice(0, 12) : null, hl ? hl.priority : null],
      fb: !!en.querySelector(".pr-feedback"),
    };
  });
  assert.deepEqual(r, {
    en: "We propose a sparse mixture of experts model that routes each token to two experts ",
    hl: ["We propose a sparse mixture of", "각 토큰을 두 전문가로", 35], fb: true,
  });
  await page.mouse.click(pt.x, pt.y);
  assert.deepEqual(await page.evaluate(() => [document.querySelectorAll(".tr-en").length, CSS.highlights.has("tr-align"), document.querySelectorAll(".tr-on").length]), [0, false, 0]);
  // 번역문 안의 인용 링크: 문장 토글이 가로채지 않음 (기본 동작·cite-cards/ref-peek로)
  const linkTap = await page.evaluate(() => {
    const a = document.querySelector('.tr-ko[data-unit="S1.p1#0"] cite a.ltx_ref');
    document.addEventListener("click", e => e.preventDefault(), { once: true });
    a.click();
    return [document.querySelectorAll(".tr-en").length, document.querySelectorAll(".tr-on").length];
  });
  assert.deepEqual(linkTap, [0, 0]);
  await page.context().close();
});

test("번역 모드: 원문 숨김·읽던 위치 유지, reveal로 드러남, lookup·titleFor·unitFor, 원문으로 돌아가면 정리", async browser => {
  const page = await newPage(browser);
  await open(page);
  await until(page, sel => !!document.querySelector(sel), ko("S1.p1#0"));
  // 읽던 문단(S1.p1)을 화면 맨 위에 두고 모드를 바꾸면 그 번역문이 같은 자리에
  await page.evaluate(() => {
    const p1 = document.getElementById("S1.p1").querySelector("p.ltx_p");
    const hitY = document.getElementById("top-stack").getBoundingClientRect().bottom + 8;
    window.scrollBy(0, p1.getBoundingClientRect().top - (hitY - 10));
  });
  // 상태 칩 줄(#top-stack, 흐름 안)이 사라지며 생기는 이동이 섞이지 않게: 진행·완료 칩이 없어질 때까지
  await page.waitForFunction(() => !document.querySelector('.pr-status[data-state="loading"], .pr-status[data-state="ready"], .tr-pending'), null, { timeout: 8000 });
  const before = await page.evaluate(() => document.getElementById("S1.p1").querySelector("p.ltx_p").getBoundingClientRect().top);
  await page.click('.pr-bar-btn[data-id="section-translate"]');
  const r = await page.evaluate(() => {
    const p1 = document.getElementById("S1.p1").querySelector("p.ltx_p");
    return {
      hidden: getComputedStyle(p1).display, title: getComputedStyle(document.querySelector("#S1 > .ltx_title")).display,
      store: PaperStore.get("section-translate:mode"), cls: document.getElementById("paper").classList.contains("tr-mode-ko"),
      top: document.querySelector('.tr-ko[data-unit="S1.p1#0"]').getBoundingClientRect().top,
    };
  });
  assert.equal(r.hidden, "none");
  assert.equal(r.title, "none");
  assert.equal(r.store, "ko");
  assert.equal(r.cls, true);
  assert.ok(Math.abs(r.top - before) <= 2, `번역문이 읽던 자리에: ${before} → ${r.top}`);
  const api = await page.evaluate(async () => {
    const st = PaperApp.feature("section-translate");
    const range = PaperAnchor.findQuote("routes each token to two experts", { root: document.getElementById("S1.p1") });
    PaperApp.selectRange(range);
    const pairs = await st.lookup(PaperApp.sel());
    const none = await st.lookup({ range: PaperAnchor.findQuote("By the Cauchy-Schwarz inequality"), start: 0, end: 1 });
    const koEl = document.querySelector('.tr-ko[data-unit="S1.p1#0"] .tr-s');
    document.getSelection().removeAllRanges();
    return { pairs, none, title: st.titleFor("S1"), unit: st.unitFor(koEl) === document.getElementById("S1.p1").querySelector("p") };
  });
  assert.deepEqual(api.pairs, [{ en: "We propose a sparse mixture of experts model that routes each token to two experts [1, 2].", ko: "각 토큰을 두 전문가로 보내는 희소 전문가 혼합 모델을 제안합니다 [1, 2]." }]);
  assert.equal(api.none, null);
  assert.equal(api.title, "1 서론");
  assert.equal(api.unit, true);
  // 점프 대상이 숨긴 원문 안이면 드러냄
  const shown = await page.evaluate(() => {
    PaperNav.jumpTo(PaperAnchor.findQuote("dense computation grows"));
    return getComputedStyle(document.getElementById("S1.p1").querySelector("p.ltx_p")).display;
  });
  assert.equal(shown, "block");
  await page.click('.pr-bar-btn[data-id="section-translate"]');
  const off = await page.evaluate(() => [document.querySelectorAll(".tr-ko, .tr-state, .tr-hide").length, PaperStore.get("section-translate:mode")]);
  assert.deepEqual(off, [0, "orig"]);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("자리표시가 깨진 번역은 '번역 실패 · 다시' 칩, 오프라인·서버 실패에도 IndexedDB의 번역은 바로 그려짐", async browser => {
  const page = await newPage(browser);
  await open(page);
  await page.evaluate(() => document.getElementById("S2.p2").scrollIntoView({ block: "center" }));
  await until(page, () => !!document.querySelector(".tr-err"));
  const err = await page.evaluate(() => {
    const c = document.querySelector(".tr-err");
    return [c.previousElementSibling.textContent.trim().slice(0, 5), c.textContent, !document.querySelector('.tr-ko[data-unit="S2.p2#1"]')];
  });
  assert.deepEqual(err, ["where", "번역 실패 · 다시", true]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await until(page, sel => !!document.querySelector(sel), ko("S1.p1#0"));
  await page.waitForTimeout(300); // IndexedDB 쓰기
  const n = page.calls.length;
  page.ctx.fail = true;
  await page.reload();
  await page.waitForFunction(() => window.PaperApp && document.readyState === "complete");
  await until(page, sel => !!document.querySelector(sel), ko("S1.p1#0"));
  const r = await page.evaluate(() => ({
    maths: document.querySelectorAll('.tr-ko[data-unit="S1.p1#0"] math').length,
    title: document.querySelector("#S1 > .ltx_title").nextElementSibling.textContent,
  }));
  assert.deepEqual(r, { maths: 2, title: "1 서론" });
  const asked = page.calls.slice(n).flatMap(c => c.ids);
  assert.ok(!asked.includes("S1.p1#0") && !asked.includes("abs.0"), `저장된 단위는 다시 요청하지 않음: ${asked}`);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("'다시 번역'은 force로 새 번역으로 바꾸고, 실패 칩의 '다시'는 그 단위만 다시 요청", async browser => {
  const page = await newPage(browser);
  await open(page);
  await until(page, sel => !!document.querySelector(sel), ko("S1.p2#0"));
  UNITS["S1.p2#0"].ko = ["기여는 다음과 같습니다:"]; // 다시 번역하면 이 문장으로
  await page.evaluate(() => {
    const s = document.querySelector('.tr-ko[data-unit="S1.p2#0"] .tr-s');
    s.scrollIntoView({ block: "center" });
  });
  await page.click('.tr-ko[data-unit="S1.p2#0"] .tr-s');
  await page.click('.tr-ko[data-unit="S1.p2#0"] .tr-en-tools button:not(.pr-fb)');
  await until(page, sel => document.querySelector(sel)?.textContent === "기여는 다음과 같습니다:", ko("S1.p2#0"));
  assert.deepEqual(page.calls.filter(c => c.force), [{ ids: ["S1.p2#0"], force: true }]);
  UNITS["S1.p2#0"].ko = ["우리의 기여는 다음과 같습니다:"];
  await page.evaluate(() => document.getElementById("S2.p2").scrollIntoView({ block: "center" }));
  await until(page, () => !!document.querySelector(".tr-err button"));
  const n = page.calls.length;
  await page.click(".tr-err button");
  await page.waitForFunction(() => !!document.querySelector(".tr-err") && !document.querySelector(".tr-pending"), null, { timeout: 5000 }); // 여전히 깨진 응답 → 다시 칩
  assert.ok(page.calls.slice(n).some(c => c.ids.length === 1 && c.ids[0] === "S2.p2#1"), JSON.stringify(page.calls.slice(n)));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("끝까지 스크롤하면 서버와 같은 단위 id만 요청 (클라이언트·서버 단위 규칙 일치), 한국어·번호뿐인 단위는 요청 안 함", async browser => {
  // features/section_translate.py collect_units + should_skip 결과 (이 픽스처)
  const SERVER = ["A1.p1#0", "A1.title", "S1.I1.i1.p1#0", "S1.I1.i2.p1#0", "S1.p1#0", "S1.p2#0", "S1.title", "S2.F1.cap", "S2.F2.cap",
    "S2.F2.sf1.cap", "S2.F2.sf2.cap", "S2.F3.cap", "S2.SS1.3.p1#0", "S2.SS1.3.title", "S2.SS1.p1#0", "S2.SS1.title", "S2.T1.cap",
    "S2.p1#0", "S2.p2#0", "S2.p2#1", "S2.p3#0", "S2.title", "Thmtheorem1.p1#0", "abs.0", "abs.1", "abs.title", "alg1.cap",
    "doc.title", "footnote1.note"];
  const page = await newPage(browser);
  await open(page);
  for (let i = 0; i < 40; i++) {
    const end = await page.evaluate(() => { window.scrollBy(0, innerHeight * 0.8); return innerHeight + scrollY >= document.documentElement.scrollHeight - 2; });
    await page.waitForTimeout(120);
    if (end) break;
  }
  await page.waitForFunction(() => !document.querySelector(".tr-pending"), null, { timeout: 5000 });
  const asked = [...new Set(page.calls.flatMap(c => c.ids))].sort();
  const extra = asked.filter(id => !SERVER.includes(id)), missing = SERVER.filter(id => !asked.includes(id));
  assert.deepEqual(extra, [], `서버에 없는 id: ${extra}`);
  assert.ok(missing.every(id => id === "footnote1.note"), `요청 안 한 단위: ${missing}`); // 각주는 ref-peek가 숨기면 요청 안 함
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
  console.log(`section-translate.browser.js: ${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
