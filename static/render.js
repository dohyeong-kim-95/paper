// 답변 렌더링: Markdown -> DOMPurify -> KaTeX. 스트리밍 청크마다 호출해도 되도록 rAF로 묶음.
(() => {
  // 코드(``` 블록, `인라인`)는 그대로 두고, 그 밖의 $$...$$ / $...$ 만 보호.
  // 인라인 $는 pandoc 규칙: 여는 $ 뒤·닫는 $ 앞에 공백 없음, 닫는 $ 뒤에 숫자 없음 ("$5 and $10" 방지)
  const TOKEN_RE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)|(\$\$[\s\S]+?\$\$|(?<!\\)\$(?=\S)[^$\n]*?[^\s\\$]\$(?!\d))/g;
  const PH_RE = /\uE000(\d+)\uE001/g; // 사용자 영역 문자라 marked가 건드리지 않음
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  const KATEX_OPTS = {
    delimiters: [
      { left: "$$", right: "$$", display: true },
      { left: "$", right: "$", display: false },
    ],
    throwOnError: false,
  };
  const mathCache = new Map(); // 수식 원문 -> KaTeX HTML (청크마다 다시 그리지 않게)

  // 수식을 자리표시자로 바꿔 markdown이 _ * \ 등을 망가뜨리지 않게 함
  function protect(text) {
    const math = [];
    const out = text.replace(TOKEN_RE, (m, code) => {
      if (code) return m;
      math.push(m);
      return `\uE000${math.length - 1}\uE001`;
    });
    return { out, math };
  }

  // 자리표시자를 <span class="math">원문</span>으로 복원 (원문은 이스케이프된 텍스트)
  function restore(html, math) {
    return html.replace(PH_RE, (_, i) =>
      `<span class="math">${math[i].replace(/[&<>"]/g, c => ESC[c])}</span>`);
  }

  function renderMath(el) {
    if (!window.renderMathInElement) return;
    for (const span of el.querySelectorAll("span.math")) {
      const src = span.textContent;
      const hit = mathCache.get(src);
      if (hit !== undefined) { span.innerHTML = hit; continue; }
      // .math 안에서만 auto-render를 돌려서 본문의 흩어진 $는 수식으로 잡지 않음
      renderMathInElement(span, KATEX_OPTS);
      if (mathCache.size > 500) mathCache.clear();
      mathCache.set(src, span.innerHTML);
    }
  }

  function render(el, text) {
    const ok = window.marked && window.DOMPurify; // CDN 실패 시 일반 텍스트
    el.style.whiteSpace = ok ? "" : "pre-wrap";
    if (!ok) { el.textContent = text; return; }
    const { out, math } = protect(text);
    el.innerHTML = DOMPurify.sanitize(restore(marked.parse(out, { breaks: true }), math));
    renderMath(el);
  }

  const queue = new Map(); // el -> 최신 text (한 프레임에 요소별로 한 번만 렌더)
  function flush() {
    for (const [el, text] of queue) render(el, text);
    queue.clear();
  }

  window.renderAnswer = (el, text) => {
    if (!queue.size) requestAnimationFrame(flush);
    queue.set(el, text);
  };
})();
