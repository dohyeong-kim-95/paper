// audio-summary 브라우저 동작 (헤드리스 Chromium + Playwright, 전체 기능 번들). tests/test_browser.py가 실행:
//   node tests/browser/audio-summary.browser.js <port>
// speechSynthesis는 가짜 엔진으로 바꿈 (말한 문장 기록, 문장 끝은 테스트가 __finish()로 넘김)
"use strict";
const assert = require("node:assert/strict");

let chromium;
try { ({ chromium } = require("playwright")); } catch { console.log("SKIP playwright 없음"); process.exit(0); }

const PORT = process.argv[2];
const BASE = `http://127.0.0.1:${PORT}`;
const PAPER = `${BASE}/paper/2401.00001`;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const IMG_SIZE = { "x1.png": [598, 300] };
const SCRIPTS = { brief: "첫 문장입니다. 둘째 문장이에요? 셋째 문장!", critique: "비평 첫 문장입니다. 비평 둘째 문장입니다." };

// 가짜 speechSynthesis: 발화는 기록만 하고 __uttMs 뒤(기본: 끝나지 않음)나 __finish()에 끝남
function fakeTts() {
  window.__spoken = [];
  window.__uttMs = 1e7;
  class U { constructor(text) { this.text = String(text); this.lang = ""; this.rate = 1; this.voice = null; this.volume = 1; } }
  const voices = [{ lang: "ko-KR", name: "유나", voiceURI: "ko", localService: true, default: false },
    { lang: "en-US", name: "Samantha", voiceURI: "en", localService: true, default: true }];
  const synth = {
    q: [], cur: null, t: 0, cancels: 0,
    getVoices: () => voices, addEventListener() {}, removeEventListener() {}, pause() {}, resume() {},
    speak(u) {
      if (u.text.trim()) __spoken.push({ text: u.text, lang: u.lang, rate: u.rate, voice: u.voice && u.voice.lang });
      this.q.push(u);
      this.pump();
    },
    pump() {
      if (this.cur || !this.q.length) return;
      const u = this.cur = this.q[0];
      setTimeout(() => { if (this.cur === u && u.onstart) u.onstart({}); }, 0);
      this.t = setTimeout(() => this.finish(), u.text.trim() ? window.__uttMs : 0);
    },
    finish() {
      const u = this.cur;
      if (!u) return;
      clearTimeout(this.t);
      this.q.shift();
      this.cur = null;
      if (u.onend) u.onend({});
      this.pump();
    },
    cancel() {
      this.cancels++;
      clearTimeout(this.t);
      const q = this.q, cur = this.cur;
      this.q = [];
      this.cur = null;
      for (const u of q) setTimeout(() => u.onerror && u.onerror({ error: u === cur ? "interrupted" : "canceled" }), 0);
    },
    get speaking() { return !!this.cur; },
  };
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = U;
  window.__finish = () => synth.finish();
  window.__last = () => __spoken[__spoken.length - 1] || null;
}

async function newPage(browser, { init, scripts } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 800 }, serviceWorkers: "block" });
  await ctx.route(u => !u.href.startsWith(BASE), r => {
    if (r.request().resourceType() !== "image") return r.fulfill({ status: 200, body: "", contentType: "text/plain" });
    const [w, h] = IMG_SIZE[r.request().url().split("/").pop()] || [300, 200];
    return r.fulfill({ status: 200, body: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"/>`, contentType: "image/svg+xml" });
  });
  const reqs = [];
  await ctx.route(`${BASE}/api/audio-summary/**`, async r => {
    const url = new URL(r.request().url());
    const style = url.searchParams.get("style");
    reqs.push(url.pathname + url.search);
    const out = scripts ? await scripts(style, url, reqs.length) : { status: 200, body: { style, text: SCRIPTS[style] } };
    await r.fulfill({ status: out.status, body: JSON.stringify(out.body), contentType: "application/json",
      headers: { "X-Offline-Cacheable": "1" } });
  });
  await ctx.route(`${BASE}/api/ask`, r => r.fulfill({ status: 200, body: "**답변**입니다. 둘째 문장.", contentType: "text/plain; charset=utf-8" }));
  // 전체 번들의 section-translate (번역 모드일 때): 서버가 모르는 단위로 답함 → 실패 칩·번역을 끼워 넣지 않음
  await ctx.route(`${BASE}/api/section-translate/**`, r => r.fulfill({ status: 200, body: "{}", contentType: "application/json" }));
  await ctx.addInitScript(fakeTts);
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.errors = [];
  page.reqs = reqs;
  page.on("pageerror", e => page.errors.push(String(e)));
  await page.goto(PAPER);
  await page.waitForFunction(() => window.PaperApp && PaperApp.has("audio-summary") && document.readyState === "complete");
  return page;
}
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 5000 });
const last = page => page.evaluate(() => __last());
const label = page => page.evaluate(() => document.querySelector(".as-play").getAttribute("aria-label"));

