"""glossary: 논문별 용어·기호 사전 (한 번 생성해 디스크 캐시, 이후 탭은 네트워크 없이 클라이언트에서 즉시)

GET /api/glossary/{arxiv_id}?retry=1
→ {"terms": [{t, a, ko, d, q, defs: [{d, q}]}], "symbols": [{tex, d, q, defs: [{d, q}]}]}
같은 기호가 섹션마다 다시 정의되면 defs가 여러 개 (클라이언트가 탭 위치 앞의 가장 가까운 정의를 고름).
d·q는 defs[0] (첫 정의)와 같음 — 단순 소비자(smart-presets '뜻' 등)용."""
import re

from fastapi import APIRouter

import app as core

router = APIRouter()

NAME = "glossary.v1"  # 프롬프트를 바꾸면 v2로
MAX_TOKENS = 8000
MAX_ITEMS = 30
MAX_DEFS = 4

PROMPT = """이 논문을 한국인 독자가 휴대폰으로 읽을 때 쓸 용어·기호 사전을 만드세요.
JSON 하나만 출력하세요 (설명·코드 펜스 없이). 형식:
{"terms":[{"t":"본문에 쓰인 영어 표기 그대로","a":["약어·다른 표기"],"ko":"한국어 용어","d":"이 논문 기준 한 줄 한국어 정의","q":"정의·처음 설명하는 본문 구절"}],
 "symbols":[{"tex":"본문 수식의 LaTeX 그대로","d":"한국어 의미","q":"기호를 정의하는 본문 구절"}]}
규칙:
- terms: 비전공 독자가 막힐 전문용어·약어·이 논문이 새로 붙인 이름, 최대 30개, 처음 나오는 순서대로. model·data·method 같은 흔한 단어는 빼기.
- "t"는 본문에 실제로 나오는 표기 그대로(대소문자 포함). 약어가 따로 쓰이면 풀네임을 t, 약어를 a에. 없으면 "a":[].
- "d"는 60자 이내 한 문장, 이 논문에서의 뜻. "ko"는 널리 쓰는 한국어 번역어(없으면 음역).
- symbols: 본문 수식의 주요 기호(변수·함수·하이퍼파라미터), 최대 30개. tex는 본문 수식 안의 모양 그대로(첨자 포함, 예: W_{g}, \\mathcal{L}_{\\text{bal}}). d는 40자 이내.
- 같은 기호가 다른 곳에서 다른 뜻으로 다시 정의되면 정의마다 항목을 따로 넣고 각자의 q를 쓰세요.
- "q"는 본문에서 글자 그대로 복사한 10~25단어 구절 (번역·요약·바꿔 쓰기 금지, 수식은 본문처럼 $...$). 확실하지 않으면 ""."""


def _s(v, n: int) -> str:
    return re.sub(r"\s+", " ", v).strip()[:n] if isinstance(v, str) else ""


_TEXT_CMD = re.compile(r"\\(?:mathrm|text|textrm|textit|textbf|textsf|texttt|textnormal|operatorname|mathit|mathsf|mathtt|mbox)(?![a-zA-Z])")
_WRAP_CMD = r"mathcal|mathbf|mathbb|mathfrak|mathscr|boldsymbol|bm|mathbfit|hat|tilde|bar|vec|dot|ddot|widehat|widetilde|overline|check|breve"
_WRAP_BARE = re.compile(r"\\(" + _WRAP_CMD + r")(?![a-zA-Z])\s*(\\[a-zA-Z]+|[^\s{}\\_^])")


def _term_key(t: str) -> str:
    # 클라이언트 normTerm과 같게: 대소문자·하이픈·띄어쓰기 차이 무시 ('load-balancing loss' = 'load balancing loss')
    return re.sub(r"[\s\-\u2010-\u2015]+", " ", t.lower()).strip()


def _tex_key(tex: str) -> str:
    # 같은 기호 묶기용 (공백·\displaystyle·한 글자 중괄호 차이 무시, \mathcal L = \mathcal{L}, \mathrm{bal} = \text{bal}).
    # 정밀한 비교는 클라이언트 normTex (클라이언트도 normTex가 같은 항목을 한 번 더 합침)
    s = re.sub(r"\\(displaystyle|textstyle|scriptstyle)(?![a-zA-Z])", "", tex.strip().strip("$"))
    s = _TEXT_CMD.sub(r"\\text", s)
    s = _WRAP_BARE.sub(r"\\\1{\2}", s)
    s = re.sub(r"\s+", "", s)
    prev = None
    while prev != s:
        prev, s = s, re.sub(r"([_^])\{([^{}\\]|\\[a-zA-Z]+(?:\{[^{}]*\})?)\}", r"\1\2", s)
    return s


def _defs(it: dict) -> list[dict]:
    raw = it.get("defs") if isinstance(it.get("defs"), list) else [it]
    out = []
    for x in raw:
        if isinstance(x, dict) and (d := _s(x.get("d"), 300)):
            out.append({"d": d, "q": _s(x.get("q"), 400)})
    return out


def _add_defs(entry: dict, defs: list[dict]) -> None:
    for d in defs:
        if len(entry["defs"]) < MAX_DEFS and all(d["q"] != x["q"] or d["d"] != x["d"] for x in entry["defs"]):
            entry["defs"].append(d)


def clean(data) -> dict:
    """validate: 형식이 틀린 항목은 버리고, 같은 용어·기호는 정의(defs)를 합침. 둘 다 비면 실패 (캐시 안 함)"""
    if not isinstance(data, dict):
        raise ValueError("JSON 객체가 아님")
    terms: dict[str, dict] = {}
    for it in data.get("terms") or []:
        if not isinstance(it, dict):
            continue
        t, ko, defs = _s(it.get("t"), 80), _s(it.get("ko"), 80), _defs(it)
        if not t or not defs:
            continue
        key = _term_key(t)
        if key in terms:
            _add_defs(terms[key], defs)
            continue
        if len(terms) >= MAX_ITEMS:
            continue
        raw_a = it.get("a")
        aliases = []
        for a in [raw_a] if isinstance(raw_a, str) else raw_a if isinstance(raw_a, list) else []:
            a = _s(a, 40)
            if a and _term_key(a) != key and _term_key(a) not in (_term_key(x) for x in aliases):
                aliases.append(a)
        terms[key] = {"t": t, "a": aliases[:3], "ko": ko, "defs": defs[:MAX_DEFS]}
    symbols: dict[str, dict] = {}
    for it in data.get("symbols") or []:
        if not isinstance(it, dict):
            continue
        tex, defs = _s(it.get("tex"), 120).strip("$ "), _defs(it)
        key = _tex_key(tex)
        if not key or not defs:
            continue
        if key in symbols:
            _add_defs(symbols[key], defs)
        elif len(symbols) < MAX_ITEMS:
            symbols[key] = {"tex": tex, "defs": defs[:MAX_DEFS]}
    if not terms and not symbols:
        raise ValueError("용어·기호가 하나도 없음")
    for e in (*terms.values(), *symbols.values()):
        e.update(d=e["defs"][0]["d"], q=e["defs"][0]["q"])
    return {"terms": list(terms.values()), "symbols": list(symbols.values())}


@router.get("/api/glossary/{arxiv_id}")
async def glossary(arxiv_id: str, retry: bool = False):
    data = await core.cached_task(arxiv_id, NAME, PROMPT, MAX_TOKENS, validate=clean, retry=retry)
    return core.offline_json(data)
