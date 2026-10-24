// entry-routes: 문장 딥링크(#q=) 공유·이동, 하이라이트 공유(#s=), 홈 안내(?err=·북마클릿), HTML 없는 논문 초록 페이지
(function () {
  "use strict";
  // ---------- 순수 함수 (node 테스트 대상) ----------
  const QUOTE_MAX = 120;
  const SID_RE = /^[A-Za-z0-9_-]{8,32}$/;
  const SHARE_MAX = 300_000; // 서버 SHARE_MAX와 같게 (보내기 전에 미리 확인)
  const ERRORS = { noid: "공유된 내용에서 arXiv 논문 번호를 찾지 못했어요." };

  // UTF-16 단위로 자르되 이모지 같은 서로게이트 짝을 반으로 가르지 않음 (짝 없는 반쪽은 서버가 UTF-8로 못 씀)
  const cutHead = (s, n) => { const t = String(s ?? "").slice(0, n); return /[\uD800-\uDBFF]$/.test(t) ? t.slice(0, -1) : t; };
  const cutTail = (s, n) => { const t = String(s ?? "").slice(-n); return /^[\uDC00-\uDFFF]/.test(t) ? t.slice(1) : t; };

  // 공백 정리 후 max자 이하로 (단어 중간에서 자르지 않음). 앞부분만 남아도 본문의 부분 문자열이라 findQuote가 찾음
  function clipQuote(text, max = QUOTE_MAX) {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max + 1), i = cut.lastIndexOf(" ");
    return (i > max / 2 ? cut.slice(0, i) : cutHead(t, max)).trim();
  }

  // hay 안에 needle이 몇 번 나오는지 (limit에서 멈춤)
  function countIn(hay, needle, limit = 2) {
    let n = 0;
    if (!needle) return 0;
    for (let i = hay.indexOf(needle); i >= 0 && n < limit; i = hay.indexOf(needle, i + 1)) n++;
    return n;
  }

  // 브라우저 기본 문장 강조 ':~:text=' (Chrome, Safari 16.1+): JS가 오기 전에도 그 문장으로 스크롤·강조.
  // 브라우저는 문서에서 '처음' 나오는 곳(범위 꼴이면 처음 나오는 시작 조각 → 그 뒤 처음 나오는 끝 조각)을 고르므로
  // 그게 바로 이 인용일 때만 붙임. count(s) = 정규화한 본문 색인에서 s가 나오는 횟수 (모르면 붙이지 않음).
  // 인용이 본문에 한 번만 나와야 하고, 길면 앞·끝 조각을 4단어부터 늘려 각각 본문에서 한 번만 나오게 (start,end),
  // 그렇게 안 되면 인용 통째. 값 안의 '-' ',' '&'는 이스케이프. 수식($alttext$)은 화면 글자와 달라 조각에 넣지 않음
  const encTD = s => encodeURIComponent(s).replace(/[-!'()*~]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  function textDirective(quote, count) {
    const q = String(quote || "").replace(/\s+/g, " ").trim();
    if (!q || typeof count !== "function" || count(q) !== 1) return "";
    const w = q.split(" "), n = w.length;
    const uniq = s => !s.includes("$") && count(s) === 1;
    if (n > 8) {
      const head = k => w.slice(0, k).join(" "), tail = k => w.slice(n - k).join(" ");
      let a = 4, b = 4;
      while (a + b < n && !uniq(head(a))) a++;
      while (a + b < n && !uniq(tail(b))) b++;
      if (a + b < n && uniq(head(a)) && uniq(tail(b))) return `text=${encTD(head(a))},${encTD(tail(b))}`;
    }
    return q.includes("$") ? "" : `text=${encTD(q)}`;
  }

  // /paper/<id>#q=<인용>[&p=<앞 문맥>][:~:text=…]. 메신저 링크 인식이 끊기지 않게 ' ( ) ! * ~ 도 이스케이프.
  // 앞 문맥이 있으면(본문에 여러 번 나오는 인용) 브라우저 지시자는 첫 등장으로 가므로 붙이지 않음
  const enc = s => encodeURIComponent(s).replace(/[!'()*~]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  function deepLink(origin, arxivId, quote, prefix = "", count = null) {
    const base = `${origin}/paper/${arxivId}`;
    const q = clipQuote(quote);
    if (!q) return base;
    const td = prefix ? "" : textDirective(q, count);
    return `${base}#q=${enc(q)}${prefix ? `&p=${enc(prefix)}` : ""}${td ? `:~:${td}` : ""}`;
  }

  // '#q=…&p=…' | '#s=<공유 id>' → {q, p, s} | null. ':~:' 뒤는 브라우저가 지우지만 모르는 브라우저에선 남아 있음
  function parseHash(hash) {
    let s = String(hash || "").replace(/^#/, "");
    const i = s.indexOf(":~:");
    if (i >= 0) s = s.slice(0, i);
    if (!/^[qs]=/.test(s)) return null;
    const out = {};
    for (const part of s.split("&")) {
      const j = part.indexOf("=");
      const k = part.slice(0, j);
      if (j < 0 || !["q", "p", "s"].includes(k)) continue;
      try { out[k] = decodeURIComponent(part.slice(j + 1)); } catch { out[k] = part.slice(j + 1); }
    }
    if (out.s && !SID_RE.test(out.s)) delete out.s;
    if (out.q) out.q = out.q.trim();
    return out.q || out.s ? out : null;
  }

  // 인용이 본문에 두 번 이상 나오면 앞 문맥을 링크에 같이 (정규화된 텍스트끼리 비교)
  function needsPrefix(normText, normQuote) {
    const i = normQuote ? normText.indexOf(normQuote) : -1;
    return i >= 0 && normText.indexOf(normQuote, i + 1) >= 0;
  }

  function shareText(quote, max = 280) {
    const t = String(quote || "").replace(/\s+/g, " ").trim();
    return t ? `“${t.length > max ? `${cutHead(t, max - 1)}…` : t}”` : "";
  }

  const errMessage = code => (code ? ERRORS[code] || "논문을 열지 못했어요." : "");

  // 공유 링크 만들기 실패 → 알림 글 (status 0 = 네트워크 오류)
  function shareError(status) {
    if (status === 413) return "보낼 내용이 너무 많아요. 항목 몇 개(특히 긴 Q&A)를 빼 주세요";
    if (status === 429) return "공유 링크를 너무 자주 만들었어요. 잠시 뒤에 다시 해 주세요";
    if (status === 507) return "지금은 공유 링크를 더 만들 수 없어요 (서버 저장 공간)";
    if (status === 400 || status === 422) return "보낼 수 없는 내용이 섞여 있어요";
    if (status >= 500) return "링크를 만들지 못했어요 (서버 오류, 잠시 뒤 다시)";
    return "링크를 만들지 못했어요 (네트워크 확인)";
  }

  // iOS·PC용: 북마크 주소로 저장해 두고 arXiv(alphaXiv·HF 등) 페이지에서 누르면 /share로 열림
  const bookmarklet = origin =>
    `javascript:void(location.href='${origin}/share?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title))`;

  // highlights-notes의 저장된 Q&A (모양이 바뀌어도 견디게): {q, a} | null
  function qaOf(qa) {
    if (!qa) return null;
    if (typeof qa === "string") return { q: "", a: qa };
    if (Array.isArray(qa)) {
      const q = qa.find(t => t && t.role === "user"), a = [...qa].reverse().find(t => t && t.role === "assistant");
      return q || a ? { q: String((q && q.content) || ""), a: String((a && a.content) || "") } : null;
    }
    const q = qa.q ?? qa.question ?? qa.shown ?? "", a = qa.a ?? qa.answer ?? qa.text ?? "";
    return q || a ? { q: String(q), a: String(a) } : null;
  }

  // pr:highlights-notes:<baseId> 항목 → 공유 항목 (서버 ShareItem 한도에 맞춤). key는 화면용 (보낼 때 뺌)
  function shareItems(list) {
    const out = [];
    for (const it of Array.isArray(list) ? list : []) {
      const a = it && it.anchor;
      if (!a || !a.quote) continue;
      const qa = it.type === "qa" ? qaOf(it.qa) : null;
      out.push({
        key: String(it.id ?? out.length),
        quote: cutHead(a.quote, 1000), prefix: cutTail(a.prefix || "", 200), suffix: cutHead(a.suffix || "", 200),
        color: /^[a-z]{1,16}$/.test(it.color || "") ? it.color : "",
        note: cutHead(it.note || "", 4000),
        q: qa ? cutHead(qa.q, 1000) : "", a: qa ? cutHead(qa.a, 8000) : "",
      });
    }
    return out.slice(0, 200);
  }

  // 보낼 JSON의 UTF-8 바이트 수 (서버 한도 미리 확인)
  const byteLength = s => new TextEncoder().encode(String(s)).length;

  const api = {
    clipQuote, countIn, textDirective, deepLink, parseHash, needsPrefix, shareText, errMessage, shareError, bookmarklet, qaOf,
    shareItems, cutHead, cutTail, byteLength, SHARE_MAX,
  };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;           // node: 여기서 끝
  const page = document.body.dataset.page;
  if (!["paper", "home", "abstract"].includes(page)) return;
  PaperApp.registerFeature("entry-routes", api);

  const UI = window.PaperUI, A = window.PaperAnchor, h = UI.h, origin = location.origin;
  const paperUrl = id => `${origin}/paper/${id}`;
  const snip = (s, n = 90) => (s.length > n ? `${cutHead(s, n - 1)}…` : s);

  // 공유 시트 (취소는 조용히, 미지원·거부면 복사). navigator.share가 없으면 글+링크를 함께 복사.
  // iOS는 탭 안에서 동기로 불러야 하므로 이 앞에서 await 하지 말 것
  function send({ title = document.title, text = "", url }) {
    if (!navigator.share) return UI.copy(text ? `${text}\n${url}` : url, "링크를 복사했습니다");
    return UI.share(text ? { title, text, url } : { title, url });
  }

  if (page === "paper") initPaper();
  else if (page === "home") initHome();
  else initAbstract();

  // ---------- 논문 페이지 ----------
  function initPaper() {
    const id = PaperApp.arxivId;
    UI.addBarButton({ id: "entry-routes", label: "공유", onClick: openShare });
    PaperApp.addSelectionAction({ id: "entry-routes", label: "공유", order: 60, onClick: shareSelection });

    // 선택한 문장 공유: 색인 안의 선택이면 #q= 딥링크, 번역문 등(anchored 아님)은 논문 링크만
    function shareSelection(s) {
      const text = shareText(s.text);
      if (!s.anchored) return send({ text, url: paperUrl(id) });
      const q = clipQuote(s.text);
      let prefix = "", count = null;
      try {
        // 색인의 normMap은 기반이 idx.nm에 캐시함(색인 무효화 때 함께 버려짐). 탭마다 다시 정규화하지 않음
        const idx = A.index(), norm = (idx.nm || (idx.nm = A.normMap(idx.text))).norm;
        count = str => countIn(norm, A.normalize(str));
        if (needsPrefix(norm, A.normalize(q))) prefix = cutTail(String(s.prefix || "").replace(/\s+/g, " "), 24).trimStart();
      } catch { /* 앞 문맥·브라우저 지시자 없이 */ }
      return send({ text, url: deepLink(origin, id, q, prefix, count) });
    }

    // #q= 로 열림: 그 문장으로 이동 + 은은하게 칠해 둠. 그림·글꼴이 늦게 와 위치가 밀리면 load 때 한 번 더.
    // jump=false(새로고침·뒤로 가기로 다시 열림)면 칠하기만: 읽던 자리는 브라우저가 되살림
    function jumpToQuote({ q, p }, jump = true) {
      const r = A.findQuote(q, { prefix: p || "" });
      if (!r) { if (jump) UI.toast("공유된 문장을 이 논문에서 찾지 못했어요 (버전이 다를 수 있어요)"); return; }
      const o = A.offsetsOf(r);
      A.paint("er-quote", [o || r], { priority: 25 });
      if (!jump) return;
      PaperNav.jumpTo(r, { back: false, smooth: false });
      if (document.readyState === "complete" || !o) return;
      const y = window.scrollY;
      window.addEventListener("load", () => {
        if (Math.abs(window.scrollY - y) > 4) return; // 그새 사용자가 움직였으면 그대로
        const r2 = A.rangeAt(o.start, o.end);
        if (r2) PaperNav.jumpTo(r2, { back: false, smooth: false, flash: false });
      }, { once: true });
    }

    // #s= 로 열림: 공유받은 하이라이트를 읽기 전용으로 칠하고 아래쪽에 줄 하나
    async function loadShared(sid, jump = true) {
      let data;
      try {
        const res = await fetch(`/api/entry-routes/share/${encodeURIComponent(sid)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
      } catch {
        UI.toast("공유된 하이라이트를 불러오지 못했어요");
        return;
      }
      const items = (Array.isArray(data.items) ? data.items : []).filter(it => it && it.quote);
      const ranges = items.map(it => A.findQuote(it.quote, { prefix: it.prefix, suffix: it.suffix })).filter(Boolean);
      A.paint("er-shared", ranges, { priority: 15 });
      const slot = UI.bottomSlot("entry-routes", 20);
      if (slot) {
        const missing = items.length - ranges.length;
        slot.replaceChildren(h("div", { class: "er-bar", role: "group", "aria-label": "공유받은 하이라이트" },
          h("span", { class: "er-bar-label", text: `공유받은 하이라이트 ${items.length}개${missing ? ` (${missing}개 위치 못 찾음)` : ""}` }),
          h("button", { type: "button", text: "목록", onclick: () => openSharedList(items) }),
          h("button", { type: "button", class: "er-bar-x", "aria-label": "공유 하이라이트 닫기", text: "✕",
            onclick: () => { A.clear("er-shared"); slot.replaceChildren(); } })));
      }
      if (jump && ranges[0]) PaperNav.jumpTo(ranges[0], { back: false, smooth: false });
    }

    function openSharedList(items) {
      const hn = () => PaperApp.feature("highlights-notes");
      const list = h("div", { class: "er-list" });
      let close = null;
      for (const it of items) {
        const row = h("div", { class: "er-item" },
          h("button", {
            type: "button", class: "er-item-quote", text: `“${snip(it.quote, 160)}”`,
            onclick: () => {
              const r = A.findQuote(it.quote, { prefix: it.prefix, suffix: it.suffix });
              if (!r) { UI.toast("본문에서 위치를 찾지 못했어요"); return; }
              close && close("close");
              PaperNav.jumpTo(r);
            },
          }));
        if (it.note) row.append(h("p", { class: "er-item-note", text: it.note }));
        if (it.q || it.a) {
          // 링크를 만든 사람이 마음대로 쓸 수 있는 글: 마크다운·HTML로 그리지 않음 (바깥 그림·스타일 주소로 IP가 새고,
          // 앱의 답변처럼 보이게 꾸밀 수 있음). 글자 그대로, 출처 표시와 함께
          row.append(h("div", { class: "er-item-qa" },
            h("small", { class: "er-item-src", text: "공유한 사람이 저장한 Q&A" }),
            it.q ? h("b", { text: `Q. ${it.q}` }) : null,
            h("div", { class: "er-item-a", text: it.a || "" })));
        } else if (hn()?.add) {
          // 하이라이트·메모만 내 노트로 (Q&A 가져오기는 범위 밖: docs/FEATURES.md §8.1)
          row.append(h("button", {
            type: "button", class: "er-item-save", text: "내 노트에 저장",
            onclick: e => {
              const btn = e.currentTarget;
              const r = A.findQuote(it.quote, { prefix: it.prefix, suffix: it.suffix });
              const startEl = r && (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement);
              const paraId = (startEl && startEl.closest(".ltx_para")?.id) || null;
              const saved = hn()?.add?.({ anchor: { quote: it.quote, prefix: it.prefix, suffix: it.suffix, paraId }, color: it.color || undefined, note: it.note || undefined, source: "entry-routes" });
              if (saved == null) { UI.toast("이 문장은 저장할 수 없어요"); return; }
              btn.disabled = true;
              btn.textContent = "저장됨";
            },
          }));
        }
        list.append(row);
      }
      close = UI.peek({ title: `공유받은 하이라이트 ${items.length}개`, body: list, size: "large", className: "er-peek" });
    }

    // ⋯ '공유': 내 하이라이트가 없으면 바로 링크 공유, 있으면 고르는 peek (링크만 / 하이라이트와 함께)
    function openShare() {
      const url = paperUrl(id);
      const mine = shareItems(PaperStore.paper("highlights-notes", []));
      if (!mine.length) { send({ url }); return; }
      const boxes = mine.map(it => ({ it, box: h("input", { type: "checkbox", checked: true, "aria-label": snip(it.quote, 60) }) }));
      const out = h("div", { class: "er-share-out" });
      const make = h("button", { type: "button", class: "er-primary", text: "공유 링크 만들기" });
      make.addEventListener("click", async () => {
        const items = boxes.filter(b => b.box.checked).map(({ it }) => { const { key, ...rest } = it; return rest; });
        if (!items.length) { UI.toast("보낼 항목을 골라 주세요"); return; }
        const payload = JSON.stringify({ arxiv_id: id, title: cutHead(document.title, 300), items });
        if (byteLength(payload) > SHARE_MAX) { UI.toast(shareError(413)); return; }
        make.disabled = true;
        make.textContent = "만드는 중…";
        let status = 0;
        try {
          const res = await fetch("/api/entry-routes/share", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: payload,
          });
          status = res.status;
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const link = origin + (await res.json()).url;
          // 보내기는 한 번 더 탭해서 (iOS는 fetch를 기다린 뒤에는 공유 시트를 못 엶)
          out.replaceChildren(
            h("input", { class: "er-link", readonly: true, value: link, "aria-label": "공유 링크", onfocus: e => e.target.select() }),
            h("button", { type: "button", class: "er-primary", text: "링크 보내기", onclick: () => send({ text: `내 하이라이트 ${items.length}개`, url: link }) }));
          make.remove();
        } catch {
          UI.toast(shareError(status));
          make.disabled = false;
          make.textContent = "공유 링크 만들기";
        }
      });
      const body = h("div", { class: "er-share" },
        h("button", { type: "button", class: "er-primary", text: "논문 링크만 보내기", onclick: () => send({ url }) }),
        h("p", { class: "er-share-sub", text: "내 하이라이트·메모도 함께 보내기 (받는 사람은 읽기 전용으로 봐요)" }),
        h("div", { class: "er-checks" }, boxes.map(({ it, box }) => h("label", { class: "er-check" }, box,
          h("span", {}, `“${snip(it.quote, 70)}”`, it.note ? h("small", { text: ` — ${snip(it.note, 50)}` }) : null,
            it.q ? h("small", { text: ` — Q. ${snip(it.q, 50)}` }) : null)))),
        make, out);
      UI.peek({ title: "공유", body, className: "er-peek" });
    }

    // 설치된 앱에서 같은 논문의 다른 #q= 링크를 열면 새로고침 없이 해시만 바뀜.
    // 이미 처리한 해시로 되돌아온 것(#S2 링크 뒤 뒤로가기)은 다시 점프하지 않음
    let handled = null;
    function fromHash(jump) {
      const hp = parseHash(location.hash);
      if (!hp || location.hash === handled) return;
      handled = location.hash;
      if (hp.q) jumpToQuote(hp, jump);
      else loadShared(hp.s, jump);
    }
    // 새로고침·뒤로 가기(bfcache 없이)·폐기된 탭 복원으로 다시 열린 페이지: 읽던 자리는 브라우저가 되살리므로
    // 첫 처리에서는 칠하기만 (공유된 문장으로 다시 끌고 가지 않음). 해시는 지우지 않음: toc-progress가 딥링크로
    // 처음 열린 화면에 이어 읽기 알림을 띄우지 않는 근거이고, 주소창의 링크를 그대로 다시 보낼 수 있게
    function restored() {
      if (document.wasDiscarded) return true;
      try {
        const t = performance.getEntriesByType("navigation")[0]?.type;
        return t === "reload" || t === "back_forward";
      } catch { return false; }
    }
    // 번들의 다른 기능(번역 모드 등)이 paper:reveal·jump 리스너를 단 뒤에 첫 점프
    setTimeout(() => fromHash(!restored()), 0);
    window.addEventListener("hashchange", () => fromHash(true));
  }

  // ---------- 홈: ?err= 알림 + 다른 앱에서 여는 방법 ----------
  function initHome() {
    const params = new URLSearchParams(location.search);
    const err = params.get("err");
    if (err) {
      const sec = UI.homeSection({ id: "entry-routes" });
      if (sec) {
        sec.classList.add("er-err");
        sec.setAttribute("role", "alert");
        sec.append(h("p", { class: "er-err-msg", text: errMessage(err) }));
        const got = params.get("q");
        if (got) sec.append(h("p", { class: "er-err-got" }, "받은 내용: ", h("code", { text: snip(got, 200) })));
        sec.append(h("p", { class: "er-err-hint", text: "arXiv 주소(예: arxiv.org/abs/2401.04088)나 번호를 위 칸에 붙여 넣어 보세요." }));
      }
      try { history.replaceState(history.state, "", location.pathname); } catch { /* 새로고침하면 다시 보임 */ }
    }
    const help = UI.homeSection({ id: "entry-routes:help" });
    if (!help) return;
    const code = bookmarklet(origin), host = location.host;
    help.append(h("details", { class: "er-help" },
      h("summary", { text: "다른 앱에서 바로 열기 (공유 · 주소 바꾸기 · 북마클릿)" }),
      h("ul", {},
        h("li", { text: "안드로이드: 이 앱을 홈 화면에 설치하면 X·카카오톡·브라우저의 공유 메뉴에 'Paper'가 생겨요. arXiv 링크를 공유하면 바로 열려요." }),
        h("li", {}, "주소 바꾸기: arXiv 주소의 'arxiv.org'를 ", h("code", { text: host }), "로 바꿔도 열려요. 예: ",
          h("code", { text: `${host}/abs/2401.04088` })),
        h("li", { text: "아이폰·PC: 아래 코드를 북마크 주소로 저장해 두고, arXiv·alphaXiv 페이지에서 그 북마크를 누르세요." })),
      h("div", { class: "er-code" }, h("code", { text: code }),
        h("button", { type: "button", text: "복사", onclick: () => UI.copy(code, "북마클릿을 복사했습니다") })),
      h("p", { class: "er-help-note", text: `iOS 단축어: '공유 시트에서 URL 받기' → 'URL 열기: ${origin}/share?url=(단축어 입력)'을 만들면 공유 메뉴에서도 열 수 있어요.` })));
  }

  // ---------- HTML 없는 논문의 초록 페이지 (features/entry_routes.py가 그림) ----------
  function initAbstract() {
    const art = document.querySelector(".er-abs");
    if (!art) return;
    const id = document.body.dataset.arxivId;
    let meta = {};
    try { meta = JSON.parse(art.dataset.er || "{}"); } catch { /* 무시 */ }
    const actions = art.querySelector(".er-abs-actions");
    actions?.append(h("button", { type: "button", class: "er-btn", text: "공유", onclick: () => send({ url: paperUrl(id) }) }));
    // 초록의 $…$ 수식: KaTeX(CDN)는 기능 번들 뒤에 오므로 load 때
    const sum = art.querySelector(".er-abs-summary");
    const math = () => {
      try {
        if (sum && window.renderMathInElement) {
          renderMathInElement(sum, { delimiters: [{ left: "$$", right: "$$", display: true }, { left: "$", right: "$", display: false }], throwOnError: false });
        }
      } catch { /* 글자 그대로 */ }
    };
    if (document.readyState === "complete") math(); else window.addEventListener("load", math, { once: true });
    // 즐겨찾기 기능이 이 페이지에 있으면 '나중에 읽기' (번들은 알파벳 순 → library는 뒤에 등록되므로 다음 틱에 확인)
    setTimeout(() => {
      const lib = PaperApp.feature("library");
      if (!lib?.add || !actions) return;
      actions.append(h("button", {
        type: "button", class: "er-btn", text: "☆ 나중에 읽기",
        onclick: e => {
          const btn = e.currentTarget;
          lib.add({ id: PaperStore.baseIdOf(id), title: meta.title, authors: meta.authors, status: "to-read" });
          btn.disabled = true;
          btn.textContent = "★ 읽을 목록에 추가됨";
        },
      }));
    }, 0);
  }
})();
