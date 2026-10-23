// figure-viewer: 그림 전체화면 뷰어(핀치·버튼 확대, 이동, 넘기기) + 그림 고정(PiP) + 그림·표 모아보기
(function () {
  "use strict";
  // 순수 함수 (node 테스트 대상)
  // 화면 상태 st = {scale, x, y}: 내용에 translate(x, y) scale(scale) (기준점 왼쪽 위). scale 1 = 화면 맞춤 크기
  const MIN = 1, MAX = 6, DOUBLE = 2.5;
  const clampScale = (s, min = MIN, max = MAX) => Math.min(max, Math.max(min, Number(s) || min));
  // 화면의 한 점(fx, fy)을 제자리에 둔 채 배율 변경 (핀치 중심·두 번 탭·휠)
  function zoomAround(st, scale, fx, fy) {
    const s = clampScale(scale), r = s / st.scale;
    return { scale: s, x: fx - (fx - st.x) * r, y: fy - (fy - st.y) * r };
  }
  // 이동 제한: 화면보다 작은 축은 가운데, 큰 축은 가장자리 빈틈이 안 보이게. view·size = {w, h} (size는 맞춤 크기)
  function clampPan(st, view, size) {
    const axis = (v, c, x) => (c <= v ? (v - c) / 2 : Math.min(0, Math.max(v - c, x)));
    return { scale: st.scale, x: axis(view.w, size.w * st.scale, st.x), y: axis(view.h, size.h * st.scale, st.y) };
  }
  // 맞춤 배율: 원래 크기 nat가 화면(여백 pad)에 다 보이게. 작은 그림은 maxUp배까지만 키움
  const fitScale = (nat, view, maxUp = 4, pad = 8) =>
    Math.max(0.01, Math.min((view.w - 2 * pad) / nat.w, (view.h - 2 * pad) / nat.h, maxUp));
  // 두 손가락: 시작 상태 st0, 시작 위치 a0·b0 → 지금 a1·b1. 거리 비율로 배율, 두 손가락 가운데를 따라 이동
  function pinch(st0, a0, b0, a1, b1) {
    const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y) || 1, d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y);
    const m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 }, m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
    const z = zoomAround(st0, st0.scale * d1 / d0, m0.x, m0.y);
    return { scale: z.scale, x: z.x + m1.x - m0.x, y: z.y + m1.y - m0.y };
  }
  // 넘기기는 맞춤 크기(scale 1)에서만: 가로로 충분히 밀면 1 다음 / -1 이전, 아니면 0 (확대 중엔 이동)
  function swipeDir(dx, dy, scale, min = 60) {
    if (scale > 1.01 || Math.abs(dx) < min || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
    return dx < 0 ? 1 : -1;
  }
  const isDoubleTap = (prev, cur, ms = 300, px = 30) =>
    !!prev && cur.t - prev.t < ms && Math.hypot(cur.x - prev.x, cur.y - prev.y) < px;
  const stepIndex = (i, dir, n) => Math.max(0, Math.min(n - 1, i + dir));
  // 고정 창 위치를 화면 안으로 (view.top: 헤더·띠 아래 끝)
  function clampPin(pos, size, view, margin = 8) {
    const top = (view.top || 0) + margin;
    return {
      x: Math.max(margin, Math.min(view.w - size.w - margin, pos.x)),
      y: Math.max(top, Math.min(view.h - size.h - margin, pos.y)),
    };
  }
  // 캡션 번호표 "Figure 1: " → "Figure 1", "(a) " → "(a)"
  const figLabel = t => String(t || "").replace(/\s+/g, " ").replace(/[\s:：.]+$/, "").trim();

  const api = { MIN, MAX, DOUBLE, clampScale, zoomAround, clampPan, fitScale, pinch, swipeDir, isDoubleTap, stepIndex, clampPin, figLabel };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;           // node: 여기서 끝
  if (document.body.dataset.page !== "paper") return;
  PaperApp.registerFeature("figure-viewer", api);

  const UI = window.PaperUI, h = UI.h, paper = document.getElementById("paper");
  if (!paper) return;

  // ---------- 본문의 그림 목록 (열 때마다 새로: 번역 등으로 DOM이 바뀔 수 있음) ----------
  const skip = el => !!el.closest(".pr-ui, .tr-ko");
  // 맨 위 단계 그림(하위 패널 figure 제외), 문서 순서. 표·알고리즘도 figure
  const topFigures = () => [...paper.querySelectorAll("figure")].filter(f => !f.parentElement.closest("figure") && !skip(f));
  // 보기 목록: 그림 속 img마다 하나(패널 각각), img가 없으면(TikZ·표·알고리즘) 그림 통째로 하나
  function items() {
    const out = [];
    for (const fig of topFigures()) {
      const imgs = [...fig.querySelectorAll("img")].filter(i => !skip(i));
      if (!imgs.length) { out.push({ fig, img: null, panel: null }); continue; }
      for (const img of imgs) {
        const f = img.closest("figure");
        out.push({ fig, img, panel: f !== fig ? f : null });
      }
    }
    return out;
  }
  function indexOf(list, el) {
    if (!el) return -1;
    const i = list.findIndex(it => it.img === el || it.panel === el);
    return i >= 0 ? i : list.findIndex(it => it.fig === el || it.fig.contains(el));
  }
  const ownCaption = fig => (fig ? [...fig.querySelectorAll("figcaption")].find(c => c.closest("figure") === fig) || null : null);
  const tagOf = fig => figLabel(ownCaption(fig)?.querySelector(".ltx_tag")?.textContent);
  const kindName = fig => (fig.classList.contains("ltx_table") ? "표" : /algorithm/.test(fig.className) ? "알고리즘" : "그림");
  function labelOf(it) {
    const base = tagOf(it.fig) || kindName(it.fig), sub = it.panel ? tagOf(it.panel) : "";
    return sub ? `${base} ${sub}` : base;
  }
  // 그림 본문만 복제 (캡션 빼고, id·기능 UI 없이). 링크는 글자만 남김 (썸네일·고정 창에서 눌리지 않게)
  function cloneBody(fig) {
    const c = UI.cloneClean(fig);
    c.querySelectorAll("figcaption").forEach(x => x.remove());
    c.querySelectorAll("a").forEach(a => a.replaceWith(...a.childNodes));
    return c;
  }
  const srcOf = img => img.currentSrc || img.src;
  function natOf(img) {
    if (img.naturalWidth && img.naturalHeight) return { w: img.naturalWidth, h: img.naturalHeight };
    const w = +img.getAttribute("width"), hh = +img.getAttribute("height");
    if (w && hh) return { w, h: hh };
    const r = img.getBoundingClientRect();
    return r.width && r.height ? { w: r.width, h: r.height } : { w: 300, h: 200 };
  }
  // 헤더와 위쪽 띠 아래 끝 (자동 숨김이면 0 근처)
  function topEdge() {
    const b = id => document.getElementById(id)?.getBoundingClientRect().bottom || 0;
    return Math.max(0, b("bar"), b("top-stack"));
  }

  let V = null, gridClose = null, pinEl = null;
  // 뷰어·모아보기를 닫고 본문으로 (본문 위치로·고정)
  function closeAll(reason = "close") {
    if (V) V.close(reason);
    if (gridClose) gridClose(reason);
  }
  function openAt(target) {
    const list = items(), i = indexOf(list, target);
    if (i >= 0) openViewer(list, i);
    return i >= 0;
  }

  // ---------- 전체화면 뷰어 (z 30, PaperUI.layer kind "viewer": 뒤로가기·Esc로 닫힘, 질문 시트가 열리면 닫힘) ----------
  function openViewer(list, start) {
    if (V) { V.list = list; V.show(start); return; }
    const prevFocus = document.activeElement;
    const v = { list, i: 0, st: { scale: 1, x: 0, y: 0 }, base: 1, nat: null, size: { w: 1, h: 1 }, view: { w: 1, h: 1 } };
    const btn = (text, onclick, cls = "", label = null) =>
      h("button", { type: "button", class: cls, text, "aria-label": label, title: label, onclick });
    const titleEl = h("span", { class: "fv-title", id: "fv-title" });
    const outBtn = btn("−", () => zoomBy(1 / 1.5), "", "축소");
    const inBtn = btn("+", () => zoomBy(1.5), "", "확대");
    const fitBtn = btn("맞춤", () => set({ scale: 1, x: 0, y: 0 }, true), "fv-fit", "화면에 맞춤");
    const top = h("div", { class: "fv-top" }, btn("✕", () => close("close"), "fv-x", "닫기"), titleEl, outBtn, inBtn, fitBtn);
    const content = h("div", { class: "fv-content" });
    const prevBtn = btn("‹", () => go(-1), "fv-nav fv-prev", "이전 그림");
    const nextBtn = btn("›", () => go(1), "fv-nav fv-next", "다음 그림");
    const stage = h("div", { class: "fv-stage" }, content, prevBtn, nextBtn);
    const cap = h("div", { class: "fv-cap" });
    const explainBtn = btn("AI 설명", () => {
      // 시트가 열리면 기반이 뷰어를 닫음 (reason "sheet")
      document.dispatchEvent(new CustomEvent("paper:figure-explain", { detail: { figureEl: cur().fig } }));
    }, "fv-ai");
    const pinBtn = btn("📌 고정", () => {
      pin(cur());
      closeAll();
      UI.toast("고정했습니다 · 끌어서 옮기고 누르면 확대");
    });
    const jumpBtn = btn("본문 위치로", () => { const it = cur(); closeAll(); PaperNav.jumpTo(it.panel || it.fig); });
    // 원본 이미지는 주소만 공유 (파일 공유·이미지 프록시 없음). '원본 열기'는 새 탭 → 길게 눌러 저장
    const shareBtn = btn("공유", () => UI.share({ title: `${labelOf(cur())} · ${document.title}`, url: srcOf(cur().img) }), "", "원본 이미지 링크 공유");
    const origLink = h("a", { class: "fv-orig", target: "_blank", rel: "noopener", text: "원본 열기" });
    const actions = h("div", { class: "fv-actions" }, explainBtn, pinBtn, jumpBtn, shareBtn, origLink);
    const root = h("div", { class: "fv-viewer pr-ui", role: "dialog", "aria-modal": "true", "aria-labelledby": "fv-title", tabindex: "-1" },
      top, stage, cap, actions);
    explainBtn.hidden = !PaperApp.has("figure-explain"); // 열 때 확인 (번들 순서와 무관)
    const cur = () => v.list[v.i];

    function show(i) {
      v.i = Math.max(0, Math.min(v.list.length - 1, i));
      const it = cur();
      let el;
      if (it.img) {
        el = h("img", { src: srcOf(it.img), alt: it.img.getAttribute("alt") || "", draggable: "false" });
        // 본문 그림이 아직 안 받아졌으면 크기가 바뀔 수 있음 → 맞춤 상태일 때만 다시 계산
        el.addEventListener("load", () => {
          const n = natOf(el);
          if (cur() === it && v.st.scale <= 1.01 && v.nat && Math.abs(n.w / n.h - v.nat.w / v.nat.h) > 0.01) layout(n);
        });
      } else el = cloneBody(it.fig);
      content.className = `fv-content${it.img ? "" : " fv-clone"}`;
      content.style.cssText = "";
      content.replaceChildren(el);
      const label = labelOf(it);
      titleEl.textContent = v.list.length > 1 ? `${label} · ${v.i + 1} / ${v.list.length}` : label;
      cap.replaceChildren(...[it.panel, it.fig].map(ownCaption).filter(Boolean).map(c => UI.cloneClean(c)));
      cap.hidden = !cap.childNodes.length;
      cap.scrollTop = 0;
      prevBtn.hidden = v.i === 0;
      nextBtn.hidden = v.i >= v.list.length - 1;
      shareBtn.hidden = origLink.hidden = !it.img;
      if (it.img) origLink.href = el.src;
      lastTap = null;
      layout(it.img ? natOf(it.img) : null);
    }
    // 맞춤 크기 계산 → 맞춤·가운데 상태로. 복제본(표 등)은 실제 크기를 재서
    function layout(nat) {
      const r = stage.getBoundingClientRect();
      v.view = { w: r.width || innerWidth, h: r.height || innerHeight };
      if (!nat) {
        // 소수점 너비를 내림하면 표 칸이 줄바꿈되어 높이가 달라짐 → 올림 + 1px로 고정한 뒤 높이를 잼
        content.style.width = "max-content";
        content.style.height = "auto";
        content.style.width = `${Math.ceil(content.getBoundingClientRect().width) + 1}px`; // show()가 transform을 지운 뒤
        nat = { w: parseFloat(content.style.width), h: content.offsetHeight || 1 };
      }
      v.nat = nat;
      v.base = fitScale(nat, v.view, cur().img || !cur().fig.querySelector("table, .ltx_listing") ? 4 : 2); // 표·알고리즘은 2배까지
      v.size = { w: nat.w * v.base, h: nat.h * v.base };
      content.style.width = `${nat.w}px`;
      content.style.height = `${nat.h}px`;
      set({ scale: 1, x: 0, y: 0 });
    }
    function draw(ex = 0, ey = 0, anim = false) {
      content.classList.toggle("fv-anim", !!anim);
      content.style.transform = `translate(${v.st.x + ex}px, ${v.st.y + ey}px) scale(${v.base * v.st.scale})`;
      const zoomed = v.st.scale > 1.01;
      outBtn.disabled = fitBtn.disabled = !zoomed;
      inBtn.disabled = v.st.scale >= MAX - 0.01;
      stage.classList.toggle("fv-zoomed", zoomed);
      root.dataset.scale = v.st.scale.toFixed(2);
    }
    function set(st, anim = false) {
      v.st = clampPan({ scale: clampScale(st.scale), x: st.x, y: st.y }, v.view, v.size);
      draw(0, 0, anim);
    }
    const zoomBy = k => set(zoomAround(v.st, v.st.scale * k, v.view.w / 2, v.view.h / 2), true);
    function go(dir) {
      const j = stepIndex(v.i, dir, v.list.length);
      if (j === v.i) { draw(0, 0, true); return false; }
      show(j);
      return true;
    }

    // ---------- 손가락: 한 손가락 = 이동(확대 중)·넘기기(맞춤)·아래로 끌어 닫기, 두 손가락 = 핀치, 두 번 탭 = 1x/2.5x ----------
    const pts = new Map();
    let g = null, lastTap = null, raf = 0, rect = null;
    const pos = e => ({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    function begin(moved = false) {
      const p = [...pts.values()];
      if (p.length === 1) g = { n: 1, st0: { ...v.st }, p0: p[0], moved };
      else if (p.length === 2) g = { n: 2, st0: { ...v.st }, a0: p[0], b0: p[1] };
      draw();
    }
    stage.addEventListener("pointerdown", e => {
      if (e.target.closest("button") || (e.pointerType === "mouse" && e.button)) return;
      rect = stage.getBoundingClientRect();
      try { stage.setPointerCapture(e.pointerId); } catch { /* 합성 이벤트 등 */ }
      pts.set(e.pointerId, pos(e));
      begin(pts.size > 1);
    });
    stage.addEventListener("pointermove", e => {
      if (!g || !pts.has(e.pointerId)) return;
      pts.set(e.pointerId, pos(e));
      if (!raf) raf = requestAnimationFrame(move);
    });
    function move() {
      raf = 0;
      if (!g) return;
      const p = [...pts.values()];
      if (g.n === 2) {
        if (p.length >= 2) { v.st = clampPan(pinch(g.st0, g.a0, g.b0, p[0], p[1]), v.view, v.size); draw(); }
        return;
      }
      if (!p.length) return;
      const dx = p[0].x - g.p0.x, dy = p[0].y - g.p0.y;
      if (!g.moved && Math.hypot(dx, dy) < 8) return;
      g.moved = true;
      if (g.st0.scale > 1.01) { v.st = clampPan({ scale: g.st0.scale, x: g.st0.x + dx, y: g.st0.y + dy }, v.view, v.size); draw(); }
      else if (Math.abs(dx) >= Math.abs(dy)) draw(dx, 0); // 넘기기 미리보기
      else draw(0, Math.max(0, dy));                     // 아래로 끌어 닫기 미리보기
    }
    function end(e) {
      if (!pts.has(e.pointerId)) return;
      if (e.type === "pointerup") pts.set(e.pointerId, pos(e));
      if (raf) { cancelAnimationFrame(raf); move(); } // 아직 안 그린 마지막 이동 반영
      const last = pts.get(e.pointerId);
      pts.delete(e.pointerId);
      if (!g) return;
      if (g.n === 2) {
        if (pts.size) begin(true); // 남은 손가락으로 계속 (탭으로 치지 않음)
        else { g = null; set(v.st.scale < 1.05 ? { scale: 1, x: 0, y: 0 } : v.st, true); } // 거의 맞춤이면 맞춤으로
        return;
      }
      if (pts.size) return;
      const gg = g;
      g = null;
      if (!gg.moved) {
        if (e.type !== "pointerup") return;
        const tap = { t: Date.now(), x: last.x, y: last.y };
        if (isDoubleTap(lastTap, tap)) {
          lastTap = null;
          if (v.st.scale > 1.01) set({ scale: 1, x: 0, y: 0 }, true);
          else set(zoomAround(v.st, DOUBLE, tap.x, tap.y), true);
        } else lastTap = tap;
        return;
      }
      lastTap = null;
      if (gg.st0.scale > 1.01) return; // 이동 끝
      const dx = last.x - gg.p0.x, dy = last.y - gg.p0.y;
      const dir = swipeDir(dx, dy, gg.st0.scale);
      if (dir && go(dir)) return;
      if (dy > 120 && dy > Math.abs(dx) * 1.5) { close("swipe"); return; }
      draw(0, 0, true); // 제자리로
    }
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
    stage.addEventListener("lostpointercapture", end);
    root.addEventListener("dragstart", e => e.preventDefault());
    // iOS Safari: 자체 제스처 이벤트로 페이지 전체가 확대되지 않게 (touch-action: none과 함께)
    for (const t of ["gesturestart", "gesturechange", "gestureend"]) root.addEventListener(t, e => e.preventDefault());
    // 캡션·버튼 줄 밖의 터치 이동은 페이지 스크롤·확대로 새지 않게
    // (캡션이 넘치지 않으면 overscroll-behavior가 듣지 않아 뒤 페이지가 스크롤되므로 그때도 막음)
    root.addEventListener("touchmove", e => {
      const c = e.target.closest(".fv-cap");
      if (e.touches.length > 1 || !c || c.scrollHeight <= c.clientHeight) e.preventDefault();
    }, { passive: false });
    // 휠·트랙패드 핀치(ctrl+휠) = 커서 위치 기준 확대
    root.addEventListener("wheel", e => {
      if (e.target.closest(".fv-cap")) return;
      e.preventDefault();
      if (!e.target.closest(".fv-stage")) return;
      const r = stage.getBoundingClientRect();
      const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
      set(zoomAround(v.st, v.st.scale * k, e.clientX - r.left, e.clientY - r.top));
    }, { passive: false });
    // 캡션 속 본문 링크(#S2, #bib…)는 뷰어를 닫고 그 자리로
    cap.addEventListener("click", e => {
      const a = e.target.closest('a[href^="#"]');
      if (!a) return;
      e.preventDefault();
      let id = a.getAttribute("href").slice(1);
      try { id = decodeURIComponent(id); } catch { /* 그대로 */ }
      const t = id && document.getElementById(id);
      closeAll();
      if (t) PaperNav.jumpTo(t);
    });
    const onKey = e => {
      if (UI.topLayer()?.close !== close || e.altKey || e.ctrlKey || e.metaKey) return;
      const k = e.key;
      if (k === "ArrowRight") go(1);
      else if (k === "ArrowLeft") go(-1);
      else if (k === "+" || k === "=") zoomBy(1.5);
      else if (k === "-") zoomBy(1 / 1.5);
      else if (k === "0") set({ scale: 1, x: 0, y: 0 }, true);
      else if (k === "ArrowUp" || k === "ArrowDown") set({ ...v.st, y: v.st.y + (k === "ArrowUp" ? 80 : -80) }, true);
      else if (!["PageUp", "PageDown", "Home", "End"].includes(k) && !(k === " " && !e.target.closest?.("button, a"))) return;
      // 나머지(스페이스·PageDown 등)는 뒤 페이지가 스크롤되지 않게 막기만
      e.preventDefault();
    };
    let resizeRaf = 0;
    const onResize = () => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => { if (V === v && v.nat) layout(v.nat); });
    };

    document.body.append(root);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    const close = UI.layer(reason => {
      root.remove();
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      if (V === v) V = null;
      // 시트가 열리며 닫힌 경우엔 시트가 포커스를 가져감
      if (reason !== "sheet" && prevFocus && prevFocus !== document.body && prevFocus.isConnected) {
        try { prevFocus.focus({ preventScroll: true }); } catch { /* 무시 */ }
      }
    }, { kind: "viewer" });
    Object.assign(v, { close, show, root });
    V = v;
    show(start);
    root.focus({ preventScroll: true });
  }

  // ---------- 그림 고정 (PiP, z 15: 질문 시트(20) 아래). 한 번에 하나, 끌어서 옮기기, 누르면 뷰어 ----------
  function pinView() { return { w: innerWidth, h: innerHeight, top: topEdge() }; }
  function place(el, p) {
    const q = clampPin(p, { w: el.offsetWidth, h: el.offsetHeight }, pinView());
    el.style.left = `${q.x}px`;
    el.style.top = `${q.y}px`;
    el._fvPos = q;
  }
  function unpin() { pinEl?.remove(); pinEl = null; }
  function pin(it) {
    unpin();
    const label = labelOf(it), target = it.img || it.fig;
    const body = h("div", { class: "fv-pin-body", role: "button", tabindex: "0", "aria-label": `${label} 크게 보기` });
    if (it.img) body.append(Object.assign(UI.cloneClean(it.img), { draggable: false })); // id 없는 복제 (본문 id 중복 방지)
    else body.append(h("div", { class: "fv-pin-clone" }, cloneBody(it.fig)));
    const x = h("button", { type: "button", class: "fv-pin-x", text: "✕", "aria-label": "고정 해제", onclick: unpin });
    const el = h("div", { class: "fv-pin pr-ui", role: "group", "aria-label": `고정한 그림: ${label}` },
      h("div", { class: "fv-pin-head" }, h("span", { text: label }), x), body);
    document.body.append(el);
    pinEl = el;
    // 표·알고리즘 복제본은 창 너비에 맞게 축소
    const c = el.querySelector(".fv-pin-clone");
    if (c) {
      const k = Math.min(1, body.clientWidth / (c.offsetWidth || 1));
      c.style.transform = `scale(${k})`;
      body.style.height = `${Math.min(c.offsetHeight * k, innerHeight * 0.4)}px`;
    }
    const reopen = () => { if (!openAt(target)) unpin(); };
    place(el, { x: innerWidth - el.offsetWidth, y: 0 });
    let s = null;
    el.addEventListener("pointerdown", e => {
      if (e.button || e.target.closest(".fv-pin-x")) return;
      s = pinDrag = { x: e.clientX, y: e.clientY, p: el._fvPos, moved: false };
      try { el.setPointerCapture(e.pointerId); } catch { /* 합성 이벤트 등 */ }
    });
    el.addEventListener("pointermove", e => {
      if (!s) return;
      const dx = e.clientX - s.x, dy = e.clientY - s.y;
      if (!s.moved && Math.hypot(dx, dy) < 6) return;
      s.moved = true;
      el.classList.add("fv-dragging");
      place(el, { x: s.p.x + dx, y: s.p.y + dy });
    });
    const up = e => {
      if (!s) return;
      const moved = s.moved;
      s = pinDrag = null;
      el.classList.remove("fv-dragging");
      if (!moved && e.type === "pointerup") reopen();
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    body.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); reopen(); } });
  }
  const reclampPin = () => { if (pinEl) place(pinEl, pinEl._fvPos); };
  // 끄는 동안 브라우저의 그림 끌어 놓기 금지: 마우스를 누른 자리(창이 비킨 뒤 본문 그림)에서 드래그가 시작되면 포인터가 취소됨
  let pinDrag = null;
  document.addEventListener("dragstart", e => { if (pinDrag) e.preventDefault(); }, true);
  window.addEventListener("resize", reclampPin);
  PaperApp.on("bar", reclampPin);

  // ---------- 그림·표 모아보기 (⋯ 메뉴): 썸네일 격자, 누르면 뷰어 (뷰어를 닫으면 격자로 돌아옴) ----------
  function openGrid() {
    if (gridClose) return;
    const figs = topFigures();
    if (!figs.length) { UI.toast("이 논문에는 그림·표가 없습니다"); return; }
    const list = items(), edge = topEdge();
    const here = figs.findIndex(f => f.getBoundingClientRect().bottom > edge); // 지금 읽는 곳 근처
    const grid = h("div", { class: "fv-grid" });
    figs.forEach((fig, i) => {
      const thumb = h("span", { class: "fv-thumb", "aria-hidden": "true" });
      const imgs = [...fig.querySelectorAll("img")].filter(x => !skip(x)).slice(0, 4);
      if (imgs.length) thumb.append(...imgs.map(im => h("img", { src: srcOf(im), alt: "", loading: "lazy", decoding: "async" })));
      else thumb.append(h("span", { class: "fv-mini" }, cloneBody(fig)));
      const capEl = ownCaption(fig);
      let text = null;
      if (capEl) {
        text = UI.cloneClean(capEl);
        text.querySelectorAll(".ltx_tag").forEach(t => t.remove());
        text.querySelectorAll("a").forEach(a => a.replaceWith(...a.childNodes));
      }
      const label = labelOf({ fig });
      grid.append(h("button", {
        type: "button", class: "fv-tile", "aria-label": `${label} 크게 보기`, "aria-current": i === here ? "true" : null,
        onclick: () => { const j = indexOf(list, fig); if (j >= 0) openViewer(list, j); },
      }, thumb, h("b", { text: label }), text ? h("span", { class: "fv-tile-cap" }, ...text.childNodes) : null));
    });
    gridClose = UI.peek({
      title: `그림·표 모아보기 · ${figs.length}`, body: grid, size: "large", className: "fv-grid-peek",
      onClose: () => { gridClose = null; },
    });
    const t = grid.children[here];
    if (t && here > 1) gridClose.el.scrollTop = Math.max(0, t.offsetTop - 80);
  }

  UI.addBarButton({ id: "figure-viewer", label: "그림·표 모아보기", icon: "🖼", onClick: openGrid });
  PaperApp.addTapHandler({
    id: "figure-viewer", priority: 50,
    test: e => {
      const img = e.target.closest("img");
      return img && img.closest("figure") && paper.contains(img) && !skip(img) ? img : null;
    },
    handle: (e, img) => openAt(img),
  });
  // ref-peek·overview 등이 그림을 열어 달라고 할 때
  PaperApp.on("open-figure", d => { if (d) openAt((d.img && paper.contains(d.img) && d.img) || d.figureEl); });
})();
