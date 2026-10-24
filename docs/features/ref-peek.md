# ref-peek

Previews of in-paper references (equations, figures, tables, algorithms, sections, appendices, theorems and
footnotes) in a `PaperUI.peek`, so the reader keeps their place. Client only: `static/features/ref-peek.js`
and `.css`. No endpoint, no Claude call, no storage.

## Paper taps (`addTapHandler`, priority 80, `allowWithSelection: true`)

- `a[href^="#"]` except `#bib.*` (cite-cards) and TOC links. `.ltx_note_mark` opens the footnote body.
- Registered with `allowWithSelection: true`, so a link tap is handled while a selection is live, was just
  dismissed, or existed at pointerdown. Without it the link would do a native fragment navigation (scroll,
  hash, history entry, no peek), and in smart-presets sentence mode the priority-20 sentence handler would
  take the tap. §5.4 says links win. `test` only matches reference links and footnote marks, so plain-text
  taps still reach sentence mode. (cite-cards needs the same flag for `#bib.` links.)
- The target comes from `getElementById(decodeURIComponent(hash))`. Its kind is read from the DOM:
  footnote → `table.ltx_equation/.ltx_equationgroup` → `figure` (outermost) → `.ltx_theorem/.ltx_proof`
  → `section` → `.ltx_para`. For align rows (`tbody#S2.E3`), the whole group table is cloned and the row
  gets `.rp-mark`. For subfigures, the whole figure is cloned and the panel gets `.rp-mark`.
- The title comes from the target's `.ltx_tag_*` ("식 (3)", "Figure 2 (a)", "2.1 Training objective",
  "Theorem 1", "각주 1"), not from the link text (`Fig.~\ref{}` links are only "2"). When the target has
  no tag (unnumbered `figure*`, captionless floats), the tapped link's `title` is used up to the first
  ` ‣ ` ("Figure 3 ‣ 4 Results ‣ …" → "Figure 3"), skipping location-only titles ("In 2 Method ‣ …").
  Otherwise the link text is used, prefixed with 그림/표/알고리즘 when it is only a number ("표 2").
  Equations without a tag stay "수식".
- The clone has no ids, `.pr-ui`, `.tr-ko` or `tr-hide`. External links open in a new tab. A `#…` link inside
  the peek opens another peek above it. A cloned image dispatches `paper:open-figure` `{figureEl, img}`
  (the original elements), but only when figure-viewer is present.
- Actions: **그 위치로 이동** (`PaperNav.jumpTo`, so '↩ 돌아가기' returns), **이 부분 질문** (a new
  `openSheet`: `quote` is the title, `selection` is the target text with `$alttext$`, `context` is the
  paragraph that held the link) and **N곳에서 언급** (the backlinks list, below).
- CSS hides `#paper .ltx_note_outer` and enlarges the hit area of `a.ltx_ref` and `.ltx_note_mark`
  (padding 6px 3px, with negative margins of the same size).
- Because the footnote bodies are hidden, each `#paper .ltx_note > .ltx_note_mark` gets `tabindex="0"`,
  `role="button"` and `aria-label="각주 N"` (rule 5 attribute toggles; nothing is inserted). Enter or Space
  calls `click()` on it, which goes through the tap handler above (or the peek's own listener for cloned
  marks). Closing the peek returns focus to the mark. The backlinks list strips these attributes from its
  sentence clones, because they sit inside a `<button>`.

## Backlinks ("N곳에서 언급")

Every `#paper a[href^="#"]` that points at the target. For a figure or equation, links to its parts count
too. For a section or bib item, only links to that exact id count. Links inside the target, `.pr-ui`,
`.tr-ko`, footnote bodies and the bibliography are skipped. Each item shows its citing sentence (a clone of
`PaperAnchor.rangeAt`, cut to about 280 characters around the link) and jumps to that sentence.

API for other groups (look it up at call time; it may be missing). **These rows are not in contract §6.1
yet**, so equation-tools and figure-viewer will not call them until the orchestrator adds them there:

```js
PaperApp.feature("ref-peek")?.mentionCount?.(id)         // number (cheap: no sentence extraction)
PaperApp.feature("ref-peek")?.backlinks?.(id)            // [{link, start, end, section, cutStart, cutEnd}]
PaperApp.feature("ref-peek")?.showBacklinks?.(id, {title}) // opens the list peek (z above a viewer); null if none
PaperApp.feature("ref-peek")?.open?.(id)                 // opens the reference peek for an id
```

The equation-tools row and figure-viewer can show "N곳에서 언급" with `mentionCount` and open the list with
`showBacklinks`. Jumping from the list closes peeks and viewers, then minimizes the sheet.

## Not included: references inside AI answers

Linking "Figure 3", "식 (5)", "[12]" or "Author et al." inside answers is out of scope (contract §8.1 and the
§8 ref-peek note). ref-peek only handles taps inside `#paper` and inside its own peeks.
