// equation-tools 브라우저 확인 (전체 번들, 헤드리스 Chromium). tests/test_browser.py가 서버를 띄우고 실행:
//   node tests/browser/equation-tools.browser.js <port>
"use strict";
const assert = require("node:assert/strict");

let chromium;
try { ({ chromium } = require("playwright")); } catch { console.log("SKIP playwright 없음"); process.exit(0); }

const PORT = process.argv[2];
const BASE = `http://127.0.0.1:${PORT}`;
const PAPER = `${BASE}/paper/2401.00001`;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const ALIGNED = "\\begin{aligned}\\mathcal{L} & =\\mathcal{L}_{\\text{task}}+\\alpha\\mathcal{L}_{\\text{bal}} \\\\ "
  + "\\mathcal{L}_{\\text{bal}} & =N\\sum_{i=1}^{N}f_{i}P_{i}\\end{aligned}";
const GATED = "h=\\sum_{i\\in\\mathcal{T}}g_{i}(x)E_{i}(x)";

// 바깥 네트워크는 막고(그림은 같은 비율의 빈 SVG), /api/ask는 기록 후 고정 답. 클립보드 쓰기는 기록만
async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 800 }, serviceWorkers: "block", hasTouch: false });
  await ctx.route(u => !u.href.startsWith(BASE), r => (r.request().resourceType() === "image"
    ? r.fulfill({ status: 200, body: '<svg xmlns="http://www.w3.org/2000/svg" width="598" height="300"/>', contentType: "image/svg+xml" })
    : r.fulfill({ status: 200, body: "", contentType: "text/plain" })));
  const asks = [];
  await ctx.route(`${BASE}/api/ask`, async r => {
    asks.push(JSON.parse(r.request().postData() || "{}"));
    try { await r.fulfill({ status: 200, body: "답변입니다.", contentType: "text/plain; charset=utf-8" }); } catch { /* 중단 */ }
  });
  await ctx.addInitScript(() => {
    window.__copied = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async t => { window.__copied.push(t); } } });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.asks = asks;
  page.errors = errors;
  await page.goto(PAPER);
  await page.waitForFunction(() => window.PaperApp && PaperApp.has("equation-tools") && document.readyState === "complete");
  return page;
}
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 5000 });
// 수식 표 안 내용 칸을 탭 (본문 탭 처리기 경유)
async function tapEq(page, id) {
  const cell = page.locator(`[id="${id}"] td.ltx_eqn_cell:not(.ltx_eqn_center_padleft):not(.ltx_eqn_center_padright) math`).first();
  await cell.scrollIntoViewIfNeeded();
  await cell.click();
}
const rowAfter = (page, id) => page.evaluate(i => {
  const n = document.getElementById(i).nextElementSibling;
  return n && n.classList.contains("eq-row") ? { ui: n.classList.contains("pr-ui"), labels: [...n.querySelectorAll("button")].map(b => b.textContent) } : null;
}, id);
const clickRow = (page, label) => page.locator(".eq-row button", { hasText: label }).first().click();

test("수식 탭 → 도구 줄(.pr-ui), 다시 탭하면 닫힘, 다른 수식을 탭하면 옮겨감, 색인은 그대로", async browser => {
  const page = await newPage(browser);
  const text0 = await page.evaluate(() => PaperAnchor.index().text);
  await tapEq(page, "S2.E1");
  assert.deepEqual(await rowAfter(page, "S2.E1"), { ui: true, labels: ["수식 설명", "LaTeX 복사", "$$ ▾", "기호만", "전체 화면", "✕"] });
  assert.equal(await page.evaluate(() => document.getElementById("S2.E1").classList.contains("eq-active")), true);
  assert.equal(await page.evaluate(() => PaperAnchor.index().text), text0);
  await tapEq(page, "S2.EGx1");
  assert.equal(await rowAfter(page, "S2.E1"), null);
  assert.ok(await rowAfter(page, "S2.EGx1"));
  await tapEq(page, "S2.EGx1");
  assert.equal(await page.evaluate(() => document.querySelectorAll(".eq-row, .eq-active").length), 0);
  // 선택이 있으면 탭해도 열리지 않음 (선택 중 탭은 선택 처리기 몫)
  await page.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector("#S2\\.p2 .ltx_p")); getSelection().removeAllRanges(); getSelection().addRange(r); });
  await tapEq(page, "S2.Ex1");
  assert.equal(await page.evaluate(() => document.querySelectorAll(".eq-row").length), 0);
  assert.deepEqual(page.errors, []);
});

