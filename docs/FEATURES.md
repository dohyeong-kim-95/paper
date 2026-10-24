# Feature contract

This is the contract every feature group follows. The foundation (this branch) owns `app.py`,
`static/{store,ui,anchor,app,render,voice,sw}.js`, `static/style.css`, `static/manifest.json`,
`templates/*`, `tests/helpers.py`, `tests/fixtures/*` and `README.md`. **Feature branches do not edit
those files.** A feature ships as new files only:

| What | Path |
|---|---|
| Backend router | `features/<group_with_underscores>.py` (exports `router = APIRouter()`) |
| Frontend script | `static/features/<group>.js` |
| Frontend styles | `static/features/<group>.css` |
| Service-worker extension (optional) | `static/features/<group>.sw.js` |
| Python tests | `tests/test_<group_with_underscores>.py` |
| JS tests | `tests/js/<group>.test.js` |
| Extra fixtures (optional, never edit the shared ones) | `tests/fixtures/<group>_*.{html,xml,json}` |
| Docs (optional) | `docs/features/<group>.md` |

If something seems to require editing a foundation file, use an extension point listed here instead.
If none fits, stop and say so; do not edit the shared file.

Run everything with:

```bash
python -m unittest discover -s tests          # also runs tests/js/*.test.js through node, and
                                              # tests/browser/*.browser.js when Playwright + Chromium exist
for f in tests/js/*.test.js; do node $f; done  # JS only
```

---

## 1. Rules (read these first)

1. **One Claude prefix for everything.** Every Claude call uses `system=core.system_blocks(paper)` and
   `**core.REQUEST_OPTS`, via `core.complete_text`, `core.cached_task`, `core.cached_stream`,
   `core.stream_claude` or `core.claude_create`. Never change `SYSTEM_PROMPT`, `system_blocks` or
   `REQUEST_OPTS`. Never use `output_config.format`, `output_format` or tools, because they change the
   cached prefix. Ask for JSON in the **user** prompt and parse it with `core.parse_json_loose`.
2. **Length and format instructions live in the user message.** The system prompt says "concise, Markdown".
   `complete_text`, `cached_task` and `cached_stream` prepend `core.TASK_PREAMBLE`, which tells the model
   to follow your format instead. Set `max_tokens` for the real output size; `max_tokens` truncation
   counts as a failure, is not cached and is remembered for 10 min (in `cached_stream` too, where the body
   ends with `[오류] …`). Glossary and gists need 8000. Cap lists at 30.
3. **Version your cache names.** `cached_task(id, "<group>.<thing>.v1", ...)` writes
   `cache/<id>.<group>.<thing>.v1.json`. Change the prompt, bump to `v2`.
4. **The JS template.** Every `static/features/*.js` file is exactly this shape (the smoke test enforces it):

   ```js
   // <group>: 한 줄 설명
   (function () {
     "use strict";
     // 순수 함수 (node 테스트 대상)
     function parseThing(text) { /* ... */ }
     const api = { parseThing };
     if (typeof module !== "undefined") module.exports = api;
     if (typeof document === "undefined") return;           // node: 여기서 끝
     if (document.body.dataset.page !== "paper") return;    // 이 기능이 쓰는 페이지만 ('paper' | 'home' | 'abstract')
     PaperApp.registerFeature("<group>", api);
     // DOM 초기화 ...
   })();
   ```

   No top-level declarations. Export nothing on `window` except through `PaperApp.registerFeature(id, api)`.
   Your code runs once, when the deferred `/features.js` bundle executes (after the DOM is parsed and
   after `store.js`, `ui.js`, `anchor.js` and `app.js`). Do not wait for `DOMContentLoaded` (it also waits
   for the CDN libraries). Each file is parsed and run on its own (`new Function`), so a syntax or runtime
   error drops only that file; it is logged as `[feature] <file>`.
   Bundle order is alphabetical, so never depend on another feature having loaded at init time; check
   `PaperApp.has(id)` lazily (at click time).
5. **Paper text is read-only.** Never wrap, move, split or edit text nodes inside `#paper`, with two
   exceptions: glossary and section-translate, and only through `PaperAnchor.wrap` / `PaperAnchor.insertUI`.
   Highlights of any kind use `PaperAnchor.paint` (CSS Custom Highlight API), not DOM marks.
   Any element you insert into `#paper` must carry the class `pr-ui` (use `PaperAnchor.insertUI`), so
   the text index, selections, clones and TOC titles ignore it. **The one exception is the element
   `PaperAnchor.wrap` puts around paper text:** it must not carry `pr-ui` or `tr-ko` (the index would drop
   the wrapped text and every later offset would shift), and `wrap` removes those classes. Only non-paper
   children you add inside it (a ruby `<rt>` gloss) carry `pr-ui`. Class/attribute toggles on paper
   elements are fine.
6. **Anchors are offsets into the PaperAnchor index.** Store `{quote, prefix, suffix}` from
   `PaperAnchor.rangeToQuote(range)` (math becomes `$alttext$`, so it re-anchors), re-find with
   `PaperAnchor.findQuote` / `locate`. Do not use `selection.toString()` for anything you will save.
7. **Taps on paper content go through `PaperApp.addTapHandler`** with the priority from §5.4. Never add
   your own `click` listener on `#paper` for content taps. Your own buttons can have normal listeners: the
   dispatcher skips clicks on **feature controls** (a `button`, `input`, `select`, `textarea`, `label`,
   `summary`, `[role=button]` or `a` that is, or sits inside, `.pr-ui`), so only your listener runs and the
   sheet it opens is not minimized. No `preventDefault` needed. The one exception is a cloned paper link
   (`a.ltx_ref`, e.g. inside a `.tr-ko` translation): it still goes to ref-peek/cite-cards. Other taps on
   `.pr-ui` content (e.g. `.tr-ko` sentence spans) also still reach the handlers. `app:minimize` ignores
   `.pr-ui` targets except `.tr-ko` text (in 번역 mode nearly all visible text is `.tr-ko`).
   `PaperAnchor.offsetAtPoint` returns `null` (so `paintedAt` returns `-1`) unless the point is on indexed
   paper text or math, so painted-range handlers never fire on chips, translations or the margins.
8. **Answer turn extras go into your slot** (`PaperApp.addAnswerAction` or `detail.slot(id)`), never inside
   `.a`. To change the answer text itself, call `renderAnswerNow(answerEl, newText)` (evidence-chips only).
9. **Overlays integrate with system Back.** Use `PaperUI.peek`. For a custom overlay (figure viewer,
   drawer, find bar) wrap it with `close = PaperUI.layer(onClose, {kind})` and call `close()` when your UI
   closes it. Android Back, iOS edge-swipe and Esc then close the top layer. **Opening the ask sheet closes
   every open layer except jump layers and layers made with `{keepOnSheet: true}`.** Each layer closed this
   way gets reason `"sheet"` in its `onClose`. Without that, the sheet (z 20) would open under a peek (25) or
   the viewer (30). So a sender such as figure-viewer does not need to close itself before dispatching
   `paper:figure-explain`. Use `keepOnSheet` only for UI that does not overlap the sheet (the find bar at the top).
   Pass your overlay's z-index as `{z}` (kind `"viewer"` defaults to 30): a peek always opens above the
   highest open layer. While any layer is open, a click on a same-document `a[href^="#"]` that no handler
   took is turned into `PaperNav.jumpTo(target)` instead of a fragment navigation, so it never adds a history
   entry (if your own listener handles such a link, call `preventDefault()` so it is not jumped twice).
   Fragment navigations (or `location.hash = …`) never count as a layer Back.
10. **Undo, not confirm.** Deletions show `PaperUI.toast("삭제됨", {actionLabel: "실행 취소", onAction})`.
    Never `confirm()`/`alert()`.
11. **Storage only through PaperStore**, only under your own key prefix (§6). Writing another group's key
    or reading another group's IndexedDB is not allowed. Call its API through `PaperApp.feature("<group>")`
    instead, with the signatures in §6.1 (look it up at call time; it may be missing):
    `PaperApp.feature("library")?.add?.({...})`.
12. **Accessibility.** Icon-only buttons get `aria-label`. Overlays are `PaperUI.peek` (role=dialog,
    focus return). Do not steal focus from a live selection. Do not announce streaming text.
13. **No new pip deps, no build step, no new CDN libraries.** Use stdlib, `httpx`, `bs4` and the existing
    marked, DOMPurify and KaTeX.

---

## 2. Backend API (`import app as core`)

Feature modules: `features/<group_with_underscores>.py`, loaded in sorted order at the end of `app.py`.
A module that raises at import is logged and skipped. The app still starts. A module without `router` is
logged as a warning and left out of `core.FEATURES`; name helper modules `_<name>.py` (they are skipped).
`features/__init__.py` imports `app` first, so importing `features.<x>` before `app` (a test that starts with
`from features.x import helper`) still registers every router. Always access `core.client`,
`core.http` and `core.CACHE_DIR` through the module at call time, because tests patch them.

```python
from fastapi import APIRouter, HTTPException
import app as core

router = APIRouter()

@router.get("/api/<group>/{arxiv_id}")
async def thing(arxiv_id: str, retry: bool = False):
    data = await core.cached_task(arxiv_id, "<group>.v1", PROMPT, 4000, validate=clean, retry=retry)
    return core.offline_json(data)   # GET + header X-Offline-Cacheable: 1 → service worker keeps it offline
```

### Papers and parsing

| Helper | Notes |
|---|---|
| `await core.get_paper(id) -> {"title","html","text"}` | Memory, then `cache/<id>.json`, then arXiv HTML, then ar5iv. Concurrent loads share one fetch. 404 if neither has HTML. |
| `await core.paper_soup(id) -> BeautifulSoup` | Memoized parse of `paper["html"]` (last 4 papers). **Shared: never mutate.** Use `copy.copy(el)` first if you must. |
| `await core.paper_index(id) -> dict` | Memoized structure (built once per paper): `title`; `sections: [{id, level: section/subsection/subsubsection/appendix/paragraph, tag: "2.1", title, full}]` (no bibliography); `bib: {bib_id: {id, label: "[1]", text, arxiv_id, doi, title_guess, hrefs}}`; `figures: [{id, kind: figure/table/algorithm, top: bool, caption, imgs}]` (`top=False` for sub-panels); `paras: [ids]`; `imgs`, `img_set`; `links` (external, outside the bibliography); `code_links` (github/gitlab repos). Shared: never mutate. |
| `core.build_index(soup)` | The pure builder behind `paper_index`. |
| `core.el_text(el, skip_notes=True)` | Text with `<math>` as ` $alttext$ ` and footnote bodies skipped (the same rule as `PaperAnchor.textOf`). |
| `core.parse_arxiv_id(s)`, `core.safe_id(s)` | |
| `core.clean_article(raw, base_url)` | The paper HTML is inserted with `\| safe`, so it is sanitized here: `on*` attributes, `iframe/object/embed/form/base/meta/link`, SVG `animate/set`, every non-element markup node (CDATA, comments, processing instructions, `<!…>` declarations: bs4 writes them back verbatim but the browser reads them as bogus comments that end at the first `>`), and `href/src/xlink:href/action` values that are not http(s), `mailto:`, `#…` or (on `img`) `data:image/` are removed. Papers cached on disk with an older `CLEAN_VERSION` (now 3) are re-cleaned on load. |
| **Never** `soup.select_one("#" + id)` | LaTeXML ids contain dots. Use `soup.find(id=...)` / `find("li", id=bib_id)`. |

