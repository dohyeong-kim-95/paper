# Paper Reader

모바일에서 arXiv 논문을 읽다가 문장을 선택해 바로 질문하는 PWA (MVP).

- 본문: arXiv 공식 HTML (`arxiv.org/html/<id>`)
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
2. 읽다가 텍스트를 길게 눌러 선택하고 "질문하기" 버튼 누르기
3. 프리셋 버튼(쉽게 설명 / 수식 풀이 / 번역 / 왜 중요?)이나 직접 질문 입력
4. 🎤 버튼을 누르고 말하면 한국어로 받아적어 바로 질문 (Chrome·Safari 등 음성 인식 지원 브라우저)