test("수식 설명: align 묶음은 aligned LaTeX 그대로 $$…$$, 번호·앞뒤 문단·섹션, 기호별 풀이 자동 질문, 시트는 안 내려감", async browser => {
  const page = await newPage(browser);
  await tapEq(page, "S2.EGx1");
  await clickRow(page, "수식 설명");
  await until(page, () => PaperApp.session && PaperApp.session.history.length === 2);
  const a = page.asks[0];
  assert.equal(a.selection, `$$${ALIGNED}$$`);
  assert.match(a.question, /^이 수식을 표로: 기호 \| 의미 \| 처음 정의된 곳/);
  assert.equal(a.section, "2 Method");
  assert.ok(a.context.startsWith("The training loss combines the task loss and a balancing term:\n[이 수식 (2), (3)]\nwhere $\\alpha$ is a small"), a.context);
  assert.ok(a.context.length <= 1500);
  const s = await page.evaluate(() => ({
    quote: PaperApp.session.quote, title: document.getElementById("sheet-title").textContent,
    presets: [...document.querySelectorAll("#presets button")].map(b => b.textContent),
    sheet: !document.getElementById("sheet").hidden, pill: !document.getElementById("sheet-pill").hidden,
  }));
  assert.deepEqual(s, { quote: "Eq. (2), (3)", title: "수식 설명", presets: ["기호별 풀이", "직관적으로", "유도 과정", "기호만"], sheet: true, pill: false });
  // 한 줄 수식 + '기호만'
  await page.evaluate(() => PaperApp.closeSheet());
  await tapEq(page, "S2.E1");
  await clickRow(page, "기호만");
  await until(page, () => PaperApp.session && PaperApp.session.history.length === 2);
  assert.equal(page.asks[1].selection, "$$g(x)=\\mathrm{softmax}(W_{g}x)$$");
  assert.match(page.asks[1].question, /기호만/);
  assert.equal(await page.evaluate(() => [PaperApp.session.quote, PaperApp.session.meta[0].presetId]).then(x => x.join("|")), "Eq. (1)|equation-tools:legend");
  assert.deepEqual(page.errors, []);
});

test("LaTeX 복사: 기본 $$…$$, 형식 peek에서 \\[…\\]로 바꾸면 저장되고 다음 복사에 적용", async browser => {
  const page = await newPage(browser);
  await tapEq(page, "S2.Ex1");
  await clickRow(page, "LaTeX 복사");
  await until(page, () => window.__copied.length === 1);
  assert.equal(await page.evaluate(() => window.__copied[0]), `$$${GATED}$$`);
  await until(page, () => document.getElementById("pr-toast")?.textContent.includes("LaTeX 복사됨"));
  await page.click(".eq-row .eq-delim");
  await page.locator(".eq-delims button", { hasText: "\\[…\\]" }).click();
  const after = await page.evaluate(() => ({
    stored: localStorage.getItem("pr:equation-tools:delim"), chip: document.querySelector(".eq-delim").textContent,
    peek: !!document.querySelector(".pr-peek"),
  }));
  assert.deepEqual(after, { stored: JSON.stringify("\\["), chip: "\\[ ▾", peek: false });
  await clickRow(page, "LaTeX 복사");
  await until(page, () => window.__copied.length === 2);
  assert.equal(await page.evaluate(() => window.__copied[1]), `\\[${GATED}\\]`);
  assert.deepEqual(page.errors, []);
});