// 단위(문단)의 윗변을 헤더·띠 바로 아래로
async function scrollUnitTop(page, sel) {
  await page.evaluate(sel => {
    const el = document.querySelector(sel);
    const top = Math.max(document.getElementById("bar").getBoundingClientRect().bottom, document.getElementById("top-stack").getBoundingClientRect().bottom);
    window.scrollTo(0, scrollY + el.getBoundingClientRect().top - top - 2);
  }, sel);
}
async function openChooser(page) {
  await page.click("#bar-more");
  await page.locator(".pr-menu-item", { hasText: "듣기" }).click();
  await page.waitForSelector(".as-peek .as-opt");
}

test("본문 읽기: 보이는 첫 문단부터 문장 칠하기·as-reading·▶, 숨기면 일시정지 → 같은 문장부터, 닫으면 정리", async browser => {
  const page = await newPage(browser);
  await scrollUnitTop(page, "#S2\\.p1 > .ltx_p");
  const text0 = await page.evaluate(() => PaperAnchor.index().text);
  await openChooser(page);
  assert.deepEqual(await page.$$eval(".as-opt", els => els.map(e => e.dataset.id)), ["brief", "critique", "body"]);
  await page.click('.as-opt[data-id="body"]');
  assert.deepEqual(await last(page), { text: "The router computes gate scores as in Eq. (1).", lang: "en-US", rate: 1, voice: "en-US" });
  const s1 = await page.evaluate(() => ({
    reading: [...document.querySelectorAll(".as-reading")].map(e => e.id),
    hl: CSS.highlights.has("as-sentence") ? [...CSS.highlights.get("as-sentence")][0].toString() : null,
    cur: document.querySelector(".as-cur").textContent,
    here: document.querySelectorAll("#paper .as-here").length,
    units: [...document.querySelectorAll("#paper .ltx_p")].filter(p => !p.closest("figure, .ltx_bibliography, .ltx_note_outer")).length,
    peek: !!document.querySelector(".as-peek"),
  }));
  assert.deepEqual(s1.reading, ["S2.p1"]);
  assert.equal(s1.hl, "The router computes gate scores as in Eq. (1).");
  assert.equal(s1.cur, "The router computes gate scores as in Eq. (1).");
  assert.ok(s1.here > 8 && s1.here === s1.units, JSON.stringify(s1));
  assert.equal(s1.peek, false);
  assert.equal(await page.evaluate(() => PaperAnchor.index().text), text0, "▶(.pr-ui)는 색인 오프셋을 바꾸지 않음");

  await page.evaluate(() => __finish());
  await until(page, () => __last().text.startsWith("Figure 1 shows the architecture"));
  assert.equal(await page.evaluate(() => [...CSS.highlights.get("as-sentence")][0].toString()),
    "Figure 1 shows the architecture, Table 1 lists the results, and Section 2.1 describes the objective.");
  await page.evaluate(() => __finish());
  await until(page, () => __last().text === "Equation 1");

  // 화면 숨김 → 일시정지, ▶ → 같은 문장부터
  const cancels = await page.evaluate(() => speechSynthesis.cancels);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  assert.equal(await label(page), "재생");
  assert.deepEqual(await page.evaluate(() => [PaperApp.tts.paused, PaperApp.tts.owner, speechSynthesis.cancels]), [true, "audio-summary", cancels + 1]);
  const n = await page.evaluate(() => __spoken.length);
  await page.evaluate(() => { delete document.hidden; delete document.visibilityState; });
  await page.click(".as-play");
  assert.equal(await page.evaluate(() => __spoken.length), n + 1);
  assert.equal((await last(page)).text, "Equation 1");
  assert.equal(await label(page), "일시정지");

  // ⏮ 은 앞 문단의 마지막 문장으로
  await page.click(".as-prev");
  assert.ok((await last(page)).text.startsWith("Figure 1 shows"));
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".as-reading")].map(e => e.id)), ["S2.p1"]);

  // 다른 문단의 ▶ → 거기부터 (수식은 말로)
  await page.evaluate(() => document.getElementById("S2.SS1.p1").scrollIntoView({ block: "center" }));
  await page.click("#S2\\.SS1\\.p1 > .as-here");
  assert.equal((await last(page)).text, "We minimize L with AdamW and a learning rate of 3 times 10 to the minus 4.");
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".as-reading")].map(e => e.id)), ["S2.SS1.p1"]);

  await page.click(".as-x");
  assert.deepEqual(await page.evaluate(() => ({
    here: document.querySelectorAll(".as-here").length, reading: document.querySelectorAll(".as-reading").length,
    hl: CSS.highlights.has("as-sentence"), player: !!document.querySelector(".as-player"), owner: PaperApp.tts.owner,
  })), { here: 0, reading: 0, hl: false, player: false, owner: null });
  assert.deepEqual(page.errors, []);
});

