// reading-settings 브라우저 확인 (헤드리스 Chromium + Playwright, 전체 기능 번들). tests/test_browser.py가 서버를 띄우고 실행:
//   node tests/browser/reading-settings.browser.js <port>
// 확인: 저장된 설정이 첫 페인트 전에 적용·시트에도 테마, peek 조작·저장·paper:settings, 헤더 자동 숨김, 문단 집중,
// 320px에서 긴 수식·표·글자 간격(WCAG 1.4.12)에도 가로 스크롤 없음, 다크에서 저자 색 보정, 화면 켜짐 유지, 넓은 화면 번역 두 칸
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
const KEY = "pr:reading-settings";

// 바깥 네트워크는 막고(그림은 같은 비율의 빈 SVG), /api/*는 빈 응답 (다른 기능의 준비 작업이 돌아도 조용히)
const IMG_SIZE = { "x1.png": [598, 300] };
async function newPage(browser, { init, viewport } = {}) {
  const ctx = await browser.newContext({ viewport: viewport || { width: 412, height: 800 }, serviceWorkers: "block" });
  await ctx.route(u => !u.href.startsWith(BASE), r => {
    if (r.request().resourceType() !== "image") return r.fulfill({ status: 200, body: "", contentType: "text/plain" });
    const [w, h] = IMG_SIZE[r.request().url().split("/").pop()] || [300, 200];
    return r.fulfill({ status: 200, body: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"/>`, contentType: "image/svg+xml" });
  });
  await ctx.route(u => u.pathname.startsWith("/api/") && !u.pathname.startsWith("/api/prewarm"),
    r => r.fulfill({ status: 503, body: "", contentType: "text/plain" }));
  if (init) await ctx.addInitScript(init.fn, init.arg);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.errors = errors;
  return page;
}
async function open(page, url = PAPER) {
  await page.goto(url);
  await page.waitForFunction(() => window.PaperApp && PaperApp.has("reading-settings") && document.readyState === "complete");
  await page.evaluate(() => {
    window.__settings = [];
    document.addEventListener("paper:settings", e => __settings.push(e.detail));
  });
}
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 5000 });
const seed = obj => ({ fn: ([k, v]) => { if (!sessionStorage.getItem("__seeded")) { localStorage.setItem(k, v); sessionStorage.setItem("__seeded", "1"); } }, arg: [KEY, JSON.stringify(obj)] });
const saved = page => page.evaluate(k => JSON.parse(localStorage.getItem(k) || "null"), KEY);

