// 음성으로 질문하기 (Web Speech API). 미지원 브라우저에선 마이크 버튼을 숨김
// 읽어주기(PaperApp.tts)와 동시에 쓰지 않음: 마이크를 켜면 읽기를 멈추고, 읽기가 시작되면 마이크를 끔
(function () {
  "use strict";
  if (typeof document === "undefined") return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = document.getElementById("mic");
  const input = document.getElementById("q");
  const form = document.getElementById("ask-form");
  if (!mic || !input || !form) return;

  if (!SR) { mic.hidden = true; return; }
  const rec = new SR();
  rec.lang = "ko-KR";
  rec.interimResults = true;  // 말하는 동안 입력창에 실시간 표시
  let finalText = "";
  const recording = () => mic.classList.contains("recording");

  mic.addEventListener("click", () => {
    if (recording()) return rec.stop();
    window.PaperApp && PaperApp.tts.stop("mic");
    finalText = "";
    rec.start();
  });

  rec.onstart = () => mic.classList.add("recording");
  rec.onresult = e => {
    const results = [...e.results];
    input.value = results.map(r => r[0].transcript).join("");
    finalText = results.filter(r => r.isFinal).map(r => r[0].transcript).join("").trim();
  };
  // 인식이 끝나고 확정된 문장이 있으면 바로 질문 전송 (via=voice → 답변을 읽어주는 기능이 알 수 있게)
  rec.onend = () => {
    mic.classList.remove("recording");
    if (finalText) {
      form.dataset.via = "voice";
      form.requestSubmit();
    }
  };
  document.addEventListener("paper:tts", e => {
    if (e.detail && e.detail.state === "start" && recording()) rec.stop();
  });
})();
