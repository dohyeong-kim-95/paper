"""section-study: 섹션별 2~3줄 한국어 요약(gists)과 섹션 이해도 퀴즈 (4지선다 3문항, 근거 원문 포함).
둘 다 논문당·섹션당 한 번 생성해 디스크에 캐시 (cached_task). 오프라인 저장 가능 GET."""
import random
import re

from fastapi import APIRouter, HTTPException

import app as core

router = APIRouter()

# 클라이언트 pickGistIds와 같은 규칙 (요약 칩을 넣을 섹션도 이것으로 고름)
GIST_LEVELS = ("section", "subsection", "appendix")
TOP_LEVELS = ("section", "appendix")
MAX_SECTIONS = 30  # 계약: 목록은 30개까지 (8000 토큰 안)
GIST_MAX = 600  # 요약 한 개 최대 글자 수
QUIZ_N = 3
GIST_TASK = "section-study.gists.v2"
QUIZ_TASK = "section-study.quiz.{}.v2"
# why가 선택지를 번호·기호로 가리키면 섞은 뒤 엉뚱한 선택지를 가리킴 → 그런 문항은 섞지 않음
POSITIONAL_RE = re.compile(r"[①-④❶-❹]|(?<![\d.])[1-4]\s*번(?!째)|(?:선택지|보기)\s*[1-4①-④a-dA-D]"
                           r"|(?i:\b(?:option|choice)\s*[1-4a-d]\b)")


# ---------- 섹션 요약 ----------
def gist_sections(idx: dict) -> list[dict]:
    """요약 대상: 최상위(section·appendix)를 먼저 모두, 남는 자리는 하위 섹션으로 채움. 문서 순서 유지, 최대 MAX_SECTIONS개
    (앞쪽 섹션의 하위 섹션들이 자리를 다 써서 뒤쪽 실험·결론·부록이 빠지지 않게)"""
    cand = [s for s in idx["sections"] if s["level"] in GIST_LEVELS]
    top = [s["id"] for s in cand if s["level"] in TOP_LEVELS][:MAX_SECTIONS]
    subs = [s["id"] for s in cand if s["level"] not in TOP_LEVELS][:MAX_SECTIONS - len(top)]
    keep = set(top) | set(subs)
    return [s for s in cand if s["id"] in keep]


def gist_prompt(secs: list[dict]) -> str:
    lines = "\n".join(f"- {s['id']}: {s['full']}" for s in secs)
    return (
        "아래 섹션마다 한국어 2~3문장 요약을 쓰세요. 그 섹션이 무엇을 왜 하는지, 핵심 방법·결과·주장을 구체적으로 "
        "(수치·모델 이름 등 고유 용어는 원문 그대로).\n"
        "- 첫 문장에 핵심. 짧은 평서문('~한다'). 수식은 $...$.\n"
        "- 하위 섹션이 따로 있는 섹션은 하위 내용을 되풀이하지 말고 전체 흐름만.\n"
        "- 목록에 있는 id만, 목록 순서대로.\n\n"
        f"섹션 목록 (id: 제목):\n{lines}\n\n"
        '출력: JSON 객체 하나만 (설명·코드 펜스 없이). 형식: {"<id>": "요약", ...}'
    )


def clean_gists(value, ids: list[str]) -> dict:
    """모르는 id·빈 값 제거, 목록 순서로. 하나도 없으면 ValueError (캐시 안 함)"""
    if isinstance(value, dict) and isinstance(value.get("gists"), (dict, list)):
        value = value["gists"]
    if isinstance(value, list):  # [{"id", "gist"}] 형태도 받아 줌
        value = {str(x.get("id")): x.get("gist") or x.get("summary") for x in value if isinstance(x, dict)}
    if not isinstance(value, dict):
        raise ValueError("JSON 객체가 아님")
    got = {str(k).strip(): v.strip()[:GIST_MAX] for k, v in value.items() if isinstance(v, str) and v.strip()}
    out = {i: got[i] for i in ids if i in got}
    if not out:
        raise ValueError("유효한 섹션 요약이 없음")
    return out


@router.get("/api/section-study/{arxiv_id}/gists")
async def gists(arxiv_id: str, retry: bool = False):
    secs = gist_sections(await core.paper_index(arxiv_id))
    if not secs:
        return core.offline_json({})
    ids = [s["id"] for s in secs]
    data = await core.cached_task(arxiv_id, GIST_TASK, gist_prompt(secs), 8000,
                                  validate=lambda v: clean_gists(v, ids), retry=retry)
    return core.offline_json(data)


