// audio-summary: 듣기 — 한국어 오디오 요약(요약·비평) + 본문/번역문 소리 내어 읽기 (지금 문장·문단 표시)
(function () {
  "use strict";

  // ---------- 순수 함수 (node 테스트) ----------
  const RATES = [0.8, 1, 1.2, 1.5];
  const MATH = "\uE000"; // 본문의 수식 하나 = 이 글자 하나 (LaTeX 안의 '.'에 문장 나누기가 속지 않게)
  const END = /[.!?。！？…]+["'”’)\]]*(?=\s|$)|\n+/g;
  // 뒤에 공백이 와도 문장 끝이 아닌 약어 (영어 본문). "et al."은 "al."로 걸림
  const ABBR = /^[("'“]*(?:e\.g|i\.e|al|cf|vs|[Ff]igs?|[Ee]qs?|[Ss]ecs?|[Tt]ab|[Rr]efs?|resp|approx|Dr|Prof|Thm|Alg|Def|Lem|Prop|Cor|App|w\.r\.t|a\.k\.a)\.$/;

  // 문장 구간 [{start, end}] (앞뒤 공백 제외). 너무 긴 문장은 쉼표·공백에서 나눔 (긴 발화는 일부 브라우저에서 중간에 끊김)
  function sentenceSpans(text, max = 220) {
    text = String(text ?? "");
    const out = [];
    const add = (a, b) => {
      while (a < b && /\s/.test(text[a])) a++;
      while (b > a && /\s/.test(text[b - 1])) b--;
      if (b > a) out.push({ start: a, end: b });
      return b;
    };
    const push = (a, b) => {
      while (a < b && /\s/.test(text[a])) a++;
      while (b - a > max) {
        const win = text.slice(a, a + max);
        let k = Math.max(win.lastIndexOf(", "), win.lastIndexOf("; "), win.lastIndexOf(": "), win.lastIndexOf("，"));
        if (k < max * 0.4) k = win.lastIndexOf(" ");
        if (k < max * 0.4) k = max - 1;
        add(a, a + k + 1);
        a += k + 1;
        while (a < b && /\s/.test(text[a])) a++;
      }
      add(a, b);
    };
    const re = new RegExp(END.source, "g");
    let start = 0, m;
    while ((m = re.exec(text))) {
      const end = m.index + m[0].length;
      const nl = m[0][0] === "\n";
      if (!nl && m[0] === ".") {
        const word = text.slice(start, end).split(/\s+/).pop();
        const next = text.slice(end).trimStart();
        // 약어, 소문자로 이어지는 영어 문장 (점 앞이 라틴 글자일 때만: 한국어 문장 뒤 'x의 제곱', 'softmax 함수는'은 새 문장)
        if (ABBR.test(word) || (/[A-Za-z]\.$/.test(word) && /^[a-z]/.test(next))) continue;
      }
      push(start, nl ? m.index : end);
      start = end;
    }
    push(start, text.length);
    return out;
  }
  const splitSentences = text => sentenceSpans(text).map(s => String(text).slice(s.start, s.end));
  // 논문 글자(본문·.tr-ko): HTML에서 줄바꿈은 공백으로 보이고 LaTeXML은 원고의 줄바꿈을 그대로 둠 →
  // 같은 길이의 공백으로 바꿔 나눔 (구간 위치는 원문 그대로). 줄바꿈을 문장 경계로 쓰는 것은 요약 대본만
  const paperSpans = (text, max) => sentenceSpans(String(text ?? "").replace(/\s/g, " "), max);

  // LaTeX alttext → 읽을 말. 복잡한 식(분수·합·적분·행렬 …)이나 길면 '수식'(영어는 'formula')
  const GREEK = ["alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta", "vartheta", "iota", "kappa", "lambda",
    "mu", "nu", "xi", "pi", "rho", "sigma", "tau", "upsilon", "phi", "varphi", "chi", "psi", "omega"];
  const GREEK_KO = ["알파", "베타", "감마", "델타", "엡실론", "엡실론", "제타", "에타", "세타", "세타", "요타", "카파", "람다",
    "뮤", "뉴", "크시", "파이", "로", "시그마", "타우", "입실론", "파이", "파이", "카이", "프사이", "오메가"];
  const WORDS = {
    en: { "=": " equals ", "+": " plus ", "-": " minus ", "/": " over ", "<": " less than ", ">": " greater than ",
      times: " times ", cdot: " times ", le: " at most ", leq: " at most ", ge: " at least ", geq: " at least ", neq: " not equal to ",
      approx: " approximately ", sim: " similar to ", in: " in ", infty: " infinity ", to: " to ", rightarrow: " to ", ldots: " dots ", cdots: " dots ",
      sq: " squared", pow: (b, e) => `${b} to the ${e}`, math: "formula" },
    ko: { "=": " 는 ", "+": " 더하기 ", "-": " 마이너스 ", "/": " 나누기 ", "<": " 작다 ", ">": " 크다 ",
      times: " 곱하기 ", cdot: " 곱하기 ", le: " 이하 ", leq: " 이하 ", ge: " 이상 ", geq: " 이상 ", neq: " 같지 않음 ",
      approx: " 약 ", sim: " 비슷 ", in: " 속함 ", infty: " 무한대 ", to: " 에서 ", rightarrow: " 에서 ", ldots: " 등 ", cdots: " 등 ",
      sq: "의 제곱", pow: (b, e) => `${b}의 ${e}제곱`, math: "수식" },
  };
  const COMPLEX = /\\(?:frac|dfrac|tfrac|sum|prod|int|oint|sqrt|lim|begin|matrix|binom|partial|nabla|max|min|arg|log|exp|sup|inf|det)(?![a-zA-Z])/;
  function mathSpeech(tex, lang = "en") {
    const ko = String(lang).startsWith("ko"), W = ko ? WORDS.ko : WORDS.en;
    let t = String(tex ?? "").replace(/\\(?:displaystyle|textstyle|scriptstyle|left|right|[bB]igg?[lr]?|quad|qquad)(?![a-zA-Z])|\\[,;:!]/g, " ");
    for (let k = 0; k < 3; k++) {
      t = t.replace(/\\(?:math(?:rm|bf|it|sf|tt|cal|bb|frak)|boldsymbol|bm|text(?:rm|bf|it)?|operatorname|hat|tilde|bar|vec|widehat|widetilde|overline)\s*\{([^{}]*)\}/g, " $1 ");
    }
    if (COMPLEX.test(t)) return W.math;
    t = t.replace(/\\([a-zA-Z]+)/g, (m, name) => {
      const g = GREEK.indexOf(name);
      if (g >= 0) return ` ${ko ? GREEK_KO[g] : name.replace(/^var/, "")} `;
      return typeof W[name] === "string" ? W[name] : m;
    });
    t = t.replace(/\s*\^\s*(?:\{\s*2\s*\}|2(?!\d))/g, W.sq);
    t = t.replace(/(\S+?)\s*\^\s*(?:\{([^{}]*)\}|(\S))/g, (m, b, e1, e2) => W.pow(b, (e1 ?? e2).trim()));
    t = t.replace(/_\s*(?:\{([^{}]*)\}|(\S))/g, (m, a, b) => ` ${a ?? b} `);
    t = t.replace(/[=+\-/<>]/g, c => W[c]).replace(/[(){}[\]|,]/g, " ").replace(/\s+/g, " ").trim();
    if (!t || /[\\^_{}]/.test(t) || t.length > 40) return W.math;
    return t;
  }

  // 말하기 전 정리: 번역 자리표시자·URL·[1, 2] 같은 번호 인용 제거, 공백 정리
  function speechText(s, lang = "en") {
    const ko = String(lang).startsWith("ko");
    return String(s ?? "")
      .replace(/⟦\d+⟧/g, " ")
      .replace(/https?:\/\/\S+?(?=[.,;:!?)]?(?:\s|$))/g, ko ? " 링크 " : " link ")
      .replace(/\[\d+(?:\s*[,–-]\s*\d+)*\]/g, " ")
      .replace(/[([]\s*(?:[,;]\s*)*[)\]]/g, " ") // 인용 연도·번호를 뺀 뒤 남은 빈 괄호: 'Smith et al. () show'
      .replace(/\s+/g, " ")
      .replace(/\s+([.,;:!?)])/g, "$1")
      .replace(/(^|[^.])\.\.(?!\.)/g, "$1.") // 'et al. ().' → 'et al..' → 'et al.' (말줄임표 ...는 그대로)
      .trim();
  }

  // 답변 Markdown → 읽을 글 (answer-tools가 없을 때 음성 질문의 답 자동 읽기용)
  function stripMarkdown(md) {
    return String(md ?? "")
      .replace(/```[\s\S]*?(?:```|$)/g, " ")
      .replace(/\$\$([\s\S]+?)\$\$|\$([^$\n]+)\$/g, (m, a, b) => ` ${mathSpeech(a || b, "ko")} `)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
      .replace(/[*_`~]+/g, "")
      .split("\n").map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
  }

  const nextRate = r => RATES.find(x => x > r + 1e-9) ?? RATES[0];
  const rateLabel = r => `${Number(r).toFixed(1)}×`;
  // 화면 위 가장자리(top) 아래로 걸쳐 보이는 첫 사각형의 번호, 없으면 -1
  const firstBelow = (rects, top) => rects.findIndex(r => r && r.height > 0 && r.bottom > top + 4);

  const api = { RATES, MATH, sentenceSpans, splitSentences, paperSpans, mathSpeech, speechText, stripMarkdown, nextRate, rateLabel, firstBelow };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;
  if (document.body.dataset.page !== "paper") return;
  PaperApp.registerFeature("audio-summary", api);

  // ---------- DOM ----------
  const OWNER = "audio-summary";
  const UI = PaperUI, A = PaperAnchor, App = PaperApp, tts = PaperApp.tts, h = PaperUI.h;
  const paperEl = document.getElementById("paper");
  if (!paperEl) return;
  const prefs = { rate: 1, style: "brief", ...(PaperStore.get("audio-summary", {}) || {}) };
  if (!RATES.includes(prefs.rate)) prefs.rate = 1;
  if (!["brief", "critique"].includes(prefs.style)) prefs.style = "brief";
  const savePrefs = () => PaperStore.set("audio-summary", { rate: prefs.rate, style: prefs.style });
  const trMode = () => PaperStore.get("section-translate:mode", "orig") || "orig";
  const STYLE_LABEL = { brief: "요약 듣기", critique: "비평 듣기" };
  const G = { play: "▶\uFE0E", pause: "⏸\uFE0E", prev: "⏮\uFE0E", next: "⏭\uFE0E" }; // 글자 모양으로 (iOS 이모지 방지)

  // 읽기 단위: 본문 문단(.ltx_p), 섹션 제목, 별행 수식. 그림·표·참고문헌·각주·기능 UI 안은 제외
  const UNIT_SEL = ".ltx_p, section > .ltx_title, table.ltx_equation, table.ltx_equationgroup";
  const UNIT_OUT = "figure, .ltx_bibliography, .ltx_note_outer, .pr-ui, .tr-ko, table.ltx_tabular, .ltx_listing, .ltx_authors";
  const units = () => [...paperEl.querySelectorAll(UNIT_SEL)].filter(el =>
    !el.closest(UNIT_OUT) && !(el.matches(".ltx_p") && el.closest("table.ltx_equation, table.ltx_equationgroup")));
  const EN_SKIP = ".pr-ui, .tr-ko, .ltx_note_outer, .ltx_note_mark, .ltx_bibliography, .ltx_tag_equation, script, style, button, noscript, template";
  // 번역문 안: section-translate가 한국어 문장을 누르면 끼워 넣는 영어 한 줄(.tr-en)과 다른 언어 부분은 읽지 않음
  const KO_SKIP = ".pr-ui, .tr-en, [lang]:not([lang|='ko']), .ltx_note_outer, .ltx_note_mark, script, style, button";
  // 인용: 괄호·번호 인용([1, 2], (Smith et al., 2020))은 건너뜀. 문장 주어인 저자 인용(\citet: 'Smith et al. (2020) show')은
  // 저자 이름만 읽고 연도·번호 링크는 뺌 (남은 빈 괄호는 speechText가 지움)
  const NUM_REF = /^\s*\d[\d\s,–-]*[a-z]?\s*$/;
  const skipCite = n => (n.localName === "cite" ? /^\s*[[(]/.test(n.textContent)
    : n.localName === "a" && NUM_REF.test(n.textContent) && !!n.parentElement && !!n.parentElement.closest("cite"));

  // 요소의 글자 + 위치 표 (수식은 MATH 한 글자). 문장 구간 → Range로 되돌릴 때 사용
  function flatten(root, skipSel) {
    const segs = [];
    let text = "";
    const visit = node => {
      for (let n = node.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) {
          if (n.data) { segs.push({ node: n, start: text.length, end: text.length + n.data.length }); text += n.data; }
        } else if (n.nodeType === 1) {
          if (n.localName === "math") { segs.push({ node: n, start: text.length, end: text.length + 1, math: true }); text += MATH; }
          else if (!n.matches(skipSel) && !skipCite(n)) visit(n);
        }
      }
    };
    visit(root);
    return { text, segs };
  }
  function rangeIn(segs, a, b) {
    const s = segs.find(g => g.end > a);
    let e = null;
    for (let k = segs.length - 1; k >= 0; k--) if (segs[k].start < b) { e = segs[k]; break; }
    if (!s || !e) return null;
    const r = document.createRange();
    if (s.math) r.setStartBefore(s.node); else r.setStart(s.node, a - s.start);
    if (e.math) r.setEndAfter(e.node); else r.setEnd(e.node, b - e.start);
    return r;
  }
  // 영어 단위 뒤의 번역(.tr-ko). section-translate.unitFor로 확인할 수 있으면 확인
  function koOf(el) {
    const st = App.feature("section-translate");
    for (let n = el.nextElementSibling; n && n.classList.contains("pr-ui"); n = n.nextElementSibling) {
      if (!n.classList.contains("tr-ko")) continue;
      let u = null;
      try { u = st && st.unitFor ? st.unitFor(n) : null; } catch { /* 무시 */ }
      if (!u || u === el) return n.textContent.trim() ? n : null;
    }
    return null;
  }
  // 단위 하나를 읽을 문장들로: {el, root, ko, lang, para, pairs, sents: [{speech, off} | {speech, range, pair}]}
  // 영어 문장은 색인 오프셋으로 저장 (glossary의 wrap이나 <mark> 대체 칠하기가 글자 노드를 옮겨도 그대로; Range는 쓸 때 만듦).
  // 번역문(.tr-ko)은 색인 밖이라 살아 있는 Range. section-translate의 문장 칸(.tr-s)이 있으면 칸마다 나누고 그 번호(쌍 번호)를 둠
  function prepUnit(el, want) {
    const ko = want === "ko" ? koOf(el) : null;
    const lang = ko || (want === "ko" && el.localName === "table") ? "ko-KR" : "en-US";
    const unit = { el, root: ko || el, ko: !!ko, lang, para: el.closest(".ltx_para"), pairs: 0, sents: [] };
    if (el.localName === "table") {
      const tag = (el.querySelector(".ltx_tag_equation")?.textContent || "").replace(/[()]/g, "").trim();
      unit.sents.push({ speech: `${lang === "ko-KR" ? "수식" : "Equation"} ${tag}`.trim(), off: A.offsetsOfElement(el) });
      return unit;
    }
    if (ko) {
      const parts = [...ko.querySelectorAll(".tr-s")];
      unit.pairs = parts.length;
      if (parts.length) parts.forEach((sp, k) => addSents(unit, sp, KO_SKIP, Number.isInteger(Number(sp.dataset.i)) ? Number(sp.dataset.i) : k));
      else addSents(unit, ko, KO_SKIP, null);
      if (!unit.sents.length) return prepUnit(el, "en"); // 번역 칸이 비었으면(준비 중 등) 원문
    } else addSents(unit, el, EN_SKIP, null);
    return unit;
  }
  function addSents(unit, root, skip, pair) {
    const { text, segs } = flatten(root, skip);
    const maths = segs.filter(s => s.math);
    let mi = 0;
    for (const sp of paperSpans(text)) {
      const raw = text.slice(sp.start, sp.end).replace(/\uE000/g, () => {
        while (mi < maths.length && maths[mi].start < sp.start) mi++;
        const m = maths[mi++];
        return ` ${mathSpeech(m ? m.node.getAttribute("alttext") || m.node.textContent : "", unit.lang)} `;
      });
      const speech = speechText(raw, unit.lang);
      if (!/[\p{L}\p{N}]/u.test(speech)) continue;
      const range = rangeIn(segs, sp.start, sp.end);
      unit.sents.push(unit.ko ? { speech, range, pair } : { speech, off: range ? A.offsetsOf(range) : null });
    }
  }
  // 문장의 지금 Range (영어: 오프셋에서 새로, 번역문: 저장한 Range가 살아 있으면)
  function rangeOf(s) {
    if (!s) return null;
    if (s.off) return A.rangeAt(s.off.start, s.off.end);
    return s.range && !s.range.collapsed && s.range.startContainer.isConnected ? s.range : null;
  }

  // ---------- 오디오 대본 (요약·비평) ----------
  const scripts = {}; // style -> {text, p}
  function loadScript(style, retry = false) {
    const c = scripts[style] || (scripts[style] = {});
    if (c.text) return Promise.resolve(c.text);
    if (c.p && !retry) return c.p;
    const url = `/api/audio-summary/${encodeURIComponent(App.arxivId)}?style=${style}`;
    c.p = fetch(retry ? `${url}&retry=1` : url).then(async r => {
      if (!r.ok) {
        let d = "";
        try { d = (await r.json()).detail; } catch { /* 무시 */ }
        throw new Error(typeof d === "string" && d ? d : `HTTP ${r.status}`);
      }
      const j = await r.json();
      if (!j || typeof j.text !== "string" || !j.text.trim()) throw new Error("빈 대본");
      c.text = j.text;
      App.addOfflineUrl(url);
      return c.text;
    }).catch(e => {
      c.p = null;
      throw e && e.name === "TypeError" ? new Error("네트워크 연결이 필요해요") : e;
    });
    return c.p;
  }

  // ---------- 재생 상태 ----------
  // st = {mode: brief|critique|body, i, playing, loading, error, ended,
  //       요약: sents, 본문: lang(ko|en), list(단위들), u, unit(prepUnit), last/prev(팝업 대상)}
  let st = null, gen = 0, readingEl = null, hereBtns = [], ui = null, scriptPeek = null, popTimer = 0, lastTouch = 0;
  const sentsOf = s => (s.mode === "body" ? (s.unit ? s.unit.sents.map(x => x.speech) : []) : s.sents || []);

  // 지금 문장부터 새로 말하기 (재개·속도 바꿈·이동 모두 이것: 브라우저 pause/resume은 모바일에서 불안정)
  function speakNow() {
    if (!st) return;
    const chunks = sentsOf(st);
    if (!chunks.length) return;
    const my = ++gen, s = st;
    s.i = Math.max(0, Math.min(s.i, chunks.length - 1));
    s.playing = true;
    s.error = null;
    s.ended = false;
    tts.speak(chunks, {
      owner: OWNER, lang: s.mode === "body" ? s.unit.lang : "ko-KR", rate: prefs.rate, start: s.i,
      onBoundary: ({ index }) => { if (my === gen && index !== s.i) { s.i = index; onSentence(); } },
      onEnd: info => {
        if (my !== gen) return;
        if (info && info.done) { advance(); return; }
        s.playing = false; // 다른 기능의 읽기·마이크·페이지 숨김 등: 이 문장에서 멈춤 (▶로 이어 듣기)
        if (info && info.error) s.error = info.error;
        render();
      },
    });
    if (st === s && my === gen) onSentence();
  }
  function silence() {
    gen++;
    if (tts.owner === OWNER) tts.stop(OWNER);
  }
  function pause() {
    if (!st || !st.playing) return;
    gen++;
    if (tts.owner === OWNER) tts.pause();
    st.playing = false;
    render();
  }
  function toggle() {
    if (!st || st.loading) return;
    if (st.playing) return pause();
    if (st.ended) { st.i = 0; if (st.mode === "body") { st.u = 0; loadUnit(1); } }
    if (st.fetchError) return startSummary(st.mode, true);
    speakNow();
  }
  // 본문: dir 방향으로 문장이 있는 단위를 찾아 준비
  function loadUnit(dir) {
    const want = st.lang === "ko" && trMode() !== "orig" ? "ko" : "en"; // 도중에 원문 모드로 바꾸면 원문
    while (st.u >= 0 && st.u < st.list.length) {
      const el = st.list[st.u];
      if (el.isConnected) {
        const p = prepUnit(el, want);
        if (p.sents.length) { st.unit = p; markPara(); return true; }
      }
      st.u += dir;
    }
    st.u = Math.max(0, Math.min(st.u, st.list.length - 1));
    return false;
  }
  function advance() {
    if (!st) return;
    if (st.mode === "body") {
      st.u++;
      st.i = 0;
      if (st.u < st.list.length && loadUnit(1)) { speakNow(); return; }
      st.u = Math.min(st.u, st.list.length - 1); // 끝: '문단 N/N' (N+1이 아니게)
    }
    st.playing = false;
    st.ended = true;
    A.clear("as-sentence");
    render();
  }
  function step(d) {
    if (!st || st.loading) return;
    const n = sentsOf(st).length;
    let i = st.i + d;
    if (st.mode === "body" && (i < 0 || i >= n)) {
      const keep = { u: st.u, unit: st.unit };
      st.u += d;
      if (st.u >= 0 && st.u < st.list.length && loadUnit(d)) i = d < 0 ? st.unit.sents.length - 1 : 0;
      else { Object.assign(st, keep); markPara(); i = Math.max(0, Math.min(i, n - 1)); }
    }
    st.i = Math.max(0, Math.min(i, sentsOf(st).length - 1));
    st.ended = false;
    if (st.playing) speakNow(); else onSentence();
  }
  function setRate(r) {
    prefs.rate = r;
    savePrefs();
    if (st && st.playing) speakNow(); // 지금 문장을 새 속도로 다시
    render();
    document.querySelectorAll(".as-rates button").forEach(b => b.setAttribute("aria-pressed", String(Number(b.dataset.rate) === r)));
  }

  // 문장이 바뀜: 본문이면 칠하고 따라 스크롤, 재생기·대본 표시
  function onSentence() {
    if (!st) return;
    const key = st.mode === "body" ? st.unit : st.mode;
    if (!st.last || st.last.unit !== key || st.last.i !== st.i) {
      st.prev = st.last;
      st.last = { unit: key, i: st.i, at: Date.now() };
    }
    if (st.mode === "body" && st.unit) {
      const s = st.unit.sents[st.i], r = rangeOf(s);
      if (r && !r.collapsed) {
        follow(r); // 칠하기 전에 (<mark> 대체는 글자 노드를 옮김)
        A.paint("as-sentence", [st.unit.ko ? r : s.off], { priority: 30, raw: st.unit.ko });
      } else A.clear("as-sentence");
      markPara();
    }
    render();
    markScript();
  }
  function markPara() {
    const p = st && st.mode === "body" && st.unit ? st.unit.para : null;
    if (readingEl && readingEl !== p) readingEl.classList.remove("as-reading");
    if (p) p.classList.add("as-reading");
    readingEl = p;
  }
  // 화면 위쪽 가장자리 (헤더 + 띠)
  function topEdge() {
    const bar = document.getElementById("bar"), ts = document.getElementById("top-stack");
    return Math.max(0, bar ? bar.getBoundingClientRect().bottom : 0, ts ? ts.getBoundingClientRect().bottom : 0);
  }
  // 읽는 문장이 화면 밖이면 따라감 (사용자가 5초 안에 직접 스크롤했으면 그대로 둠)
  function follow(target) {
    if (Date.now() - lastTouch < 5000) return;
    const r = target.getBoundingClientRect();
    if (!r.height && !r.width) return;
    const top = topEdge() + 8, dock = document.getElementById("bottom-dock");
    const bottom = (dock ? Math.min(innerHeight, dock.getBoundingClientRect().top) : innerHeight) - 8;
    if (r.top >= top && r.bottom <= bottom) return;
    window.scrollTo({ top: Math.max(0, scrollY + r.top - top - Math.max(0, bottom - top) * 0.25), behavior: "smooth" });
  }
  const userScroll = e => { if (!(e.target instanceof Element && e.target.closest("#bottom-dock, .pr-peek"))) lastTouch = Date.now(); };
  addEventListener("touchstart", userScroll, { passive: true });
  addEventListener("wheel", userScroll, { passive: true });

  // ---------- 시작 ----------
  function startSummary(style, retry = false) {
    silence();
    clearBody();
    closeScript();
    prefs.style = style;
    savePrefs();
    const s = st = { mode: style, i: 0, sents: null, loading: true };
    openPlayer();
    const cached = scripts[style] && scripts[style].text;
    if (cached && !retry) { s.sents = splitSentences(cached); s.loading = false; speakNow(); return; }
    tts.prime(); // iOS: 이 탭 안에서 소리 잠금 해제 (대본은 네트워크 뒤에 말함)
    render();
    loadScript(style, retry).then(text => {
      if (st !== s) return;
      s.sents = splitSentences(text);
      s.loading = false;
      // 받는 동안 화면이 꺼졌거나 다른 앱으로 갔으면 말하지 않음 (돌아와서 ▶로 첫 문장부터)
      if (document.hidden) { s.playing = false; render(); return; }
      speakNow();
    }, e => {
      if (st !== s) return;
      s.loading = false;
      s.fetchError = true;
      s.error = (e && e.message) || "대본을 받지 못했어요";
      render();
    });
  }
  // 본문 읽기: fromEl(▶를 누른 문단)이나 화면에 보이는 첫 단위부터. lang: ko(번역문 우선) | en
  function startBody(fromEl, lang) {
    if (st && st.mode === "body" && fromEl) {
      const k = st.list.indexOf(fromEl);
      if (k >= 0) {
        st.u = k;
        st.i = 0;
        if (loadUnit(1)) { lastTouch = 0; speakNow(); }
        return;
      }
    }
    silence();
    closeScript();
    const list = units();
    if (!list.length) { UI.toast("읽을 본문이 없습니다"); return; }
    let k = fromEl ? list.indexOf(fromEl) : -1;
    if (k < 0) {
      const top = topEdge();
      k = Math.max(0, firstBelow(list.map(el => {
        const r = el.getBoundingClientRect();
        const ko = !r.height && koOf(el); // 번역 모드에서 숨긴 원문이면 번역의 자리
        return ko ? ko.getBoundingClientRect() : r;
      }), top));
    }
    clearBody();
    st = { mode: "body", lang, list, u: k, i: 0 };
    openPlayer();
    if (!loadUnit(1)) { st.ended = true; render(); return; }
    lastTouch = 0;
    speakNow(); // 탭 안에서 바로 (iOS)
  }
  // 문단마다 ▶ (여기부터 듣기): 재생기가 열려 있는 동안 (요약을 듣다가도 원하는 문단부터 읽기로)
  // 본문 읽기 중이면 그 언어로, 아니면 번역 모드에서는 번역문, 원문 모드에서는 영어
  const hereLang = () => (st && st.mode === "body" ? st.lang : trMode() !== "orig" ? "ko" : "en");
  function addHere() {
    if (hereBtns.length) return;
    for (const el of units()) {
      if (!el.matches(".ltx_p")) continue;
      const b = h("button", { type: "button", class: "as-here", "aria-label": "여기부터 듣기", title: "여기부터 듣기", text: G.play });
      b.addEventListener("click", () => startBody(el, hereLang()));
      A.insertUI(el, b, "beforebegin");
      hereBtns.push(b);
    }
  }
  function removeHere() { for (const b of hereBtns) b.remove(); hereBtns = []; }
  function clearBody() {
    A.clear("as-sentence");
    if (readingEl) readingEl.classList.remove("as-reading");
    readingEl = null;
  }
  function stopAll() {
    silence();
    clearBody();
    closeScript();
    hidePop();
    removeHere();
    st = null;
    const slot = UI.bottomSlot(OWNER);
    if (slot) slot.replaceChildren();
    ui = null;
    barBtn.setActive(false);
  }

  // ---------- 재생기 (아래쪽 줄 위, PaperUI.bottomSlot) ----------
  function openPlayer() {
    const slot = UI.bottomSlot(OWNER);
    if (!slot) return;
    barBtn.setActive(true);
    addHere();
    if (ui) return;
    const btn = (cls, label, text, onclick) => h("button", { type: "button", class: cls, "aria-label": label, title: label, text, onclick });
    const curText = h("span", { class: "as-cur-text" });
    ui = {
      mode: h("b", { class: "as-mode" }),
      pos: h("span", { class: "as-pos" }),
      curText,
      cur: h("button", { type: "button", class: "as-cur", title: "이 문장 하이라이트·질문", onclick: showPop }, curText),
      play: btn("as-play", "재생", G.play, toggle),
      rate: btn("as-rate", "읽기 속도", "", () => setRate(nextRate(prefs.rate))),
      script: btn("as-script-btn", "대본 보기", "대본", openScript),
      popText: h("span", { class: "as-pop-text" }),
      hl: btn("as-hl", "이 문장 하이라이트", "✎ 이 문장 하이라이트", () => popAction("hl")),
      ask: btn("as-ask", "이 문장 질문", "? 질문", () => popAction("ask")),
    };
    ui.pop = h("div", { class: "as-pop", hidden: true }, ui.popText, h("span", { class: "as-pop-btns" }, ui.hl, ui.ask));
    ui.pop.addEventListener("pointerdown", () => { clearTimeout(popTimer); popTimer = setTimeout(hidePop, 5000); });
    slot.replaceChildren(h("div", { class: "as-player", role: "region", "aria-label": "듣기 재생기" },
      ui.pop,
      h("div", { class: "as-top" }, ui.mode, ui.pos, btn("as-x", "듣기 닫기", "✕", stopAll)),
      ui.cur,
      h("div", { class: "as-ctl" },
        btn("as-prev", "이전 문장", G.prev, () => step(-1)), ui.play, btn("as-next", "다음 문장", G.next, () => step(1)),
        ui.rate, ui.script)));
  }
  const ERRORS = {
    "not-allowed": "브라우저가 소리를 막았어요. ▶를 눌러 주세요",
    "language-unavailable": "이 언어의 음성이 없어요 (기기 설정에서 음성 설치)",
    "voice-unavailable": "이 언어의 음성이 없어요 (기기 설정에서 음성 설치)",
    "unsupported": "이 브라우저는 소리 내어 읽기를 지원하지 않아요",
  };
  function render() {
    if (!st || !ui) return;
    const sents = sentsOf(st);
    ui.mode.textContent = st.mode === "body" ? (st.unit && st.unit.ko ? "번역문 듣기" : "본문 읽기") : STYLE_LABEL[st.mode];
    ui.pos.textContent = st.mode === "body" ? `문단 ${st.u + 1}/${st.list.length}` : sents.length ? `${st.i + 1}/${sents.length}` : "";
    ui.curText.textContent = st.loading ? "대본을 만드는 중… (처음 한 번만, 몇 초 걸려요)"
      : st.error ? (st.fetchError ? `${st.error} · ▶ 다시` : ERRORS[st.error] || `읽기 오류 (${st.error}) · ▶ 다시`)
        : st.ended ? "끝까지 들었어요 · ▶ 처음부터" : sents[st.i] || "";
    ui.cur.disabled = !!(st.loading || st.error || st.ended);
    ui.play.textContent = st.playing ? G.pause : G.play;
    ui.play.setAttribute("aria-label", st.playing ? "일시정지" : "재생");
    ui.play.disabled = !!st.loading;
    ui.rate.textContent = rateLabel(prefs.rate);
    ui.script.hidden = st.mode === "body" || !st.sents;
  }

  // ---------- 5초 미니 팝업: 이 문장 하이라이트 / 질문 ----------
  // 대상은 탭한 순간 듣던 문장 (문장이 막 바뀐 직후 1.2초 안이면 바로 전 문장)
  function showPop() {
    if (!st || !ui || st.loading || st.error || !st.last) return;
    const t = st.prev && Date.now() - st.last.at < 1200 ? st.prev : st.last;
    const body = st.mode === "body";
    const s = body ? t.unit.sents[t.i] : { speech: (st.sents || [])[t.i] };
    if (!s || !s.speech) return;
    ui.pop.target = { body, unit: body ? t.unit : null, i: t.i, s };
    ui.popText.textContent = s.speech.length > 90 ? `${s.speech.slice(0, 88)}…` : s.speech;
    ui.hl.hidden = !(body && App.feature("highlights-notes") && App.feature("highlights-notes").add);
    ui.pop.hidden = false;
    clearTimeout(popTimer);
    popTimer = setTimeout(hidePop, 5000);
  }
  function hidePop() {
    clearTimeout(popTimer);
    if (ui) { ui.pop.hidden = true; ui.pop.target = null; }
  }
  // 영어 원문 범위: 번역문이면 같은 번호의 영어 문장 (문장 칸 .tr-s가 있으면 칸의 쌍 번호, 없으면 문장 번호),
  // 개수가 맞지 않으면 단위 전체
  function enRange(t) {
    const u = t.unit;
    if (!u.ko) return rangeOf(t.s);
    const en = prepUnit(u.el, "en");
    const [k, n] = t.s.pair != null ? [t.s.pair, u.pairs] : [t.i, u.sents.length];
    const r0 = en.sents.length === n ? rangeOf(en.sents[k]) : null;
    if (r0 && !r0.collapsed) return r0;
    const r = document.createRange();
    r.selectNodeContents(u.el);
    return r;
  }
  function popAction(kind) {
    const t = ui && ui.pop.target;
    hidePop();
    if (!t) return;
    if (kind === "hl") {
      const hn = App.feature("highlights-notes");
      const r = hn && hn.add ? enRange(t) : null;
      let id = null;
      try { id = r ? hn.add({ range: r, source: OWNER }) : null; } catch (e) { console.error("[audio-summary]", e); }
      if (id == null) UI.toast("이 문장은 하이라이트할 수 없어요");
      return;
    }
    pause();
    if (!t.body) {
      App.openSheet({ quote: t.s.speech, selection: t.s.speech, section: "오디오 요약 대본" });
      return;
    }
    const r = enRange(t), q = r ? A.rangeToQuote(r) : null;
    const sel = (q && q.quote) || t.s.speech;
    const para = t.unit.el.closest(".ltx_para") || t.unit.el, sec = t.unit.el.closest("section");
    const title = sec ? [...sec.children].find(c => c.classList.contains("ltx_title")) : null;
    App.openSheet({
      quote: t.unit.ko ? t.s.speech : sel, selection: sel,
      context: A.clipAround(A.textOf(para), sel, 1500), section: title ? A.textOf(title) : "",
    });
  }

  // ---------- 대본 peek (요약·비평): 지금 문장 표시, 문장을 누르면 거기부터 ----------
  function openScript() {
    if (!st || !st.sents) return;
    const style = st.mode, text = scripts[style] && scripts[style].text;
    const play = k => { if (st && st.mode === style) { st.i = k; speakNow(); } };
    // 문장이 문단처럼 이어지도록 span (button은 inline-block이 됨) + 키보드
    const box = h("div", { class: "as-script" }, st.sents.map((s, k) => h("span", {
      class: "as-s", role: "button", tabindex: "0", dataset: { i: k }, text: s, onclick: () => play(k),
      onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); play(k); } },
    })));
    scriptPeek = UI.peek({
      title: `대본 · ${STYLE_LABEL[style]}`, size: "large", className: "as-script-peek",
      body: h("div", {}, box, h("div", { class: "as-fb" }, h("span", { text: "이 대본 어땠나요?" }), UI.feedback(OWNER, style))),
      actions: text ? [{ label: "복사", onClick: () => UI.copy(text) }] : [],
      onClose: () => { scriptPeek = null; },
    });
    markScript();
  }
  function closeScript() { if (scriptPeek) scriptPeek("close"); scriptPeek = null; }
  function markScript() {
    if (!scriptPeek || !st) return;
    scriptPeek.el.querySelectorAll(".as-s").forEach(el => {
      const on = Number(el.dataset.i) === st.i;
      el.classList.toggle("as-now", on);
      if (on) el.scrollIntoView({ block: "nearest" });
    });
  }

  // ---------- 고르기 peek ('듣기') ----------
  function voiceHint() {
    const synth = window.speechSynthesis;
    if (!tts.supported) return "이 브라우저는 소리 내어 읽기를 지원하지 않아요. 대본은 글로 볼 수 있어요.";
    let n = 0;
    try { n = synth.getVoices().length; } catch { /* 무시 */ }
    if (n && !tts.voiceFor("ko-KR")) return "한국어 음성이 없어요. 기기 설정의 텍스트 음성 변환에서 한국어 음성을 설치하세요.";
    return "";
  }
  function openChooser() {
    const mode = trMode();
    let close = null;
    const go = fn => () => { close && close("as-start"); fn(); };
    const opt = (id, label, sub, fn) => h("button", { type: "button", class: "as-opt", dataset: { id }, onclick: go(fn) },
      h("b", { text: label }), h("span", { class: "as-sub", text: sub }), h("span", { class: "as-ready" }));
    const opts = [
      opt("brief", "요약 듣기", "약 3분 · 한국어로 논문 전체 개요", () => startSummary("brief")),
      opt("critique", "비평 듣기", "리뷰어 관점의 강점·약점", () => startSummary("critique")),
    ];
    if (tts.supported) {
      if (mode !== "orig") opts.push(opt("body-ko", "번역문 듣기", "지금 보는 곳부터 · 한국어 번역 (번역 전 문단은 영어)", () => startBody(null, "ko")));
      opts.push(opt("body", mode !== "orig" ? "원문 읽기" : "본문 읽기", "지금 보는 곳부터 · 영어 원문, 문장마다 표시", () => startBody(null, "en")));
    }
    const rates = h("div", { class: "as-rates", role: "group", "aria-label": "읽기 속도" }, h("span", { text: "속도" }),
      RATES.map(r => h("button", { type: "button", text: rateLabel(r), dataset: { rate: r }, "aria-pressed": String(r === prefs.rate), onclick: () => setRate(r) })));
    const tip = mode === "orig" && App.has("section-translate") ? "번역 모드를 켜면 한국어 번역문도 들을 수 있어요." : "";
    const hint = h("p", { class: "as-hint", text: [voiceHint(), tip].filter(Boolean).join(" ") });
    const box = h("div", { class: "as-chooser" }, h("div", { class: "as-opts" }, opts), rates, hint);
    close = UI.peek({ title: "듣기", body: box, className: "as-peek", onClose: () => { onVoices = null; } });
    const markReady = () => {
      for (const s of ["brief", "critique"]) {
        const el = box.querySelector(`.as-opt[data-id="${s}"] .as-ready`);
        if (el) el.textContent = scripts[s] && scripts[s].text ? "준비됨" : "";
      }
    };
    markReady();
    onVoices = () => { hint.textContent = [voiceHint(), tip].filter(Boolean).join(" "); };
    // 마지막으로 들은 스타일의 대본을 미리 받아 둠 (고르는 동안 생성 → 누르면 바로 재생)
    loadScript(prefs.style).then(markReady, () => {});
  }
  let onVoices = null;
  try { window.speechSynthesis && window.speechSynthesis.addEventListener("voiceschanged", () => onVoices && onVoices()); } catch { /* 무시 */ }

  const barBtn = UI.addBarButton({ id: OWNER, label: "듣기", icon: "🎧", title: "듣기", onClick: openChooser });

  // ---------- 페이지 숨김·번역 변경·음성 질문 ----------
  // 화면이 꺼지거나 다른 앱으로 가면 일시정지 (speechSynthesis는 미디어가 아니라 백그라운드에서 멈춤) → ▶로 같은 문장부터
  document.addEventListener("visibilitychange", () => { if (document.hidden) pause(); });
  // 번역문 DOM이 다시 그려지면 지금 단위를 다시 준비해서 칠하기 (raw Range는 끊어짐)
  function refreshKo() {
    if (!st || st.mode !== "body" || !st.unit || !st.unit.ko || st.unit.root.isConnected) return;
    const p = prepUnit(st.unit.el, st.lang);
    if (p.ko && p.sents.length === st.unit.sents.length) { st.unit = p; onSentence(); } else A.clear("as-sentence");
  }
  App.on("translations", refreshKo);
  App.on("dom-changed", refreshKo);
  // 음성으로 한 질문의 답은 소리로 (hands-free). answer-tools가 있으면 그쪽이 읽음
  App.on("answer-done", d => {
    if (!d || d.restored || d.via !== "voice" || App.has("answer-tools")) return;
    const text = stripMarkdown(d.text);
    if (text) tts.speak(splitSentences(text), { owner: `${OWNER}:answer`, lang: "ko-KR", rate: prefs.rate });
  });
})();