test("요약 듣기: 고르기 창을 열면 미리 받아 둠, 한국어로 읽기·이동·속도·대본 peek, 끝, 비평은 받는 동안 '만드는 중'", async browser => {
  const page = await newPage(browser, {
    scripts: async style => {
      if (style === "critique") await new Promise(r => setTimeout(r, 400));
      return { status: 200, body: { style, text: SCRIPTS[style] } };
    },
  });
  await openChooser(page);
  await until(page, () => document.querySelector('.as-opt[data-id="brief"] .as-ready').textContent === "준비됨");
  await page.click('.as-opt[data-id="brief"]');
  assert.deepEqual(await last(page), { text: "첫 문장입니다.", lang: "ko-KR", rate: 1, voice: "ko-KR" });
  assert.deepEqual(await page.evaluate(() => [document.querySelector(".as-mode").textContent, document.querySelector(".as-pos").textContent]), ["요약 듣기", "1/3"]);
  await page.click(".as-next");
  assert.equal((await last(page)).text, "둘째 문장이에요?");
  await page.click(".as-rate");
  assert.deepEqual(await last(page), { text: "둘째 문장이에요?", lang: "ko-KR", rate: 1.2, voice: "ko-KR" });
  assert.deepEqual(await page.evaluate(() => [document.querySelector(".as-rate").textContent, PaperStore.get("audio-summary")]),
    ["1.2×", { rate: 1.2, style: "brief" }]);

  await page.click(".as-script-btn");
  await page.waitForSelector(".as-script-peek .as-s");
  assert.deepEqual(await page.$$eval(".as-script-peek .as-s", els => els.map(e => [e.textContent, e.classList.contains("as-now")])),
    [["첫 문장입니다.", false], ["둘째 문장이에요?", true], ["셋째 문장!", false]]);
  await page.click(".as-script-peek .as-s >> nth=0");
  assert.equal((await last(page)).text, "첫 문장입니다.");
  assert.equal(await page.$eval(".as-script-peek .as-now", e => e.textContent), "첫 문장입니다.");
  await page.keyboard.press("Escape");
  for (let k = 0; k < 3; k++) await page.evaluate(() => __finish());
  await until(page, () => document.querySelector(".as-cur").textContent.includes("끝까지"));
  assert.equal(await page.evaluate(() => PaperApp.tts.owner), null);
  assert.equal(page.reqs.filter(u => u.includes("style=brief")).length, 1, "대본은 한 번만 받음");

  await openChooser(page);
  await page.click('.as-opt[data-id="critique"]');
  await until(page, () => document.querySelector(".as-cur").textContent.includes("만드는 중"));
  await until(page, () => __last().text === "비평 첫 문장입니다.");
  assert.deepEqual(await page.evaluate(() => [document.querySelector(".as-mode").textContent, PaperStore.get("audio-summary").style]), ["비평 듣기", "critique"]);

  // 재생기가 열려 있으면 요약 중에도 문단마다 ▶ → 그 문단부터 본문 읽기
  assert.ok(await page.evaluate(() => document.querySelectorAll("#paper .as-here").length) > 8);
  await page.click("#S2\\.SS1\\.p1 > .as-here");
  assert.deepEqual(await page.evaluate(() => [document.querySelector(".as-mode").textContent, __last().text, __last().lang]),
    ["본문 읽기", "We minimize L with AdamW and a learning rate of 3 times 10 to the minus 4.", "en-US"]);
  assert.deepEqual(page.errors, []);
});

