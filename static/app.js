const askBtn = document.getElementById("ask-btn");
const sheet = document.getElementById("sheet");
const quote = document.getElementById("quote");
const answer = document.getElementById("answer");
const qInput = document.getElementById("q");
let selection = "";
let history = [];  // 이 시트 세션의 이전 대화 [{role, content}]
let controller;

// 텍스트 선택 → "질문하기" 버튼 표시
document.addEventListener("selectionchange", () => {
  const s = document.getSelection().toString().trim();
  if (s && sheet.hidden) { selection = s; askBtn.hidden = false; }
  else if (!s) askBtn.hidden = true;
});

// 새 선택으로 열거나 닫을 때 대화 초기화
function resetSession() {
  controller?.abort();
  history = [];
  answer.replaceChildren();
}

askBtn.addEventListener("click", () => {
  resetSession();
  quote.textContent = selection;
  quote.hidden = !selection;
  sheet.hidden = false;
  askBtn.hidden = true;
});

document.getElementById("close").addEventListener("click", () => {
  resetSession();
  sheet.hidden = true;
  document.getSelection().removeAllRanges();
});

document.querySelectorAll(".presets button").forEach(b =>
  b.addEventListener("click", () => ask(b.dataset.q)));

document.getElementById("ask-form").addEventListener("submit", e => {
  e.preventDefault();
  if (qInput.value.trim()) ask(qInput.value.trim());
  qInput.value = "";
});

// 답변 표시: 마크다운+수식 렌더링 (render.js 로드 실패 시 일반 텍스트)
function setAnswerText(el, text) {
  window.renderAnswer ? renderAnswer(el, text) : (el.textContent = text);
}

// 질문 말풍선 + 답변 칸을 추가하고 답변 칸을 반환
function addTurn(question) {
  const turn = document.createElement("div");
  turn.className = "turn";
  const q = document.createElement("div");
  q.className = "q";
  q.textContent = question;
  const a = document.createElement("div");
  a.className = "a";
  turn.append(q, a);
  answer.append(turn);
  turn.scrollIntoView({ block: "nearest" });
  return a;
}

async function ask(question) {
  controller?.abort();
  const ctrl = controller = new AbortController();
  const a = addTurn(question);
  setAnswerText(a, "…");
  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ arxiv_id: ARXIV_ID, selection, question, history }),
      signal: ctrl.signal,
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    setAnswerText(a, text);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      setAnswerText(a, text);
    }
    if (res.ok && text) history.push({ role: "user", content: question }, { role: "assistant", content: text });
  } catch (e) {
    if (e.name !== "AbortError") throw e;
    a.parentElement.remove();  // 중단된 턴은 기록에 없으니 화면에서도 제거
  }
}
