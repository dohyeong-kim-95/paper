# Paper Reader

모바일에서 arXiv 논문을 읽다가 문장을 선택해 바로 질문하는 PWA (MVP).

- 본문: arXiv 공식 HTML (`arxiv.org/html/<id>`)
- 공식 HTML이 없으면 ar5iv(`ar5iv.labs.arxiv.org/html/<id>`)로 대체, 받은 논문은 `cache/`에 JSON으로 저장
- 질문: Claude Haiku 5.5, 스트리밍 응답 + 논문 본문 프롬프트 캐싱 (논문을 열 때 미리 캐시)

## 실행

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
uvicorn app:app --host 0.0.0.0 --port 8000
```

휴대폰에서 PWA로 설치하려면 HTTPS가 필요합니다. 예: `cloudflared tunnel --url http://localhost:8000`
접속 후 브라우저 메뉴에서 "홈 화면에 추가"를 누르면 됩니다.

## 사용법

1. arXiv ID 또는 URL 입력
2. 읽다가 텍스트를 길게 눌러 선택하면 화면 아래에 버튼 줄이 나타남 → "질문하기"
3. 프리셋 버튼(쉽게 설명 / 수식 풀이 / 번역 / 왜 중요?)이나 직접 질문 입력
4. 🎤 버튼을 누르고 말하면 한국어로 받아적어 바로 질문 (Chrome·Safari 등 음성 인식 지원 브라우저)
5. 시트를 아래로 끌거나 본문을 탭하면 "답변 보기"로 내려둠, 휴대폰 뒤로가기도 시트·창을 먼저 닫음

## 기능 추가 (확장 구조)

기능은 새 파일만으로 붙습니다. 계약과 자리표는 [docs/FEATURES.md](docs/FEATURES.md).

- `features/<group>.py`: `router = APIRouter()` 를 두면 앱 시작 때 자동 등록 (`import app as core` 로 공용 헬퍼 사용)
- `static/features/<group>.js|.css`: `/features.js`, `/features.css` 로 묶여 모든 페이지에 로드 (파일별 함수 스코프)
- 공용 화면 API: `PaperStore`, `PaperUI`, `PaperAnchor`, `PaperNav`, `PaperApp`

## 테스트

네트워크·API 키 없이 돕니다 (Claude·arXiv는 가짜로 대체).

```bash
python -m unittest discover -s tests          # tests/js/*.test.js 도 node로 함께 실행
for f in tests/js/*.test.js; do node $f; done  # JS만
```