test("대본 실패: 오류 표시 → ▶는 retry=1로 다시 받아 읽음", async browser => {
  const page = await newPage(browser, {
    scripts: async (style, url) => (url.searchParams.get("retry")
      ? { status: 200, body: { style, text: SCRIPTS[style] } }
      : { status: 502, body: { detail: "생성 실패: 잘림" } }),
  });
  await page.evaluate(() => PaperStore.set("audio-summary", { rate: 1, style: "critique" })); // 미리 받기는 비평 쪽
  await openChooser(page);
  await page.click('.as-opt[data-id="brief"]');
  await until(page, () => document.querySelector(".as-cur").textContent === "생성 실패: 잘림 · ▶ 다시");
  await page.click(".as-play");
  await until(page, () => __last() && __last().text === "첫 문장입니다.");
  assert.ok(page.reqs.some(u => u.includes("style=brief&retry=1")), page.reqs.join(" "));
  assert.deepEqual(page.errors, []);
});

test("번역문 듣기: 문장 칸(.tr-s)마다 한국어로 읽고 raw로 칠함, 펼친 영어 줄(.tr-en)은 안 읽음, 하이라이트는 같은 쌍의 영어 문장, 질문은 시트 (막 바뀐 문장이면 앞 문장)", async browser => {
  const page = await newPage(browser, { init: () => localStorage.setItem("pr:section-translate:mode", '"both"') });
  await page.evaluate(() => {
    window.__hl = null;
    PaperApp.registerFeature("highlights-notes", { add(x) { window.__hl = { source: x.source, text: x.range.toString(), self: this === PaperApp.feature("highlights-notes") }; return "h1"; } });
    const p = document.querySelector("#S1\\.p1 > .ltx_p");
    PaperApp.registerFeature("section-translate", { unitFor: el => (el.closest(".tr-ko") ? p : null) });
    // section-translate가 그리는 모양: div.tr-ko[lang=ko] > span.tr-s[data-i] (쌍 번호), 누른 문장 뒤에 span.tr-en[lang=en]
    const s = (i, ...parts) => { const e = document.createElement("span"); e.className = "tr-s"; e.dataset.i = i; e.append(...parts); return e; };
    const math = document.getElementById("S1.p1.m1").cloneNode(true);
    math.removeAttribute("id");
    const en = document.createElement("span");
    en.className = "tr-en";
    en.lang = "en";
    en.append("We propose a sparse mixture of experts model.", Object.assign(document.createElement("span"), { className: "tr-en-tools", textContent: "번역 평가" }));
    const ko = document.createElement("div");
    ko.className = "tr-ko tr-p";
    ko.lang = "ko";
    ko.append(s(0, "큰 언어 모델은 잘 확장되지만 연산은 ", math, "처럼 늘어납니다."), " ",
      s(1, "우리는 희소 전문가 혼합 모델을 제안합니다. 각 토큰은 두 전문가로 갑니다."), en, " ",
      s(2, "지식 증류가 ", Object.assign(document.createElement("b"), { textContent: "라우터" }), "를 압축합니다."), " ", s(3, "구현은 공개되어 있습니다."));
    PaperAnchor.insertUI(p, ko);
  });
  await until(page, () => !document.querySelector("#paper .tr-state"));
  await scrollUnitTop(page, "#S1\\.p1 > .ltx_p");
  await openChooser(page);
  assert.deepEqual(await page.$$eval(".as-opt", els => els.map(e => e.dataset.id)), ["brief", "critique", "body-ko", "body"]);
  await page.click('.as-opt[data-id="body-ko"]');
  // 보이는 첫 단위는 다른 기능의 칩·띠에 따라 달라짐 → 그 문단의 ▶로 정해진 곳부터
  await page.click("#S1\\.p1 > .as-here");
  const first = await last(page);
  assert.deepEqual([first.lang, first.text], ["ko-KR", "큰 언어 모델은 잘 확장되지만 연산은 x의 제곱 처럼 늘어납니다."]);
  assert.deepEqual(await page.evaluate(() => {
    const r = [...CSS.highlights.get("as-sentence")][0];
    return [document.querySelector(".as-mode").textContent, !!r.startContainer.parentElement.closest(".tr-ko"),
      [...document.querySelectorAll(".as-reading")].map(e => e.id)];
  }), ["번역문 듣기", true, ["S1.p1"]]);

  await page.waitForTimeout(1300); // ▶ 직후 1.2초 안에 누르면 그 전에 듣던 문장이 대상
  await page.click(".as-cur");
  assert.equal(await page.isVisible(".as-pop .as-hl"), true);
  await page.click(".as-pop .as-hl");
  assert.deepEqual(await page.evaluate(() => [__hl.source, __hl.self, __hl.text.startsWith("Large language models scale well"), __hl.text.includes("We propose")]),
    ["audio-summary", true, true, false]);
  assert.equal(await page.isVisible(".as-pop"), false);

  await page.evaluate(() => __finish());
  await until(page, () => __last().text === "우리는 희소 전문가 혼합 모델을 제안합니다.");
  await page.click(".as-cur"); // 방금 바뀜 → 듣던 앞 문장이 대상
  assert.equal(await page.textContent(".as-pop-text"), first.text);
  await page.click(".as-pop .as-ask");
  await until(page, () => PaperApp.isSheetOpen());
  const q = await page.evaluate(() => ({ quote: PaperApp.session.quote, selection: PaperApp.session.selection, context: PaperApp.session.context, paused: PaperApp.tts.paused }));
  assert.equal(q.quote, first.text);
  assert.ok(q.selection.startsWith("Large language models scale well, but dense computation grows as $x^{2}$"), q.selection);
  assert.ok(q.context.includes("Knowledge distillation"));
  assert.equal(q.paused, true);

  // 한 쌍(.tr-s)에 한국어 두 문장: 둘째 문장도 같은 영어 문장(쌍 1)으로, 펼친 영어 줄은 읽지 않고 다음 칸으로
  await page.evaluate(() => PaperApp.closeSheet());
  await page.click(".as-play");
  assert.equal((await last(page)).text, "우리는 희소 전문가 혼합 모델을 제안합니다.");
  await page.evaluate(() => __finish());
  await until(page, () => __last().text === "각 토큰은 두 전문가로 갑니다.");
  await page.waitForTimeout(1300); // '방금 바뀜'(1.2초)이 지나면 지금 문장이 대상
  await page.click(".as-cur");
  await page.click(".as-pop .as-hl");
  assert.deepEqual(await page.evaluate(() => [__hl.text.startsWith("We propose a sparse mixture"), __hl.text.includes("Knowledge")]), [true, false]);
  await page.evaluate(() => __finish());
  await until(page, () => __last().text === "지식 증류가 라우터를 압축합니다.");
  assert.deepEqual(await page.evaluate(() => __spoken.filter(s => /We propose|번역 평가/.test(s.text)).length), 0);
  assert.deepEqual(page.errors, []);
});