// ⋯ 메뉴 → '읽기 설정' peek
async function openPanel(page) {
  await page.click("#bar-more");
  await page.locator(".pr-menu-item", { hasText: "읽기 설정" }).click();
  await page.waitForSelector(".rs-peek .rs-panel");
}
const toggle = (page, label) => page.locator(".rs-peek .rs-toggle", { hasText: label }).locator("input");
async function slide(page, index, value) {
  await page.evaluate(([i, v]) => {
    const input = document.querySelectorAll(".rs-peek input[type=range]")[i];
    input.value = String(v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, [index, value]);
}

test("저장된 설정이 첫 페인트 전에 적용되고, 세피아는 질문 시트에도, 새로고침해도 그대로", async browser => {
  const page = await newPage(browser, { init: seed({ theme: "sepia", size: 20, lh: 1.8, margin: 24, font: "serif", justify: true }) });
  // 첫 페인트 전 적용: 문서 파싱 직후(기능 번들 전)에 이미 속성이 붙어 있어야 함
  await page.goto(PAPER, { waitUntil: "commit" });
  await page.waitForSelector("#paper");
  const early = await page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.style.getPropertyValue("--fs")]);
  assert.deepEqual(early, ["sepia", "20px"]);
  await page.waitForFunction(() => window.PaperApp && PaperApp.has("reading-settings"));
  const r = await page.evaluate(() => {
    const d = document.documentElement, p = document.querySelector("#S1\\.p1 .ltx_p"), paper = document.getElementById("paper");
    PaperApp.openSheet({ quote: "x", selection: "x" });
    const cs = getComputedStyle(p);
    return {
      attrs: [d.dataset.theme, d.dataset.font, d.dataset.justify, paper.lang],
      font: [cs.fontSize, cs.lineHeight, cs.textAlign, getComputedStyle(paper).paddingLeft],
      sheetBg: getComputedStyle(document.getElementById("sheet")).backgroundColor,
      meta: document.querySelector('meta[name="theme-color"]').content,
    };
  });
  assert.deepEqual(r.attrs, ["sepia", "serif", "1", "en"]);
  assert.deepEqual(r.font, ["20px", "36px", "justify", "24px"]);
  assert.equal(r.sheetBg, "rgb(234, 223, 198)");
  assert.equal(r.meta, "#f4ecd8");
  await page.reload();
  await page.waitForFunction(() => window.PaperApp && PaperApp.has("reading-settings"));
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "sepia");
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("peek: 테마·글자 크기·글꼴을 바꾸면 바로 적용·저장되고 paper:settings, 기본값으로 + 실행 취소", async browser => {
  const page = await newPage(browser);
  await open(page);
  await openPanel(page);
  await page.locator(".rs-peek .rs-seg button", { hasText: "다크" }).click();
  await slide(page, 0, 21);
  await page.locator(".rs-peek .rs-seg button", { hasText: "명조" }).click();
  const r = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme, fs: document.documentElement.style.getPropertyValue("--fs"),
    font: document.documentElement.dataset.font, pressed: document.querySelector('.rs-peek .rs-seg button[aria-pressed="true"]').textContent,
    bg: getComputedStyle(document.body).backgroundColor, events: __settings,
  }));
  assert.deepEqual([r.theme, r.fs, r.font, r.pressed, r.bg], ["dark", "21px", "serif", "다크", "rgb(18, 18, 18)"]);
  assert.deepEqual(r.events, [{ key: "theme", value: "dark" }, { key: "size", value: 21 }, { key: "font", value: "serif" }]);
  assert.deepEqual(await saved(page), { size: 21, lh: 1.65, theme: "dark", font: "serif", justify: false, margin: 16, wake: false, autohide: false, ruby: false, focus: false });
  await page.locator(".rs-peek .rs-reset").click();
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-theme")), false);
  assert.equal((await saved(page)).size, 17);
  await page.locator("#pr-toast button", { hasText: "실행 취소" }).click();
  assert.deepEqual([(await saved(page)).theme, (await saved(page)).size], ["dark", 21]);
  assert.equal(await page.evaluate(() => document.querySelector(".rs-peek input[type=range]").value), "21", "peek도 다시 그림");
  // 선택 버튼 토글은 PaperApp.setSelBar로 (pr:app:selbar)
  await toggle(page, "텍스트 선택 버튼").uncheck();
  assert.equal(await page.evaluate(() => localStorage.getItem("pr:app:selbar")), "false");
  // 용어 루비 토글은 glossary가 있을 때만
  await page.evaluate(() => PaperApp.registerFeature("glossary"));
  await page.keyboard.press("Escape");
  await openPanel(page);
  await toggle(page, "용어 위에 뜻 표시").check();
  assert.equal((await saved(page)).ruby, true);
  assert.deepEqual((await page.evaluate(() => __settings)).slice(-1), [{ key: "ruby", value: true }]);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("글자 크기·여백을 바꿔도 화면 맨 위의 읽던 글자가 제자리 (스크롤 고정이 없는 사파리 흉내)", async browser => {
  const page = await newPage(browser);
  await open(page);
  await page.addStyleTag({ content: "html, body, #paper, #paper * { overflow-anchor: none !important; }" });
  const at = () => page.evaluate(() => PaperAnchor.offsetsOfElement(document.getElementById("S2.p3")).start + 3);
  await page.evaluate(() => {
    const el = document.getElementById("S2.p3");
    window.scrollBy(0, el.getBoundingClientRect().top - document.getElementById("top-stack").getBoundingClientRect().bottom - 2);
  });
  await openPanel(page);
  const before = await at();
  assert.equal(typeof before, "number");
  const yOf = off => page.evaluate(o => PaperAnchor.rangeAt(o, o + 1).getClientRects()[0].top, off);
  const y0 = await yOf(before);
  await slide(page, 0, 22);
  await slide(page, 2, 30);
  const y1 = await yOf(before);
  assert.ok(Math.abs(y1 - y0) <= 3, `${y0} → ${y1}`);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("헤더 자동 숨김(PaperUI.setBarHidden)과 문단 집중", async browser => {
  const page = await newPage(browser, { init: seed({ autohide: true, focus: true }) });
  await open(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(100);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 120); await sleep(50); }
  await until(page, () => document.documentElement.classList.contains("pr-bar-hidden"));
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, -120); await sleep(50); }
  await until(page, () => !document.documentElement.classList.contains("pr-bar-hidden"));
  const f = await page.evaluate(async () => {
    document.getElementById("S2.p1").scrollIntoView({ block: "center" });
    await new Promise(r => setTimeout(r, 300));
    const cur = document.querySelector("#paper .rs-cur");
    return {
      focus: document.getElementById("paper").classList.contains("rs-focus"), n: document.querySelectorAll("#paper .rs-cur").length,
      curOpacity: cur && getComputedStyle(cur).opacity,
      farOpacity: getComputedStyle(document.getElementById("A1.p1")).opacity,
    };
  });
  assert.deepEqual([f.focus, f.n, f.curOpacity], [true, 1, "1"]);
  assert.ok(Number(f.farOpacity) < 0.5, JSON.stringify(f));
  // 끄면 헤더는 다시 보이고 흐림도 사라짐
  await openPanel(page);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 120); await sleep(30); }
  await toggle(page, "스크롤하면 헤더 숨김").uncheck();
  await toggle(page, "문단 집중").uncheck();
  const off = await page.evaluate(() => [document.documentElement.classList.contains("pr-bar-hidden"), document.querySelectorAll("#paper .rs-cur, #paper.rs-focus").length]);
  assert.deepEqual(off, [false, 0]);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("320px: 긴 수식·넓은 표·긴 줄 안 수식과 WCAG 글자 간격에도 페이지 가로 스크롤 없음, 넘치는 블록만 흐림 힌트", async browser => {
  const page = await newPage(browser, { viewport: { width: 320, height: 700 }, init: seed({ size: 22, margin: 4 }) });
  await open(page);
  await page.evaluate(async () => {
    // 테스트용으로 본문을 일부러 넓게: 긴 행렬식, 열이 많은 표, 긴 줄 안 수식
    const mrow = document.querySelector("#S2\\.E1 math mrow");
    for (let i = 0; i < 40; i++) mrow.insertAdjacentHTML("beforeend", `<mo>+</mo><msub><mi>W</mi><mn>${i}</mn></msub>`);
    const tr = document.querySelectorAll("#S2\\.T1 tr");
    tr.forEach(r => { for (let i = 0; i < 12; i++) r.insertAdjacentHTML("beforeend", `<td class="ltx_td">column${i}</td>`); });
    const p = document.querySelector("#S1\\.p1 .ltx_p");
    p.insertAdjacentHTML("beforeend", ' <math id="t-long" display="inline" alttext="a_1+a_2+a_3+a_4+a_5+a_6+a_7+a_8+a_9+a_10+a_11+a_12"><mrow>' +
      Array.from({ length: 30 }, (_, i) => `<msub><mi>a</mi><mn>${i}</mn></msub><mo>+</mo>`).join("") + "</mrow></math>");
    await new Promise(r => setTimeout(r, 600));
  });
  const probe = () => page.evaluate(() => ({
    page: document.documentElement.scrollWidth - window.innerWidth,
    body: document.body.scrollWidth - window.innerWidth,
    ovf: [...document.querySelectorAll("#paper .rs-ovf")].map(e => e.id || e.className.baseVal || e.className),
  }));
  const r = await probe();
  assert.ok(r.page <= 0 && r.body <= 0, JSON.stringify(r));
  assert.ok(r.ovf.length >= 3, JSON.stringify(r));
  assert.ok(await page.evaluate(() => document.getElementById("t-long").classList.contains("rs-wide-math")));
  // 끝까지 밀면 rs-end (오른쪽 흐림 대신 왼쪽)
  const end = await page.evaluate(async () => {
    const el = document.querySelector("#paper .rs-ovf");
    el.scrollLeft = el.scrollWidth;
    await new Promise(r => setTimeout(r, 100));
    return [el.classList.contains("rs-end"), getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage];
  });
  assert.equal(end[0], true);
  assert.match(end[1], /gradient/);
  // WCAG 1.4.12 글자 간격 북마클릿 + 설정 peek 열기
  await page.addStyleTag({ content: "* { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-bottom: 2em !important; }" });
  await openPanel(page);
  await sleep(300);
  const w = await probe();
  assert.ok(w.page <= 0 && w.body <= 0, `글자 간격 ${JSON.stringify(w)}`);
  const clipped = await page.evaluate(() => {
    const box = document.querySelector(".rs-peek").getBoundingClientRect();
    const bad = [...document.querySelectorAll(".rs-peek .rs-toggle, .rs-peek .rs-seg button, .rs-peek .rs-label")]
      .filter(e => e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().right > box.right + 1).map(e => e.textContent);
    return { bad, right: box.right, vw: window.innerWidth };
  });
  assert.deepEqual(clipped.bad, []);
  assert.ok(clipped.right <= clipped.vw);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("다크: 안 읽히는 저자 색은 밝기만 고치고(옛 style·새 --ltx-fg-color·색 상자), 라이트로 돌아가면 원래 색", async browser => {
  const page = await newPage(browser);
  await open(page);
  await page.evaluate(() => {
    document.querySelector("#S1\\.p1 .ltx_p").insertAdjacentHTML("beforeend",
      ' <span id="t-c1" class="ltx_text" style="color:#000080;">navy</span> <span id="t-c2" class="ltx_text" style="--ltx-fg-color:#000080;">var</span>' +
      ' <span id="t-c3" class="ltx_text" style="background-color:#FFFF00;">box</span> <span id="t-c4" class="ltx_text" style="color:#FF0000;">red</span>');
  });
  await openPanel(page);
  await page.locator(".rs-peek .rs-seg button", { hasText: "다크" }).click();
  const cr = () => page.evaluate(() => {
    const parse = s => s.match(/\d+/g).slice(0, 3).map(Number);
    const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const L = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const ratio = (a, b) => { const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const bodyBg = parse(getComputedStyle(document.body).backgroundColor);
    return ["t-c1", "t-c2", "t-c3", "t-c4"].map(id => {
      const el = document.getElementById(id), cs = getComputedStyle(el);
      const bg = cs.backgroundColor === "rgba(0, 0, 0, 0)" ? bodyBg : parse(cs.backgroundColor);
      return { id, color: cs.color, fixed: el.classList.contains("rs-recolor"), ratio: Math.round(ratio(parse(cs.color), bg) * 10) / 10 };
    });
  });
  const dark = await cr();
  for (const c of dark) assert.ok(c.ratio >= 4.5, JSON.stringify(dark));
  assert.deepEqual(dark.map(c => c.fixed), [true, true, true, false], "빨강은 다크 바탕에서도 대비가 충분해 그대로");
  assert.ok(dark[0].color !== "rgb(0, 0, 128)");
  await page.locator(".rs-peek .rs-seg button", { hasText: "라이트" }).click();
  const light = await cr();
  assert.deepEqual(light.map(c => [c.color, c.fixed]), [["rgb(0, 0, 128)", false], ["rgb(0, 0, 128)", false], ["rgb(26, 26, 26)", false], ["rgb(255, 0, 0)", false]]);
  // 그림: 다크·세피아에서 흰 바탕
  await page.locator(".rs-peek .rs-seg button", { hasText: "세피아" }).click();
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#paper img")).backgroundColor), "rgb(255, 255, 255)");
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("화면 켜짐 유지: 켜면 요청, 탭이 다시 보이면 다시 요청, 끄면 놓음, 실패하면 토스트·꺼짐", async browser => {
  const page = await newPage(browser, {
    init: {
      fn: () => {
        window.__wl = [];
        const fake = {
          request: async type => {
            if (window.__wlFail) throw new DOMException("no", "NotAllowedError");
            const s = new EventTarget();
            s.released = false;
            s.release = async () => { if (!s.released) { s.released = true; s.dispatchEvent(new Event("release")); } };
            window.__wl.push({ type, s });
            return s;
          },
        };
        Object.defineProperty(Navigator.prototype, "wakeLock", { get: () => fake, configurable: true });
      },
    },
  });
  await open(page);
  await openPanel(page);
  await toggle(page, "화면 켜짐 유지").check();
  await until(page, () => __wl.length === 1);
  const r = await page.evaluate(async () => {
    const first = __wl[0];
    await first.s.release(); // 탭을 떠나면 브라우저가 놓음
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise(r => setTimeout(r, 50));
    return { type: first.type, n: __wl.length };
  });
  assert.deepEqual(r, { type: "screen", n: 2 });
  await toggle(page, "화면 켜짐 유지").uncheck();
  assert.equal(await page.evaluate(() => __wl[1].s.released), true);
  assert.equal((await saved(page)).wake, false);
  await page.evaluate(() => { window.__wlFail = true; });
  await toggle(page, "화면 켜짐 유지").click(); // 요청이 실패하면 스스로 다시 꺼짐 (check()는 켜진 상태를 기대함)
  await until(page, () => /화면 켜짐 유지를 켤 수 없습니다/.test(document.getElementById("pr-toast")?.textContent || ""));
  assert.equal(await toggle(page, "화면 켜짐 유지").isChecked(), false);
  assert.equal((await saved(page)).wake, false);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("긴 수식 정리: 표 안 수식 칸은 손대지 않고, 들여쓴 줄 안 수식도 내리고, 넓어지면 흐림 클래스까지 지움", async browser => {
  const page = await newPage(browser, { viewport: { width: 320, height: 700 } });
  await open(page);
  const mk = (id, n) => `<math id="${id}" class="ltx_Math" display="inline" alttext="${"x+".repeat(20)}"><mrow>` +
    Array.from({ length: n }, (_, i) => `<msub><mi>b</mi><mn>${i}</mn></msub><mo>+</mo>`).join("") + "</mrow></math>";
  const cls = () => page.evaluate(() => Object.fromEntries(["S2.E2.m2", "t-list", "t-in"].map(id => {
    const m = document.getElementById(id), r = m.getBoundingClientRect(), pr = document.getElementById("paper").getBoundingClientRect();
    return [id, { cls: [...m.classList].filter(c => c.startsWith("rs-")).join(" "), out: r.right > pr.right + 1 }];
  })));
  await page.evaluate(async html => {
    const cell = document.getElementById("S2.E2.m2").querySelector("mrow");
    for (let i = 0; i < 30; i++) cell.insertAdjacentHTML("beforeend", `<mo>+</mo><msub><mi>c</mi><mn>${i}</mn></msub>`);
    document.querySelector("#S1\\.I1\\.i1\\.p1 .ltx_p").insertAdjacentHTML("beforeend", " " + html[0]);
    document.querySelector("#S1\\.p1 .ltx_p").insertAdjacentHTML("beforeend", " " + html[1]);
    await new Promise(r => setTimeout(r, 600));
  }, [mk("t-list", 9), mk("t-in", 12)]);
  const a = await cls();
  assert.equal(a["S2.E2.m2"].cls, "", JSON.stringify(a));
  assert.match(a["t-list"].cls, /rs-wide-math/, JSON.stringify(a));
  assert.equal(a["t-list"].out, false, JSON.stringify(a));
  assert.match(a["t-in"].cls, /rs-wide-math/, JSON.stringify(a));
  // 몇 번 다시 돌려도 그대로 (켰다 껐다 없음)
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await page.setViewportSize({ width: 321, height: 700 });
  await sleep(500);
  assert.match((await cls())["t-in"].cls, /rs-wide-math/);
  await page.setViewportSize({ width: 900, height: 700 });
  await sleep(500);
  const b = await cls();
  assert.equal(b["t-in"].cls, "", JSON.stringify(b));
  assert.equal(b["S2.E2.m2"].cls, "", JSON.stringify(b));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("숨겼다 다시 보인 짧은 수식은 자기 줄로 내리지 않음 (숨은 동안 좌표 0을 넘침으로 보지 않음)", async browser => {
  const page = await newPage(browser, { viewport: { width: 412, height: 800 } });
  await open(page);
  const cls = () => page.evaluate(() => [...document.getElementById("t-short").classList].filter(c => c.startsWith("rs-")).join(" "));
  await page.evaluate(async () => {
    document.querySelector("#S1\\.p1 .ltx_p").insertAdjacentHTML("beforeend",
      ' <math id="t-short" display="inline" alttext="a_1+b_2+c_3+d_4+e_5+f_6+g_7+h_8"><mi>a</mi><mo>+</mo><mi>b</mi></math>');
    await new Promise(r => setTimeout(r, 600));
  });
  assert.equal(await cls(), "");
  await page.evaluate(async () => {
    const p = document.querySelector("#S1\\.p1 .ltx_p");
    p.style.display = "none";
    await new Promise(r => setTimeout(r, 600));
  });
  assert.equal(await cls(), "");
  await page.evaluate(async () => {
    document.querySelector("#S1\\.p1 .ltx_p").style.display = "";
    await new Promise(r => setTimeout(r, 600));
  });
  const r = await page.evaluate(() => getComputedStyle(document.getElementById("t-short")).display);
  assert.equal(await cls(), "");
  assert.notEqual(r, "block");
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("넓은 화면 + 번역 '둘다': 원문·번역 문단이 나란히, '번역'으로 바꾸면 한 칸", async browser => {
  const page = await newPage(browser, {
    viewport: { width: 1280, height: 800 },
    init: { fn: () => localStorage.setItem("pr:section-translate:mode", JSON.stringify("both")) },
  });
  await open(page);
  const r = await page.evaluate(() => {
    const p = document.querySelector("#S1\\.p1 .ltx_p");
    const ko = document.createElement("div");
    ko.className = "tr-ko";
    ko.textContent = "대규모 언어 모델은 잘 확장되지만 밀집 계산은 늘어납니다.";
    PaperAnchor.insertUI(p, ko, "afterend");
    const a = p.getBoundingClientRect(), b = ko.getBoundingClientRect();
    const side = { sameTop: Math.abs(a.top - b.top) < 2, right: b.left >= a.right };
    document.dispatchEvent(new CustomEvent("paper:translations", { detail: { mode: "ko" } }));
    const c = ko.getBoundingClientRect(), d = p.getBoundingClientRect();
    return { side, stacked: c.top >= d.bottom - 1, both: document.documentElement.classList.contains("rs-tr-both") };
  });
  assert.deepEqual(r, { side: { sameTop: true, right: true }, stacked: true, both: false });
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
  console.log(`reading-settings.browser.js: ${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
