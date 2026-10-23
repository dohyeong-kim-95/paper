// PaperUI: 화면 공용 부품 — 레이어(뒤로가기 연동), peek 시트, 토스트, 헤더 버튼, FAB, 상태 칩, 피드백, 복사/공유
(function () {
  "use strict";

  // 헤더 버튼 자리표 (docs/FEATURES.md 표와 같게 유지). primary 3개만 헤더에, 나머지는 ⋯ 메뉴.
  // 표에 없는 id는 메뉴로 가고 순서는 자기 order(기본 500).
  const BAR = {
    "toc-progress": { order: 10, primary: true },
    "section-translate": { order: 20, primary: true },
    "in-paper-search": { order: 30, primary: true },
    "overview": { order: 40 },
    "reading-settings": { order: 50 },
    "library": { order: 60 },
    "highlights-notes": { order: 70 },
    "glossary": { order: 80 },
    "skim-highlights": { order: 90 },
    "audio-summary": { order: 100 },
    "figure-viewer": { order: 110 },
    "related-papers": { order: 120 },
    "entry-routes": { order: 130 },
    "offline-save": { order: 140 },
    "library:status": { order: 150 },
    "library:bibtex": { order: 160 },
    "app:selbar": { order: 900 },
  };
  const MAX_PRIMARY = 3;

  // 순수 함수: 버튼 목록 → {primary, overflow}
  function barLayout(buttons, table = BAR, max = MAX_PRIMARY) {
    const withMeta = buttons.map(b => ({ ...b, order: table[b.id]?.order ?? b.order ?? 500, primary: !!table[b.id]?.primary }));
    withMeta.sort((a, b) => a.order - b.order || String(a.id).localeCompare(String(b.id)));
    const primary = withMeta.filter(b => b.primary).slice(0, max);
    const overflow = withMeta.filter(b => !primary.includes(b));
    return { primary, overflow };
  }

  // 순수 함수: order 순 정렬 + id 중복은 나중 것으로 교체
  function upsert(list, item) {
    const i = list.findIndex(x => x.id === item.id);
    if (i >= 0) list[i] = item; else list.push(item);
    list.sort((a, b) => (a.order ?? 500) - (b.order ?? 500));
    return list;
  }

  const api = { BAR, barLayout, upsert };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;

  const $ = id => document.getElementById(id);

  // 작은 DOM 헬퍼: h("button", {class: "x", onclick: fn, text: "라벨"}, ...children)
  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "class" || k === "className") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  // ---------- 레이어: 시트·peek·뷰어·점프를 시스템 뒤로가기(안드로이드 back, iOS 스와이프)로 닫기 ----------
  // 레이어가 하나라도 열려 있으면 history에 표지 항목({prLayer:1}) 하나를 둠. 뒤로가기 → 맨 위 레이어 하나 닫고 필요하면 다시 push.
  // 스크롤 복원 모드는 history 항목마다 따로: 레이어를 연 시점의 항목만 manual (뒤로가기로 돌아올 때 브라우저가
  // 그 시점 위치로 튀지 않게), 표지 항목은 auto (새로고침·탭 폐기·다른 페이지에서 돌아올 때 읽던 위치 복원)
  const layers = [];
  let sentinel = false, backPending = 0;
  const scrollMode = m => { try { history.scrollRestoration = m; } catch { /* 무시 */ } };
  function pushSentinel() {
    if (sentinel || backPending || !layers.length) return;
    scrollMode("manual");
    try { history.pushState({ prLayer: 1 }, ""); sentinel = true; } catch { /* 무시 */ }
    scrollMode("auto");
  }
  // 새로고침 등으로 표지 항목에서 페이지가 다시 열림(레이어 없음): 보통 항목으로 (레이어를 열면 표지를 새로 쌓음)
  try { if (history.state && history.state.prLayer) history.replaceState(null, ""); } catch { /* 무시 */ }
  const settle = () => { pushSentinel(); if (!layers.length && !backPending) scrollMode("auto"); };
  function layer(onClose, opts = {}) {
    const l = { onClose, kind: opts.kind || "layer", keepOnSheet: !!opts.keepOnSheet, open: true };
    layers.push(l);
    pushSentinel();
    const close = (reason = "close") => {
      if (!l.open) return;
      l.open = false;
      layers.splice(layers.indexOf(l), 1);
      try { onClose(reason); } catch (e) { console.error(e); }
      if (!layers.length && sentinel) { sentinel = false; backPending++; history.back(); }
    };
    l.close = close;
    return close;
  }
  window.addEventListener("popstate", () => {
    if (backPending) { backPending--; settle(); return; }
    sentinel = false;
    const top = layers[layers.length - 1];
    if (top) {
      top.open = false;
      layers.pop();
      try { top.onClose("back"); } catch (e) { console.error(e); }
    }
    settle();
  });
  const topLayer = () => layers[layers.length - 1] || null;
  // 조건에 맞는 열린 레이어를 위에서부터 닫음 (시트를 열 때 그 위에 뜨는 오버레이 닫기 등)
  function closeLayers(pred, reason = "close") {
    for (const l of layers.slice().reverse()) if (l.open && pred(l)) l.close(reason);
  }
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && topLayer()) { e.preventDefault(); topLayer().close("escape"); }
  });

  // 아래로 끌어 닫기 (handle을 잡고 target을 움직임). onDone(dy) → true면 닫힘 처리됨
  function dragDown(handle, target, onClose, opts = {}) {
    let y0 = null, dy = 0;
    handle.addEventListener("pointerdown", e => {
      if (e.button || e.target.closest("button, a, input, textarea, select")) return; // 버튼 클릭은 그대로
      y0 = e.clientY; dy = 0;
      handle.setPointerCapture?.(e.pointerId);
      target.style.transition = "none";
    });
    handle.addEventListener("pointermove", e => {
      if (y0 === null) return;
      dy = e.clientY - y0;
      if (dy > 0 || opts.allowUp) target.style.transform = `translateY(${Math.max(dy, opts.allowUp ? -40 : 0)}px)`;
    });
    const end = () => {
      if (y0 === null) return;
      y0 = null;
      target.style.transition = "";
      target.style.transform = "";
      if (dy > (opts.threshold || 80)) onClose("swipe");
      else if (dy < -40 && opts.onUp) opts.onUp();
      else if (Math.abs(dy) < 6 && opts.onTap) opts.onTap();
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  function rememberFocus() {
    const prev = document.activeElement;
    return () => { if (prev && prev.isConnected && prev.focus) try { prev.focus({ preventScroll: true }); } catch { /* 무시 */ } };
  }

  // ---------- peek: 보조 바텀시트 (z 25). 반환값 close(), close.el / close.body ----------
  let peekCount = 0;
  function peek({ title = "", body = null, actions = [], className = "", onClose, size } = {}) {
    const restore = rememberFocus();
    const titleId = `pr-peek-t${++peekCount}`;
    const backdrop = h("div", { class: "pr-peek-backdrop pr-ui" });
    const bodyEl = h("div", { class: "pr-peek-body" });
    if (body instanceof Node) bodyEl.append(body);
    else if (body != null) bodyEl.textContent = String(body);
    const closeBtn = h("button", { class: "pr-peek-x", "aria-label": "닫기", text: "✕" });
    const head = h("div", { class: "pr-peek-head" }, h("div", { class: "pr-handle", "aria-hidden": "true" }),
      h("b", { id: titleId, text: title }), closeBtn);
    const box = h("section", {
      class: `pr-peek pr-ui ${size === "large" ? "pr-peek-large" : ""} ${className}`.trim(),
      role: "dialog", "aria-modal": "true", "aria-labelledby": titleId, tabindex: "-1",
    }, head, bodyEl);
    if (actions.length) {
      box.append(h("div", { class: "pr-peek-actions" }, actions.map(a =>
        h("button", { class: a.primary ? "primary" : "", text: a.label, onclick: () => a.onClick && a.onClick({ close }) }))));
    }
    const depth = layers.filter(l => l.kind === "peek").length;
    backdrop.style.zIndex = 25 + depth * 2;
    box.style.zIndex = 26 + depth * 2;
    document.body.append(backdrop, box);
    const close = layer(reason => {
      backdrop.remove();
      box.remove();
      restore();
      onClose && onClose(reason);
    }, { kind: "peek" });
    backdrop.addEventListener("click", () => close("outside"));
    closeBtn.addEventListener("click", () => close("close"));
    dragDown(head, box, close);
    requestAnimationFrame(() => box.focus({ preventScroll: true }));
    close.el = box;
    close.body = bodyEl;
    return close;
  }

  // ---------- 토스트 (z 40). 되돌리기 버튼 지원: toast('삭제됨', {actionLabel: '실행 취소', onAction}) ----------
  // 한 번에 하나. 일반 토스트는 새 토스트로 바로 바뀌지만, 버튼이 있는 토스트(실행 취소·이동)가 떠 있으면
  // 그동안 온 토스트는 뒤에 줄 섬 (일반 토스트는 최대 2개만 대기) → 되돌리기가 다른 기능의 알림에 지워지지 않음
  let toastTimer = null, toastCur = null;
  const toastQ = [];
  function showToast(t) {
    let root = $("pr-toast");
    if (!root) {
      root = h("div", { id: "pr-toast", class: "pr-toast pr-ui", role: "status", "aria-live": "polite" });
      document.body.append(root);
    }
    clearTimeout(toastTimer);
    toastCur = t;
    root.replaceChildren(h("span", { text: t.msg }));
    if (t.actionLabel) {
      root.append(h("button", { text: t.actionLabel, onclick: () => { t.close(); t.onAction && t.onAction(); } }));
    }
    root.hidden = false;
    toastTimer = setTimeout(t.close, t.actionLabel ? Math.max(t.ms, 5000) : t.ms);
  }
  function toast(msg, { actionLabel, onAction, ms = 3500 } = {}) {
    const t = { msg, actionLabel, onAction, ms };
    t.close = () => {
      const i = toastQ.indexOf(t);
      if (i >= 0) { toastQ.splice(i, 1); return; }
      if (toastCur !== t) return;
      clearTimeout(toastTimer);
      toastCur = null;
      const root = $("pr-toast");
      if (root) { root.hidden = true; root.replaceChildren(); }
      const next = toastQ.shift();
      if (next) showToast(next);
    };
    if (toastCur && toastCur.actionLabel) {
      const plain = toastQ.filter(x => !x.actionLabel);
      if (!actionLabel && plain.length >= 2) toastQ.splice(toastQ.indexOf(plain[0]), 1);
      toastQ.push(t);
    } else showToast(t);
    return { close: t.close };
  }
  document.addEventListener("paper:store-full", () =>
    toast("저장 공간이 부족해 일부가 저장되지 않았습니다 · 내보내기를 권장합니다", { ms: 6000 }));

  // ---------- 헤더 버튼 ----------
  const barButtons = [];
  function renderBar() {
    const holder = $("bar-actions"), more = $("bar-more");
    if (!holder) return;
    const { primary, overflow } = barLayout(barButtons);
    holder.replaceChildren(...primary.map(b => b.el));
    for (const b of barButtons) b.inMenu = overflow.some(o => o.id === b.id);
    if (more) more.hidden = !overflow.length;
  }
  function openMenu() {
    const { overflow } = barLayout(barButtons);
    const list = h("div", { class: "pr-menu" });
    const close = peek({ title: "더보기", body: list, className: "pr-menu-peek" });
    for (const b of overflow) {
      list.append(h("button", {
        class: `pr-menu-item${b.dot ? " pr-dot" : ""}${b.active ? " active" : ""}`,
        onclick: () => { close("menu"); b.onClick && b.onClick(); },
      }, b.icon ? h("span", { class: "pr-menu-icon", "aria-hidden": "true", text: b.icon }) : null, h("span", { text: b.label })));
    }
  }
  function addBarButton({ id, label, icon, title, order, onClick } = {}) {
    const el = h("button", { class: "pr-bar-btn", "aria-label": title || label, title: title || label, text: icon || label, dataset: { id } });
    const b = { id, label, icon, order, onClick, el, dot: false, active: false };
    el.addEventListener("click", () => b.onClick && b.onClick());
    upsert(barButtons, b);
    renderBar();
    return {
      el,
      setLabel(t) { b.label = t; if (!icon) el.textContent = t; el.setAttribute("aria-label", t); },
      setActive(on) { b.active = !!on; el.classList.toggle("active", !!on); el.setAttribute("aria-pressed", String(!!on)); },
      setDot(on) { b.dot = !!on; el.classList.toggle("pr-dot", !!on); $("bar-more")?.classList.toggle("pr-dot", barButtons.some(x => x.inMenu && x.dot)); },
      remove() { barButtons.splice(barButtons.indexOf(b), 1); el.remove(); renderBar(); },
    };
  }

  // ---------- FAB (오른쪽 아래, 시트가 열리면 숨김) ----------
  const fabs = [];
  function addFab({ id, label, icon, order, onClick } = {}) {
    const stack = $("fab-stack");
    const el = h("button", { class: "pr-fab", "aria-label": label, title: label, dataset: { id } },
      icon ? h("span", { "aria-hidden": "true", text: icon }) : null, h("span", { class: "pr-fab-label", text: label }));
    el.addEventListener("click", () => onClick && onClick());
    upsert(fabs, { id, order, el });
    if (stack) stack.replaceChildren(...fabs.map(f => f.el));
    return el;
  }

  // ---------- 홈 화면 섹션 (홈 기능들이 정해진 순서로 붙음) ----------
  const HOME = { "entry-routes": 5, "library": 10, "vocab": 20, "daily-feed": 30, "entry-routes:help": 90 };
  function homeSection({ id, title, order } = {}) {
    const root = $("home-sections");
    if (!root) return null;
    let sec = root.querySelector(`:scope > [data-section="${CSS.escape(id)}"]`);
    if (sec) return sec;
    const ord = HOME[id] ?? order ?? 500;
    sec = h("section", { class: "pr-home-section", dataset: { section: id, order: ord } }, title ? h("h2", { text: title }) : null);
    const after = [...root.children].find(c => Number(c.dataset.order) > ord);
    root.insertBefore(sec, after || null);
    return sec;
  }

  // ---------- 백그라운드 준비 상태 칩: status('glossary', '용어', 'loading'|'ready'|'error'|null, {onRetry}) ----------
  const statuses = new Map();
  function status(key, label, state, { onRetry } = {}) {
    const strip = $("status-strip");
    if (!strip) return;
    let chip = statuses.get(key);
    if (!state) { chip?.remove(); statuses.delete(key); strip.hidden = !statuses.size; return; }
    if (!chip) { chip = h("span", { class: "pr-status", dataset: { key } }); statuses.set(key, chip); strip.append(chip); }
    clearTimeout(chip._t);
    chip.dataset.state = state;
    const mark = { loading: "…", ready: "✓", error: "✕" }[state] || "";
    chip.replaceChildren(h("span", { text: `${label} ${mark}` }));
    if (state === "error" && onRetry) chip.append(h("button", { text: "다시", onclick: () => onRetry() }));
    if (state === "ready") chip._t = setTimeout(() => status(key, label, null), 2500);
    strip.hidden = false;
  }

  // ---------- 👍/👎 피드백 → POST /api/feedback ----------
  function feedback(kind, target = "", { arxivId, label = "", question = "", answerLen = 0 } = {}) {
    const store = window.PaperStore && window.PaperStore.session;
    const key = `ui:fb:${kind}:${target}`;
    const wrap = h("span", { class: "pr-feedback", role: "group", "aria-label": "평가" });
    const mk = (vote, icon, name) => {
      const b = h("button", { class: "pr-fb", "aria-label": name, "aria-pressed": "false", text: icon, dataset: { vote } });
      b.addEventListener("click", async () => {
        for (const x of wrap.children) x.setAttribute("aria-pressed", String(x === b));
        store && store.set(key, vote);
        try {
          await fetch("/api/feedback", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              kind, vote, target: String(target).slice(0, 200), label,
              arxiv_id: arxivId || document.body.dataset.arxivId || "",
              question: String(question).slice(0, 300), answer_len: answerLen,
            }),
          });
        } catch { /* 오프라인이면 조용히 */ }
      });
      return b;
    };
    wrap.append(mk("up", "👍", "좋아요"), mk("down", "👎", "별로예요"));
    const prev = store && store.get(key);
    if (prev) wrap.querySelector(`[data-vote="${prev}"]`)?.setAttribute("aria-pressed", "true");
    return wrap;
  }

  // ---------- 복제·복사·공유·다운로드 ----------
  // 본문 요소 복제: id 제거(중복 방지), 기능이 넣은 .pr-ui / 번역 .tr-ko 제거
  function cloneClean(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll(".pr-ui, .tr-ko").forEach(x => x.remove());
    c.removeAttribute?.("id");
    c.querySelectorAll("[id]").forEach(x => x.removeAttribute("id"));
    return c;
  }

  async function copy(text, msg = "복사됨") {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = h("textarea", { class: "pr-offscreen" });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* 무시 */ }
      ta.remove();
    }
    if (msg) toast(msg);
    return true;
  }

  // navigator.share → 취소(AbortError)는 조용히, 미지원·거부면 텍스트/URL 복사
  async function share(data = {}) {
    if (navigator.share) {
      try { await navigator.share(data); return true; }
      catch (e) { if (e.name === "AbortError") return false; }
    }
    await copy(data.url || data.text || data.title || "", "링크를 복사했습니다");
    return true;
  }

  // 파일 내보내기: iOS 홈 화면 앱에서는 공유 시트가 유일하게 확실한 방법
  async function download(name, text, type = "text/plain") {
    const file = typeof File !== "undefined" ? new File([text], name, { type }) : null;
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return true; }
      catch (e) { if (e.name === "AbortError") return false; }
    }
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = h("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return true;
  }

  document.addEventListener("DOMContentLoaded", () => $("bar-more")?.addEventListener("click", openMenu));

  window.PaperUI = Object.assign(api, {
    h, layer, topLayer, closeLayers, dragDown, peek, toast, addBarButton, addFab, homeSection, status, feedback,
    cloneClean, copy, share, download,
  });
})();
