# entry-routes

논문을 앱으로 들여오는 길과, 읽던 문장을 친구에게 보내는 길.

## 들어오는 길

| 방법 | 동작 |
|---|---|
| 주소 바꾸기 | `arxiv.org/abs/<id>`, `/pdf/<id>(.pdf)`, `/html/<id>`의 호스트만 이 앱으로 바꾸면 `307 → /paper/<id>` (버전 유지). 번호가 없으면 `/?err=noid&q=<받은 값>` |
| 안드로이드 공유 | 설치한 PWA는 `manifest.json`의 `share_target`(`GET /share?title=&text=&url=`)으로 공유 메뉴에 뜸. url → text → title 순서로, `arxiv.org/abs/…`·`arXiv:…`·alphaXiv·HF Papers 같은 확실한 형태를 먼저 찾고 없으면 아무 새 형식 번호 |
| iOS·PC 북마클릿 | 홈의 '다른 앱에서 바로 열기'에 있는 `javascript:void(location.href='<origin>/share?url='+…)`를 북마크 주소로 저장 |
| iOS 단축어 | '공유 시트에서 URL 받기' → 'URL 열기: `<origin>/share?url=(단축어 입력)`' (iOS에는 share_target이 없음) |
| HTML 없는 논문 | `/paper/<id>`가 404면 `core.on_paper_missing` 훅이 arXiv API 초록 페이지(`data-page="abstract"`: 제목·저자·초록·PDF·arXiv 링크·다시 시도·공유)를 그림. 메타데이터는 `cache/<id>.entry-routes.abs.json`에 1일. arXiv API도 실패하면 기본 404 페이지 |

## 나가는 길

- **선택 '공유'** (선택 줄 60): `/paper/<id>#q=<인용 ≤120자>`. 인용이 본문에 여러 번 나오면 `&p=<앞 문맥 24자>`.
  수식이 없으면 브라우저 기본 문장 강조 `:~:text=<앞 4단어>,<끝 4단어>`도 붙임 (Chrome, Safari 16.1+: JS 전에도 스크롤·강조).
  `anchored`가 아닌 선택(번역문 등)은 논문 링크만. 공유 글은 `“인용”`.
- **⋯ '공유'** (130): 내 하이라이트가 없으면 논문 링크를 바로 공유. 있으면 peek에서 '논문 링크만 보내기' 또는
  골라서 `POST /api/entry-routes/share` → `/paper/<id>#s=<공유 id>` 링크 (만든 뒤 '링크 보내기'를 한 번 더 탭: iOS는
  fetch를 기다린 뒤 공유 시트를 못 엶).
- `navigator.share`가 없으면 글과 링크를 함께 복사. 취소(AbortError)는 조용히, 그 밖의 실패는 `PaperUI.share`가 복사.

## 받는 쪽

- `#q=`: `findQuote(q, {prefix: p})` → `jumpTo(range, {back: false})` + `er-quote` 칠하기 (우선순위 25). 못 찾으면 알림.
  그림 로드로 위치가 밀리면 `load` 때 한 번 더 (사용자가 안 움직였을 때만). 같은 앱에서 해시만 바뀌어도 (`hashchange`) 처리.
- `#s=`: `GET /api/entry-routes/share/<id>`(오프라인 캐시 가능) → `er-shared` 칠하기 (15) + 아래쪽 줄
  (`PaperUI.bottomSlot("entry-routes", 20)`: 공유받은 하이라이트 N개 · 목록 · ✕). 목록에서 하이라이트·메모는
  `highlights-notes.add`로 '내 노트에 저장' (그 기능이 있을 때만), Q&A는 읽기 전용.

## API

| | |
|---|---|
| `GET /abs/{rest}`, `/pdf/{rest}`, `/html/{rest}`, `/share` | 307 리다이렉트 (Claude·네트워크 호출 없음) |
| `POST /api/entry-routes/share` | `{arxiv_id, title, items: [{quote, prefix, suffix, color, note, q, a}]}` (1–200개, 전체 300KB) → `{id, url}`. 계정 없음: 무작위 id로 `cache/<id>.entry-routes.share.json` |
| `GET /api/entry-routes/share/{id}` | 저장된 공유 (없으면 404) |

## 범위 밖 (docs/FEATURES.md §8, §8.1)

초록 페이지의 '초록 번역'·'PDF로 질문' (논문 HTML이 없어 공용 `system_blocks(paper)` 접두가 없음), 공유받은 Q&A 스레드
가져오기, 답변 공유 (answer-tools의 answer-actions가 담당).
