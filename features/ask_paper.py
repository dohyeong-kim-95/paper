"""ask-paper: 답변이 끝날 때마다 이어 물을 짧은 후속 질문 칩 (POST /api/ask-paper/followups).

시트 대화(history, 방금 끝난 턴 포함) 뒤에 지시 user 턴 하나를 붙여 한 번 호출. 마지막 assistant 턴에
캐시 지점(mark_cache)을 두어, 다음 /api/ask의 자동 캐시 지점이 그 항목을 찾아 대화 앞부분을 읽게 함.
top-level cache_control 없음 (고유한 지시문에 1.25x 쓰기만 하고 읽히지 않음)."""
import logging

from fastapi import APIRouter, HTTPException

import app as core

log = logging.getLogger("paper.ask_paper")
router = APIRouter()

FOLLOWUP_PROMPT = (
    "위 대화를 이어갈 짧은 후속 질문 3개를 JSON 문자열 배열로만 출력해. 각 25자 이내, 한국어. "
    "독자가 이 논문을 더 깊이 이해하도록 돕는 질문으로, 이미 답한 내용은 반복하지 말 것. "
    '형식: ["…", "…", "…"]'
)
MAX_TOKENS = 200
MAX_LEN = 40  # 25자를 부탁하지만 조금 넘는 것은 허용, 이보다 길면 버림
MAX_ITEMS = 3


def clean_followups(value, asked=()) -> list[str]:
    """모델 출력(파싱된 JSON) → 짧은 질문 문자열 최대 3개. 문자열 아님·빈 것·너무 긺·중복·이미 물은 질문은 버림"""
    if isinstance(value, dict):  # {"questions": [...]} 처럼 감싸 온 경우
        value = next((v for v in value.values() if isinstance(v, list)), [])
    if not isinstance(value, list):
        return []
    seen = {" ".join(str(q).split()) for q in asked}
    out = []
    for q in value:
        if not isinstance(q, str):
            continue
        q = " ".join(q.split())
        if not q or len(q) > MAX_LEN or q in seen:
            continue
        seen.add(q)
        out.append(q)
    return out[:MAX_ITEMS]


def followup_messages(body: core.Ask) -> list[dict]:
    """build_messages(question 없이) + 마지막 assistant 턴에 캐시 지점 + 지시 user 턴"""
    if not body.history or body.history[-1].role != "assistant":
        raise HTTPException(400, "대화가 assistant 답변으로 끝나야 합니다.")
    messages = core.mark_cache(core.build_messages(body.model_copy(update={"question": ""})))
    messages.append(core.user_turn(FOLLOWUP_PROMPT, preamble=False))
    return messages


@router.post("/api/ask-paper/followups")
async def followups(body: core.Ask):
    messages = followup_messages(body)
    paper = await core.get_paper(body.arxiv_id)
    try:
        text = await core.complete_text(paper, messages=messages, max_tokens=MAX_TOKENS, preamble=False)
        value = core.parse_json_loose(text)
    except (HTTPException, ValueError) as e:
        # 칩은 덤: 호출 실패·잘림·형식 오류는 빈 목록 (200)
        log.info("followups skipped: %s", getattr(e, "detail", e))
        return []
    return clean_followups(value, asked=[t.content for t in body.history if t.role == "user"])
