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
  `anchored`가 아닌 선택(번역문 등)은 논문 링크만. 공유 글은 `“인용”`.
- **브라우저 기본 문장 강조** `:~:text=` (Chrome, Safari 16.1+: JS 전에도 스크롤·강조). 브라우저는 문서에서 *처음* 나오는
  곳을 고르므로(범위 꼴은 처음 나오는 시작 조각 → 그 뒤 처음 나오는 끝 조각), 정규화한 본문 색인으로 세어 그게 이 인용일
  때만 붙임: 인용이 본문에 한 번만 나와야 하고(`&p=`가 붙는 인용엔 없음), 8단어가 넘으면 앞·끝 조각을 4단어부터 늘려
  각각 한 번만 나오게 한 `text=<앞>,<끝>`, 안 되면 인용 통째 `text=<인용>`. 수식(`$alttext$`)은 화면 글자와 달라 조각에
  넣지 않음 (통째로 가야 하는데 수식이 있으면 생략). 색인을 못 읽으면 생략. 실제 기기(안드로이드 Chrome)에서 확인 필요:
  headless Chromium의 `page.goto`는 텍스트 조각을 적용하지 않아 브라우저 테스트로는 링크 모양만 확인함.
- **⋯ '공유'** (130): 내 하이라이트가 없으면 논문 링크를 바로 공유. 있으면 peek에서 '논문 링크만 보내기' 또는
  골라서 `POST /api/entry-routes/share` → `/paper/<id>#s=<공유 id>` 링크 (만든 뒤 '링크 보내기'를 한 번 더 탭: iOS는
  fetch를 기다린 뒤 공유 시트를 못 엶).
- `navigator.share`가 없으면 글과 링크를 함께 복사. 취소(AbortError)는 조용히, 그 밖의 실패는 `PaperUI.share`가 복사.
- 공유 링크 만들기 실패 알림은 상태별: 413 '너무 많아요, 몇 개 빼 주세요'(보내기 전에 300KB를 넘으면 미리), 429 '잠시 뒤',
  507 '서버 저장 공간', 400/422 '보낼 수 없는 내용', 5xx '서버 오류', 그 밖(네트워크) '네트워크 확인'.
- 보내는 글은 UTF-16 단위로 자르되 이모지 같은 서로게이트 짝을 반으로 가르지 않음 (`cutHead`·`cutTail`).

## 받는 쪽

- `#q=`: `findQuote(q, {prefix: p})` → `jumpTo(range, {back: false})` + `er-quote` 칠하기 (우선순위 25). 못 찾으면 알림.
  그림 로드로 위치가 밀리면 `load` 때 한 번 더 (사용자가 안 움직였을 때만). 같은 앱에서 해시만 바뀌어도 (`hashchange`) 처리.
- `#s=`: `GET /api/entry-routes/share/<id>`(오프라인 캐시 가능) → `er-shared` 칠하기 (15) + 아래쪽 줄
  (`PaperUI.bottomSlot("entry-routes", 20)`: 공유받은 하이라이트 N개 · 목록 · ✕). 목록에서 하이라이트·메모는
  `highlights-notes.add`로 '내 노트에 저장' (그 기능이 있을 때만). Q&A는 읽기 전용이고 **글자 그대로** 보여 줌
  (링크를 만든 사람이 마음대로 쓴 글이라 마크다운·HTML로 그리지 않음: 바깥 그림·스타일 주소로 받는 사람 IP가 새지 않게),
  '공유한 사람이 저장한 Q&A'라고 표시.
- **새로고침·뒤로 가기(bfcache 없이)·폐기된 탭 복원**(`performance` navigation type `reload`/`back_forward`,
  `document.wasDiscarded`)으로 다시 열리면 첫 처리에서 칠하기만 하고 점프하지 않음: 읽던 자리는 브라우저 스크롤 복원이
  되살림. 해시는 지우지 않음 (`replaceState`로 지우면 toc-progress가 딥링크로 처음 열린 화면에서 해시가 빈 것을 보고 이어 읽기
  알림을 띄움. 주소창 링크를 그대로 다시 보낼 수도 있음). 새 `#q=`/`#s=` 해시(`hashchange`)는 언제나 이동.

## API

| | |
|---|---|
| `GET /abs/{rest}`, `/pdf/{rest}`, `/html/{rest}`, `/share` | 307 리다이렉트 (Claude·네트워크 호출 없음) |
| `POST /api/entry-routes/share` | `{arxiv_id, title, items: [{quote, prefix, suffix, color, note, q, a}]}` (1–200개, 전체 300KB) → `{id, url}`. 계정 없음: 무작위 id로 `cache/<id>.entry-routes.share.json`. 짝 없는 서로게이트(`\ud83d`)는 빼고 받음 (반쪽뿐인 인용은 422). 한 IP당 10분에 30개 (429). 공유 파일 전체 100MB 상한: 닿으면 90일 지난 공유부터 지우고, 그래도 넘으면 507 |
| `GET /api/entry-routes/share/{id}` | 저장된 공유 (없으면 404) |

## 범위 밖 (docs/FEATURES.md §8, §8.1)

초록 페이지의 '초록 번역'·'PDF로 질문' (논문 HTML이 없어 공용 `system_blocks(paper)` 접두가 없음), 공유받은 Q&A 스레드
가져오기, 답변 공유 (answer-tools의 answer-actions가 담당).

## 계약 문서(docs/FEATURES.md)에 아직 없는 것 (계약 담당이 반영할 것)

- §8 toc-progress: 이어 읽기 알림을 건너뛰는 조건이 `#q=`만 적혀 있음. `#s=`(공유 하이라이트) 링크도 entry-routes가
  첫 공유 하이라이트로 점프하므로 `/^#[qs]=/`로 넓혀야 함. (지금 toc-progress 구현은 해시가 비어 있지 않으면 모두
  건너뛰어 실제로는 겹치지 않음.)
- §5.10 칠하기 이름: `er-quote` (25, 기본 `<mark>` 대체) · `er-shared` (15, 기본 `<mark>` 대체), 주인 entry-routes.
- §5.11 아래쪽 자리: `entry-routes` (order 20, 공유받은 하이라이트 줄: N개 · 목록 · ✕).
