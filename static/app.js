const askBtn = document.getElementById("ask-btn");
const sheet = document.getElementById("sheet");
const quote = document.getElementById("quote");
const answer = document.getElementById("answer");
const qInput = document.getElementById("q");
let selection = "";

// 텍스트 선택 → "질문하기" 버튼 표시
document.addEventListener("selectionchange", () => {
  const s = document.getSelection().toString().trim();
  if (s && sheet.hidden) { selection = s; askBtn.hidden = false; }
  else if (!s) askBtn.hidden = true;
});

askBtn.addEventListener("click", () => {
  quote.textContent = selection;
  quote.hidden = !selection;
  answer.textContent = "";
  sheet.hidden = false;
  askBtn.hidden = true;
});

document.getElementById("close").addEventListener("click", () => {
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

let controller;
async function ask(question) {
  controller?.abort();
  controller = new AbortController();
  answer.textContent = "…";
  const res = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ arxiv_id: ARXIV_ID, selection, question }),
    signal: controller.signal,
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  answer.textContent = "";
  let raw = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
    window.renderAnswer ? renderAnswer(answer, raw) : (answer.textContent = raw);
  }
}
