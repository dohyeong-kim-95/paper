// answer-tools: 답변 근거 문장 칩(📍 본문 보기 → 그 문장으로 점프) + 답변 도구(복사·읽어주기·공유·👍👎)
(function () {
  "use strict";
  // ---------- 순수 함수 (node 테스트 대상) ----------
  // 질문 끝에 붙는 근거 요청. 기록(history)에 바뀐 질문 그대로 남으므로 다음 턴 앞부분도 같은 바이트 (캐시 적중)
  const EVIDENCE_ASK = '\n\n(답변 맨 끝에 근거가 된 본문 문장을 근거: "영어 원문 그대로 6~15단어" 형식으로 1~2줄. 수식 없는 구간으로.)';
  const EVIDENCE_ENDPOINTS = ["/api/ask", "/api/figure-explain/ask"];
  // 번역·뜻은 근거가 곧 선택한 문장 → 군더더기 (뜻 답은 vocab이 그대로 단어장에 저장하므로 근거 줄이 남지 않게)
  const NO_EVIDENCE_PRESETS = ["translate", "meaning"];
  const MAX_QUOTES = 3;
  const MIN_CHIP_WORDS = 4; // 이보다 짧은 인용은 본문 아무 데서나 맞음 (단어 안·URL 안) → 칩 없이 흐리게

  // 질문 훅: 질문에 근거 요청을 한 번만 덧붙임 (이미 들어 있으면 그대로)
  function withEvidence(payload, meta = {}) {
    const q = String((payload && payload.question) || "");
    if (!q.trim() || !EVIDENCE_ENDPOINTS.includes(meta.endpoint) || NO_EVIDENCE_PRESETS.includes(meta.presetId)) return payload;
    if (q.includes(EVIDENCE_ASK.trim())) return payload;
    return { ...payload, question: q + EVIDENCE_ASK };
  }

  // '근거: "..."' 줄 (앞 기호·굵게·괄호 허용), '근거:'만 있는 머리줄, 그 아래 따옴표로 시작하는 줄
  const EV_HEAD = /^[\s>*_\-•·([]*(?:\d+[.)]\s*)?(?:📍\s*)?근거(?:\s*문장)?\s*\d*\s*[*_]*\s*[:：]\s*[*_]*\s*(.*)$/;
  const EV_BARE = /^[\s>*_\-•·([#]*(?:📍\s*)?근거(?:\s*문장)?[\s*_]*[:：]?[\s*_)\]]*$/;
  const MARKER = /^\s*(?:[-*+•·>]|\d+[.)])?\s*/;
  const EV_CONT = /^\s*(?:[-*+•·>]|\d+[.)])?\s*["“„「『'‘]/;
  const LISTED = /^\s*(?:[-*+•·>]|\d+[.)])\s/;
  const FENCE = /^\s*(```|~~~)/;
  const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/;
  // 인용을 뺀 나머지에 있어도 되는 것: 공백·구두점·강조 기호·구분자(— / |)·번호·'및/그리고/또는/and/or'
  const CONJ = /(^|\s)(?:및|그리고|또는|and|or)(?=\s|$)/g;
  const FILLER = /\d+[.)]|[\s.,;:!?·•、。，*_~`'"‘’\-–—―/|()[\]（）]+/g;
  const GLOSS = /[(（][^()（）]*[)）][\s.*_]*$/; // 맨 끝 괄호 설명: (3절), (희소 전문가 혼합)

  // 인용 다듬기: 말줄임표로 끊긴 인용은 가장 긴 조각, 앞뒤 따옴표·강조·끝 구두점 제거 (본문 정확 일치용).
  // 둥근 작은따옴표(‘ ’)는 앞뒤에서만 뗌 (가운데 ’는 아포스트로피)
  function cleanQuote(s) {
    const parts = String(s).split(/\s*(?:\.\.\.|…)\s*/).map(x => x.trim()).filter(Boolean);
    const longest = parts.reduce((a, b) => (b.length > a.length ? b : a), "");
    return longest.replace(/^[\s'"`*_‘’‚‛]+/, "").replace(/[\s'"`*_‘’‚‛.,;:!?]+$/, "");
  }
  // 줄 내용이 '인용만'이면 인용 목록, 아니면 null (따옴표 친 영어 용어가 섞인 한국어 문장은 본문).
  // 인용 밖 글자는 4자 이하(예: '…"라는 문장')이고 인용이 4단어 이상일 때만 봐줌.
  // 따옴표가 없으면 한글 없는 영어 3단어 이상일 때만 전체를 인용으로
  function evidenceQuotes(rest) {
    const t = String(rest || "").replace(/[“”„‟″「」『』]/g, '"');
    const spans = [...t.matchAll(/"([^"]+)"/g)];
    if (spans.length) {
      const qs = spans.map(m => cleanQuote(m[1])).filter(Boolean);
      const left = t.replace(/"[^"]+"/g, " ").replace(GLOSS, " ").replace(CONJ, "$1").replace(FILLER, "");
      const words = qs.reduce((n, q) => n + q.split(/\s+/).length, 0);
      return !left || ([...left].length <= 4 && words >= MIN_CHIP_WORDS) ? qs : null;
    }
    const bare = cleanQuote(t.replace(GLOSS, "").replace(/^[\s(（]+|[\s)）]+$/g, ""));
    return bare && !HANGUL.test(bare) && /[A-Za-z]/.test(bare) && bare.split(/\s+/).length >= 3 ? [bare] : null;
  }
  // 칩(본문 점프)으로 보여줄 만한 인용: 4단어 이상 영어
  const chipWorthy = q => !HANGUL.test(q) && String(q).split(/\s+/).filter(Boolean).length >= MIN_CHIP_WORDS;

  // 답변 → {body: 근거 줄을 뺀 본문, quotes: [인용], removed: 뺀 줄 수}. 코드 블록 안은 건드리지 않음.
  // 근거 묶음: 근거 줄(또는 '근거:' 머리줄) + 바로 아래 인용만 있는 줄들. 빈 줄 뒤에는 목록 인용만 이어짐
  function splitEvidence(text) {
    const kept = [], quotes = [];
    let fence = false, inEv = false, gap = false, cut = false, removed = 0, bareAt = -1;
    // '근거:' 머리줄만 있던 줄은 아래에 인용이 오면 그때 뺌 (인용이 안 오면 제목으로 남김)
    const dropBare = () => { if (bareAt >= 0) { kept.splice(bareAt, 1); removed++; bareAt = -1; } };
    const take = qs => { quotes.push(...qs); removed++; dropBare(); inEv = true; gap = false; cut = true; };
    // 근거 묶음이 끝남: 뺀 줄·빈 줄 자리에 문단 구분 하나 (marked breaks:true에서 앞 문단에 붙지 않게)
    const endEv = () => {
      if (inEv && (gap || cut) && kept.length && kept[kept.length - 1].trim()) kept.push("");
      inEv = gap = cut = false; bareAt = -1;
    };
    for (const line of String(text || "").split("\n")) {
      if (FENCE.test(line)) { endEv(); fence = !fence; kept.push(line); continue; }
      if (fence) { kept.push(line); continue; }
      const m = line.match(EV_HEAD);
      if (m || EV_BARE.test(line)) {
        const content = m ? m[1] : "";
        const meaningful = !!content.replace(/[\s*_)\]]/g, "");
        const qs = meaningful ? evidenceQuotes(content) : [];
        // 내용이 인용만이 아닌 줄(예: '근거: 2절 실험', '**근거:** 저자들은 "MoE"가 …')은 본문에 남김
        if (!qs) { endEv(); kept.push(line); continue; }
        if (meaningful) { take(qs); continue; } // 인용 줄 ('근거: "…"'처럼 비어도 뺌)
        dropBare(); endEv(); kept.push(line); bareAt = kept.length - 1; inEv = true;
        continue;
      }
      if (inEv) {
        if (!line.trim()) { gap = true; continue; }
        // 빈 줄 뒤에는 목록 인용(또는 아직 인용이 없는 머리줄 아래 첫 인용)만 이어감 → 뒤 문단은 본문
        if (EV_CONT.test(line) && (!gap || LISTED.test(line) || bareAt >= 0)) {
          const qs = evidenceQuotes(line.replace(MARKER, ""));
          if (qs) { take(qs); continue; }
        }
        endEv();
      }
      kept.push(line);
    }
    // 근거 앞에 둔 구분선(---)·빈 줄 정리
    while (removed && kept.length && /^[\s\-*_]*$/.test(kept[kept.length - 1])) kept.pop();
    const seen = new Set();
    const uniq = quotes.filter(q => { const k = q.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    return { body: removed ? kept.join("\n").trimEnd() : String(text || ""), quotes: uniq.slice(0, MAX_QUOTES), removed };
  }
  const parseEvidence = text => splitEvidence(text).quotes;

  // 읽어주기용 텍스트: 근거 줄 빼고 Markdown 기호 제거, 수식은 '수식', 코드 블록은 '코드 생략'
  function speakable(text) {
    const t = splitEvidence(text).body
      .replace(/```[\s\S]*?(?:```|$)/g, " 코드 생략 ")
      .replace(/\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)/g, " 수식 ")
      .replace(/(?<!\\)\$(?=\S)[^$\n]*?[^\s\\$]\$(?!\d)/g, " 수식 ")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<[^>\n]+>/g, " ")
      .replace(/`([^`\n]*)`/g, "$1")
      .replace(/^[ \t]*(?:(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+)+/gm, "")
      .replace(/^[ \t]*\|?[ \t:|-]*-[ \t:|-]*\|?[ \t]*$/gm, "") // 표 구분선·가로줄
      .replace(/\|/g, " ")
      .replace(/\*\*|__|~~/g, "")
      .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?!\w)/g, "$1$2");
    return t.split("\n").map(l => l.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n");
  }

  const api = { EVIDENCE_ASK, EVIDENCE_ENDPOINTS, NO_EVIDENCE_PRESETS, withEvidence, splitEvidence, parseEvidence, evidenceQuotes, cleanQuote, chipWorthy, speakable };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;           // node: 여기서 끝
  if (document.body.dataset.page !== "paper") return;
  PaperApp.registerFeature("answer-tools", api);

  const UI = window.PaperUI, A = window.PaperAnchor, h = UI.h, tts = PaperApp.tts;
  const OWNER = "answer-tools";
  const renderNow = (el, text) => (window.renderAnswerNow ? renderAnswerNow(el, text) : (el.textContent = text));

  PaperApp.addAskHook(withEvidence);

  // ---------- 근거 칩: 근거 줄을 답변에서 빼고(.a 다시 그림) 칩은 도구 줄 슬롯에. 복원된 턴도 같게 (네트워크 없음) ----------
  // 그릴 때는 본문에서 찾지 않음 (긴 논문은 색인 정규화가 수 초: 모든 답·복원마다 막힘). 누를 때 찾고, 없으면 흐린 글로 바꿈
  const MISS = "본문에서 찾지 못한 인용", SHORT = "짧은 인용이라 본문 위치를 찾지 않음";
  const muted = (quote, title) =>
    h("span", { class: "at-ev-miss", lang: HANGUL.test(quote) ? null : "en", title, text: `근거 “${quote}”` });
  function jump(quote, btn) {
    const r = A.findQuote(quote); // 누를 때 찾음 (그사이 본문 DOM이 바뀌었을 수 있음)
    if (!r) { UI.toast("본문에서 이 문장을 찾지 못했습니다"); btn.replaceWith(muted(quote, MISS)); return; }
    PaperApp.minimizeSheet(); // '답변 보기'로 돌아옴
    PaperNav.jumpTo(r);       // '↩ 돌아가기'로 읽던 곳
  }
  function evidenceItem(quote) {
    if (!chipWorthy(quote)) return muted(quote, SHORT);
    const btn = h("button", { type: "button", class: "at-ev-chip", "aria-label": `본문 보기: ${quote}` },
      h("span", { class: "at-ev-pin", text: "📍 본문 보기" }), h("span", { class: "at-ev-q", lang: "en", text: `“${quote}”` }));
    btn.addEventListener("click", () => jump(quote, btn));
    return btn;
  }
  PaperApp.addAnswerAction({
    id: "evidence-chips",
    render(d) {
      const { body, quotes, removed } = splitEvidence(d.text);
      if (!removed) return null;
      renderNow(d.answerEl, body);
      return quotes.length ? h("div", { class: "at-ev", role: "group", "aria-label": "답변 근거" }, quotes.map(evidenceItem)) : null;
    },
  });

  // ---------- 답변 도구: 복사 · 읽어주기 · 공유 · 👍👎 ----------
  let speakingBtn = null;
  function setSpeaking(btn, on) {
    btn.textContent = on ? "■ 그만 읽기" : "🔊 읽어주기";
    btn.setAttribute("aria-pressed", String(on));
    if (on) speakingBtn = btn; else if (speakingBtn === btn) speakingBtn = null;
  }
  // 탭 핸들러 안에서 동기로 불러야 iOS에서 소리 남 (음성 질문의 자동 읽기는 voice.js가 마이크 탭에서 prime)
  function startSpeak(btn, text) {
    const t = speakable(text);
    if (!t) return;
    if (tts.speak(t, { lang: "ko-KR", owner: OWNER, onEnd: () => setSpeaking(btn, false) })) setSpeaking(btn, true);
  }
  PaperApp.addAnswerAction({
    id: "answer-actions",
    render(d) {
      const text = d.text || "";
      if (!text.trim()) return null;
      const row = h("span", { class: "at-actions" });
      row.append(h("button", { type: "button", text: "복사", onclick: () => UI.copy(text) }));
      let ttsBtn = null;
      if (tts.supported) {
        ttsBtn = h("button", { type: "button", class: "at-tts", "aria-pressed": "false", text: "🔊 읽어주기" });
        ttsBtn.addEventListener("click", () => (speakingBtn === ttsBtn ? tts.stop("user") : startSpeak(ttsBtn, text)));
        row.append(ttsBtn);
      }
      // 공유 시트가 없으면(데스크톱) 복사와 같으므로 숨김
      if (navigator.share) {
        const q = d.shown ? `Q. ${d.shown}\n\n` : "";
        row.append(h("button", { type: "button", text: "공유", onclick: () => UI.share({ title: document.title, text: q + text }) }));
      }
      const target = `${(d.session && d.session.threadId) || "t"}:${d.turn}`;
      row.append(UI.feedback("answer", target, {
        label: String(d.presetId || d.label || d.via || "").slice(0, 100),
        question: d.shown || d.question || "", answerLen: text.length,
      }));
      // 음성으로 물은 답은 바로 읽어줌 (핸즈프리)
      if (ttsBtn && d.via === "voice" && !d.restored) startSpeak(ttsBtn, text);
      return row;
    },
  });
  // 읽던 답변이 화면에서 사라지면(시트 닫기·새 대화·새 질문) 읽기도 멈춤. 내려두기는 계속 읽음
  const stopMine = reason => { if (tts.owner === OWNER) tts.stop(reason); };
  PaperApp.on("sheet-close", d => d && d.reason === "close" && stopMine("sheet"));
  PaperApp.on("sheet-open", d => d && !d.restored && stopMine("sheet"));
  PaperApp.on("ask", () => stopMine("ask"));
})();
