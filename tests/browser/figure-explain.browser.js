// figure-explain 브라우저 확인 (헤드리스 Chromium + Playwright, 전체 기능 번들). tests/test_browser.py가 실행:
//   node tests/browser/figure-explain.browser.js <port>
"use strict";
const assert = require("node:assert/strict");

let chromium;
try { ({ chromium } = require("playwright")); } catch { console.log("SKIP playwright 없음"); process.exit(0); }

const PORT = process.argv[2];
const BASE = `http://127.0.0.1:${PORT}`;
const PAPER = `${BASE}/paper/2401.00001`;
const IMG = "https://arxiv.org/html/2401.00001v1/";
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const IMG_SIZE = { "x1.png": [598, 300], "x2.png": [300, 200], "x3.svg": [300, 200] };

// 바깥 네트워크는 막고 그림은 같은 비율의 빈 SVG로. intercept면 /api/figure-explain/ask를 가로채 payload 기록
async function newPage(browser, { intercept = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 800 }, serviceWorkers: "block" });
  await ctx.route(u => !u.href.startsWith(BASE), r => {
    if (r.request().resourceType() !== "image") return r.fulfill({ status: 200, body: "", contentType: "text/plain" });
    const [w, h] = IMG_SIZE[r.request().url().split("/").pop()] || [300, 200];
    return r.fulfill({ status: 200, body: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"/>`, contentType: "image/svg+xml" });
  });
  const asks = [];
  if (intercept) {
    await ctx.route(`${BASE}/api/figure-explain/ask`, async r => {
      asks.push(JSON.parse(r.request().postData() || "{}"));
      try { await r.fulfill({ status: 200, body: "그림 설명입니다.", contentType: "text/plain; charset=utf-8" }); } catch { /* 중단 */ }
    });
  }
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", e => page.errors.push(String(e)));
  page.asks = asks;
  await page.goto(PAPER);
  await page.waitForFunction(() => window.PaperApp && document.readyState === "complete" && PaperApp.has("figure-explain"));
  return page;
}
async function waitAsks(page, n) {
  for (let i = 0; i < 100 && page.asks.length < n; i++) await sleep(50);
  assert.equal(page.asks.length, n, "질문 요청 수");
  return page.asks[n - 1];
}
const chip = (page, id, text = "AI 설명") => page.locator(`[id="${id}"] > .fe-chips > button`, { hasText: text });
const closeSheet = page => page.evaluate(() => PaperApp.closeSheet());
const session = page => page.evaluate(() => {
  const s = PaperApp.session;
  return { title: s.title, quote: s.quote, endpoint: s.endpoint, presets: s.presets.map(p => p.label) };
});

test("칩: 바깥 그림마다 하나(하위 패널 중복 없음), 패널 칩 (a)(b), 색인·그림을 건드리지 않음", async browser => {
  const page = await newPage(browser);
  const r = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#paper .fe-chips")];
    const f1 = document.getElementById("S2.F1"), row = f1.querySelector(".fe-chips").getBoundingClientRect();
    const img = f1.querySelector("img").getBoundingClientRect();
    return {
      ids: rows.map(x => x.parentElement.id),
      allPrUi: rows.every(x => x.classList.contains("pr-ui")),
      nested: document.querySelectorAll("#paper figure figure .fe-chips").length,
      f2: [...document.getElementById("S2.F2").querySelector(".fe-chips").children].map(b => b.textContent),
      indexClean: !PaperAnchor.index().text.includes("AI 설명"),
      visible: row.width > 0 && row.height >= 28,
      noOverlap: row.bottom <= img.top + 1, // 칩 줄은 그림 위 빈자리에
    };
  });
  assert.deepEqual(r, {
    ids: ["S2.F1", "S2.F2", "S2.F3", "S2.T1", "alg1"], allPrUi: true, nested: 0,
    f2: ["AI 설명", "(a)", "(b)"], indexClean: true, visible: true, noOverlap: true,
  });
  assert.deepEqual(page.errors, []);
});