test("다른 기능이 읽기를 시작하면 일시정지 → ▶로 이어 듣기; 음성 질문의 답은 한 번만 소리로 (answer-tools가 있으면 그쪽, 없으면 audio-summary)", async browser => {
  const page = await newPage(browser);
  await openChooser(page);
  await until(page, () => document.querySelector('.as-opt[data-id="brief"] .as-ready').textContent === "준비됨");
  await page.click('.as-opt[data-id="brief"]');
  await page.click(".as-next");
  await page.evaluate(() => PaperApp.tts.speak("다른 기능의 읽기", { owner: "answer-tools" }));
  assert.equal(await label(page), "재생");
  assert.equal(await page.textContent(".as-cur"), "둘째 문장이에요?");
  await page.click(".as-play");
  assert.equal((await last(page)).text, "둘째 문장이에요?");

  await page.evaluate(() => {
    PaperApp.openSheet({ quote: "x", selection: "x" });
    const form = document.getElementById("ask-form");
    document.getElementById("q").value = "이게 뭐야";
    form.dataset.via = "voice";
    form.requestSubmit();
  });
  await until(page, () => __last().text === "답변입니다.");
  await page.waitForTimeout(200); // 겹쳐 읽는 쪽이 있으면 그 사이에 말함
  const answer = await page.evaluate(() => ({
    n: __spoken.filter(s => s.text === "답변입니다.").length, lang: __last().lang, owner: PaperApp.tts.owner, at: PaperApp.has("answer-tools"),
  }));
  // §8: answer-tools가 있으면 그쪽이 자동으로 읽음 (audio-summary는 겹쳐 읽지 않음), 없을 때만 audio-summary가 대신
  assert.deepEqual(answer, { n: 1, lang: "ko-KR", owner: answer.at ? "answer-tools" : "audio-summary:answer", at: answer.at });
  assert.equal(await page.evaluate(() => document.querySelector(".as-play").getAttribute("aria-label")), "재생");
  assert.deepEqual(page.errors, []);
});

