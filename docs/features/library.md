# library (내 서재)

Client only: `static/features/library.js` / `.css`, on the paper and home pages (the API also on the abstract page).

## Record (`pr:library[<baseId>]`)

The §6 shape, plus fields library keeps for itself:

| field | meaning |
|---|---|
| `updated` | last explicit change (status, star, tags, gist) |
| `statusAt` | when the status was last set, cleared included. Import merges take `status` from the copy with the larger `statusAt`, so a status the user cleared on one device stays cleared |
| `readMs` | active reading time (visible tab, input in the last 2 min). Merges keep the larger value |
| `cites` | arXiv ids cited by this paper (≤150), for the CiteSee tint on other papers |

## Reading status

- `add()` (§6.1) only moves the status forward.
- Reading time moves an unset or `to-read` status to `reading` once, at the moment it passes 1 minute: either
  the record's total `readMs`, or the time read since this page was opened. After that, a status the user
  picks (`to-read`, or clearing it) is never overwritten. Once the user picks a status in the 읽기 상태 peek,
  that page never promotes again.
- '완료로 표시' is offered at most once per tab session (≥90 % toc-progress, ≥5 min read), only from the periodic
  flush while the page is visible. The flushes on `hidden` and `pagehide` never show it.

## Authors

`.ltx_authors .ltx_personname` is split into lines at `<br>`. Footnote marks (`sup`, `math`, `\thanks`) and
affiliation and email spans count as name separators, and so do `,` `;` `&` `and` and wide spaces (`\quad`).
Every name on the first line is kept. A later line counts only if it has two or more names and each one looks
like a person's name (2–5 capitalized words, no institution words or acronyms). Reading stops at the first line
that fails this, usually an affiliation or email line. A continuation line with a single name is dropped,
because it cannot be told apart from an affiliation.

## BibTeX

The key is the first author's surname plus the year (`kim2024`). The `.bib` export of the list adds `a`, `b`, …
to repeated keys (`kim2024`, `kim2024a`).

## Backup and import: known limitation

Import runs only on the home page. It merges each key through `PaperStore.merge`, which uses the mergers
registered on **that** page. A group that calls `PaperStore.addMerger` after the template's
`data-page !== "paper"` return registers nothing on home. Its keys then fall back to `mergeDefault`, which keeps
the local value for a plain object. Today this hits `pr:toc-progress:pos:<id>` (§6: "register: newer ts"):
on import, an older local reading position beats a newer imported one. The fix belongs to each owner, and the
contract should say it: call `addMerger` before the page check, so the rule is there on every page.