### Claude

| Helper | Notes |
|---|---|
| `await core.complete_text(paper, prompt, max_tokens=1500, *, messages=None, preamble=True) -> str` | Non-streaming. Prepends `TASK_PREAMBLE` (unless `preamble=False`). API errors and `max_tokens` truncation raise `HTTPException(502)`. Pass `messages=` to send your own list, e.g. follow-ups. |
| `await core.cached_task(id, name, prompt, max_tokens=4000, as_json=True, validate=None, retry=False)` | A disk hit returns immediately. Concurrent callers share one call (`asyncio.shield`, so one client disconnecting does not cancel the others). Atomic write. `as_json` uses `parse_json_loose`. `validate(value) -> value` may filter; raising **any** exception (`ValueError`, `IndexError`, …) counts as a failure. Failures (502) are **not cached** and are remembered for 10 min (`retry=True` bypasses this, e.g. for the status chip's "다시"). |
| `await core.cached_stream(id, name, prompt, max_tokens=4000, headers=None, retry=False) -> StreamingResponse` | Text artifact streamed as `text/plain`. A cache hit sends one chunk. Generation runs in a background task: if the user leaves, it still finishes and caches. Concurrent GETs tail the same buffer. Failures (API error, `max_tokens` truncation, empty output) end the body with one line `\n\n[오류] ...`, are not cached, and are remembered for 10 min like `cached_task`: a new GET then raises `HTTPException(502)` instead of paying for another generation, unless `retry=True` (pass the route's `retry` query flag through). Sets `X-Offline-Cacheable: 1`; the service worker skips bodies that end with the error line. Clients check for that line (`PaperApp.ERROR_TAIL`). |
| `core.stream_claude(paper, messages, max_tokens=4000) -> StreamingResponse` | For `/api/ask`-style multi-turn streams. Uses top-level `cache_control` so the growing conversation tail is cached. API errors, any other exception and `max_tokens` truncation end the body with the single `\n\n[오류] …` line (`core.error_tail`), so clients treat the reply as failed. |
| `await core.claude_create(paper, messages, max_tokens)` | Raw shared call (no preamble, no checks). |
| `core.build_messages(body: core.Ask) -> list` | `history` + `question` (skipped if empty). The first user turn gets `build_first_turn(selection, context, question, section)`: `<highlight>`, then `<context><section>…</section>…</context>`, **first user turn only** so follow-ups keep identical bytes. |
| `core.Ask` | `arxiv_id, selection="", context="", section="", question="", history=[Turn]`. Subclass it for extra fields (e.g. `figure_id`, `image_urls`). |
| `core.mark_cache(messages, index=-1)` | Turns a message's content into a text block with `cache_control`. Renders byte-identical to the string form. Use it on the last assistant turn in follow-up style calls. |
| `core.user_turn(prompt, preamble=True)`, `core.message_text(msg)`, `core.TASK_PREAMBLE` | |
| `core.parse_json_loose(text)` | Strips fences and chatter, then `json.loads`. Raises `ValueError`. |
| `@core.on_prewarm async def f(arxiv_id)` | Runs server-side after `/api/prewarm` warms the paper cache (on every paper open). Use only for cheap or P0 artifacts (overview). Normally prefetch from the client via `PaperApp.idle`. Every registered hook runs on each `POST /api/prewarm`, in tests too (§9). |

A one-shot task sends exactly one cache breakpoint (the system block). Do not add top-level `cache_control`
to one-shot calls: the automatic breakpoint lands on your unique prompt, which costs a 1.25x write that is
never read. Use at most 4 breakpoints in total.

### Disk, arXiv, images, offline, feedback

| Helper | Notes |
|---|---|
| `core.task_path(id, name)` | `CACHE_DIR/<safe id>.<safe name>.json`. Sanitizes `name`, so ids from URLs are safe. |
| `core.read_json(path, default)`, `core.write_json(path, obj)` (atomic), `core.update_json(path, fn, default)` | `update_json` is atomic within the event loop (no awaits). Use it for read-modify-write maps such as `cite-cards`. |
| `await core.arxiv_query(id_list=None, search=None, max_results=10, start=0, sort_by=None, sort_order="descending", timeout=10)` | export.arxiv.org with a **global 3 s spacing**. Returns `parse_atom` dicts: `{id (no version), version, title, summary, authors, published, updated, year, primary_category, categories, doi, comment, abs_url, pdf_url}`. Raises `httpx.HTTPError` (network or status) and `ValueError` (bad XML). Batch: one `id_list` call for many ids. |
| `core.parse_atom(xml)` | Pure. Skips arXiv error entries. |
| `await core.fetch_image(id, url) -> (media_type, bytes) \| None` | Only `<img src>` values that appear in this paper **and** sit on arxiv.org/ar5iv hosts (otherwise 400). No redirects. png/jpeg/gif/webp only. ≤3.7 MB raw. LRU of 50. `None` means skip it. |
| `core.offline_json(data)` / header `core.OFFLINE_HEADERS` | Opt a GET response into offline caching. |
| `POST /api/feedback` | `{kind, vote: up\|down, arxiv_id, target, label, question, answer_len, note}` is appended to `cache/feedback.jsonl`. Use `PaperUI.feedback(kind, target)` on the client. |
| `@core.on_paper_missing async def f(request, arxiv_id) -> Response \| None` | Called in registration order when `/paper/{id}` has no HTML (404). The first non-`None` response is returned. Otherwise the foundation renders `templates/error.html` (404, with an arXiv link). `arxiv_id` is raw user input, so validate it (`parse_arxiv_id`). Only entry-routes registers one. |
| `core.render_page(request, title, body_html, *, page="abstract", arxiv_id=None, status_code=200) -> Response` | A plain page on `base.html` (shared scripts, `/features.js`/`.css`, CDN libraries, reading settings) with `<body data-page="<page>">` and `<main class="pr-page">body_html</main>`. `body_html` is inserted as is: escape outside text with `core.html_escape`. `page` is `[a-z][a-z0-9-]*`. Use it for the entry-routes abstract page (feature JS checks `data-page === "abstract"`). |

Route prefix: `/api/<group>/...` (entry-routes is the only exception, see §7).

---

## 3. Frontend API

Load order on **every** page: `store.js`, `ui.js`, `anchor.js`, `app.js` (classic, end of body), then
(paper page) `voice.js`, then deferred `render.js`, deferred `/features.js` (all `static/features/*.js`,
each parsed and run on its own inside try/catch that logs the file name; the bundle ends with
`PaperApp.featuresReady()`, which restores a saved sheet thread), then the CDN libraries (marked, DOMPurify,
KaTeX: on every page, home included). `/features.css` is a stylesheet in `<head>`. The KaTeX stylesheet loads
without blocking (`media="print"`, switched on load), so a slow CDN never delays the first paint, the scripts,
the ⋯ menu or the thread restore. `<body data-page="home|paper|error|abstract" data-arxiv-id="...">`
(`abstract` and other names come from `core.render_page`). The global `ARXIV_ID` const still exists on the
paper page.

### 3.1 PaperStore (`store.js`)

All keys start with `pr:`. Values are JSON. Nothing throws: blocked storage falls back to memory.

```js
PaperStore.get(key, fallback)        // key with or without 'pr:'
PaperStore.set(key, value) -> bool   // false on quota error (+ one '저장 공간 부족' toast app-wide)
PaperStore.del(key); PaperStore.update(key, fn, fallback); PaperStore.keys(prefix)
PaperStore.paper(ns, fallback, baseId?) / setPaper(ns, v, baseId?) / delPaper(ns, baseId?)  // key 'pr:<ns>:<baseId>'
PaperStore.paperKey(ns, baseId?); PaperStore.baseIdOf("2401.04088v2") === "2401.04088"
PaperStore.addMerger(prefix, fn(local, incoming, key) -> merged)   // your key's import rule (§6)
PaperStore.merge(key, local, incoming); PaperStore.exportAll(); PaperStore.importAll(obj) -> n
PaperStore.session  // the same API over sessionStorage (per tab)
```

### 3.2 PaperUI (`ui.js`)

```js
PaperUI.h(tag, {class, text, dataset, onclick, ...attrs}, ...children)   // tiny DOM helper
PaperUI.peek({title, body: Node|string, actions: [{label, onClick({close}), primary}], className, size: "large", onClose})
  -> close(reason)   // close.el (the dialog), close.body. Bottom sheet z 25 (stacks), role=dialog, focus return,
                     // closes on ✕, tap outside, swipe down on the header, Back, Esc
PaperUI.layer(onClose(reason), {kind, keepOnSheet, z}) -> close(reason)   // put any custom overlay on the Back stack
  // reasons: "close" (your call), "back", "escape", "sheet" (the ask sheet opened; see rule 9)
  // z: your overlay's z-index (kind "viewer" defaults to 30). A peek opens above the highest open layer
PaperUI.topLayer()                                       // {kind, keepOnSheet, z, close} | null
PaperUI.closeLayers(pred(layer) -> bool, reason)         // close matching layers, top first
PaperUI.toast(msg, {actionLabel, onAction, ms}) -> {close}   // z 40, aria-live polite. One at a time. A toast with
  // an action (실행 취소, 이동) is never replaced: toasts that arrive meanwhile wait behind it (at most 2 plain ones).
  // A plain toast is replaced by the next one.
PaperUI.addBarButton({id, label, icon, title, onClick}) -> {el, setLabel, setActive, setDot, remove}
  // placement and order come from the bar table (§5.1), not from you. Ids outside the table go to the ⋯ menu.
  // Returns a no-op handle on pages without a header (home).
PaperUI.addFab({id, label, icon, order, onClick}) -> el    // bottom right in #bottom-dock (§5.11), hidden while the sheet is open
PaperUI.homeSection({id, title}) -> <section> | null      // home page container, ordered by §5.7
PaperUI.status(key, label, "loading"|"ready"|"error"|null, {onRetry})   // background enrichment chips under the header
PaperUI.topSlot(id) -> <div> | null     // your row in the sticky strip under the header, ordered by §5.11 (null without a header)
PaperUI.bottomSlot(id) -> <div> | null  // your row above the back chip / answer pill / FAB row (§5.11)
PaperUI.setBarHidden(bool); PaperUI.isBarHidden()   // header auto-hide state: html.pr-bar-hidden + 'paper:bar' {hidden}.
  // Only reading-settings calls setBarHidden; never move .bar yourself
PaperUI.feedback(kind, target, {arxivId, label, question, answerLen}) -> el   // 👍/👎 → /api/feedback
PaperUI.cloneClean(el)          // deep clone without ids, .pr-ui and .tr-ko (for peeks, pins, previews)
PaperUI.copy(text, msg="복사됨"); PaperUI.share({title, text, url}); PaperUI.download(name, text, type)
  // share: cancelling is silent; falls back to a clipboard copy. download: uses the share sheet on iOS PWA, else <a download>
PaperUI.dragDown(handle, target, onClose, {threshold, allowUp, onUp, onTap})
PaperUI.barLayout / BAR / upsert   // pure, exported for tests
```

### 3.3 PaperAnchor and PaperNav (`anchor.js`)

The index is the flat text of `#paper`, built lazily and invalidated by a MutationObserver. It skips
`.pr-ui`, `.tr-ko`, `.ltx_note_outer` (footnote bodies), `.ltx_bibliography`, `script`, `style` and `button`.
Each `<math>` counts as ` $alttext$ `. Offsets do not change when features insert `.pr-ui` nodes or call
`wrap`.

```js
PaperAnchor.index() -> {text, segs: [{node, start, end, math}], root}
PaperAnchor.textOf(el)                      // text with $alttext$, same skips, whitespace collapsed
PaperAnchor.normalize(s)                    // lowercase, unified quotes and dashes, collapsed spaces, no space before .,;:!?)
PaperAnchor.locate(quote, {root, prefix, suffix}) -> {start, end} | null  // exact normalized match, then first 8 words
PaperAnchor.findQuote(quote, {root, prefix, suffix}) -> Range | null
PaperAnchor.rangeToQuote(range) -> {quote, prefix, suffix, start, end}   // what you store
PaperAnchor.rangeAt(start, end) -> Range; PaperAnchor.offsetsOf(range); PaperAnchor.offsetsOfElement(el)
PaperAnchor.offsetAtPoint(x, y) -> offset | null   // tap hit-testing (caretPositionFromPoint/caretRangeFromPoint).
  // null unless the point is on indexed paper text or math: .pr-ui, .tr-ko, buttons, footnote bodies and
  // empty space all give null
PaperAnchor.paint(name, [{start,end} | Range], {priority, fallback = true, raw = false}) / clear(name) / paintedAt(name, x, y) -> index | -1
  // CSS Custom Highlight API: style it with ::highlight(<name>) in your CSS, priority from §5.10. Without
  // CSS.highlights it falls back to <mark class="pa-mark pa-mark-<name>"> (yellow by default; style
  // mark.pa-mark-<name>), or paints nothing with fallback: false (underline-only or per-keystroke names).
  // Repaints automatically on paper:dom-changed. paint/clear never dispatch paper:dom-changed themselves,
  // so repainting from that listener is safe.
  // raw: true paints Ranges outside the index (inside .tr-ko translations) as live Ranges instead of offsets
  // (an offset would collapse there). No <mark> fallback; paintedAt hit-tests their client rects; paint again
  // after you change that translated DOM. Use it for the Korean side only (audio-summary, section-translate).
PaperAnchor.insertUI(refEl, el, "afterend"|"beforeend"|...) // adds .pr-ui and inserts
PaperAnchor.wrap(start, end, makeEl) -> [els] / unwrap(els)  // ONLY glossary and section-translate. Removes
  // pr-ui/tr-ko from the element makeEl returns (it holds paper text, rule 5)
PaperAnchor.changed()                       // call after any sanctioned text-node move → 'paper:dom-changed'
PaperAnchor.flash(Range | Element)          // 1.5 s highlight
PaperAnchor.locateIn / normMap / quoteAt / clipAround   // pure, for node tests

// Selections outside the index (a .tr-ko translation, or a .pr-ui card a feature made selectable) have no
// anchor: rangeToQuote gives an empty quote, selInfo.anchored is false and selInfo.start/end are null.
// Actions that store an anchor hide themselves with when: s => s.anchored (§5.2). selInfo.inTranslation
// (the selection starts inside .tr-ko) is for translation-specific UI only.

PaperNav.jumpTo(Element | Range | {start,end}, {flash=true, smooth=true, back=true}) -> bool
  // dispatches 'paper:reveal' {el, range} first, scrolls, flashes, and pushes a Back layer with the
  // '↩ 돌아가기' chip. System Back returns to the previous position. Use back: false when stepping through
  // many targets (search matches), so each step does not add a Back entry.
PaperNav.back(); PaperNav.depth
```

### 3.4 PaperApp (`app.js`)

```js
PaperApp.page, arxivId, baseId
PaperApp.warm                    // Promise of the prewarm fetch; never rejects
PaperApp.idle(fn) -> Promise     // background jobs, one at a time, after warm, paused while an answer streams
PaperApp.registerFeature(id, api?); PaperApp.has(id); PaperApp.feature(id) -> api object | undefined
  // feature() is undefined when the group is absent or registered no object: call PaperApp.feature(id)?.fn?.(...)
PaperApp.on(name, fn(detail, e)) // = document.addEventListener("paper:" + name, ...)

// Selection (paper page)
PaperApp.sel() -> selInfo | null // live selection or the last snapshot (survives the tap that collapses it on iOS)
PaperApp.selectRange(range)      // programmatic selection (sentence mode); shows the sel-bar
PaperApp.justSelected()          // true for 400 ms after a selection collapsed
PaperApp.addSelectionAction({id, label, order, primary, when(selInfo) -> bool, onClick(selInfo)})  // upsert by id
PaperApp.addTapHandler({id, priority, allowWithSelection, test(e) -> truthy hit, handle(e, hit)})
  // one dispatcher for clicks inside #paper. It skips e.defaultPrevented and feature controls (rule 7).
  // While a selection exists, was just dismissed, or the tap started with one, only handlers with
  // allowWithSelection: true are tried (smart-presets sentence mode). Calls preventDefault on a hit.
  // Higher priority first, only one handler runs.

// selInfo = {text (math as $alttext$), raw, range, start, end, prefix, suffix, wordCount, isMath, latex: [alttext],
//            paragraphEl, paraId, sectionEl, sectionId, sectionTitle, context (paragraph text ≤1500 chars, $alttext$),
//            anchored (start/end/prefix/suffix exist: something indexed was selected; false inside .tr-ko or other .pr-ui),
//            inTranslation (selection starts inside .tr-ko)}
PaperApp.setSelBar(on)           // turn the sel-bar on/off (pr:app:selbar) and keep the header button label in sync

// Ask sheet
PaperApp.openSheet({quote, selection, context, section, endpoint="/api/ask", extra={}, presets, history=[], shown=[],
                    meta=[], autoAsk: string | {q, label, id}, title, selInfo, threadId, origin}) -> session | null
  // selection/context/section/extra/endpoint are FROZEN for the session (so the cached prefix holds).
  // presets: array of strings or {id,label,q} that replaces the ranked registered presets for this session.
  // history: earlier turns ({role, content}) to continue a saved thread; they are re-rendered (restored: true)
  //   with shown[i] and meta[i] ({label, presetId, via}). Session hooks do NOT run when history is given:
  //   pass back the saved session's own quote/selection/context/section/endpoint/extra/history/shown/meta
  //   and the first user turn is byte-identical (session.continued is true).
  // threadId: the conversation's stable id. A new session gets threadId = its id; pass the saved threadId back
  //   when continuing so the same thread is updated (id changes on every openSheet). origin: any opaque value of
  //   yours. Both are kept on the session and survive the reload restore.
  // Every open layer except jump and keepOnSheet layers is closed first (rule 9).
PaperApp.ask(question, {label, presetId, via})
PaperApp.addLocalTurn({shown, node | markdown, actions: [{label, onClick({turnEl, answerEl, remove})}]})
  -> {turnEl, answerEl, toolsEl, slot(id), remove} | null
  // shows local content (cached translation pairs, a saved meaning) as a turn in the open sheet without calling
  // Claude: no history, not persisted, no answer-done event, gone on the next openSheet or reload. markdown is
  // rendered with renderAnswerNow. A later ask() adds normal turns after it. A session with only local turns is
  // closed (not kept as a pill) when minimized. Call openSheet (without autoAsk) first.
PaperApp.closeSheet(); PaperApp.minimizeSheet(); PaperApp.restoreSheet(); PaperApp.isSheetOpen()
PaperApp.session                 // {id, threadId, origin, quote, selection, context, section, endpoint, extra, presets, title, selInfo, history, shown, meta, continued}
PaperApp.streaming               // bool
PaperApp.ERROR_TAIL              // /\n\n\[오류\][^\n]*$/: the failure line that ends a failed streamed body

PaperApp.addPreset({id, label, q: string | (selInfo, session) => string, run?(session), order, match(selInfo) -> number|false})
  // upsert by id; sorted by match score desc then order; match(null) is a sheet without a selection.
  // run: do something instead of asking (e.g. open a quiz peek).
PaperApp.removePreset(id); PaperApp.presets()
PaperApp.addSessionHook(fn(session))   // runs once in openSheet before freezing, for NEW sessions only (not when
  // continuing with history, not on reload restore); may append to session.context or extra
PaperApp.addAskHook(fn(payload, {endpoint, presetId, label, via, turn, session}) -> payload|void)
  // ONLY payload.question changes are kept (selection/context/section/history/extra are re-frozen).
  // history stores the transformed question, so the next turn's prefix is byte-identical.
PaperApp.addAnswerAction({id, order, render(detail) -> Node | Promise<Node> | null})   // into the turn slot `id`
PaperApp.addSheetTool({id, order, render(session) -> Node | null})   // rows above the presets (#sheet-tools).
  // render runs every time the sheet is shown (open and restore); call PaperApp.refreshSheetTools() to
  // re-render while it is open (e.g. on online/offline)
PaperApp.addOfflineUrl(url); PaperApp.offlineUrls() -> [url]   // cacheable GETs this page already fetched
  // (generation finished). offline-save re-fetches only these, so saving never starts paid generation.

PaperApp.tts.speak(text | [chunks], {lang="ko-KR", rate, voice, owner, start, onBoundary({index, charIndex, text}), onEnd(info)})
PaperApp.tts.stop(reason); pause(); resume(); seek(i); prime(); supported; speaking; paused; owner; voiceFor(lang); splitSentences(text)
  // The only owner of speechSynthesis. A new speak() stops the previous owner (onEnd({interrupted:true})).
  // Call the first speak() synchronously inside a tap handler (iOS). voice.js calls prime() in the mic tap,
  // so a later automatic speak() (answer to a voice question) has sound on iOS. Starting the mic stops TTS;
  // TTS start cancels the mic and drops what was heard so far (it is not sent as a question).
  // Resuming restarts the current sentence. Stops on pagehide. Dispatches 'paper:tts' {state: start|pause|resume|end, owner}.
```

Default presets have fixed ids: `easy` 쉽게 설명, `equation` 수식 풀이, `translate` 번역 and `why` 왜 중요?
(scores 40, 30 or 90 for math, 20 and 10). The default selection action is `ask` 질문하기 (order 0, primary).

### 3.5 Events (all on `document`, prefix `paper:`)

| Event | detail | When |
|---|---|---|
| `paper:selection` | selInfo \| null | debounced selection change inside `#paper` |
| `paper:sheet-open` | `{session, restored}` | sheet shown (restored: re-opened from the pill) |
| `paper:sheet-close` | `{session, reason: "close" \| "minimize"}` | |
| `paper:ask` | `{payload, session, endpoint}` | a request is about to be sent (abort your follow-up requests) |
| `paper:answer-done` | `{turnEl, answerEl, toolsEl, slot(id), turn, question (sent, transformed), shown, text, label, presetId, via, endpoint, session, payload, restored}` | **after** the final synchronous Markdown render. `restored: true` for turns re-rendered from history or a reload. Do not refetch on restored turns. |
| `paper:answer-error` | `{session, payload, error, turnEl}` | stream failed; a '이어서 받기' retry button is shown |
| `paper:reveal` | `{el, range}` | before a jump. If you hide paper text (translate mode), un-hide it. |
| `paper:jump` | `{el, range}` | after a jump |
| `paper:dom-changed` | — | after `wrap`/`unwrap`/`changed()` (not after `paint`/`clear`). Re-derive Ranges from your stored offsets. |
| `paper:tts` | `{state, owner, index}` | |
| `paper:bar` | `{hidden}` | the header was hidden or shown (`PaperUI.setBarHidden`) |
| `paper:store-full` | — | localStorage quota hit (the toast is automatic) |

Feature-to-feature events (names reserved here): `paper:figure-explain` `{figureEl}` (figure-viewer →
figure-explain), `paper:open-figure` `{figureEl, img}` (ref-peek/overview → figure-viewer), `paper:gists`
`{map}` (section-study → toc-progress), `paper:translations` `{mode}` (section-translate → toc-progress,
which then reads titles with `section-translate.titleFor`), `paper:settings` `{key, value}` (reading-settings →
anyone, after a setting changes, e.g. `ruby` for glossary or `autohide`).

### 3.6 render.js

`renderAnswer(el, text)` renders on the next animation frame (for streaming). `renderAnswerNow(el, text)`
renders synchronously and cancels the pending frame. Use it for any Markdown you render, on any page: notes
previews, overview card, saved Q&A (home's library and vocab too; the CDN libraries load on every page).
`/features.js` runs before the CDN libraries, so an early call renders plain text; the element is re-rendered
automatically once marked and DOMPurify load (if its text did not change in between). If the CDN never
loads, it stays plain text.

---

## 4. Offline

`sw.js` (cache `paper-v2`): versioned `/static/*?v=` and `/features.*?v=` are served cache-first.
Navigations are network-first with a 3 s fallback to the saved page (or an offline page). jsDelivr is
cache-first. arXiv images are cache-first: images seen while browsing go to `paper-v2-img` (last 60), and
images the user saved go to **`paper-v2-saved`** (no limit, never trimmed, checked first).
**`GET /api/*` responses are network-first, and are saved for offline only when the response carries
`X-Offline-Cacheable: 1`** (`core.offline_json`, `core.cached_stream`). A `text/plain` body that ends with the
`\n\n[오류] …` line (a failed stream) is not saved. POSTs are never cached, so persist translations
client-side (IndexedDB).

Page messages: `{type: "precache", urls}` copies or fetches the images into `paper-v2-saved` and the SW answers
`{type: "precached", n}`; `{type: "unsave", urls}` removes them (`{type: "unsaved", n}`). For anything else,
add `static/features/<group>.sw.js` (served as `/features.sw.js`, loaded by `importScripts`) and push to
`self.PR_SW.routes` (`{test(url, request), handle(event) -> Promise<Response>}`) or `self.PR_SW.onMessage`.
A cache of your own must be named `` `${self.PR_SW.V}-<name>` `` (`paper-v2-…`) and registered with
`self.PR_SW.keep(name)`, otherwise `activate` deletes it. If `/features.sw.js` fails to load while a new SW
installs (offline), `activate` keeps every `paper-v2-…` cache and deletes only older versions.
Only offline-save should need this.

Which GETs to save: features call `PaperApp.addOfflineUrl(url)` after they have fetched a cacheable GET whose
generation finished (overview, glossary, gists, …). offline-save re-fetches `PaperApp.offlineUrls()` only,
so saving never starts a paid generation for a feature the user did not open.

---

## 5. Shared UI tables

### 5.1 Header bar (`ui.js` `BAR`, 3 primary slots)

| id | label | slot | owner |
|---|---|---|---|
| `toc-progress` | 목차 | primary 10 | toc-progress |
| `section-translate` | 번역 (mode via `setActive` + toast: 원문 → 둘다 → 번역) | primary 20 | section-translate |
| `in-paper-search` | 검색 | primary 30 | in-paper-search |
| `overview` | 요약 | ⋯ 40 | overview |
| `reading-settings` | Aa 읽기 설정 | ⋯ 50 | reading-settings |
| `library` | ★ 즐겨찾기 / ☆ 즐겨찾기 | ⋯ 60 | library |
| `highlights-notes` | 노트 | ⋯ 70 | highlights-notes |
| `glossary` | 용어 | ⋯ 80 | glossary |
| `skim-highlights` | 핵심 문장 (`setDot(true)` when data is ready) | ⋯ 90 | skim-highlights |
| `audio-summary` | 듣기 | ⋯ 100 | audio-summary |
| `figure-viewer` | 그림·표 모아보기 | ⋯ 110 | figure-viewer |
| `related-papers` | 관련 논문 | ⋯ 120 | related-papers |
| `entry-routes` | 공유 | ⋯ 130 | entry-routes |
| `offline-save` | 오프라인 저장 | ⋯ 140 | offline-save |
| `library:status` | 읽기 상태 | ⋯ 150 | library |
| `library:bibtex` | BibTeX 복사 | ⋯ 160 | library |
| `app:selbar` | 선택 버튼 끄기/켜기 | ⋯ 900 | foundation |

toc-progress may put a `<span id="bar-section">` (current section label) **inside `.bar-title`**
(replacing its text). Nothing else edits the header. Auto-hide goes through `PaperUI.setBarHidden` (§5.11).

### 5.2 Selection bar (`#sel-bar`, docked at the bottom, left to right)

| id | label | order | owner | when |
|---|---|---|---|---|
| `ask` | 질문하기 (primary) | 0 | foundation | always |
| `smart-presets:explain` | 설명 | 10 | smart-presets | always (opens the sheet and auto-asks the top-ranked preset) |
| `smart-presets:translate` | 번역 | 20 | smart-presets | always (auto-asks the `translate` preset; uses cached translate pairs when available) |
| `highlights-notes:highlight` | 하이라이트 | 30 | highlights-notes | `anchored` |
| `highlights-notes:note` | 메모 | 40 | highlights-notes | `anchored` |
| `vocab` | 단어장 | 50 | vocab | `wordCount <= 4 && anchored` |
| `entry-routes` | 공유 | 60 | entry-routes | always (no `#q=` part when `!anchored`) |
| `related-papers` | 관련 연구 | 70 | related-papers | `wordCount >= 3` |
| `smart-presets:snap` | 문장 맞추기 | 80 | smart-presets | always |

### 5.3 Presets (ids)

| id | label | owner | match |
|---|---|---|---|
| `easy`, `equation`, `translate`, `why` | base four | foundation | see §3.4 (smart-presets may upsert `equation` and `translate`) |
| `meaning` | 뜻 (이 논문에서) | smart-presets | `wordCount <= 4 && !isMath` → 100 |
| `intuition` | 직관적으로 | smart-presets | `isMath \|\| latex.length` → 85 |
| `summary3` | 3줄 요약 | smart-presets | `wordCount > 60` → 60 |
| `custom:<id>` | user presets | smart-presets | 5 |
| `section-study:quiz` | 이 섹션 퀴즈 (`run`) | section-study | `selInfo && selInfo.sectionId` → 1 |

vocab keys its "단어장에 추가" button on `detail.presetId === "meaning"`, never on the label text.

### 5.4 Tap priorities (`addTapHandler`)

| id | priority | target |
|---|---|---|
| `highlights-notes` | 90 | inside a saved highlight (`PaperAnchor.paintedAt`) |
| `ref-peek` | 80 | `a[href^="#"]:not([href^="#bib."])`, `.ltx_note_mark` |
| `cite-cards` | 80 | `a[href^="#bib."]` (disjoint from ref-peek) |
| `cite-cards:link` | 75 | external `github.com/<owner>/<repo>` links (preview peek) |
| `glossary` | 70 | painted `gl-term` ranges, inline `<math>` not inside `table.ltx_equation, table.ltx_equationgroup` |
| `equation-tools` | 60 | inside `table.ltx_equation, table.ltx_equationgroup` (not on links) |
| `figure-viewer` | 50 | `img` inside `#paper figure` |
| `section-translate` | 40 | Korean sentence spans in `.tr-ko` |
| `skim-highlights` | 30 | painted skim sentence |
| `smart-presets:sentence` | 20 | `test` is false unless sentence mode (`pr:smart-presets:sentence-mode`) is on. Registered with `allowWithSelection: true`: a tap on plain text selects its sentence with `selectRange`; a second tap within 300 ms inside the current selection expands it to the paragraph. Content handlers above it (links, terms, highlights) still win. |
| `app:minimize` | -1000 | foundation: plain tap while the sheet is open → minimize (not on links or `.pr-ui`, except `.tr-ko` text) |

Feature controls (rule 7) never reach this table.

### 5.5 Answer turn slots (`.turn-tools`, `SLOTS` in `app.js`)

| slot id | order | owner | content |
|---|---|---|---|
| `evidence-chips` | 10 | answer-tools | '📍 본문 보기' chips (full-width row) |
| `answer-actions` | 20 | answer-tools | 복사 · 읽어주기 · 👍👎 (`PaperUI.feedback("answer", …)`) |
| `highlights-notes` | 30 | highlights-notes | 노트에 저장 |
| `vocab` | 40 | vocab | 단어장에 추가 (presetId `meaning` only) |
| `ask-paper` | 50 | ask-paper | follow-up question chips (full-width row) |

Slots are `display: contents` inside a wrapping flex row. Give a full-width row `flex-basis: 100%`.

### 5.6 FABs and sheet tools

| kind | id | order | owner |
|---|---|---|---|
| FAB | `ask-paper` 논문에 질문 | 10 | ask-paper |
| sheet tool | `smart-presets:style` (길이 · 수준 chips) | 10 | smart-presets |
| sheet tool | `offline-save` (네트워크 연결 필요, only while offline) | 20 | offline-save |

FABs live in `#bottom-dock` (§5.11) with the back chip and the answer pill, so they never overlap them.

### 5.7 Home sections (`PaperUI.homeSection`)

`entry-routes` (5, `?err=` message) · `library` (10, 이어 읽기 · 즐겨찾기 · 전체 기록 · 모든 노트) · `vocab` (20, 단어장 복습) · `daily-feed` (30) · `entry-routes:help` (90, bookmarklet).

### 5.8 Status chips (`PaperUI.status` keys)

`overview` 요약 · `skim-highlights` 핵심 문장 · `glossary` 용어 · `section-study` 섹션 요약 · `section-translate` 번역.

### 5.9 z-index scale (CSS vars in `style.css`)

header and `#top-stack` 5 · `#bottom-dock` (FAB/back chip/answer pill/bottom slots) 10 · sel-bar 12 (22 while
the sheet is open) · pinned figure 15 · sheet 20 · peek 25+ · full-screen viewer 30 · toast 40. Use `var(--z-…)`.
A peek opens above the highest open layer: 25/26 for the first, +2 for each stacked peek, 31/32 over the viewer
(pass `{z}` to `PaperUI.layer` for your own overlay). Opening the sheet closes the layers above it (rule 9).
The sheet and peeks sit above the on-screen keyboard (`--kb`, `--vvh` on `:root`).

### 5.10 Highlight names and priorities (`PaperAnchor.paint(name, items, {priority, fallback})`)

| name | priority | fallback without `CSS.highlights` | owner |
|---|---|---|---|
| `pa-flash` | 100 | background flash on the enclosing block | foundation (jumps) |
| `ps-current` | 50 | `<mark>` | in-paper-search |
| `ps-match` | 45 | none (`fallback: false`, repainted per keystroke) | in-paper-search |
| `hn-<color>` | 40 | `<mark>` | highlights-notes |
| `tr-align` | 35 | `<mark>` (English side); none for the `.tr-ko` side (`raw: true`) | section-translate (the sentence pair of a tapped Korean sentence) |
| `as-sentence` | 30 | `<mark>`; none when it paints a `.tr-ko` sentence (`raw: true`) | audio-summary |
| `sk-<facet>` | 20 | `<mark>` | skim-highlights |
| `gl-term` | 10 | none (`fallback: false`, underline only) | glossary |

Ranges inside `.tr-ko` are painted with `{raw: true}` (§3.3); offsets cannot address translated text.

### 5.11 Screen edges: top strip and bottom dock (`PaperUI.topSlot` / `bottomSlot`)

Under the header, `#top-stack` is one sticky column at `top: var(--bar-h)`. Every bar that sits "under the
header" is a row in it, from `PaperUI.topSlot(id)`, in this order. Do not position your own fixed bars at the top.

| slot id | order | owner | content |
|---|---|---|---|
| `toc-progress` | 10 | toc-progress | 3px reading-progress bar |
| `in-paper-search` | 20 | in-paper-search | find bar (its layer uses `keepOnSheet`) |
| `offline-save` | 30 | offline-save | offline banner |
| `app:status` | 40 | foundation | status chips (`PaperUI.status`, `#status-strip`) |
| `glossary` | 50 | glossary | definition chip for a term whose first use is off screen |

Above the bottom edge, `#bottom-dock` is one flex row: `#back-chip` (↩ 돌아가기), `#sheet-pill` (답변 보기), then
`#fab-stack`. On narrow screens the FABs wrap to the line above instead of overlapping. Rows from
`PaperUI.bottomSlot(id)` sit above that line, full width. The whole dock moves above the sel-bar while it shows
(`body.pr-sel-active`).

| slot id | order | owner | content |
|---|---|---|---|
| `audio-summary` | 10 | audio-summary | player popup (play/pause, current sentence, close) |

Sizes on `:root`, kept current by `ui.js`: `--bar-h` (header height including the safe area), `--top-stack-h`,
and `--top-h` (the bottom edge of the header plus strip; the strip only while the header is hidden). Header
auto-hide is `PaperUI.setBarHidden(bool)` (reading-settings only). It sets `html.pr-bar-hidden`, which slides
`.bar` up and moves `#top-stack` to the top, and dispatches `paper:bar` `{hidden}`.

---

## 6. Storage keys (owner writes, others read)

Global keys are `pr:<group>[:<sub>]`. Per-paper keys are `pr:<group>[:<sub>]:<baseId>` (via `PaperStore.paper`).
The library export/import covers every `pr:*` key and merges each through `PaperStore.merge`. Register your
rule with `PaperStore.addMerger` when the default (below) is wrong.

Default merge: arrays are unioned by `id` (or by value), and the larger `ts`/`opened`/`updated` wins.
Objects whose values are all objects (maps) merge per key by the same rule. Anything else keeps the local value.

| key | owner | shape | merge |
|---|---|---|---|
| `pr:app:selbar` | foundation | bool | default (keep local) |
| session `pr:app:thread:<baseId>`, `pr:ui:fb:*` | foundation | sessionStorage | not exported |
| `pr:reading-settings` | reading-settings | `{size, lh, theme: system\|light\|dark\|sepia, font: sans\|serif, justify, margin, wake, autohide, ruby}`; `base.html` applies `theme`, `size`, `lh`, `margin`, `font`, `justify` before first paint | default |
| `pr:smart-presets:style` | smart-presets | `{len, level, field, mode, lang}` | default |
| `pr:smart-presets:custom` | smart-presets | `[{id, label, q, ts}]` | default (union by id) |
| `pr:smart-presets:sentence-mode` | smart-presets | bool | default |
| `pr:skim-highlights` | skim-highlights | `{on, facets, minScore}` | default |
| `pr:section-translate:mode` | section-translate | `"orig" \| "both" \| "ko"` | default. Units are cached in IndexedDB `pr-section-translate`. |
| `pr:library` | library | `{<baseId>: {id, title, authors, opened, status: "to-read" \| "reading" \| "done", star, tags, gist, readMs, cites}}` | default (newer `opened` per id) |
| `pr:cite-cards:bib` | cite-cards | `[{id, key, bibtex, ts}]` (the `.bib` basket; library reads it) | default |
| `pr:equation-tools:delim` | equation-tools | `"$$" \| "$" \| "\\[" \| "none"` | default |
| `pr:glossary:known` | glossary | `["term", ...]` | default (union) |
| `pr:glossary:ruby` | glossary | bool: the '용어 한국어 병기' switch in the 용어 list. Until it is set, glossary follows `pr:reading-settings.ruby`; a `paper:settings` `{key: "ruby"}` event is copied into it | default |
| `pr:highlights-notes:<baseId>` | highlights-notes | `[{id, type: hl\|note\|qa, color, anchor: {quote, prefix, suffix, paraId}, note, qa, ts}]` | default |
| `pr:highlights-notes:threads:<baseId>` | highlights-notes | `[{id (= session.threadId), anchor, label, quote, selection, context, section, endpoint, extra, history, shown, meta, ts}]` | default |
| `pr:highlights-notes:prefs` | highlights-notes | `{color, highlighter, useNotes}` | default |
| `pr:toc-progress:pos:<baseId>` | toc-progress | `{paraId, ratio, pct, ts}` (library reads `pct`) | **register**: newer `ts` |
| `pr:toc-progress:wpm` | toc-progress | number | default |
| `pr:vocab` | vocab | `[{id, term, sentence, paperId, title, meaning, due, step, ts}]` | default |
| `pr:daily-feed:cats` | daily-feed | `["cs.CL", ...]` | default |
| `pr:audio-summary` | audio-summary | `{rate, style}` | default |
| `pr:offline-save:<baseId>` | offline-save | `{ts, n}` | default |
| `pr:in-paper-search:recent` | in-paper-search | `["query", ...]` | default |

Cross-group writes go through the owner's API (§6.1): e.g. cite-cards '★ 나중에 읽기' calls
`PaperApp.feature("library")?.add?.({...})`. library registers `{add, get}` with `registerFeature`.

### 6.1 Feature APIs (`PaperApp.registerFeature(id, api)`; callers use `PaperApp.feature(id)?.fn?.(...)` at call time)

These are the only cross-group calls. The owner registers one object that contains exactly these method names
(next to its pure functions from the JS template). A caller must cope with the feature being absent
(`feature()` returns `undefined`) and with `null` results.

| owner | method | returns | rules / callers |
|---|---|---|---|
| library | `add({id, title?, authors?, status?, star?, gist?, tags?})` | the merged record | `id` is a base id (`PaperStore.baseIdOf`). Merges into `pr:library[id]`, creating it if missing: only the given fields change; `status` never moves back (`to-read` < `reading` < `done`); `star` changes only when a boolean is passed; `tags` are unioned; `opened` is not touched (adding a paper is not opening it). Callers: cite-cards '★ 나중에 읽기' → `{id, title, authors, status: "to-read"}`; overview → `{id: PaperApp.baseId, gist}` (the first line of the 3줄 요약, once it finished) |
| library | `get(baseId)` | record \| `null` | |
| highlights-notes | `add({anchor: {quote, prefix, suffix, paraId} \| range: Range, color?, note?, source?})` | id \| `null` | `null` when it cannot anchor (e.g. inside `.tr-ko`). Saves, paints, and shows its own undo toast. `color` defaults to the user's pen. Callers: skim-highlights '내 하이라이트로 저장', audio-summary '이 문장 하이라이트' (`source` = caller id) |
| section-translate | `lookup(selInfo)` | `Promise<[{en, ko}] \| null>` | cached sentence pairs that cover the selection, from its IndexedDB; `null` if not translated yet. Never fetches. Caller: smart-presets '번역' (shows the pairs instead of asking when every sentence is covered) |
| section-translate | `titleFor(sectionId)` | string \| `null` | Korean section title once translated. Caller: toc-progress, on `paper:translations` |
| section-translate | `unitFor(el)` | Element \| `null` | the English unit a `.tr-ko` element translates. Callers: audio-summary, anyone mapping a translation back to the paper |
| glossary | `lookup(term)` | `{term, ...entry}` \| `null` | from the loaded list (normalized match); `null` before it loads. Optional for callers |

---

## 7. Feature groups

Each row is the full assignment. "Helpers" lists the shared APIs the group is expected to use, so it does
not re-implement them. "DOM" lists the only mutations it may make inside `#paper`.

| group | python module | JS / CSS | endpoints | storage prefix | CSS / highlight prefix | header bar | FAB | answer slot | helpers | DOM in `#paper` |
|---|---|---|---|---|---|---|---|---|---|---|
| answer-tools (evidence-chips, answer-actions) | — (uses `/api/feedback`) | `answer-tools.js/.css` | — | — | `at-` | — | — | `evidence-chips` 10, `answer-actions` 20 | addAskHook, addAnswerAction, renderAnswerNow, PaperAnchor.findQuote, PaperNav.jumpTo, minimizeSheet, PaperUI.feedback/copy, PaperApp.tts | none |
| ask-paper | `ask_paper.py` | `ask-paper.js/.css` | `POST /api/ask-paper/followups` | — | `ap-` | — | `ask-paper` 10 | `ask-paper` 50 | openSheet({presets}), build_messages, mark_cache, complete_text(messages=), parse_json_loose, `paper:ask` (abort) | none |
| audio-summary | `audio_summary.py` | `audio-summary.js/.css` | `GET /api/audio-summary/{id}?style=brief\|critique` | `pr:audio-summary` | `as-`, `::highlight(as-sentence)` | `audio-summary` ⋯100 | — | — | cached_task(as_json=False), offline_json, PaperApp.tts, PaperAnchor.paint (`raw` for `.tr-ko`), PaperUI.bottomSlot (player), peek, highlights-notes.add, section-translate.unitFor | class `as-reading` on the current `.ltx_para`; ▶ buttons via insertUI |
| cite-cards | `cite_cards.py` | `cite-cards.js/.css` | `GET /api/cite-cards/{id}/{bib_id}`, `GET /api/cite-cards/github?repo=` | `pr:cite-cards:bib` | `cc-` | — | — | — | paper_index().bib, arxiv_query (one id_list batch), update_json, offline_json, cloneClean, peek, openSheet, PaperApp.feature("library") | none |
| daily-feed | `daily_feed.py` | `daily-feed.js/.css` (home) | `GET /api/daily-feed?cat=` | `pr:daily-feed:cats` | `df-` | — | — | — | arxiv_query (throttled), parse_atom, offline_json, homeSection | n/a (home) |
| entry-routes | `entry_routes.py` | `entry-routes.js/.css` (home, paper, abstract) | `GET /abs/{rest:path}`, `/pdf/{rest:path}`, `/html/{rest:path}`, `/share` (only non-`/api` routes allowed); optional `POST /api/entry-routes/share` | — | `er-` | `entry-routes` ⋯130 | — | — | parse_arxiv_id, on_paper_missing + render_page/html_escape, arxiv_query, PaperUI.share, findQuote, jumpTo, homeSection, rangeToQuote | none |
| equation-tools | — | `equation-tools.js/.css` | — | `pr:equation-tools:delim` | `eq-` | — | — | — | addTapHandler 60, openSheet({presets, autoAsk}), PaperUI.copy, PaperAnchor.textOf/insertUI | action row after the equation table via insertUI |
| figure-explain | `figure_explain.py` | `figure-explain.js/.css` | `POST /api/figure-explain/ask` (stream) | — | `fe-` | — | — | — | core.Ask subclass, build_messages, fetch_image, stream_claude, paper_index().figures, openSheet({endpoint, extra, presets, autoAsk}) | 'AI 설명' chip inside top-level figures via insertUI(..., "beforeend") |
| figure-viewer | — | `figure-viewer.js/.css` | — | — | `fv-` | `figure-viewer` ⋯110 | — | — | addTapHandler 50, PaperUI.layer({kind: "viewer"}), cloneClean, PaperUI.share({url}), PaperApp.has("figure-explain") | none (overlay z 30, pin z 15 outside `#paper`) |
| glossary | `glossary.py` | `glossary.js/.css` | `GET /api/glossary/{id}` | `pr:glossary:known`, `pr:glossary:ruby` | `gl-`, `::highlight(gl-term)` | `glossary` ⋯80 | — | — | cached_task(8000 tokens, lists ≤30), PaperApp.idle, PaperUI.status, PaperUI.topSlot (definition chip), PaperAnchor.locate/paint/paintedAt, peek, feedback("glossary") | paint only; `PaperAnchor.wrap` is allowed only as a fallback (ruby glosses; the wrapper is not `pr-ui`, its `<rt>` is) |
| highlights-notes | — | `highlights-notes.js/.css` | — | `pr:highlights-notes:*` | `hn-`, `::highlight(hn-<color>)` | `highlights-notes` ⋯70 | — | `highlights-notes` 30 | rangeToQuote, findQuote({root, prefix, suffix}), paint/paintedAt, addTapHandler 90, openSheet({history, shown, meta, endpoint, extra, threadId}), session.threadId, addSessionHook (`<my-notes>`), PaperUI.download/toast undo, renderAnswerNow, registerFeature `{add}` | paint only |
| in-paper-search | `in_paper_search.py` | `in-paper-search.js/.css` | `POST /api/in-paper-search/locate` | `pr:in-paper-search:recent` | `ps-`, `::highlight(ps-match)`, `::highlight(ps-current)` | `in-paper-search` primary 30 | — | — | PaperAnchor.index/normalize/paint, jumpTo({back: false} per step), complete_text, parse_json_loose, PaperUI.layer({keepOnSheet: true}) + PaperUI.topSlot (find bar) | class `ps-declutter` on `#paper` and `ps-hit` on paragraphs |
| library | — | `library.js/.css` (both pages) | — | `pr:library` | `lib-` | `library` ⋯60, `library:status` ⋯150, `library:bibtex` ⋯160 | — | — | PaperStore.exportAll/importAll/merge, homeSection, PaperUI.download/toast undo, registerFeature("library", {add, get}) | class `lib-cite-seen` on `a.ltx_ref` |
| offline-save | — | `offline-save.js/.css` (+ optional `offline-save.sw.js`) | — | `pr:offline-save:*` | `os-` | `offline-save` ⋯140 | — | — | SW `precache`/`unsave` messages (`paper-v2-saved`), `PaperApp.offlineUrls()`, `self.PR_SW` (+`keep`, cache names `paper-v2-…`), PaperUI.toast/topSlot (banner), addSheetTool + refreshSheetTools | none (banner in the top strip) |
| overview | `overview.py` | `overview.js/.css` | `GET /api/overview/{id}`, `GET /api/overview/{id}/method` | — | `ov-` | `overview` ⋯40 | — | — | cached_stream(retry), on_prewarm, PaperApp.idle, renderAnswerNow, findQuote, jumpTo, openSheet, PaperUI.status/feedback("overview"), paper_index().code_links, library.add({gist}), addOfflineUrl | card after `.ltx_authors` via insertUI |
| reading-settings | — | `reading-settings.js/.css` | — | `pr:reading-settings` | `rs-` | `reading-settings` ⋯50 | — | — | PaperStore, peek, `html[data-theme\|data-font\|data-justify]`, `--fs` `--lh` `--margin`, PaperApp.setSelBar, PaperUI.setBarHidden (auto-hide), dispatch `paper:settings` | attributes and classes only |
| ref-peek | — | `ref-peek.js/.css` | — | — | `rp-` | — | — | — | addTapHandler 80, cloneClean, peek, jumpTo, openSheet, PaperAnchor.textOf, `paper:open-figure` | none (CSS hides `.ltx_note_outer`) |
| related-papers | `related_papers.py` | `related-papers.js/.css` | `GET /api/related-papers/{id}` | — | `rel-` | `related-papers` ⋯120 | — | — | paper_index().bib, arxiv_query, task_path + read/write_json (TTL), offline_json, peek | none |
| section-study (section-gist, section-quiz) | `section_study.py` | `section-study.js/.css` | `GET /api/section-study/{id}/gists`, `GET /api/section-study/{id}/quiz/{section_id}` | — | `ss-` | — | — | — | paper_index().sections, cached_task(validate), PaperApp.idle, PaperUI.status/feedback("gist"/"quiz"), addPreset(run), openSheet, jumpTo | one `.ss-head` block ('요약'/'퀴즈' chips row, then the gist box) **after** the section `.ltx_title` and after its `.tr-ko` title sibling if there is one (never inside `.ltx_title`), via insertUI (§8) |
| section-translate | `section_translate.py` | `section-translate.js/.css` | `POST /api/section-translate/{id}` `{ids}` | `pr:section-translate:mode` | `tr-` (`.tr-ko` units, `tr-hide`), `::highlight(tr-align)` | `section-translate` primary 20 | — | — | paper_soup, el_text, update_json, complete_text(4000), parse_json_loose, cloneClean, PaperUI.status/feedback("translate"), addTapHandler 40, PaperAnchor.paint (`raw` for `.tr-ko`), `paper:reveal` | `.tr-ko` siblings via insertUI (class `tr-ko pr-ui`; a title's `.tr-ko` directly after its `.ltx_title`), class `tr-hide` on English units; `wrap` only for sentence alignment marks (not `pr-ui`) |
| skim-highlights | `skim_highlights.py` | `skim-highlights.js/.css` | `GET /api/skim-highlights/{id}` | `pr:skim-highlights` | `sk-`, `::highlight(sk-<facet>)` | `skim-highlights` ⋯90 | — | — | cached_task(validate) or cached_stream (JSONL), PaperApp.idle, PaperUI.status, PaperAnchor.locate/paint/paintedAt, addTapHandler 30, jumpTo, highlights-notes.add | paint only |
| smart-presets | — | `smart-presets.js/.css` | — | `pr:smart-presets:*` | `sp-` | — | — | — | addPreset (upsert), addSelectionAction, addAskHook, addSessionHook, addSheetTool, selectRange, addTapHandler 20 (allowWithSelection), peek, section-translate.lookup | none |
| toc-progress | — | `toc-progress.js/.css` | — | `pr:toc-progress:*` | `toc-` | `toc-progress` primary 10 | — | — | PaperAnchor.textOf (titles), jumpTo, PaperUI.layer (drawer), PaperUI.topSlot (progress bar), toast, PaperStore.paper/addMerger, `paper:gists`, `paper:translations` + section-translate.titleFor | none (progress bar in the top strip, drawer outside `#paper`; `#bar-section` inside `.bar-title`) |
| vocab | — | `vocab.js/.css` (both pages) | — | `pr:vocab` | `vo-` | — | — | `vocab` 40 | addSelectionAction(when), addAnswerAction (presetId `meaning`), homeSection, toast undo | none |

---

## 8. Per-group notes (fixes already decided)

- **answer-tools.** Evidence: add the instruction once per turn, only when `meta.endpoint` is `/api/ask` or
  `/api/figure-explain/ask` and the question does not already contain it. On `answer-done` (not restored),
  parse the `근거:` lines from `detail.text`, call `renderAnswerNow(answerEl, textWithoutThoseLines)`, and
  put the chips in `detail.slot("evidence-chips")`. Do the same on **restored** turns (thread continued or
  reloaded): parsing and stripping needs no network, otherwise restored answers show raw `근거:` lines.
  Read aloud uses `PaperApp.tts.speak(..., {owner: "answer-tools"})`. When `detail.via === "voice"` (and not
  restored), auto-speak (the hands-free loop); voice.js already primed TTS inside the mic tap for iOS.
  answer-actions also owns '공유' (the entry-routes brief's 답변 공유): `PaperUI.share({title: document.title,
  text: <answer text>})`, no deep link. entry-routes adds nothing to answer turns.
- **ask-paper.** `/api/ask-paper/followups` takes `core.Ask` with `question=""` and the history including the
  finished turn. Use `messages = core.mark_cache(core.build_messages(body))` plus a final user turn with the
  instruction, then `complete_text(paper, messages=..., max_tokens=200, preamble=False)`. No top-level
  `cache_control`. Fire about 300 ms after `answer-done` (skip `restored`), and abort on `paper:ask`.
  Returns `[]` on parse errors (still 200).
- **audio-summary.** No mediaSession, no locked-screen promise. Pause on `visibilitychange` hidden.
  Use the **translated** text when section-translate's mode is not `orig` (read the `.tr-ko` text), and paint
  the current Korean sentence with `paint("as-sentence", [range], {priority: 30, raw: true})` (a Range over the
  `.tr-ko` sentence; offsets cannot address it). The player popup goes in `PaperUI.bottomSlot("audio-summary")`.
  '이 문장 하이라이트' calls `PaperApp.feature("highlights-notes")?.add?.({range, source: "audio-summary"})` (§6.1);
  in translated mode pass the English unit's range (`section-translate.unitFor`), because `add` returns `null`
  for a `.tr-ko` range.
- **cite-cards.** Look up the bib through `paper_index(id)["bib"]` (never build `#` selectors). On the first
  tap, fetch metadata for **all** bib arXiv ids in one `arxiv_query(id_list=...)` and cache them in
  `task_path(id, "cite-cards")` via `update_json`. Title search only for the tapped non-arXiv entry, with
  punctuation stripped and `difflib` ≥ 0.9. The network failing gives `{bib_text, enriched: null}`, not cached.
  The GitHub preview uses `api.github.com/repos/<owner>/<repo>` only (no generic URL fetch), cached.
  '★ 나중에 읽기' calls `library.add({id, title, authors, status: "to-read"})` (§6.1).
- **daily-feed.** Validate `cat` with `^[a-z\-]+(\.[A-Za-z\-]+)?$` before any HTTP. 1 h in-memory cache
  per category. Use `arxiv_query(search=f"cat:{cat}", sort_by="submittedDate", max_results=30)`.
  The test fixture is `tests/fixtures/arxiv_atom.xml` (shared). Show the arXiv abstracts as they are:
  Korean blurbs need a Claude call without a paper, which rule 1 does not allow (§8.1).
- **entry-routes.** `manifest.json` already has `"id": "/"` and `share_target` → `GET /share` (title/text/url).
  You implement `/share` and the `/abs|/pdf|/html` redirects (307). Use `navigator.share` → clipboard only
  when missing or `NotAllowedError` (`PaperUI.share` does this). `#q=` deep links use `findQuote` + `jumpTo`.
  Papers without HTML: register `@core.on_paper_missing` and return an abstract page built from
  `core.arxiv_query(id_list=[id])` (validate the id with `parse_arxiv_id` first, return `None` to fall back
  to the foundation's 404 page). Render it with `core.render_page(request, title, body_html, page="abstract",
  arxiv_id=id)`, escaping every arXiv string with `core.html_escape`; `entry-routes.js` handles
  `data-page="abstract"`. Its '초록 번역' and 'PDF로 질문' are out of scope (§8.1). Use the `/` `?err=` home
  section for errors from `/abs|/pdf|/html|/share`. The `#q=` part is only added when `selInfo.anchored`.
- **equation-tools.** Walk rows (`tr.ltx_equation, tr.ltx_eqn_row`). Within a row, join cell alttexts with
  `" "`. Strip `\displaystyle`. Join rows with ` \\ ` inside `\begin{aligned}…\end{aligned}` when there is
  more than one row. Take the label from the row's `.ltx_tag_equation`. Copy on tap only (no long-press).
  The fixture has `S2.E1` (single), `S2.EGx1` > `tbody#S2.E2`, `#S2.E3` (align) and `S2.Ex1` (unnumbered).
  The action row is `.pr-ui`, so its buttons (including '수식 설명' → `openSheet`) are feature controls (rule 7).
  '전체 화면' is `PaperUI.peek({size: "large", body: PaperUI.cloneClean(table)})`; `paper:open-figure` stays
  figures-only.
- **figure-explain.** The endpoint body is `class FigureAsk(core.Ask): figure_id: str; image_urls: list[str] = []`.
  Images come only through `core.fetch_image` (400 for foreign URLs, `None` means skip). Put image blocks
  before the text in the first user turn; the bytes are identical on follow-ups (the LRU). Chips go on
  figures with no figure ancestor (`paper_index` `top`). Send ≤4 panels; the client sends
  `img.getAttribute("src")`. The fixture has `S2.F1` (png), `S2.F2` (subfigures png + svg), `S2.F3`
  (TikZ svg), `S2.T1` (table) and `alg1` (algorithm). Top-level figures with no fetchable `img` (TikZ
  `svg.ltx_picture`, tables, algorithms) still get the chip and are explained from text: `image_urls: []`,
  with the caption and `PaperAnchor.textOf(figure)` in `context`. Theorem/proof blocks are out of scope (§8.1).
- **figure-viewer.** Use `touch-action: none` on the overlay plus `preventDefault` on `gesturestart` and
  `gesturechange`. Swipe between figures only at scale 1. Build the pin with `PaperUI.cloneClean`. Hide
  'AI 설명' unless `PaperApp.has("figure-explain")` (checked at open time). The viewer is a
  `PaperUI.layer({kind: "viewer"})` (z 30, so peeks such as ref-peek backlinks open above it); when 'AI 설명'
  leads to `openSheet`, the foundation closes the viewer (reason `"sheet"`), so just dispatch
  `paper:figure-explain`. Save/share of the original image shares its URL only (`PaperUI.share({title, url:
  img.src})`): no file sharing and no image proxy route.
- **glossary.** Do not wrap text nodes for underlines. Paint `gl-term` ranges with `{priority: 10, fallback:
  false}` and hit-test with `paintedAt("gl-term", x, y)`. With no `CSS.highlights` there are no underlines
  (the list still works). `max_tokens` 8000, lists capped at 30. Schedule chunked work through
  `PaperApp.idle`. The '용어 한국어 병기' (ruby) switch lives in glossary's own 용어 list and is stored in
  `pr:glossary:ruby`; glossary still reads `pr:reading-settings.ruby` as the default and reacts to `paper:settings`
  `{key: "ruby"}`, so reading-settings needs no ruby control. Optional `registerFeature("glossary", {lookup})`.
  The definition chip for a term whose first use is off screen goes in `PaperUI.topSlot("glossary")`. Ruby
  fallback: the `wrap` element holds paper text and is not `pr-ui`; only its `<rt>` is (rule 5).
- **highlights-notes.** Anchors come from `rangeToQuote` + `paraId`. Re-anchor with `findQuote(quote,
  {root: paraEl, prefix, suffix})`, falling back to the whole paper. Save every sheet session to `threads`
  automatically on `answer-done` (not `restored`), keyed by `session.threadId`, with all of its frozen fields:
  `{quote, selection, context, section, endpoint, extra, history, shown, meta}` (a figure-explain thread must
  continue on its endpoint with its images). Continue a thread with `openSheet({...thoseFields, threadId})`:
  the same `threadId` comes back on the session (also after a reload restore), so later turns update that
  thread instead of adding a new one. Session hooks do not run again when `history` is given, so `<reader>`
  or `<my-notes>` already in `context` are not appended twice and the first turn is byte-identical.
  '내 메모 참고' uses `addSessionHook` to append `<my-notes>…</my-notes>` to `session.context` for no-selection
  sessions only. Register `{add}` (§6.1). Hide the selection actions when `!anchored`.
- **in-paper-search.** Literal search over `PaperAnchor.index().text` via normalized matching. The find bar is
  a `PaperUI.layer({kind: "find", keepOnSheet: true})` rendered in `PaperUI.topSlot("in-paper-search")`. Step through matches with
  `jumpTo(range, {back: false})` (one Back entry for the whole search, the find bar's). Paint `ps-match` with
  `{priority: 45, fallback: false}` and `ps-current` with `{priority: 50}`. `/api/in-paper-search/locate`
  returns ≤5 `{q, why}`, or `[]` on any failure (still 200).
- **library.** Export/import uses `PaperStore.exportAll()` / `importAll()`. Export through `PaperUI.download`
  (share sheet on iOS). Register `PaperApp.registerFeature("library", {add, get})` with the merge rules in
  §6.1 (cite-cards adds other papers, overview adds `gist`).
- **offline-save.** Do not edit `sw.js`. The '오프라인 저장' button posts `{type: "precache", urls}` (the
  `#paper img` src list, any number) to `navigator.serviceWorker.controller`; the SW keeps them in
  `paper-v2-saved`, which browsing never evicts. '저장 해제' posts `{type: "unsave", urls}`. It also re-fetches
  `PaperApp.offlineUrls()` (cacheable GETs other features already finished) so they enter the API cache;
  never fetch other groups' endpoints by name. Offline banner on `online`/`offline` events, in
  `PaperUI.topSlot("offline-save")`. While offline, show '네트워크 연결 필요' in the sheet via `addSheetTool`
  (§5.6); it re-renders whenever the sheet is shown, and call `PaperApp.refreshSheetTools()` on
  `online`/`offline`. A `*.sw.js` cache of your own is named `paper-v2-…` and registered with `PR_SW.keep` (§4).
- **overview.** `cached_stream(id, "overview.v1", PROMPT, 2500)`. Register `@core.on_prewarm` to start it
  server-side. Client prefetch goes through `PaperApp.idle` and reads the stream into a buffer. The card is
  inserted with `insertUI(authorsEl, card, "afterend")`. Render Markdown with `renderAnswerNow`. Quote lines
  `→ "…"` become chips (`findQuote` → `jumpTo`), and lines whose quote is not found are removed.
  Take a `retry` query flag and pass it to `cached_stream`; a remembered failure is a 502, so show the
  status chip's '다시' (it calls with `?retry=1`). A body ending with the `[오류]` line is a failure too. When the
  text is complete: `PaperApp.addOfflineUrl(url)` and `library.add({id: PaperApp.baseId, gist})` (§6.1).
- **reading-settings.** The `pr:reading-settings` shape in §6 is fixed: `base.html` reads it before first paint.
  The themes exist in `style.css` (`html[data-theme=light|dark|sepia]`), and the font, justify, size,
  line-height and margin hooks too. Add the wake lock, auto-hide header and the '선택 버튼' toggle in the
  peek. The toggle calls `PaperApp.setSelBar(bool)` (not `PaperStore.set("app:selbar")`, which would leave the
  header button label stale). Auto-hide calls `PaperUI.setBarHidden(true)` on scroll down and `false` on scroll
  up or when the setting is turned off; never transform `.bar` yourself (the top strip and `--top-h` follow
  `html.pr-bar-hidden`, §5.11). After any change, dispatch `paper:settings` `{key, value}`.
- **ref-peek.** `classifyHref`: equations `/(^|\.)(E|Ex)\d+/`, figures and tables `/\.(F|T)\d+/` (incl. `S2.F2.sf1`),
  theorems `/^Thm/`, appendix `/^A\d/`, sections `/^S\d+(\.SS\d+)*$/`, and `#bib.` is null. The title comes
  from `.ltx_tag_*` of the target, not the link text. For align rows, clone `closest("table")`. Footnotes:
  hide `.ltx_note_outer` in CSS and peek the `.ltx_note_content` on `.ltx_note_mark` taps. Links inside
  answers are out of scope (§8.1).
- **related-papers.** Cited ids come from `paper_index(id)["bib"]` (≤15, one `id_list` call). Similar
  papers come from a title search excluding the paper itself. Cache `task_path(id, "related-papers")` with
  a `ts` for the 7-day TTL. HTTP errors give 200 with empty lists, not cached.
- **section-study.** The prompt lists `paper_index(id)["sections"]` (fixture: `S1`, `S2`, `S2.SS1`, `A1`).
  `validate` drops unknown keys and bad quiz items. Quiz names are `section-study.quiz.<section_id>.v1`
  (the name is sanitized). Return 404 for an unknown section before any Claude call.
  Placement: one `.ss-head` block per section (the '요약'/'퀴즈' chips row, then the gist box), inserted with
  `insertUI(ref, el, "afterend")` where `ref` is the section's `.ltx_title`, or the `.tr-ko` element right after
  it when section-translate already added one (`while (ref.nextElementSibling?.classList.contains("tr-ko"))
  ref = ref.nextElementSibling`). Never put chips inside `.ltx_title`: in 번역 mode it carries `tr-hide`.
- **section-translate.** Units are innermost text blocks: each `p.ltx_p` addressed `"<closest ltx_para id>#<n>"`,
  abstract paragraphs `abs.<n>`, section titles `<section id>.title`. A parent `ltx_para` never duplicates
  its nested paras (fixture: `S1.p2` > `S1.I1.i1.p1`). Math, `cite` and `a.ltx_ref` become `⟦n⟧`.
  Equation tables and `.ltx_note` become block placeholders. The server returns the placeholder list and
  splits sentences itself. The model returns `{"u":[{"id","ko":[…]}]}`. Skip units with fewer than 3 words or
  a Hangul ratio above 0.3 (fixture `S1.p3`). Use `update_json` on `task_path(id, "section-translate")`.
  The client checks every `⟦n⟧` appears once, persists units in IndexedDB, and listens to `paper:reveal`.
  `.tr-ko` units are `pr-ui`, which is `user-select: none`: set `user-select: text` on `.tr-ko` in your CSS so
  translations can be selected and copied (such selections have `inTranslation` and `anchored: false`). Put reconstructed paper
  links (`⟦n⟧` for `a.ltx_ref`) back as clones that keep the `ltx_ref` class, so taps still reach ref-peek.
  Register `{lookup, titleFor, unitFor}` (§6.1) and dispatch `paper:translations` `{mode}` on mode changes
  and when new titles are ready. Section titles: insert the title's `.tr-ko` directly after `.ltx_title`
  (`insertUI(title, ko, "afterend")`, so it always comes before section-study's `.ss-head`); `tr-hide` on the
  `.ltx_title` itself is fine because nothing else lives inside it. Tapping a Korean sentence paints the pair
  as `tr-align` (§5.10): the English side by offsets, the Korean side with `{raw: true}`.
- **skim-highlights.** `validate` filters facets and empty quotes. Paint per facet with `paint("sk-goal", …,
  {priority: 20})`. The '핵심 문장' bar button gets `setDot(true)` when data is ready. '내 하이라이트로 저장'
  calls `PaperApp.feature("highlights-notes")?.add?.({anchor, source: "skim-highlights"})` (§6.1).
- **smart-presets.** The `<style>` instruction goes in through `addAskHook` (question only). `<reader>`
  (research field) goes into `session.context` via `addSessionHook`, so it is stable for the whole
  session (it is not re-run when a saved thread continues). One-tap verbs: `openSheet({..., autoAsk: {q,
  label, id}})` from the selection actions. '번역' first awaits `PaperApp.feature("section-translate")?.lookup?.(sel)`.
  When the cached pairs cover the selection, it calls `openSheet({...})` without `autoAsk`, then
  `PaperApp.addLocalTurn({shown: "번역", node: <pairs>, actions: [{label: "더 자세히", onClick: () =>
  PaperApp.ask(<translate q>, {presetId: "translate", label: "번역"})}]})`; otherwise it auto-asks `translate`.
  '뜻' may do the same with `PaperApp.feature("glossary")?.lookup?.(term)` and a '더 자세히' action that asks
  the `meaning` preset.
  Sentence mode is the tap handler `smart-presets:sentence` (§5.4: priority 20, `allowWithSelection`), which
  calls `PaperApp.selectRange(range)`; a second tap within 300 ms on the selection expands to the paragraph.
- **toc-progress.** Titles come from `PaperAnchor.textOf(title)` (skips `.pr-ui` chips such as '요약'), or
  `section-translate.titleFor(id)` in 둘다/번역 mode (refresh on `paper:translations`). The drawer is a
  `PaperUI.layer` (closed when the sheet opens). The 3px progress bar is `PaperUI.topSlot("toc-progress")`
  (it follows header auto-hide). Register a merger for `pos` (newer `ts`). The resume toast
  uses `PaperUI.toast(msg, {actionLabel: "이동", onAction})` (action toasts are not replaced by other toasts);
  skip it when `location.hash` starts with `#q=` (an entry-routes deep link already jumps).
- **vocab.** The '단어장' selection action has `when: s => s.wordCount <= 4 && s.anchored`. The answer
  slot only appears for `detail.presetId === "meaning"` (restored turns keep `presetId` through `meta`).
  Deletion uses an undo toast.

### 8.1 Out of scope / deferred (do not improvise these)

- **daily-feed Korean blurbs.** Every Claude call needs a paper prefix (rule 1, checked by `tests/helpers`).
  Show the arXiv abstracts as they are.
- **ref-peek links inside answers** ("Figure 3", "Eq. (5)", "[12]"). Only evidence-chips may re-render `.a`
  (rule 8); a second re-render would depend on bundle order.
- **glossary symbol legend under a tapped display equation.** equation-tools owns those taps (priority 60).
  Its '수식 설명' already asks Claude about the symbols.
- **entry-routes `/paper/{id}` for papers without HTML** is in scope only through `core.on_paper_missing`
  and `core.render_page` (§2); do not add other global handlers on `core.app`. On that abstract page,
  **'초록 번역' and 'PDF로 질문'** are out of scope: there is no paper HTML, so no `system_blocks(paper)`
  prefix (rule 1).
- **Importing shared Q&A threads** ('내 노트로 가져오기'). entry-routes shares quotes (`#q=`) only;
  highlights-notes has no thread import API.
- **figure-explain chips on theorem/proof blocks** (`.ltx_theorem`, `.ltx_proof`). Only `figure` elements.
- **figure-viewer file sharing or an image proxy.** Share the image URL (§8 figure-viewer).

---

## 9. Testing

Python (`tests/helpers.py`):

```python
from tests.helpers import CoreTestCase, AsyncCoreTestCase, core, fixture, seed_paper, api_error, PAPER_ID

class MyTests(CoreTestCase):          # temp CACHE_DIR, FakeClaude, FakeHTTP, seeded paper 2401.00001, self.client
    def test_x(self):
        self.claude.push('```json\n{"terms": []}\n```')          # or {"chunks": [...], "stop_reason", "error", "error_at", "delay"}
        self.http.arxiv()                                        # export.arxiv.org → tests/fixtures/arxiv_atom.xml
        self.http.route("x1.png", b"...", headers={"content-type": "image/png"})
        r = self.client.get(f"/api/glossary/{self.paper_id}")
        self.assert_shared_call()                                # system/REQUEST_OPTS shared; also auto-checked in tearDown
        self.claude.user_texts()                                 # user messages of the last call
```

- `CoreTestCase` (sync, `self.client` TestClient) and `AsyncCoreTestCase` (`IsolatedAsyncioTestCase`, call
  `core.*` directly; use `asyncio.gather` for the concurrency tests).
- Every recorded Claude call is checked in `tearDown` for the shared system and `REQUEST_OPTS`, and for
  no `output_config.format` and no tools.
- Unrouted HTTP raises `httpx.ConnectError`, because the network is disabled.
- Fixtures: `tests/fixtures/sample_ltx.html` (frozen, seeded as `2401.00001`; images become
  `https://arxiv.org/html/2401.00001v1/x1.png` …) and `tests/fixtures/arxiv_atom.xml` (2301.00001,
  2302.00002, 2401.00001 and one error entry). Add your own fixture files instead of editing these.
- Feature files under `static/features/` in tests: create them in a temp location, or `addCleanup(path.unlink)`
  so a crash never leaves them to be served.
- Import order does not matter: `features/__init__.py` imports `app`, so a test may start with
  `from features.<x> import helper` and the routers are still registered.
- `POST /api/prewarm` runs **every** registered `on_prewarm` hook (overview's included), and those hooks
  consume `FakeClaude` script items. To test only your hook, `mock.patch.object(core, "PREWARM_HOOKS", [])`
  and register it again inside the patch.
- Browser tests: `tests/test_browser.py` starts a real server (FakeClaude, seeded paper, temp cache) and runs
  `node tests/browser/<name>.browser.js <port>` with Playwright (from `NODE_PATH`) and headless Chromium. It is
  skipped when either is missing. `foundation.browser.js` runs with **no features** (empty `static/features`,
  no prewarm or paper-missing hooks), so your hooks and tap handlers cannot break it, and you never edit it.
  A feature may add `tests/browser/<group>.browser.js`, which runs against the full bundle; intercept `/api/*`
  with `page.route`, block outside hosts (serve arXiv images with their real aspect ratio, as
  `foundation.browser.js` does, or late layout shifts make scroll checks flaky), and print `SKIP …` first if
  it cannot run.

JS (`tests/js/_runner.js`, plain node, no DOM):

```js
const { test, assert, load } = require("./_runner");
const { parseEvidence } = load("static/features/answer-tools.js");
test("parses two quotes", () => { assert.equal(parseEvidence('…').length, 2); });
```

Test pure functions only (export them via `module.exports` in the template). `tests/js/smoke.test.js`
already checks `node --check`, require-without-DOM and the IIFE template for every feature file, and that
every `static/features/*.css` closes its braces, comments and strings (the CSS files are concatenated).
`tests/js/sw.test.js` runs `sw.js` against fake `caches`/`fetch`; extend that pattern for `*.sw.js` code.