test("그림: 탭 한 번에 시트 + 첫 프리셋 자동 질문 (img src·캡션·언급 문단)", async browser => {
  const page = await newPage(browser);
  await chip(page, "S2.F1").click();
  const b = await waitAsks(page, 1);
  assert.equal(b.figure_id, "S2.F1");
  assert.deepEqual(b.image_urls, [IMG + "x1.png"]);
  assert.equal(b.image_data, undefined);
  assert.match(b.selection, /^Figure 1: Architecture of the sparse mixture layer/);
  assert.equal(b.section, "2 Method");
  assert.match(b.context, /^\[첨부: 원본 이미지 1장\]/);
  assert.match(b.context, /shows the architecture/); // S2.p1이 #S2.F1을 언급
  assert.match(b.question, /무엇을 보여주는지 → 핵심 메시지 → 주의할 점·한계 → 확장 아이디어/);
  assert.deepEqual(b.history, []);
  const s = await session(page);
  assert.equal(s.endpoint, "/api/figure-explain/ask");
  assert.equal(s.title, "Figure 1 AI 설명");
  assert.deepEqual(s.presets, ["이 그림이 보여주는 것", "축·범례 읽는 법", "그림 속 글자 번역"]);
  await page.waitForFunction(() => document.querySelector("#answer .turn .a")?.textContent.includes("그림 설명입니다."));
  // 이어지는 질문도 같은 이미지·문맥 (extra 고정)
  await page.evaluate(() => PaperApp.ask("축은?"));
  const b2 = await waitAsks(page, 2);
  assert.deepEqual([b2.image_urls, b2.context, b2.history.length], [b.image_urls, b.context, 2]);
  assert.deepEqual(page.errors, []);
});

test("표·알고리즘: 이미지 없이 행 | 열, 줄 번호 포함 텍스트", async browser => {
  const page = await newPage(browser);
  await chip(page, "S2.T1").click();
  const t = await waitAsks(page, 1);
  assert.deepEqual([t.figure_id, t.image_urls, t.image_data], ["S2.T1", [], undefined]);
  assert.match(t.context, /Model \| MMLU \| GSM8K\nDense \| 61\.2 \| 40\.1\nSparse \(ours\) \| 63\.5 \| 42\.8/);
  assert.match(t.context, /improves accuracy by 2\.3 points/); // S2.p3이 #S2.T1을 언급
  assert.equal((await session(page)).presets[0], "이 표가 보여주는 것");
  assert.ok((await session(page)).presets.includes("표 수치 해석"));
  await closeSheet(page);
  await chip(page, "alg1").click();
  const a = await waitAsks(page, 2);
  assert.equal(a.figure_id, "alg1");
  assert.match(a.context, /1: Compute gate scores \$g\(x\)\$\n2: Select the two experts/);
  assert.match(a.question, /한 줄씩/);
  assert.equal((await session(page)).presets[0], "알고리즘 한 줄씩 풀이");
  assert.deepEqual(page.errors, []);
});

test("하위 패널: (b) 칩은 그 패널만, 바깥 그림은 svg 패널을 빼고 '일부 패널만 첨부'", async browser => {
  const page = await newPage(browser);
  await chip(page, "S2.F2", "(b)").click();
  const p = await waitAsks(page, 1);
  assert.deepEqual([p.figure_id, p.image_urls], ["S2.F2.sf2", []]); // x3.svg는 서버가 못 씀 → 보내지 않음
  assert.match(p.context, /^\[이미지를 첨부하지 못함/);
  assert.match(p.selection, /Figure 2: Training curves[\s\S]*\(b\) Expert load/);
  const s = await session(page);
  assert.deepEqual([s.title, s.quote, s.presets[0]], ["Figure 2 (b) AI 설명", "Figure 2 (b) Expert load", "(b) 패널이 보여주는 것"]);
  assert.ok(!s.presets.includes("그림 속 글자 번역"));
  await closeSheet(page);
  await chip(page, "S2.F2").click();
  const f = await waitAsks(page, 2);
  assert.deepEqual([f.figure_id, f.image_urls], ["S2.F2", [IMG + "x2.png"]]);
  assert.match(f.context, /\(일부 패널만 첨부\)/);
  assert.match(f.context, /shows stable training/); // S2.p3이 #S2.F2.sf1(패널)을 언급
  assert.deepEqual(page.errors, []);
});

test("TikZ(svg.ltx_picture): canvas로 그린 PNG를 보냄", async browser => {
  const page = await newPage(browser);
  await chip(page, "S2.F3").click();
  const b = await waitAsks(page, 1);
  assert.deepEqual([b.figure_id, b.image_urls], ["S2.F3", []]);
  assert.equal(b.image_data.length, 1);
  assert.match(b.image_data[0], /^data:image\/png;base64,/);
  const png = Buffer.from(b.image_data[0].split(",")[1], "base64");
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [320, 160]); // 80x40을 4배로
  assert.match(b.context, /^\[첨부: 원본 이미지 1장\]/);
  assert.match(b.context, /E1/); // 그림 속 글자도 문맥에
  assert.ok((await session(page)).presets.includes("그림 속 글자 번역"));
  assert.deepEqual(page.errors, []);
});

