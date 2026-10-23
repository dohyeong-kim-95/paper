// figure-explain: 그림·표·알고리즘마다 'AI 설명' 칩 → 원본 이미지(비전)·캡션·인용 문단으로 바로 질문
(function () {
  "use strict";
  // ---------- 순수 함수 (node 테스트 대상) ----------
  const ENDPOINT = "/api/figure-explain/ask";
  const MAX_IMAGES = 4; // 서버 상한과 같게 (URL + 그린 이미지)
  const MAX_SVGS = 2; // TikZ(svg.ltx_picture)를 그려 보낼 최대 개수
  const MAX_CONTEXT = 2500;
  const RASTER_MAX = 220000; // 그린 PNG의 data URL 길이 상한 (대화 저장 공간까지 생각해 작게)
  const KIND_NAME = { figure: "그림", table: "표", algorithm: "알고리즘", listing: "코드" };
  const BODY_LABEL = { figure: "그림 안 글자", table: "표 내용 (열은 | 로 구분)", algorithm: "알고리즘 (줄 번호 포함)", listing: "코드" };

  const P = (id, label, q) => ({ id: `figure-explain:${id}`, label, q });
  const WHAT = "무엇을 보여주는지 → 핵심 메시지 → 주의할 점·한계 → 확장 아이디어 순서로 짧게 설명해줘";
  const OCR = P("ocr", "그림 속 글자 번역", "첨부한 그림 안의 글자(축 이름·눈금 단위·범례·라벨·주석)를 빠짐없이 찾아 「원문 → 한국어」 목록으로 번역해줘. 약어는 풀어서");

  // 종류별 프리셋. 첫 번째를 자동으로 물음. '그림 속 글자 번역'은 이미지를 첨부했을 때만 (비전)
  function presetsFor(kind, { hasImage = false, panel = "" } = {}) {
    let list;
    if (panel) {
      list = [
        P("panel", `${panel} 패널이 보여주는 것`, `${panel} 패널만 보고: ${WHAT}`),
        P("axes", "축·범례 읽는 법", `${panel} 패널의 축·범례·색·기호를 읽는 법을 알려줘`),
        P("whole", "전체 그림과의 관계", `${panel} 패널이 같은 그림의 다른 패널·논문 주장과 어떻게 연결되는지 짧게 알려줘`),
      ];
    } else if (kind === "table") {
      list = [
        P("what", "이 표가 보여주는 것", `이 표가 ${WHAT}`),
        P("numbers", "표 수치 해석", "표의 수치를 해석해줘: 가장 좋은·나쁜 값, 차이의 크기와 의미, 눈여겨볼 행·열, 굵은 글씨·밑줄 표시의 뜻"),
        P("cols", "열·기호 읽는 법", "표의 행·열 이름, 약어, 화살표(↑↓)·± 같은 기호를 읽는 법을 알려줘"),
      ];
    } else if (kind === "algorithm" || kind === "listing") {
      const name = KIND_NAME[kind];
      list = [
        P("lines", `${name} 한 줄씩 풀이`, `이 ${name}을 줄 번호 순서로 한 줄씩 쉽게 풀이해줘. 기호의 뜻과 각 줄이 왜 필요한지도 짧게`),
        P("io", "입력·출력·복잡도", `이 ${name}의 입력·출력, 핵심 아이디어, 계산 비용(복잡도)을 짧게 정리해줘`),
        P("link", "본문 수식과 연결", `이 ${name}의 각 단계가 본문의 어느 수식·설명과 대응하는지 알려줘`),
      ];
    } else {
      list = [
        P("what", "이 그림이 보여주는 것", `이 그림이 ${WHAT}`),
        P("axes", "축·범례 읽는 법", "이 그림의 축·범례·색·기호를 읽는 법을 알려줘"),
      ];
    }
    if (hasImage && kind !== "algorithm" && kind !== "listing") list.push(OCR);
    return list;
  }

  // 클래스 목록 → 종류
  function figureKind(cls, hasListing = false) {
    const c = ` ${cls || ""} `;
    if (c.includes(" ltx_float_algorithm ")) return "algorithm";
    if (c.includes(" ltx_table ")) return "table";
    if (hasListing || /\sltx_float_(lst)?listing\s/.test(c)) return "listing";
    return "figure";
  }

  // 서버가 가져올 수 있는 img인지 (svg는 서버가 건너뜀 → 보내지 않아 매번 헛걸음하지 않게)
  const isFetchable = src => /^https?:\/\//i.test(src || "") && !/\.svgz?(?:[?#]|$)/i.test(src);

  // [{src, area}] → 가져올 수 있는 것 중 넓이가 큰 max개 (문서 순서 유지). skipped: 못 보낸 img 수
  function pickPanels(imgs, max = MAX_IMAGES) {
    const ok = imgs.map((x, i) => ({ ...x, i })).filter(x => isFetchable(x.src));
    const keep = ok.length > max ? ok.slice().sort((a, b) => (b.area || 0) - (a.area || 0) || a.i - b.i).slice(0, max).sort((a, b) => a.i - b.i) : ok;
    const urls = [...new Set(keep.map(x => x.src))];
    return { urls, skipped: imgs.length - urls.length };
  }

  // 표 → "열 | 열" 줄들 (빈 줄 제외)
  const tableText = rows => rows.map(r => r.map(c => String(c || "").trim()).join(" | ")).filter(r => r.replace(/[|\s]/g, "")).join("\n");

  // 패널 이름: 캡션 태그 "(a) " → "(a)", 없으면 순서로 (a)(b)…
  function panelLabel(tag, i) {
    const m = String(tag || "").match(/\(([^)]{1,4})\)/);
    if (m) return `(${m[1]})`;
    return i >= 0 ? `(${String.fromCharCode(97 + (i % 26))})` : "(패널)";
  }

  const clip = (s, n) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s);
  // needle 둘레만 남기기 (언급한 문장이 잘리지 않게)
  function around(text, needle, n) {
    if (text.length <= n) return text;
    const at = needle ? text.indexOf(needle) : -1;
    const from = Math.max(0, Math.min(text.length - n, at < 0 ? 0 : at - Math.floor(n / 3)));
    return (from > 0 ? "…" : "") + text.slice(from, from + n) + (from + n < text.length ? "…" : "");
  }

  // 질문 문맥 (≤max자): 첨부 메모 → 그림 본문(표 행·알고리즘 줄·그림 속 글자) → 이 그림을 언급한 문단(≤3)
  function buildContext({ note = "", label = "그림 내용", content = "", refs = [] } = {}, max = MAX_CONTEXT) {
    const out = [];
    const used = () => out.join("\n\n").length + (out.length ? 2 : 0);
    if (note) out.push(clip(note, 300));
    const refs3 = refs.filter(r => r && r.text).slice(0, 3);
    if (content) out.push(`[${label}]\n` + clip(content, Math.max(80, (refs3.length ? Math.min(1500, max - 600) : max) - used() - label.length - 3)));
    if (refs3.length) {
      const head = "[이 그림을 언급한 본문]";
      const each = Math.floor((max - used() - head.length - 1) / refs3.length) - 4;
      if (each >= 60) out.push(head + "\n" + refs3.map(r => "- " + around(r.text, r.needle, each)).join("\n"));
    }
    return clip(out.join("\n\n"), max);
  }

  // 그릴 크기: 긴 변 maxSide 이하, 작은 그림은 최대 maxScale배까지 키움 (벡터라 손실 없음)
  const fitScale = (w, h, maxSide = 1000, maxScale = 4) => Math.min(maxScale, maxSide / Math.max(w || 1, h || 1, 1));

  const api = { ENDPOINT, MAX_IMAGES, presetsFor, figureKind, isFetchable, pickPanels, tableText, panelLabel, around, buildContext, fitScale };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;
  if (document.body.dataset.page !== "paper") return;
  PaperApp.registerFeature("figure-explain", api);

  // ---------- DOM ----------
  const paper = document.getElementById("paper");
  if (!paper) return;
  const A = window.PaperAnchor, UI = window.PaperUI, h = UI.h;
  const SVGNS = "http://www.w3.org/2000/svg";
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const outside = el => !el.closest(".pr-ui, .tr-ko");
  const topOf = el => { let t = el; for (let p = el.parentElement && el.parentElement.closest("figure"); p; p = p.parentElement && p.parentElement.closest("figure")) t = p; return t; };
  const topFigures = () => [...paper.querySelectorAll("figure[id]")].filter(f => outside(f) && !(f.parentElement && f.parentElement.closest("figure")));
  // 바로 아래 단계의 하위 그림(패널)
  const panelsOf = fig => [...fig.querySelectorAll("figure")].filter(p => outside(p) && p.parentElement.closest("figure") === fig);
  const ownCaption = fig => [...fig.children].find(c => c.localName === "figcaption") || [...fig.querySelectorAll("figcaption")].find(c => c.closest("figure") === fig) || null;
  const captionOf = fig => { const c = ownCaption(fig); return c ? A.textOf(c) : ""; };
  function tagOf(fig) {
    const c = ownCaption(fig), t = c && c.querySelector(".ltx_tag");
    return t ? A.textOf(t).replace(/[\s:.]+$/, "") : "";
  }
  function sectionOf(fig) {
    const sec = fig.closest("section"), t = sec && [...sec.children].find(c => c.classList.contains("ltx_title"));
    return t ? A.textOf(t) : "";
  }

  // 이 그림(또는 그 패널: S2.F2.sf1)을 링크로 언급한 문단 ≤3
  function refsTo(ids, fig) {
    const seen = new Set(), out = [];
    for (const a of paper.querySelectorAll('a[href^="#"]')) {
      const id = a.getAttribute("href").slice(1);
      if (!ids.some(x => id === x || id.startsWith(x + ".")) || !outside(a) || fig.contains(a)) continue;
      const p = a.closest(".ltx_para, p");
      if (!p || seen.has(p)) continue;
      seen.add(p);
      out.push({ text: A.textOf(p), needle: A.textOf(a) });
      if (out.length >= 3) break;
    }
    return out;
  }

  // 그림 본문: 표는 행 | 열, 알고리즘·코드는 줄, 그 밖(TikZ 라벨 등)은 캡션을 뺀 글자
  function bodyText(el, kind) {
    if (kind === "table") {
      const rows = [...el.querySelectorAll("tr")].filter(outside).slice(0, 80)
        .map(tr => [...tr.children].filter(c => c.localName === "td" || c.localName === "th").map(c => A.textOf(c)));
      const t = tableText(rows);
      if (t) return t;
    }
    if (kind === "algorithm" || kind === "listing") {
      const lines = [...el.querySelectorAll(".ltx_listingline")].filter(outside).map(l => {
        const t = A.textOf(l), tag = l.querySelector(".ltx_tag"), n = tag ? A.textOf(tag) : "";
        return n && t.startsWith(n) ? `${n} ${t.slice(n.length).trim()}` : t; // "1:Compute" → "1: Compute"
      }).filter(Boolean);
      if (lines.length) return lines.join("\n");
    }
    const cap = captionOf(el);
    return A.textOf(el).replace(cap, "").trim();
  }

  // ---------- TikZ(svg) → PNG: canvas에 그려 base64로 (서버는 SVG를 못 그림) ----------
  const raster = new Map(); // svg → Promise<dataURL|null> (같은 그림은 같은 바이트 → 서버 쪽 대화 캐시 적중)
  const num = v => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : 0; };
  function svgSize(svg) {
    const vb = svg.viewBox && svg.viewBox.baseVal, r = svg.getBoundingClientRect();
    return [num(svg.getAttribute("width")) || (vb && vb.width) || r.width, num(svg.getAttribute("height")) || (vb && vb.height) || r.height];
  }
  // plain: Safari는 foreignObject(LaTeXML의 글자 라벨)가 있으면 canvas를 막음 → 라벨을 SVG <text>로 바꿔 다시
  function svgSource(svg, w, hh, W, H, plain) {
    const c = svg.cloneNode(true);
    if (!c.getAttribute("viewBox")) c.setAttribute("viewBox", `0 0 ${w} ${hh}`);
    c.setAttribute("width", W);
    c.setAttribute("height", H);
    c.removeAttribute("style");
    c.querySelectorAll(".pr-ui").forEach(x => x.remove());
    if (plain) {
      for (const fo of c.querySelectorAll("foreignObject")) {
        const fh = num(fo.getAttribute("height")) || 10;
        const t = document.createElementNS(SVGNS, "text");
        t.setAttribute("x", fo.getAttribute("x") || "0");
        t.setAttribute("y", String((num(fo.getAttribute("y")) || 0) + fh * 0.8));
        t.setAttribute("font-size", String(Math.max(6, Math.min(fh, 16))));
        t.setAttribute("font-family", "serif");
        if (fo.getAttribute("transform")) t.setAttribute("transform", fo.getAttribute("transform"));
        fo.querySelectorAll("annotation, annotation-xml").forEach(x => x.remove());
        t.textContent = fo.textContent.replace(/\s+/g, " ").trim();
        fo.replaceWith(t);
      }
    }
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(c));
  }
  const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  async function drawSvg(svg, plain) {
    const [w, hh] = svgSize(svg);
    if (!w || !hh) return null;
    const s = fitScale(w, hh), W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(hh * s));
    const img = await loadImg(svgSource(svg, w, hh, W, H, plain));
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const g = cv.getContext("2d");
    g.fillStyle = "#fff"; // 투명 배경 → 흰색 (어두운 테마와 무관하게)
    g.fillRect(0, 0, W, H);
    g.drawImage(img, 0, 0, W, H);
    let url = cv.toDataURL("image/png"); // 막힌 canvas면 SecurityError → plain으로 다시
    if (url.length > RASTER_MAX) url = cv.toDataURL("image/jpeg", 0.85);
    return url.length > RASTER_MAX ? null : url;
  }
  function rasterize(svg) {
    if (!raster.has(svg)) raster.set(svg, drawSvg(svg, false).catch(() => drawSvg(svg, true)).catch(() => null));
    return Promise.race([raster.get(svg), sleep(1500).then(() => null)]); // 늦으면 텍스트만으로
  }

  // 보낼 이미지: img src(getAttribute 그대로: 서버가 논문 HTML의 값과 비교) 큰 것부터 ≤4, 남는 자리에 TikZ 그림 ≤2
  async function imagesOf(el) {
    const imgs = [...el.querySelectorAll("img")].filter(outside).map(i => ({
      src: i.getAttribute("src") || "",
      area: (i.naturalWidth * i.naturalHeight) || (num(i.getAttribute("width")) * num(i.getAttribute("height"))),
    }));
    const { urls, skipped } = pickPanels(imgs);
    const svgs = [...el.querySelectorAll("svg")].filter(s => outside(s) && !(s.parentElement && s.parentElement.closest("svg")));
    const room = Math.min(MAX_SVGS, MAX_IMAGES - urls.length);
    const data = (await Promise.all(svgs.slice(0, Math.max(0, room)).map(rasterize))).filter(Boolean);
    return { urls, data, partial: skipped > 0 || svgs.length > data.length, total: imgs.length + svgs.length };
  }

  // 그림(또는 패널)을 설명: 시트 열고 첫 프리셋을 바로 물음
  async function explain(el) {
    const top = topOf(el);
    const isPanel = el !== top;
    const cls = top.getAttribute("class") || "";
    const kind = figureKind(cls, !!top.querySelector(".ltx_listing"));
    const tag = tagOf(top) || KIND_NAME[kind];
    const label = isPanel ? panelLabel(tagOf(el), panelsOf(top).indexOf(el)) : "";
    const { urls, data, partial, total } = await imagesOf(el);
    const n = urls.length + data.length;
    const note = n
      ? `[첨부: ${isPanel ? `${label} 패널의 ` : ""}원본 이미지 ${n}장${partial ? " (일부 패널만 첨부)" : ""}]`
      : (total ? "[이미지를 첨부하지 못함: 캡션과 본문으로만 판단]" : "");
    const mainCap = captionOf(top), cap = isPanel ? captionOf(el) : mainCap;
    const presets = presetsFor(kind, { hasImage: n > 0, panel: label });
    const ids = [top.id, el.id].filter(Boolean);
    PaperApp.openSheet({
      title: `${tag}${label ? " " + label : ""} AI 설명`,
      quote: isPanel ? `${tag} ${cap}` : (cap || tag),
      selection: isPanel ? `${mainCap}\n${cap}`.trim() : (mainCap || tag),
      context: buildContext({ note, label: BODY_LABEL[kind], content: bodyText(el, kind), refs: refsTo([...new Set(ids)], top) }),
      section: sectionOf(top),
      endpoint: ENDPOINT,
      extra: { figure_id: el.id || top.id, image_urls: urls, ...(data.length ? { image_data: data } : {}) },
      presets,
      autoAsk: presets[0],
      origin: "figure-explain",
    });
  }

  async function run(btn, el) {
    if (btn.getAttribute("aria-busy") === "true") return;
    btn.setAttribute("aria-busy", "true");
    try { await explain(el); } catch (e) { console.error("[figure-explain]", e); UI.toast("그림 설명을 열지 못했습니다"); }
    btn.removeAttribute("aria-busy");
  }

  // 칩: 바깥쪽 그림에만 하나 (하위 패널 중복 없음), 패널이 둘 이상이면 (a)(b)… 칩도
  function addChips(fig) {
    if (!fig.id || [...fig.children].some(c => c.classList.contains("fe-chips"))) return;
    const tag = tagOf(fig) || KIND_NAME[figureKind(fig.getAttribute("class"), !!fig.querySelector(".ltx_listing"))];
    const panels = panelsOf(fig);
    const chip = (text, aria, el, extra = "") => h("button", {
      type: "button", class: `fe-chip${extra}`, text, "aria-label": aria, onclick: e => run(e.currentTarget, el),
    });
    const row = h("div", { class: "fe-chips" },
      chip("AI 설명", `${tag} AI 설명`, fig),
      panels.length >= 2 ? panels.map((p, i) => { const l = panelLabel(tagOf(p), i); return chip(l, `${tag} ${l} 패널 AI 설명`, p, " fe-panel"); }) : null);
    fig.classList.add("fe-has");
    A.insertUI(fig, row, "beforeend");
  }
  topFigures().forEach(addChips);

  // figure-viewer의 'AI 설명' → 여기서 처리 (viewer는 시트가 열리며 닫힘)
  PaperApp.on("figure-explain", d => {
    let el = d && d.figureEl;
    if (el && !paper.contains(el) && el.id) el = document.getElementById(el.id);
    el = el && el.closest ? el.closest("figure") : null;
    if (el && paper.contains(el)) explain(el).catch(e => console.error("[figure-explain]", e));
  });
})();
