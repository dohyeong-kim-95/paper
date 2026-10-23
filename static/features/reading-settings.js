// reading-settings: 읽기 설정(Aa) — 글자 크기·줄 간격·여백·테마(세피아/다크)·글꼴·양쪽 정렬·문단 집중·헤더 자동 숨김·화면 켜짐 유지
(function () {
  "use strict";

  // ---------- 순수 함수 (node 테스트 대상) ----------
  // 기본값은 style.css 기본값과 같게 (--fs 17px, --lh 1.65, --margin 16px). 모양은 docs/FEATURES.md §6 (+ focus)
  const DEFAULTS = Object.freeze({
    size: 17, lh: 1.65, theme: "system", font: "sans", justify: false, margin: 16,
    wake: false, autohide: false, ruby: false, focus: false,
  });
  const RANGE = { size: [14, 22, 1], lh: [1.5, 2, 0.05], margin: [4, 40, 2] }; // [최소, 최대, 눈금]
  const THEMES = ["system", "light", "dark", "sepia"];
  const FONTS = ["sans", "serif"];
  const FLAGS = ["justify", "wake", "autohide", "ruby", "focus"];

  // 범위·눈금 맞추기. 문자열 숫자도 받고, 숫자가 아니면 기본값
  function clampNum(v, [lo, hi, step], dflt) {
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n)) return dflt;
    const c = Math.min(hi, Math.max(lo, n));
    return Math.round(Math.round(c / step) * step * 100) / 100;
  }
  // 저장값(가져오기·옛 버전 포함) → 빠진 것은 기본값, 범위 밖은 잘라냄, 모르는 키는 버림
  function clampSettings(s) {
    const src = s && typeof s === "object" ? s : {};
    const out = { ...DEFAULTS };
    for (const k of Object.keys(RANGE)) out[k] = clampNum(src[k], RANGE[k], DEFAULTS[k]);
    if (THEMES.includes(src.theme)) out.theme = src.theme;
    if (FONTS.includes(src.font)) out.font = src.font;
    for (const k of FLAGS) out[k] = src[k] === true || src[k] === 1 || src[k] === "1" || src[k] === "true";
    return out;
  }

  // 색 문자열 → [r, g, b] | null (#rgb, #rrggbb(aa), rgb()/rgba(), 흔한 이름). 투명이면 null
  const NAMED = {
    black: "#000", white: "#fff", red: "#f00", green: "#008000", blue: "#00f", yellow: "#ff0", cyan: "#0ff",
    magenta: "#f0f", gray: "#808080", grey: "#808080", orange: "#ffa500", purple: "#800080", brown: "#a52a2a",
    navy: "#000080", teal: "#008080", olive: "#808000", maroon: "#800000", lime: "#0f0",
  };
  function parseColor(str) {
    let s = String(str || "").trim().toLowerCase();
    if (NAMED[s]) s = NAMED[s];
    let m = s.match(/^#([0-9a-f]{3,8})$/);
    if (m) {
      let x = m[1];
      if (x.length === 3 || x.length === 4) x = [...x.slice(0, 3)].map(c => c + c).join("");
      else if (x.length === 6 || x.length === 8) x = x.slice(0, 6);
      else return null;
      return [0, 2, 4].map(i => parseInt(x.slice(i, i + 2), 16));
    }
    m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?)\s*)?\)$/);
    if (!m) return null;
    if (m[4] !== undefined && Number(m[4]) === 0) return null;
    return [m[1], m[2], m[3]].map(v => Math.max(0, Math.min(255, Math.round(Number(v)))));
  }
  const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  // WCAG 대비 (1 ~ 21)
  function contrast(a, b) {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  }
  function toHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    if (!d) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, s, l];
  }
  function fromHsl([h, s, l]) {
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [r, g, b].map(v => Math.round((v + m) * 255));
  }
  const hex = rgb => "#" + rgb.map(v => v.toString(16).padStart(2, "0")).join("");
  // 글자색 fg가 바탕 bg 위에서 대비 min 이상이 되도록 밝기만 바꾼 색(#rrggbb). 이미 충분하면 null (색상·채도는 유지)
  function readableColor(fg, bg, min = 4.5) {
    if (!fg || !bg || contrast(fg, bg) >= min) return null;
    const up = contrast([255, 255, 255], bg) >= contrast([0, 0, 0], bg); // 어두운 바탕이면 밝게
    const [h, s, l0] = toHsl(fg);
    for (let i = 1; i <= 20; i++) {
      const c = fromHsl([h, s, up ? l0 + (1 - l0) * i / 20 : l0 * (1 - i / 20)]);
      if (contrast(c, bg) >= min) return hex(c);
    }
    return up ? "#ffffff" : "#000000";
  }

  // 헤더 자동 숨김 판단: 같은 방향으로 slop 넘게 내리면 숨김, 올리면 보임, 맨 위 근처는 항상 보임
  function nextBar(st, y, { top = 80, slop = 24 } = {}) {
    const dy = y - st.y;
    let acc = dy && Math.sign(dy) === Math.sign(st.acc) ? st.acc + dy : dy;
    let hidden = st.hidden;
    if (y <= top) { hidden = false; acc = 0; }
    else if (acc > slop) hidden = true;
    else if (acc < -slop) hidden = false;
    return { y, acc, hidden };
  }

  const api = { DEFAULTS, RANGE, clampSettings, parseColor, contrast, readableColor, nextBar };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;
  if (document.body.dataset.page !== "paper") return;
  PaperApp.registerFeature("reading-settings", api);

  // ---------- DOM ----------
  const UI = PaperUI, h = UI.h, store = PaperStore;
  const KEY = "reading-settings";
  const root = document.documentElement, paper = document.getElementById("paper");
  const darkMq = window.matchMedia ? matchMedia("(prefers-color-scheme: dark)") : null;
  let cur = clampSettings(store.get(KEY));
  const effTheme = () => (cur.theme === "system" ? (darkMq && darkMq.matches ? "dark" : "light") : cur.theme);
  const emit = (key, value) => document.dispatchEvent(new CustomEvent("paper:settings", { detail: { key, value } }));
  if (paper && !paper.getAttribute("lang")) paper.setAttribute("lang", "en"); // 양쪽 정렬 하이픈은 언어가 있어야 됨

  // html 속성·변수: base.html(첫 페인트 전)과 같은 규칙 + 기본값이면 속성을 지움. 상태 표시줄 색(theme-color)도 바탕색으로
  function applyLook() {
    const attr = (a, v) => (v == null ? root.removeAttribute(a) : root.setAttribute(a, v));
    attr("data-theme", cur.theme === "system" ? null : cur.theme);
    attr("data-font", cur.font === "serif" ? "serif" : null);
    attr("data-justify", cur.justify ? "1" : null);
    root.style.setProperty("--fs", `${cur.size}px`);
    root.style.setProperty("--lh", String(cur.lh));
    root.style.setProperty("--margin", `${cur.margin}px`);
    const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && bg) meta.setAttribute("content", bg);
  }

  // ---------- 저자 글자색: 다크·세피아 바탕에서 안 읽히면 밝기만 고친 색을 --rs-fg로 (속성·클래스만 바꿈) ----------
  // LaTeXML: style="color:…" (옛), style="--ltx-fg-color:…" (새), MathML mathcolor/mathbackground
  const COLORED = '[style*="color"], [mathcolor], [mathbackground]';
  const fgOf = el => parseColor((el.style && (el.style.color || el.style.getPropertyValue("--ltx-fg-color"))) || el.getAttribute("mathcolor"));
  const bgOf = el => parseColor((el.style && (el.style.backgroundColor || el.style.getPropertyValue("--ltx-bg-color"))) || el.getAttribute("mathbackground"));
  function recolor() {
    if (!paper) return;
    const tinted = effTheme() !== "light";
    if (!tinted && !paper.querySelector(".rs-recolor")) return;
    const cs = getComputedStyle(root);
    const pageBg = parseColor(cs.getPropertyValue("--bg")), pageFg = parseColor(cs.getPropertyValue("--fg"));
    for (const el of paper.querySelectorAll(COLORED)) {
      if (el.closest(".pr-ui, svg")) continue; // 기능 UI, 흰 바탕을 까는 그림(SVG) 안은 그대로
      let fix = null;
      if (tinted) {
        let bg = null;
        for (let p = el; p && p !== paper && !bg; p = p.parentElement) bg = bgOf(p);
        const fg = fgOf(el) || (bgOf(el) ? pageFg : null); // 색 상자(배경만 있음) 안의 글자는 페이지 글자색을 상자 바탕에 맞춤
        fix = fg && readableColor(fg, bg || pageBg);
      }
      if (fix) {
        el.style.setProperty("--rs-fg", fix);
        el.classList.add("rs-recolor");
      } else if (el.classList.contains("rs-recolor")) {
        el.classList.remove("rs-recolor");
        el.style.removeProperty("--rs-fg");
      }
    }
  }

  // ---------- 긴 수식·표: 블록 안 가로 스크롤 + 넘칠 때만 가장자리 흐림(rs-ovf, 스크롤 위치에 따라 rs-mid/rs-end) ----------
  const WIDE = "table.ltx_equation, table.ltx_equationgroup, table.ltx_tabular, figure.ltx_table, math[display=block], .ltx_listing, pre";
  function edge(el) {
    const x = Math.abs(el.scrollLeft), max = el.scrollWidth - el.clientWidth;
    el.classList.toggle("rs-mid", x > 2 && x < max - 2);
    el.classList.toggle("rs-end", x >= max - 2);
  }
  function markOverflow() {
    if (!paper) return;
    const els = [...paper.querySelectorAll(WIDE)];
    // 줄 안 수식이 화면보다 넓으면(긴 것만 봄) 자기 줄로 내려 그 안에서 스크롤 (rs-wide-math → display: block = block math)
    const inl = [...paper.querySelectorAll('math:not([display="block"])')].filter(m => (m.getAttribute("alttext") || "").length > 30);
    const limit = paper.clientWidth - 2 * cur.margin;
    // 먼저 다 읽고 나서 씀 (레이아웃 한 번). 이미 내린 수식은 아직 넘치는지로 판단 (안 그러면 켰다 껐다 반복)
    const over = els.map(el => el.scrollWidth - el.clientWidth > 2);
    const wide = inl.map(m => (m.classList.contains("rs-wide-math") ? m.scrollWidth - m.clientWidth > 2 : m.getBoundingClientRect().width > limit));
    inl.forEach((m, i) => { m.classList.toggle("rs-wide-math", wide[i]); if (wide[i]) { els.push(m); over.push(true); } });
    els.forEach((el, i) => {
      el.classList.toggle("rs-ovf", over[i]);
      if (over[i]) edge(el); else el.classList.remove("rs-mid", "rs-end");
    });
  }
  document.addEventListener("scroll", e => {
    const t = e.target;
    if (t instanceof Element && t.classList.contains("rs-ovf")) edge(t);
  }, { capture: true, passive: true });
  if (paper && typeof ResizeObserver !== "undefined") {
    // 폭·글자 크기·그림 로드로 크기가 바뀌면 다시 (처음 observe 때도 한 번 불림)
    let t = 0;
    new ResizeObserver(() => { clearTimeout(t); t = setTimeout(markOverflow, 250); }).observe(paper);
  } else setTimeout(markOverflow, 500);

  // ---------- 문단 집중: 읽기 선(화면 위 1/3)에 걸친 블록만 또렷하게, 나머지는 흐리게 (클래스만) ----------
  const UNIT = ".ltx_para, .ltx_abstract > .ltx_p, .ltx_title, figure, .ltx_float, .ltx_theorem, .ltx_proof, .ltx_bibitem, .ltx_authors";
  let curUnit = null, focusRaf = 0;
  function outerUnit(el) {
    let u = el && el.closest ? el.closest(UNIT) : null;
    if (!u || !paper.contains(u) || u.closest(".pr-ui")) return null;
    for (let p = u.parentElement && u.parentElement.closest(UNIT); p && paper.contains(p); p = p.parentElement && p.parentElement.closest(UNIT)) u = p;
    return u;
  }
  function updateFocus() {
    focusRaf = 0;
    if (!cur.focus || !paper) return;
    const top = document.getElementById("top-stack")?.getBoundingClientRect().bottom || 0;
    const y = top + (window.innerHeight - top) / 3, r = paper.getBoundingClientRect(), x = r.left + r.width / 2;
    let u = null;
    for (const dy of [0, -24, 24, -48, 48]) if ((u = outerUnit(document.elementFromPoint(x, y + dy)))) break;
    if (!u || u === curUnit) return;
    curUnit?.classList.remove("rs-cur");
    u.classList.add("rs-cur");
    curUnit = u;
  }

  // ---------- 헤더 자동 숨김 (PaperUI.setBarHidden만 부름, .bar는 직접 안 건드림) ----------
  let barSt = { y: window.scrollY, acc: 0, hidden: false }, barRaf = 0;
  document.getElementById("bar")?.addEventListener("focusin", () => UI.setBarHidden(false)); // 키보드로 헤더에 가면 보임

  // ---------- 화면 켜짐 유지 (Wake Lock). 없으면 조용히 미지원, 탭이 다시 보이면 다시 요청, 15분 손 안 대면 놓아 줌 ----------
  const WAKE_IDLE = 15 * 60e3;
  let lock = null, lockReq = null, lastAct = Date.now(), idleOff = false, wakeTimer = 0;
  function lockOn() {
    if (lock) return Promise.resolve(true);
    if (lockReq) return lockReq;
    if (!cur.wake || !navigator.wakeLock || document.visibilityState !== "visible") return Promise.resolve(false);
    lockReq = navigator.wakeLock.request("screen").then(l => {
      lockReq = null;
      if (!cur.wake) { l.release().catch(() => {}); return false; }
      lock = l;
      l.addEventListener("release", () => { if (lock === l) lock = null; });
      return true;
    }, () => { lockReq = null; return false; });
    return lockReq;
  }
  function lockOff() {
    const l = lock;
    lock = null;
    if (l) l.release().catch(() => {});
  }
  function wakeStart() {
    idleOff = false;
    lastAct = Date.now();
    clearInterval(wakeTimer);
    wakeTimer = setInterval(() => {
      if (lock && Date.now() - lastAct > WAKE_IDLE) { idleOff = true; lockOff(); }
    }, 60e3);
    return lockOn();
  }
  function wakeStop() { clearInterval(wakeTimer); idleOff = false; lockOff(); }
  const touched = () => {
    lastAct = Date.now();
    if (idleOff && cur.wake) { idleOff = false; lockOn(); }
  };
  for (const t of ["pointerdown", "keydown"]) document.addEventListener(t, touched, { capture: true, passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !cur.wake) return;
    lastAct = Date.now();
    idleOff = false;
    lockOn(); // 탭을 떠나면 브라우저가 놓아 버림 → 돌아오면 다시
  });

  window.addEventListener("scroll", () => {
    if (cur.autohide && !barRaf) {
      barRaf = requestAnimationFrame(() => {
        barRaf = 0;
        barSt = nextBar(barSt, window.scrollY);
        UI.setBarHidden(barSt.hidden);
      });
    }
    if (cur.focus && !focusRaf) focusRaf = requestAnimationFrame(updateFocus);
    if (cur.wake) touched();
  }, { passive: true });

  // ---------- 넓은 화면 + 번역 '둘다': 문단별 두 칸 (CSS가 html.rs-tr-both를 봄) ----------
  const setBoth = mode => root.classList.toggle("rs-tr-both", mode === "both");
  setBoth(store.get("section-translate:mode", "orig"));
  PaperApp.on("translations", d => { if (d && d.mode) setBoth(d.mode); });

  // ---------- 적용·저장 ----------
  function apply(prev = {}) {
    applyLook();
    if (prev.theme !== cur.theme) recolor();
    if (paper) paper.classList.toggle("rs-focus", cur.focus);
    if (cur.focus && !prev.focus) updateFocus();
    if (!cur.focus && curUnit) { curUnit.classList.remove("rs-cur"); curUnit = null; }
    if (cur.autohide !== prev.autohide) {
      barSt = { y: window.scrollY, acc: 0, hidden: false };
      if (!cur.autohide) UI.setBarHidden(false);
    }
    if (cur.wake !== prev.wake) { if (cur.wake) wakeStart(); else wakeStop(); }
  }
  // 글자 크기·줄 간격·여백·글꼴을 바꿔도 화면 맨 위 줄의 글자가 그 자리에 (스크롤 고정이 없는 사파리용, 크롬은 거의 안 움직임)
  function keepPlace(fn) {
    const A = window.PaperAnchor, r = paper && paper.getBoundingClientRect();
    const top = (document.getElementById("top-stack")?.getBoundingClientRect().bottom || 0) + 16;
    let off = null;
    // 맨 위 줄 근처에서 글자 위의 점을 찾음 (문단 사이 빈 곳이면 조금씩 아래로). 찾는 동안만 peek 바탕막을 통과 (rs-probe)
    if (A && r && r.top < top) {
      root.classList.add("rs-probe");
      for (let dy = 0; dy <= 80 && off == null; dy += 20) for (const fx of [0.15, 0.4]) if ((off = A.offsetAtPoint(r.left + r.width * fx, top + dy)) != null) break;
      root.classList.remove("rs-probe");
    }
    const yOf = () => { const rg = off != null && A.rangeAt(off, off + 1); return rg ? (rg.getClientRects()[0] || rg.getBoundingClientRect()).top : null; };
    const y0 = yOf();
    fn();
    const y1 = y0 == null ? null : yOf();
    if (y1 != null && Math.abs(y1 - y0) > 1) window.scrollBy(0, y1 - y0);
  }
  // 바꾸고 저장 → 적용 → 바뀐 키마다 'paper:settings' {key, value} (quiet: 슬라이더를 끄는 중에는 알리지 않음)
  function commit(next, { quiet = false } = {}) {
    const prev = cur;
    cur = clampSettings(next);
    store.set(KEY, cur);
    if (["size", "lh", "margin", "font"].some(k => cur[k] !== prev[k])) keepPlace(() => apply(prev));
    else apply(prev);
    if (!quiet) for (const k of Object.keys(cur)) if (cur[k] !== prev[k]) emit(k, cur[k]);
    return prev;
  }
  apply();
  darkMq?.addEventListener?.("change", () => { if (cur.theme === "system") { applyLook(); recolor(); } });
  // 다른 탭에서 바꾸면 따라감 (설정은 모든 논문 공통)
  window.addEventListener("storage", e => {
    if (e.key !== store.key(KEY)) return;
    const prev = cur;
    cur = clampSettings(store.get(KEY));
    apply(prev);
    render();
  });

  // ---------- 설정 peek ----------
  let panel = null;
  const seg = (key, opts, label) => h("div", { class: `rs-seg rs-seg-${key}`, role: "group", "aria-label": label },
    opts.map(([v, text, extra]) => h("button", {
      type: "button", "aria-pressed": String(cur[key] === v), dataset: { v },
      onclick: e => {
        commit({ ...cur, [key]: v });
        for (const b of e.currentTarget.parentElement.children) b.setAttribute("aria-pressed", String(b.dataset.v === v));
      },
    }, extra || null, h("span", { text }))));
  const row = (label, ...kids) => h("div", { class: "rs-row" }, h("div", { class: "rs-label", text: label }), ...kids);
  function slider(key, label, fmt, ends) {
    const [lo, hi, step] = RANGE[key];
    const out = h("output", { text: fmt(cur[key]) });
    const input = h("input", { type: "range", min: lo, max: hi, step, value: cur[key], "aria-label": label });
    input.addEventListener("input", () => { commit({ ...cur, [key]: input.value }, { quiet: true }); out.textContent = fmt(cur[key]); });
    input.addEventListener("change", () => emit(key, cur[key]));
    return h("div", { class: "rs-row" }, h("div", { class: "rs-label" }, h("span", { text: label }), out),
      h("div", { class: "rs-slider" }, h("span", { class: "rs-end-lo", "aria-hidden": "true", text: ends[0] }), input,
        h("span", { class: "rs-end-hi", "aria-hidden": "true", text: ends[1] })));
  }
  function toggle(label, note, on, onChange, disabled = false) {
    const input = h("input", { type: "checkbox", role: "switch", disabled });
    input.checked = !!on;
    input.addEventListener("change", () => onChange(input.checked, input));
    return h("label", { class: "rs-toggle" }, h("span", {}, h("span", { text: label }), note ? h("small", { text: note }) : null), input);
  }
  const flag = (key, label, note, disabled) => toggle(label, note, cur[key], v => commit({ ...cur, [key]: v }), disabled);

  function build() {
    const wakeOk = !!navigator.wakeLock;
    return h("div", { class: "rs-panel" },
      slider("size", "글자 크기", v => `${v}px`, ["가", "가"]),
      row("테마", seg("theme", [
        ["system", "시스템"], ["light", "라이트"], ["dark", "다크"], ["sepia", "세피아"],
      ].map(([v, t]) => [v, t, h("span", { class: `rs-swatch rs-sw-${v}`, "aria-hidden": "true" })]), "테마")),
      slider("lh", "줄 간격", v => v.toFixed(2), ["≡", "☰"]),
      slider("margin", "좌우 여백", v => `${v}px`, ["▏", "▕"]),
      row("글꼴", seg("font", [["sans", "고딕"], ["serif", "명조", h("span", { class: "rs-serif", "aria-hidden": "true", text: "Aa" })]], "글꼴")),
      h("div", { class: "rs-toggles" },
        flag("justify", "양쪽 정렬", "영어 단어를 하이픈으로 나눠 줄 끝을 맞춤"),
        flag("focus", "문단 집중", "읽는 문단만 또렷하게, 나머지는 흐리게"),
        flag("autohide", "스크롤하면 헤더 숨김", "위로 올리면 다시 보임"),
        toggle("화면 켜짐 유지", wakeOk ? "읽는 동안 화면이 꺼지지 않음 (15분 동안 손대지 않으면 해제)" : "이 브라우저는 지원하지 않음",
          cur.wake && wakeOk, async (on, input) => {
            commit({ ...cur, wake: on });
            if (on && !(await lockOn())) {
              UI.toast("화면 켜짐 유지를 켤 수 없습니다 (절전 모드 등)");
              commit({ ...cur, wake: false });
              input.checked = false;
            }
          }, !wakeOk),
        PaperApp.has("glossary") ? flag("ruby", "용어 위에 뜻 표시", "어려운 용어 위에 짧은 한국어 뜻") : null,
        toggle("텍스트 선택 버튼", "선택하면 화면 아래에 질문·하이라이트 버튼", store.get("app:selbar", true) !== false, on => {
          PaperApp.setSelBar(on);
          emit("selbar", on);
        })),
      h("button", {
        type: "button", class: "rs-reset", text: "기본값으로",
        onclick: () => {
          const prev = commit({ ...DEFAULTS });
          render();
          UI.toast("읽기 설정을 기본값으로 되돌렸습니다", { actionLabel: "실행 취소", onAction: () => { commit(prev); render(); } });
        },
      }));
  }
  function render() { if (panel) panel.body.replaceChildren(build()); }
  function open() {
    if (panel) return;
    panel = UI.peek({ title: "읽기 설정", body: build(), className: "rs-peek", onClose: () => { panel = null; } });
  }
  UI.addBarButton({ id: "reading-settings", label: "읽기 설정", icon: "Aa", title: "읽기 설정", onClick: open });
})();