test("원고 줄바꿈은 문장 경계가 아님, 저자 인용(citet)은 이름만, <mark> 대체 칠하기에서도 문장 범위 유지, 끝나면 '문단 N/N'", async browser => {
  const page = await newPage(browser, {
    init: () => { // CSS Custom Highlight API가 없는 브라우저: PaperAnchor.paint가 <mark>로 감쌈 (글자 노드가 옮겨짐)
      delete window.Highlight;
      try { Object.defineProperty(CSS, "highlights", { value: undefined, configurable: true }); } catch { /* 무시 */ }
    },
  });
  await page.evaluate(() => {
    window.__hl = null;
    PaperApp.registerFeature("highlights-notes", { add(x) { window.__hl = x.range.toString(); return "h1"; } });
    document.querySelector("#S2\\.SS1\\.p1 > .ltx_p").innerHTML = "The router computes gate scores\nfor every token in the batch.\n"
      + '<cite class="ltx_cite ltx_citemacro_citet">Smith et al. (<a class="ltx_ref" href="#bib.bib1">2020</a>)</cite> show that routing\n'
      + 'is stable <cite class="ltx_cite ltx_citemacro_cite">[<a class="ltx_ref" href="#bib.bib2">2</a>]</cite>.';
  });
  const marks = () => page.evaluate(() => [...document.querySelectorAll("mark.pa-mark-as-sentence")].map(m => m.textContent).join(""));
  const S1 = "The router computes gate scores\nfor every token in the batch.";
  await openChooser(page);
  await page.click('.as-opt[data-id="body"]');
  await page.click("#S2\\.SS1\\.p1 > .as-here");
  assert.equal((await last(page)).text, "The router computes gate scores for every token in the batch.");
  assert.equal(await marks(), S1);
  await page.evaluate(() => __finish());
  await until(page, () => __last().text.startsWith("Smith"));
  assert.equal((await last(page)).text, "Smith et al. show that routing is stable.");
  assert.equal(await marks(), "Smith et al. (2020) show that routing\nis stable [2].");
  await page.click(".as-prev");
  assert.equal((await last(page)).text, "The router computes gate scores for every token in the batch.");
  assert.equal(await marks(), S1, "<mark>로 글자 노드가 옮겨진 뒤에도 같은 문장 전체");
  await page.waitForTimeout(1300);
  await page.click(".as-cur");
  await page.click(".as-pop .as-hl");
  assert.equal(await page.evaluate(() => __hl), S1);

  // 마지막 문단의 ▶ → 끝까지: 위치는 '문단 N/N'
  await page.locator("#paper .as-here").last().click();
  for (let k = 0; k < 60 && !(await page.textContent(".as-cur")).includes("끝까지"); k++) await page.evaluate(() => __finish());
  assert.ok((await page.textContent(".as-cur")).includes("끝까지"));
  const pos = /^문단 (\d+)\/(\d+)$/.exec(await page.textContent(".as-pos"));
  assert.ok(pos && pos[1] === pos[2], String(pos && pos[0]));
  assert.deepEqual(page.errors, []);
});

test("대본을 받는 동안 화면이 꺼지면 말하지 않음 → 돌아와서 ▶로 첫 문장부터", async browser => {
  const page = await newPage(browser, {
    scripts: async style => {
      await new Promise(r => setTimeout(r, 600));
      return { status: 200, body: { style, text: SCRIPTS[style] } };
    },
  });
  await openChooser(page);
  await page.click('.as-opt[data-id="brief"]');
  await until(page, () => document.querySelector(".as-cur").textContent.includes("만드는 중"));
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await until(page, () => document.querySelector(".as-cur").textContent === "첫 문장입니다.");
  assert.deepEqual(await page.evaluate(() => [__spoken.length, speechSynthesis.speaking, PaperApp.tts.owner]), [0, false, null]);
  assert.equal(await label(page), "재생");
  await page.evaluate(() => { delete document.hidden; delete document.visibilityState; });
  await page.click(".as-play");
  assert.deepEqual(await last(page), { text: "첫 문장입니다.", lang: "ko-KR", rate: 1, voice: "ko-KR" });
  assert.equal(await label(page), "일시정지");
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
  console.log(`audio-summary.browser.js: ${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
