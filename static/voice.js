// 음성으로 질문하기 (Web Speech API). 미지원 브라우저에선 마이크 버튼을 숨김
{
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = document.getElementById("mic");
  const input = document.getElementById("q");
  const form = document.getElementById("ask-form");

  if (!SR) mic.hidden = true;
  else {
    const rec = new SR();
    rec.lang = "ko-KR";
    rec.interimResults = true;  // 말하는 동안 입력창에 실시간 표시
    let finalText = "";

    mic.addEventListener("click", () => {
      if (mic.classList.contains("recording")) return rec.stop();
      finalText = "";
      rec.start();
    });

    rec.onstart = () => mic.classList.add("recording");
    rec.onresult = e => {
      const results = [...e.results];
      input.value = results.map(r => r[0].transcript).join("");
      finalText = results.filter(r => r.isFinal).map(r => r[0].transcript).join("").trim();
    };
    // 인식이 끝나고 확정된 문장이 있으면 바로 질문 전송
    rec.onend = () => {
      mic.classList.remove("recording");
      if (finalText) form.requestSubmit();
    };
  }
}
