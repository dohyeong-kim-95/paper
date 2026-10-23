"""in-paper-search: 'AI로 찾기' — 한국어(또는 아무 말) 질문 → 논문 안 관련 위치 ≤5곳 [{q: 본문 그대로 인용, why: 한 줄}].

질문마다 달라서 디스크에 캐시하지 않음 (같은 질문은 메모리 LRU). 실패는 항상 200 + [] (찾기 줄이 '못 찾음'으로 보여 줌).
인용(q)은 클라이언트가 PaperAnchor.locate로 다시 찾고, 못 찾는 것은 버림."""
import logging
import re
from collections import OrderedDict

from fastapi import APIRouter
from pydantic import BaseModel, Field

import app as core

log = logging.getLogger("paper.in_paper_search")
router = APIRouter()

MAX_RESULTS = 5
MAX_TOKENS = 600
PROMPT = """독자가 이 논문에서 다음 내용이 나오는 곳을 찾고 있습니다.
<query>{query}</query>

질문과 가장 관련 있는 본문 위치를 관련도 높은 순으로 최대 5곳 고르세요. JSON 배열 하나만 출력하세요:
[{{"q": "본문 인용", "why": "한 줄 설명"}}]
- q: 위 <paper> 본문에서 그대로 복사한 연속된 6~15단어 (원문 언어 그대로, 보통 영어). 한 문장 안에서 고르고, 철자·대소문자·기호를 바꾸거나 생략(…)·의역하지 말 것. 수식은 본문에 적힌 $...$ 그대로. 제목·참고문헌·각주는 제외.
- why: 그 위치가 질문과 어떻게 관련되는지 한국어 한 줄 (40자 이내).
- 같은 문장을 두 번 고르지 말 것. 관련 위치가 없으면 [] 만 출력."""

_memo: OrderedDict = OrderedDict()  # (arxiv_id, 정규화 질문) -> 결과 (빈 결과·실패는 저장 안 함)
MEMO_KEEP = 64


class LocateBody(BaseModel):
    arxiv_id: str = Field(max_length=40)
    query: str = Field("", max_length=2000)  # 길면 200자로 자름 (clean_query)


def clean_query(q: str) -> str:
    # 프롬프트 태그를 깨지 않게 꺾쇠 제거, 공백 정리
    return re.sub(r"\s+", " ", re.sub(r"[<>]", " ", q or "")).strip()[:200]


def clean_results(value) -> list[dict]:
    """모델 출력 → [{q, why}] ≤5. 형식이 틀린 항목은 버림 (어떤 입력이든 리스트 반환)"""
    if isinstance(value, dict):  # {"results": [...]} 처럼 감싼 경우
        value = next((v for v in value.values() if isinstance(v, list)), [])
    if not isinstance(value, list):
        return []
    out, seen = [], set()
    for it in value:
        if not isinstance(it, dict):
            continue
        q, why = it.get("q") or it.get("quote"), it.get("why") or ""
        if not isinstance(q, str) or not isinstance(why, str):
            continue
        q = re.sub(r"\s+", " ", q).strip().strip("\"'“”‘’").strip(" .…")
        if len(q) < 4 or len(q) > 400 or q.lower() in seen:
            continue
        seen.add(q.lower())
        out.append({"q": q, "why": re.sub(r"\s+", " ", why).strip()[:120]})
        if len(out) == MAX_RESULTS:
            break
    return out


async def locate(arxiv_id: str, query: str) -> list[dict]:
    paper = await core.get_paper(arxiv_id)
    text = await core.complete_text(paper, PROMPT.format(query=query), MAX_TOKENS)
    return clean_results(core.parse_json_loose(text))


@router.post("/api/in-paper-search/locate")
async def api_locate(body: LocateBody):
    query = clean_query(body.query)
    if not query:
        return []
    key = (body.arxiv_id, query.lower())
    if key in _memo:
        _memo.move_to_end(key)
        return _memo[key]
    try:
        # 같은 질문이 동시에 오면 호출 한 번
        results = await core.singleflight(("in-paper-search", *key), lambda: locate(body.arxiv_id, query))
    except Exception as e:  # noqa: BLE001 - 어떤 실패든 200 + [] (계약 §8)
        log.warning("locate failed for %s: %r", body.arxiv_id, e)
        return []
    if results:
        _memo[key] = results
        while len(_memo) > MEMO_KEEP:
            _memo.popitem(last=False)
    return results