test("foreignObject 라벨: canvas가 막히면(Safari) 글자를 <text>로 바꿔 다시 그림", async browser => {
  const page = await newPage(browser);
  await page.evaluate(() => {
    // LaTeXML TikZ 모양: 뒤집힌 좌표계 + foreignObject 라벨(수식 포함)
    const fig = document.createElement("figure");
    fig.id = "fe-tikz";
    fig.className = "ltx_figure";
    fig.innerHTML = '<svg class="ltx_picture" height="57" overflow="visible" version="1.1" width="138"><g transform="translate(0,57) matrix(1 0 0 -1 0 0)" fill="#000000" stroke="#000000"><path d="M 0 0 L 50 0 L 50 30 Z" style="fill:none"></path><g transform="matrix(1 0 0 1 10 10)"><foreignObject width="40" height="12" transform="matrix(1 0 0 -1 0 12)" overflow="visible"><span class="ltx_text">Router <math alttext="g(x)"><mi>g</mi><annotation encoding="application/x-tex">g(x)</annotation></math></span></foreignObject></g></g></svg><figcaption class="ltx_caption">Figure 9: Router sketch.</figcaption>';
    document.getElementById("paper").append(fig);
    const srcs = window.__srcs = [];
    const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
    Object.defineProperty(HTMLImageElement.prototype, "src", { configurable: true, get: desc.get, set(v) { srcs.push(String(v)); desc.set.call(this, v); } });
    const orig = HTMLCanvasElement.prototype.toDataURL;
    let calls = 0;
    HTMLCanvasElement.prototype.toDataURL = function (...a) {
      if (!calls++) throw new DOMException("Tainted canvases may not be exported.", "SecurityError");
      return orig.apply(this, a);
    };
    document.dispatchEvent(new CustomEvent("paper:figure-explain", { detail: { figureEl: fig } }));
  });
  const b = await waitAsks(page, 1);
  const drawn = await page.evaluate(() => __srcs.filter(s => s.startsWith("data:image/svg+xml")).map(decodeURIComponent));
  assert.equal(drawn.length, 2);
  assert.match(drawn[0], /foreignObject/);
  assert.doesNotMatch(drawn[1], /foreignObject/);
  assert.match(drawn[1], /<text [^>]*transform="matrix\(1 0 0 -1 0 12\)"[^>]*>Router g<\/text>/);
  assert.equal(b.image_data.length, 1);
  assert.match(b.image_data[0], /^data:image\/png;base64,/);
  assert.match(b.selection, /Figure 9: Router sketch/);
  assert.deepEqual(page.errors, []);
});

test("paper:figure-explain 이벤트 (figure-viewer → 여기)", async browser => {
  const page = await newPage(browser);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("paper:figure-explain", { detail: { figureEl: document.querySelector('[id="S2.F1"] img') } })));
  const b = await waitAsks(page, 1);
  assert.equal(b.figure_id, "S2.F1");
  assert.equal(await page.evaluate(() => PaperApp.isSheetOpen()), true);
});

test("진짜 서버: 그린 PNG·img URL payload를 받아 스트리밍 (가짜 Claude 'ok')", async browser => {
  const page = await newPage(browser, { intercept: false });
  for (const id of ["S2.F3", "S2.F1"]) {
    await chip(page, id).click();
    await page.waitForFunction(() => {
      const a = document.querySelector("#answer .turn .a");
      return a && (a.textContent.trim() === "ok" || document.querySelector("#answer .pr-retry"));
    }, null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => !!document.querySelector("#answer .pr-retry")), false, `${id}: 서버가 거부함`);
    await closeSheet(page);
  }
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
  console.log(`figure-explain.browser.js: ${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
