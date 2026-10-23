# ref-peek

Previews of in-paper references (equations, figures, tables, algorithms, sections, appendices, theorems and
footnotes) in a `PaperUI.peek`, so the reader keeps their place. Client only: `static/features/ref-peek.js`
and `.css`. No endpoint, no Claude call, no storage.

## Paper taps (`addTapHandler`, priority 80)

- `a[href^="#"]` except `#bib.*` (cite-cards) and TOC links. `.ltx_note_mark` opens the footnote body.
- The target comes from `getElementById(decodeURIComponent(hash))`. Its kind is read from the DOM:
  footnote → `table.ltx_equation/.ltx_equationgroup` → `figure` (outermost) → `.ltx_theorem/.ltx_proof`
  → `section` → `.ltx_para`. For align rows (`tbody#S2.E3`), the whole group table is cloned and the row
  gets `.rp-mark`. For subfigures, the whole figure is cloned and the panel gets `.rp-mark`.
- The title comes from the target's `.ltx_tag_*` ("식 (3)", "Figure 2 (a)", "2.1 Training objective",
  "Theorem 1", "각주 1"), not from the link text (`Fig.~\ref{}` links are only "2").
- The clone has no ids, `.pr-ui`, `.tr-ko` or `tr-hide`. External links open in a new tab. A `#…` link inside
  the peek opens another peek above it. A cloned image dispatches `paper:open-figure` `{figureEl, img}`
  (the original elements), but only when figure-viewer is present.
- Actions: **그 위치로 이동** (`PaperNav.jumpTo`, so '↩ 돌아가기' returns), **이 부분 질문** (a new
  `openSheet`: `quote` is the title, `selection` is the target text with `$alttext$`, `context` is the
  paragraph that held the link) and **N곳에서 언급** (the backlinks list, below).
- CSS hides `#paper .ltx_note_outer` and enlarges the hit area of `a.ltx_ref` and `.ltx_note_mark`
  (padding 6px 3px, with negative margins of the same size).

## Backlinks ("N곳에서 언급")

Every `#paper a[href^="#"]` that points at the target. For a figure or equation, links to its parts count
too. For a section or bib item, only links to that exact id count. Links inside the target, `.pr-ui`,
`.tr-ko`, footnote bodies and the bibliography are skipped. Each item shows its citing sentence (a clone of
`PaperAnchor.rangeAt`, cut to about 280 characters around the link) and jumps to that sentence.

API for other groups (look it up at call time; it may be missing):

```js
PaperApp.feature("ref-peek")?.mentionCount?.(id)         // number (cheap: no sentence extraction)
PaperApp.feature("ref-peek")?.backlinks?.(id)            // [{link, start, end, section, cutStart, cutEnd}]
PaperApp.feature("ref-peek")?.showBacklinks?.(id, {title}) // opens the list peek (z above a viewer); null if none
PaperApp.feature("ref-peek")?.open?.(id)                 // opens the reference peek for an id
```

The equation-tools row and figure-viewer can show "N곳에서 언급" with `mentionCount` and open the list with
`showBacklinks`. Jumping from the list closes peeks and viewers, then minimizes the sheet.

## References inside answers

On `paper:answer-done` (restored turns too, since it costs no network), the answer text is scanned after a
`setTimeout(0)`, so another feature's synchronous re-render (evidence-chips) has already happened. The scan
finds "Figure 3 / Fig. 3 / 그림 3", "Table 2 / 표 2", "Eq. (5) / 식 (5) / (5)식", "Section 4.2 / §4.2 / 4.2절",
"Appendix A / 부록 A", "Theorem 1 / 정리 1 …", "Algorithm 1", "[12]" and "Author et al. / Author 등". Matches are
resolved through a map built from the paper's own tags and bib labels, and from the text of
`a[href^="#bib."]` links. **`.a` is never modified.** Matches are painted with
`PaperAnchor.paint("rp-ans", ranges, {raw: true, priority: 5})` and hit-tested on click. A
MutationObserver re-scans when `.a` is re-rendered later, so the result does not depend on bundle order.
A tapped mention opens the same peek above the sheet. Bib mentions open a peek of the bibliography entry,
because cite-cards has no API for opening its card from outside `#paper`. From an answer, **이 부분 질문**
asks in the current conversation ("<title>에 대해 자세히 설명해줘") instead of starting a new one.

The contract (§8.1) lists "links inside answers" as out of scope because a second re-render of `.a` would
depend on bundle order. This approach adds no re-render and no DOM inside `.a`. Without `CSS.highlights`
(iOS < 17.2) the mentions still work when tapped, but they are not underlined.