test("본문 선택 복사: 인라인 수식은 $alttext$, 수식 표는 aligned 한 줄, 수식 없는 선택은 기본 복사", async browser => {
  const page = await newPage(browser);
  const r = await page.evaluate(() => {
    const copy = range => {
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(range);
      const dt = new DataTransfer();
      const ev = new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true });
      document.getElementById("paper").dispatchEvent(ev);
      // text/html은 붙여넣는 앱처럼 파싱해서 구조만 비교
      const html = dt.getData("text/html");
      const doc = new DOMParser().parseFromString(html, "text/html");
      return {
        text: dt.getData("text/plain"), prevented: ev.defaultPrevented, meta: html.startsWith('<meta charset="utf-8">'),
        body: doc.body.textContent, divs: [...doc.body.querySelectorAll("div")].map(d => d.textContent),
        math: doc.querySelectorAll("math").length, attrs: doc.body.querySelectorAll("[id], [class], [data-id]").length,
        links: [...doc.querySelectorAll("a")].map(a => a.getAttribute("href")),
        styled: [...doc.body.querySelectorAll("[style]")].map(e => [e.localName, e.getAttribute("style"), e.textContent.slice(0, 16)]),
        rows: [...doc.querySelectorAll("table > tbody > tr")].map(tr => [...tr.cells].map(c => c.textContent)),
      };
    };
    const para = document.getElementById("S2.p2");
    const whole = document.createRange();
    whole.setStart(para.querySelector(".ltx_p").firstChild, 4);
    whole.setEndAfter(para.querySelector('[id="S2.Ex1"]'));
    const inline = document.createRange();
    const p1 = document.querySelector("#S1\\.p1 .ltx_p");
    inline.setStart(p1.firstChild, p1.firstChild.data.indexOf("grows"));
    inline.setEnd(p1.childNodes[4], 1);
    const inMath = document.createRange();
    inMath.selectNodeContents(document.querySelector("#S2\\.E3 math mi"));
    const plain = document.createRange();
    plain.selectNodeContents(document.querySelector("#S1\\.p3 .ltx_p"));
    const links = document.createRange();
    links.selectNodeContents(document.querySelector("#S1\\.p1 .ltx_p"));
    const thm = document.createRange();
    thm.selectNodeContents(document.getElementById("Thmtheorem1"));
    // 공통 조상이 표의 한 행(tr)이어도 HTML은 table > tbody > tr로 감쌈 (고아 tr이면 붙여넣을 때 표가 사라짐)
    const row = document.querySelector('[id="S2.T1"] tbody tr');
    row.cells[1].insertAdjacentHTML("beforeend", '<math alttext="\\pm 0.1" display="inline"><mi>y</mi></math>');
    const cells = document.createRange();
    cells.setStart(row.cells[0].firstChild, 0);
    cells.setEnd(row.cells[2].firstChild, 4);
    return { whole: copy(whole), inline: copy(inline), inMath: copy(inMath), plain: copy(plain), links: copy(links), thm: copy(thm),
      cells: copy(cells), href: location.origin + location.pathname };
  });
  assert.equal(r.whole.text, `training loss combines the task loss and a balancing term:\n\n$$${ALIGNED}$$\n\n`
    + "where $\\alpha$ is a small coefficient. The layer output is the gated sum\n\n$$" + GATED + "$$");
  assert.equal(r.inline.text, "grows as $x^{2}$ for a model of width $x$.");
  assert.equal(r.inMath.text, `$$${ALIGNED}$$`);
  assert.deepEqual([r.plain.text, r.plain.prevented, r.plain.body], ["", false, ""]);
  assert.ok(r.whole.prevented && !/ℒ|α/.test(r.whole.text));
  // text/html도 같이 (기본 복사를 막으면 브라우저 HTML이 사라짐): 수식은 LaTeX 글자, 블록 수식은 div 한 줄, id·class 없음
  assert.ok(r.whole.meta);
  assert.deepEqual(r.whole.divs, [`$$${ALIGNED}$$`, `$$${GATED}$$`]);
  assert.deepEqual([r.whole.math, r.whole.attrs], [0, 0]);
  assert.match(r.whole.body, /^training loss combines .*where \$\\alpha\$ is a small coefficient\. The layer output is the gated sum/s);
  assert.equal(r.inline.body, "grows as $x^{2}$ for a model of width $x$.");
  assert.equal(r.inMath.body, `$$${ALIGNED}$$`);
  // 링크는 절대 주소로 (다른 앱에 붙여도 동작), 기울임은 인라인 스타일로
  assert.ok(r.links.prevented && r.links.links.length >= 3, JSON.stringify(r.links.links));
  assert.ok(r.links.links.every(u => /^https?:\/\//.test(u)), JSON.stringify(r.links.links));
  assert.ok(r.links.links.includes(`${r.href}#bib.bib1`) && r.links.links.includes("https://github.com/example/sparse-moe"));
  assert.ok(r.links.body.includes("grows as $x^{2}$ for a model of width $x$."));
  assert.equal(r.thm.math, 0);
  assert.deepEqual(r.thm.styled.filter(x => x[1] === "font-style:italic"), [["span", "font-style:italic", "If every expert "]]);
  assert.ok(r.thm.body.includes("is minimized when $f_{i}=1/N$."), r.thm.body);
  assert.equal(r.cells.text, "Dense 61.2$\\pm 0.1$ 40.1");
  assert.deepEqual(r.cells.rows, [["Dense", "61.2$\\pm 0.1$", "40.1"]]);
  assert.deepEqual(page.errors, []);
});

