// ask-paper: 선택 없이 논문 전체에 질문 (FAB + 시작 질문 칩) + 답변마다 추천 후속 질문 칩
(function () {
  "use strict";
  // ---------- 순수 함수 (node 테스트 대상) ----------
  // 시작 질문: label은 칩 글자, q는 실제로 보내는 질문
  const STARTERS = [
    { id: "ask-paper:contrib", label: "핵심 기여는?", q: "이 논문의 핵심 기여를 정리해줘" },
    { id: "ask-paper:limits", label: "한계점은?", q: "이 논문의 한계점과 약점은 뭐야?" },
    { id: "ask-paper:setup", label: "실험 설정 요약", q: "실험 설정(데이터셋, 비교 대상, 평가 지표, 주요 하이퍼파라미터)을 요약해줘" },
    { id: "ask-paper:prior", label: "기존 연구와 차이", q: "기존 연구와 비교해 이 논문이 무엇이 다른지 알려줘" },
    { id: "ask-paper:use", label: "내 연구에 어떻게 쓸까?", q: "이 논문의 아이디어를 내 연구에 어떻게 응용할 수 있을까?" },
    { id: "ask-paper:defend", label: "저자 입장에서 약점 방어", q: "리뷰어가 지적할 만한 약점을 꼽고, 저자 입장에서 각각 어떻게 방어할지 알려줘" },
  ];
  const ENDPOINT = "/api/ask-paper/followups";
  const DELAY = 300; // answer-done 뒤 잠깐 기다림 (바로 다음 질문을 누르면 요청 자체를 안 보냄)
  const MAX = 3, MAX_LEN = 40;

  const norm = s => String(s ?? "").replace(/\s+/g, " ").trim();

  // 후속 질문 요청 본문: 세션의 고정 필드 + 방금 끝난 턴까지의 history (다음 /api/ask와 같은 바이트), question은 비움
  function followupBody(payload, answerText) {
    const p = payload || {};
    return {
      arxiv_id: p.arxiv_id, selection: p.selection || "", context: p.context || "", section: p.section || "",
      question: "",
      history: [
        ...(p.history || []).map(t => ({ role: t.role, content: t.content })),
        { role: "user", content: String(p.question || "") },
        { role: "assistant", content: String(answerText || "") },
      ],
    };
  }

  // 서버 응답 방어: 문자열·짧은 것·중복·이미 물은 질문 제외, 최대 3개
  function cleanFollowups(list, asked = []) {
    if (!Array.isArray(list)) return [];
    const seen = new Set(asked.map(norm));
    const out = [];
    for (const x of list) {
      if (typeof x !== "string") continue;
      const q = norm(x);
      if (!q || q.length > MAX_LEN || seen.has(q)) continue;
      seen.add(q);
      out.push(q);
      if (out.length >= MAX) break;
    }
    return out;
  }

  const api = { STARTERS, ENDPOINT, followupBody, cleanFollowups };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;           // node: 여기서 끝
  if (document.body.dataset.page !== "paper") return;
  PaperApp.registerFeature("ask-paper", api);

  const UI = window.PaperUI, h = UI.h;
  const ORIGIN = "ask-paper";

  // ---------- FAB: 논문 전체에 질문 ----------
  function openPaperChat() {
    const s = PaperApp.session;
    // 내려둔 논문 전체 대화가 있으면 이어서 (새로 열면 그 대화가 사라짐). 새로 하려면 시트의 ✕
    if (s && s.origin === ORIGIN && !PaperApp.isSheetOpen()) { PaperApp.restoreSheet(); return; }
    PaperApp.openSheet({ quote: null, selection: "", presets: STARTERS, title: "논문에 질문", origin: ORIGIN });
  }
  if (document.getElementById("sheet")) {
    UI.addFab({ id: "ask-paper", label: "논문에 질문", icon: "💬", order: 10, onClick: openPaperChat });
  }

  // ---------- 답변마다 추천 후속 질문 칩 (모든 시트 세션) ----------
  let pending = null; // {timer, ctrl}

  function cancel() {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.ctrl.abort();
    pending = null;
  }
  // 지난 턴의 칩은 지움 (새 질문이 시작되면 마지막 답변 아래에만 남김)
  function clearChips() {
    document.querySelectorAll("#answer .ap-followups").forEach(el => el.remove());
  }

  // 시트가 맨 아래까지 내려 있으면 새 칩도 보이게
  function nearBottom() {
    const sh = document.getElementById("sheet");
    return !!sh && !sh.hidden && sh.scrollHeight - sh.scrollTop - sh.clientHeight < 48;
  }

  function renderChips(row, list) {
    const stick = nearBottom();
    row.classList.remove("ap-loading");
    row.removeAttribute("aria-hidden");
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "추천 후속 질문");
    row.replaceChildren(...list.map(q => h("button", {
      type: "button", class: "ap-chip", text: q,
      onclick: () => PaperApp.ask(q, { via: "followup" }),
    })));
    if (stick) row.scrollIntoView({ block: "nearest" });
  }

  async function load(detail, row, ctrl) {
    const body = followupBody(detail.payload, detail.text);
    let list = [];
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.ok) list = await res.json();
    } catch { /* 중단·오프라인: 칩 없음 */ }
    if (ctrl.signal.aborted) return;
    if (pending && pending.ctrl === ctrl) pending = null;
    // 그 사이 시트를 닫았거나 다른 대화로 바뀜
    if (!row.isConnected || PaperApp.session !== detail.session) { row.remove(); return; }
    const asked = body.history.filter(t => t.role === "user").map(t => t.content);
    const qs = cleanFollowups(list, asked);
    if (qs.length) renderChips(row, qs); else row.remove();
  }

  PaperApp.on("answer-done", d => {
    // 복원된 턴(이어 보기·새로고침)은 다시 부르지 않음
    if (!d || d.restored || !d.payload || !d.session || !d.text) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    cancel();
    clearChips();
    const row = h("div", { class: "ap-followups ap-loading", "aria-hidden": "true" },
      h("span", { class: "ap-skel" }), h("span", { class: "ap-skel" }), h("span", { class: "ap-skel" }));
    d.slot("ask-paper").append(row);
    const ctrl = new AbortController();
    pending = { ctrl, timer: setTimeout(() => load(d, row, ctrl), DELAY) };
    ctrl.signal.addEventListener("abort", () => { if (row.classList.contains("ap-loading")) row.remove(); });
  });

  // 새 질문이 시작되면 진행 중인 후속 질문 요청은 버리고 지난 칩도 지움
  PaperApp.on("ask", () => { cancel(); clearChips(); });
  PaperApp.on("sheet-close", d => { if (d && d.reason === "close") cancel(); });
})();