# ---------- 섹션 퀴즈 ----------
def quiz_prompt(sec: dict) -> str:
    return (
        f"섹션 \"{sec['full']}\" (id {sec['id']})을 읽은 독자의 이해도를 확인하는 4지선다 문제 {QUIZ_N}개를 한국어로 만드세요.\n"
        "- 이 섹션 내용만으로 풀 수 있게. 핵심 개념·이유·결과를 묻고, 단순 암기(숫자 맞히기)는 최대 1문제.\n"
        "- 선택지 4개는 짧고 서로 달라야 하며 정답은 하나. 오답도 그럴듯하게. '모두 정답'·'정답 없음' 같은 선택지 금지.\n"
        "- why: 정답인 이유를 1~2문장으로 (흔한 오답이 왜 틀렸는지도 짧게). 선택지는 번호·기호(①, 2번, (b) 등)로 "
        "가리키지 말고 내용으로 언급할 것 (선택지 순서는 나중에 섞임).\n"
        "- quote: 근거가 되는 이 섹션의 영어 원문 한 구절을 그대로 복사 (8~30단어, 수식은 본문의 $...$ 그대로, "
        "고치거나 줄이지 말 것).\n"
        "- 수식은 $...$.\n\n"
        "출력: JSON 배열 하나만 (설명·코드 펜스 없이). 형식: "
        '[{"q": "질문", "choices": ["선택지1", "선택지2", "선택지3", "선택지4"], "a": 정답 번호(0~3), '
        '"why": "해설", "quote": "영어 원문"}]'
    )


def _answer_index(a) -> int | None:
    if isinstance(a, bool):
        return None
    if isinstance(a, str) and a.strip().isdigit():
        a = int(a.strip())
    return a if isinstance(a, int) and 0 <= a <= 3 else None


def clean_quiz(value, seed: str = "") -> list[dict]:
    """형식이 틀린 문항(선택지 4개 아님·중복, 정답 번호 범위 밖 등)은 버림. 최대 QUIZ_N개.
    정답 위치가 한쪽으로 쏠리지 않게 선택지를 섞음 (seed로 고정 → 같은 입력이면 같은 결과)"""
    if isinstance(value, dict):
        value = value.get("quiz") or value.get("items") or value.get("questions")
    if not isinstance(value, list):
        raise ValueError("JSON 배열이 아님")
    out = []
    for it in value:
        if not isinstance(it, dict):
            continue
        q, choices, a = it.get("q"), it.get("choices"), _answer_index(it.get("a"))
        if not isinstance(q, str) or not q.strip() or a is None:
            continue
        if not isinstance(choices, list) or len(choices) != 4 or not all(isinstance(c, str) and c.strip() for c in choices):
            continue
        choices = [c.strip() for c in choices]
        if len(set(choices)) != 4:
            continue
        why, quote = it.get("why"), it.get("quote")
        why = why.strip() if isinstance(why, str) else ""
        order = list(range(4))
        if not POSITIONAL_RE.search(" ".join([why, *choices])):  # 번호로 가리키면 원래 순서 그대로
            random.Random(f"{seed}|{q.strip()}").shuffle(order)
        out.append({
            "q": q.strip(),
            "choices": [choices[j] for j in order],
            "a": order.index(a),
            "why": why,
            "quote": quote.strip() if isinstance(quote, str) else "",
        })
        if len(out) >= QUIZ_N:
            break
    if not out:
        raise ValueError("유효한 문항이 없음")
    return out


@router.get("/api/section-study/{arxiv_id}/quiz/{section_id}")
async def quiz(arxiv_id: str, section_id: str, retry: bool = False):
    idx = await core.paper_index(arxiv_id)
    sec = next((s for s in idx["sections"] if s["id"] == section_id), None)
    if sec is None:  # Claude 호출 전에 거름
        raise HTTPException(404, "논문에 없는 섹션입니다.")
    data = await core.cached_task(arxiv_id, QUIZ_TASK.format(section_id), quiz_prompt(sec), 2000,
                                  validate=lambda v: clean_quiz(v, section_id), retry=retry)
    return core.offline_json(data)
