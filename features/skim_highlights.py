"""skim-highlights: 핵심 문장 자동 하이라이트 (목표/새로움/방법/결과/한계).

GET /api/skim-highlights/{id} → text/plain JSONL 스트림. 한 줄에 {"f": facet, "q": 본문 인용, "s": 1-3}, 논문 순서.
생성·캐시는 core.cached_stream (모델이 JSONL로 씀), 내보낼 때 줄 단위로 검증 → 클라이언트가 도착하는 대로 칠함.
유효한 문장이 하나도 없으면 형식 오류: 저장된 원문을 지우고 '[오류]' 꼬리, core._failures에 기억 →
FAIL_TTL 동안 cached_stream이 502 (retry=1이면 다시 생성) — 다른 생성 실패와 같은 기억·같은 규칙."""
import contextlib
import json
import re
import time

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

import app as core

router = APIRouter()

NAME = "skim-highlights.v1"  # 프롬프트를 바꾸면 v2
MAX_TOKENS = 3000
MAX_ITEMS = 30
FACETS = ("goal", "novelty", "method", "result", "limit")
ALIASES = {
    "objective": "goal", "aim": "goal", "problem": "goal", "motivation": "goal",
    "contribution": "novelty", "novel": "novelty", "new": "novelty",
    "methods": "method", "approach": "method",
    "results": "result", "finding": "result", "findings": "result",
    "limitation": "limit", "limitations": "limit", "limits": "limit",
}
ERROR_TAIL = re.compile(r"\n\n\[오류\][^\n]*$")
ELLIPSIS = re.compile(r"^(?:\.\.\.|…)\s*|\s*(?:\.\.\.|…)$")

PROMPT = """이 논문을 휴대폰에서 빠르게 훑어 읽는(skim) 독자를 위해 핵심 문장을 골라 역할별 색으로 표시하려고 합니다.
위 시스템 지시의 Markdown 형식은 무시하고 JSON 줄(JSONL)만 출력하세요. 머리말·설명·코드 펜스 금지.

한 줄에 JSON 객체 하나: {"f": "<역할>", "q": "<본문 인용>", "s": <1~3>}

- f (역할)는 다음 다섯 중 하나:
  "goal" = 연구 목표·풀려는 문제
  "novelty" = 이 논문만의 새로운 기여·아이디어
  "method" = 핵심 방법·설계
  "result" = 이 논문 자신의 주요 실험 결과·발견
  "limit" = 한계·실패 사례·향후 과제 (논의·결론에서, 최소 1개)
- q: 논문 본문(영어)에서 그대로 복사한 연속된 6~20단어 (짧은 문장이면 문장 전체). 한 문장 안에서만,
  철자·구두점을 바꾸지 말고, 수식·인용 번호·각주가 들어간 부분은 피하세요.
- s: 중요도. 3 = 꼭 읽을 문장, 2 = 중요, 1 = 참고.
- 15~30줄. 앞(초록·서론)·가운데(방법·실험)·끝(논의·결론·한계)에 고루 퍼지게 고르세요.
- 인용한 선행 연구의 결과를 설명하는 문장은 고르지 마세요. 그림·표 캡션, 참고문헌도 제외.
- 논문에 나오는 순서대로 출력하세요.

출력 예 (형식만):
{"f": "goal", "q": "<본문에서 그대로 복사한 6~20단어>", "s": 3}"""

def clean_item(obj) -> dict | None:
    """모델이 쓴 한 항목 → {"f","q","s"} | None (모르는 역할·빈 인용·3단어 미만은 버림)"""
    if not isinstance(obj, dict):
        return None
    f = str(obj.get("f") or obj.get("facet") or "").strip().lower()
    f = ALIASES.get(f, f)
    q = obj.get("q") or obj.get("quote") or ""
    q = ELLIPSIS.sub("", re.sub(r"\s+", " ", q if isinstance(q, str) else "")).strip()
    if f not in FACETS or len(q.split()) < 3:
        return None
    try:
        s = int(obj.get("s", 2))
    except (TypeError, ValueError):
        s = 2
    return {"f": f, "q": q[:400], "s": min(3, max(1, s))}


def items_of(value) -> list:
    if isinstance(value, dict):
        return value["items"] if isinstance(value.get("items"), list) else [value]
    return value if isinstance(value, list) else []


def parse_line(line: str) -> list[dict]:
    """JSONL 한 줄 (펜스·쉼표·대괄호가 붙어도, 통째 {"items": [...]}여도) → 유효한 항목들"""
    i, j = line.find("{"), line.rfind("}")
    if i < 0 or j <= i:
        return []
    raw = line[i:j + 1]
    for cand in (raw, f"[{raw}]"):  # 한 줄에 객체가 여러 개면 배열로 한 번 더
        with contextlib.suppress(ValueError):
            return [x for x in map(clean_item, items_of(json.loads(cand))) if x]
    return []


async def filtered(arxiv_id: str, chunks):
    """cached_stream 본문을 줄 단위로 검증해 정규화된 JSONL로. 실패 꼬리는 그대로 넘김"""
    seen: set[str] = set()
    parts: list[str] = []
    buf = ""

    def emit(items) -> str:
        out = []
        for it in items:
            key = it["q"].lower()
            if len(seen) >= MAX_ITEMS or key in seen:
                continue
            seen.add(key)
            out.append(json.dumps(it, ensure_ascii=False) + "\n")
        return "".join(out)

    async for chunk in chunks:
        s = chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk
        parts.append(s)
        *lines, buf = (buf + s).split("\n")
        out = emit(x for line in lines for x in parse_line(line))
        if out:
            yield out
    text = "".join(parts)
    tail = ERROR_TAIL.search(text)
    if tail:  # API 오류·max_tokens 잘림: cached_stream이 저장하지 않고 실패도 기억함
        yield tail.group(0)
        return
    out = emit(parse_line(buf))
    if not seen:  # 줄마다 나뉘지 않은 JSON(여러 줄로 예쁘게 쓴 {"items": [...]})이면 통째로 한 번 더
        with contextlib.suppress(ValueError):
            out = emit(x for x in map(clean_item, items_of(core.parse_json_loose(text))) if x)
    if out:
        yield out
    if not seen:
        # 형식 오류는 캐시에 남기지 않고 실패로 기억 (cached_stream이 FAIL_TTL 동안 502: 매번 다시 생성·과금하지 않게).
        # _produce가 저장·실패 기억 지우기를 마친 뒤(스트림 끝)라 덮어써지지 않음
        core.task_path(arxiv_id, NAME).unlink(missing_ok=True)
        core._failures[(arxiv_id, NAME)] = (time.time(), 502, "핵심 문장 응답 형식 오류 (유효한 문장 없음)")
        yield core.error_tail("핵심 문장을 찾지 못했습니다 (응답 형식 오류)")


@router.get("/api/skim-highlights/{arxiv_id}")
async def skim_highlights(arxiv_id: str, retry: bool = False):
    resp = await core.cached_stream(arxiv_id, NAME, PROMPT, MAX_TOKENS, retry=retry)
    return StreamingResponse(filtered(arxiv_id, resp.body_iterator), media_type=core.TEXT,
                             headers={**core.OFFLINE_HEADERS, "Cache-Control": "no-cache"})