test("전체 화면: 너비에 맞춤, ＋는 1.25배, 뒤로(Esc) 닫힘, 수식 설명은 시트로", async browser => {
  const page = await newPage(browser);
  await tapEq(page, "S2.EGx1");
  await clickRow(page, "전체 화면");
  await until(page, () => document.querySelector(".eq-full-peek .eq-stage")?.style.getPropertyValue("--eq-s"));
  const fit = await page.evaluate(() => {
    const st = document.querySelector(".eq-stage"), t = st.firstElementChild;
    return {
      s: Number(st.style.getPropertyValue("--eq-s")), ids: document.querySelectorAll(".eq-stage [id]").length,
      fits: t.getBoundingClientRect().width <= st.clientWidth, title: document.querySelector(".eq-full-peek .pr-peek-head b").textContent,
      clone: t.matches("table.ltx_equationgroup"),
    };
  });
  assert.ok(fit.s > 0.3 && fit.s <= 3, String(fit.s));
  assert.deepEqual({ ...fit, s: 0 }, { s: 0, ids: 0, fits: true, title: "Eq. (2), (3)", clone: true });
  await page.click('.eq-full-tools button[aria-label="확대"]');
  const s2 = await page.evaluate(() => Number(document.querySelector(".eq-stage").style.getPropertyValue("--eq-s")));
  assert.ok(Math.abs(s2 - Math.min(6, fit.s * 1.25)) < 0.01, `${fit.s} → ${s2}`);
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => !!document.querySelector(".eq-full-peek")), false);
  await clickRow(page, "전체 화면");
  await page.locator(".eq-full-tools button", { hasText: "수식 설명" }).click();
  await until(page, () => PaperApp.session && PaperApp.session.history.length === 2);
  assert.equal(await page.evaluate(() => !!document.querySelector(".eq-full-peek")), false);
  assert.equal(page.asks[0].selection, `$$${ALIGNED}$$`);
  assert.deepEqual(page.errors, []);
});

test("답변 속 KaTeX 탭 → LaTeX 복사 (블록 $$…$$, 인라인 $…$), 선택 중이면 복사 안 함", async browser => {
  const page = await newPage(browser);
  await page.evaluate(() => {
    PaperApp.openSheet({ quote: "x", selection: "x" });
    const k = (tex, display) => `<span class="${display ? "katex-display" : ""}"><span class="katex"><span class="katex-mathml"><math><semantics><mi>x</mi><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">${tex}</span></span></span>`;
    const div = document.createElement("div");
    div.className = "a";
    div.innerHTML = `<p>식 ${k("a+b", false)} 그리고</p>${k("\\frac{a}{b}", true)}`;
    document.getElementById("answer").append(div);
  });
  await page.locator(".answer .katex-display .katex-html").click();
  await page.locator(".answer p .katex-html").click();
  await until(page, () => window.__copied.length === 2);
  assert.deepEqual(await page.evaluate(() => window.__copied), ["$$\\frac{a}{b}$$", "$a+b$"]);
  // 선택이 남아 있는 상태의 탭 (실제 탭은 mousedown에서 선택이 풀리므로 click만 보냄)
  await page.evaluate(() => {
    const r = document.createRange();
    r.selectNodeContents(document.querySelector(".answer p"));
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    document.querySelector(".answer p .katex-html").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  assert.equal(await page.evaluate(() => window.__copied.length), 2);
  // 실제 탭 순서: 끌어서 고른 뒤 수식을 탭해 선택을 푸는 탭 → 복사하지 않음 (누를 때 선택이 있었음)
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.waitForTimeout(450); // justSelected() 창이 지나도록
  const p = await page.locator(".answer p").boundingBox();
  await page.mouse.move(p.x + 1, p.y + 4);
  await page.mouse.down();
  await page.mouse.move(p.x + 14, p.y + 4, { steps: 4 });
  await page.mouse.up();
  assert.ok(await page.evaluate(() => getSelection().toString().length > 0));
  await page.locator(".answer p .katex-html").click();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__copied.length), 2);
  // 선택이 풀린 뒤의 보통 탭은 다시 복사
  await page.waitForTimeout(450);
  await page.locator(".answer p .katex-html").click();
  await until(page, () => window.__copied.length === 3);
  // iOS WebKit은 document 리스너만으로는 click을 안 보냄 → 조상에 cursor: pointer가 있어야 함 (copy는 안 됨)
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".answer .katex, .answer .katex-html")].map(e => getComputedStyle(e).cursor)),
    ["pointer", "pointer", "pointer", "pointer"]);
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
  console.log(`equation-tools.browser.js: ${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
