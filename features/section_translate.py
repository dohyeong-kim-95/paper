"""section-translate: 스크롤 따라 단락 번역 (원문/둘다/번역, 수식·인용 보존, 문장 대응).

단위 = 가장 안쪽 글 덩어리: p.ltx_p('<가장 가까운 ltx_para id>#<n>'), 초록 문단('abs.<n>'), 제목('<부모 id>.title',
'doc.title', 'abs.title'), 그림·표 캡션('<figure id>.cap'), 각주 본문('<note id>.note').
수식·인용·참조·번호는 ⟦n⟧ 자리표시로 바꿔 보내고(모델이 못 건드리게) 클라이언트가 원래 노드 복제로 되돌림.
서버가 영어 문장을 나누고 모델은 같은 개수의 한국어 문장만 냄 (영어를 되풀이하지 않아 출력 토큰·지연 절반).
클라이언트 static/features/section-translate.js의 collectUnits·scan·atomKind와 같은 규칙을 유지할 것."""
import asyncio
import hashlib
import json
import logging
import re
from collections import OrderedDict

from bs4 import Comment, NavigableString
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import app as core

log = logging.getLogger("paper.section_translate")
router = APIRouter()

VERSION = "v1"  # 프롬프트·자리표시 규칙을 바꾸면 올림 (캐시 키 해시에 들어가 옛 번역은 안 씀)
CACHE_NAME = "section-translate"  # cache/<id>.section-translate.json: {"<unit id>:<hash>": ["한국어 문장", ...]}
MAX_IDS = 40  # 제목 묶음용 (단락은 클라이언트가 6개·2500자 이하로 묶음)
MAX_CHARS = 6000
MAX_TOKENS = 4000
PH = re.compile(r"⟦(\d+)⟧")
PH_LOOSE = re.compile(r"⟦\s*(\d+)\s*⟧")
HANGUL = re.compile("[%s-%s%s-%s%s-%s]" % tuple(map(chr, (0xAC00, 0xD7A3, 0x1100, 0x11FF, 0x3130, 0x318F))))  # 한글 음절·자모·호환 자모
LETTER = re.compile(r"[^\W\d_]")
WORD = re.compile(r"[^\W\d_]{2,}")
# 문장 끝으로 보지 않는 약어 (소문자, 끝 점 없이)
ABBR = {"e.g", "i.e", "al", "fig", "figs", "eq", "eqs", "sec", "secs", "vs", "cf", "etc", "approx", "resp", "no",
        "ref", "refs", "thm", "def", "lem", "prop", "cor", "tab", "app", "ch", "viz", "w.r.t", "a.k.a", "dr", "mr", "ms", "st"}


def _cls(el) -> list:
    return el.get("class") or []


def _skip_p(a) -> bool:
    # 이 조상 안의 p.ltx_p는 단위가 아님 (표 칸, 각주(따로 단위), 참고문헌, html.parser만 허용하는 p 안의 p)
    return a.name in ("p", "td", "th") or bool({"ltx_bibliography", "ltx_note"} & set(_cls(a)))


def _in(el, *classes) -> bool:
    return any(set(classes) & set(_cls(a)) for a in el.parents)


def collect_units(soup) -> dict:
    """{unit_id: (kind, el)} kind: title | p | cap | note. 공유 soup이므로 읽기만"""
    root = soup.find("article") or soup
    units: dict = {}
    for t in root.find_all(class_="ltx_title"):
        if _in(t, "ltx_bibliography", "ltx_note"):
            continue
        cls = _cls(t)
        if "ltx_title_document" in cls:
            uid = "doc.title"
        elif "ltx_title_abstract" in cls:
            uid = "abs.title"
        elif t.parent is not None and t.parent.get("id"):
            uid = f"{t.parent['id']}.title"
        else:
            continue
        units.setdefault(uid, ("title", t))
    abs_n, para_n = 0, {}
    for p in root.find_all("p", class_="ltx_p"):
        if any(_skip_p(a) for a in p.parents):
            continue
        if _in(p, "ltx_abstract"):
            uid, abs_n = f"abs.{abs_n}", abs_n + 1
        else:
            para = p.find_parent(lambda t: "ltx_para" in _cls(t) and t.get("id"))
            if para is None:
                continue
            n = para_n.get(para["id"], 0)
            para_n[para["id"]] = n + 1
            uid = f"{para['id']}#{n}"
        units.setdefault(uid, ("p", p))
    cap_n = {}
    for cap in root.find_all("figcaption"):
        fig = cap.parent
        if fig is None or fig.name != "figure" or not fig.get("id") or _in(cap, "ltx_bibliography"):
            continue
        n = cap_n.get(fig["id"], 0)
        cap_n[fig["id"]] = n + 1
        units.setdefault(f"{fig['id']}.cap{n or ''}", ("cap", cap))
    for c in root.find_all(class_="ltx_note_content"):
        note = c.find_parent(class_="ltx_note")
        if note is None or not note.get("id") or _in(c, "ltx_bibliography"):
            continue
        units.setdefault(f"{note['id']}.note", ("note", c))
    return units


def unit_source(el) -> tuple[str, list]:
    """단위 텍스트(자리표시 ⟦n⟧ 포함)와 자리표시 목록. 순서·종류는 클라이언트 scan·atomKind와 같음"""
    parts, ph = [], []

    def add(item):
        parts.append(f"⟦{len(ph)}⟧")
        ph.append(item)

    def walk(n):
        for c in n.children:
            if isinstance(c, NavigableString):
                if not isinstance(c, Comment):
                    parts.append(str(c))
                continue
            cls = _cls(c)
            if c.name == "math":
                add({"k": "math", "tex": c.get("alttext", "")})
            elif c.name == "table" and ("ltx_equation" in cls or "ltx_equationgroup" in cls):
                add({"k": "eq", "id": c.get("id", "")})  # 수식 블록은 통째로 (번호 보존)
            elif "ltx_note" in cls:
                mark = c.find(class_="ltx_note_mark")  # 각주 본문은 따로 단위 → 여기서는 표시만
                add({"k": "note", "id": c.get("id", ""), "text": core.el_text(mark) if mark else ""})
            elif c.name == "cite":
                add({"k": "cite", "text": core.el_text(c)})
            elif c.name == "a" and "ltx_ref" in cls:
                add({"k": "ref", "href": c.get("href", ""), "text": core.el_text(c)})
            elif "ltx_tag" in cls or "ltx_note_mark" in cls:
                add({"k": "tag", "text": core.el_text(c)})  # 'Figure 1:', '2.1' 등 번호는 원문 그대로
            elif c.name == "img":
                add({"k": "img", "src": c.get("src", "")})
            elif c.name in ("script", "style", "button") or "pr-ui" in cls or "ltx_note_outer" in cls:
                continue
            else:
                walk(c)

    walk(el)
    return re.sub(r"\s+", " ", "".join(parts)).strip(), ph


def should_skip(text: str, kind: str) -> bool:
    """번역할 필요 없는 단위: 글자가 없음, 한글 비율 0.3 초과(이미 한국어), 단어가 너무 적음 (제목·캡션은 1개, 나머지 3개)"""
    plain = PH.sub(" ", text)
    letters = LETTER.findall(plain)
    if not letters:
        return True
    if len(HANGUL.findall(plain)) / len(letters) > 0.3:
        return True
    return len(WORD.findall(plain)) < (1 if kind in ("title", "cap") else 3)


def split_sentences(text: str) -> list[str]:
    """영어 문장 나누기 (약어·이니셜·자리표시 뒤 마침표 처리). 클라이언트는 이 결과를 그대로 받아 씀"""
    out, start = [], 0
    for m in re.finditer(r"\s+", text):
        before, nxt = text[start:m.start()], text[m.end():m.end() + 1]
        body = re.sub(r"(⟦\d+⟧|[\"'”’)\]])+$", "", before)  # 'cheap.⟦3⟧ Our' 처럼 끝의 자리표시·닫는 괄호는 건너봄
        if not body.endswith((".", "!", "?")) or not nxt:
            continue
        if not (nxt.isupper() or nxt.isdigit() or nxt in "⟦(\"'“["):
            continue
        if body.endswith(".") and body == before:
            w = re.search(r"([A-Za-z][A-Za-z.]*)\.$", body)
            if w and (w.group(1).lower() in ABBR or len(w.group(1)) == 1):
                continue  # Eq. (1), et al. Smith, A. Author
        out.append(text[start:m.start()].strip())
        start = m.end()
    tail = text[start:].strip()
    if tail:
        out.append(tail)
    return out


def fingerprint(text: str) -> str:
    # 클라이언트가 같은 단위를 가리키는지 확인 (파서 차이로 번호가 어긋나면 번역을 붙이지 않음)
    return re.sub(r"[^a-z0-9]", "", text.lower())[:32]


def text_hash(text: str, ph: list) -> str:
    return hashlib.sha1(f"{VERSION}\n{text}\n{json.dumps(ph, ensure_ascii=False, sort_keys=True)}".encode()).hexdigest()[:8]


def clean_ko(ko, n_ph: int) -> list[str]:
    """모델의 ko 목록 검사: 문자열 목록, 모든 ⟦n⟧(0..n_ph-1)이 정확히 한 번. 아니면 ValueError"""
    if isinstance(ko, str):
        ko = [ko]
    if not isinstance(ko, list) or not ko or not all(isinstance(s, str) for s in ko):
        raise ValueError("ko 목록이 아님")
    ko = [PH_LOOSE.sub(lambda m: f"⟦{m.group(1)}⟧", s).strip() for s in ko]
    if not "".join(ko).strip():
        raise ValueError("빈 번역")
    found = sorted(int(x) for x in PH.findall("".join(ko)))
    if found != list(range(n_ph)):
        raise ValueError(f"자리표시 불일치: {found} != 0..{n_ph - 1}")
    return ko


def pairs(en: list[str], ko: list[str]) -> list[list[str]]:
    # 문장 수가 다르면 단위 전체를 한 쌍으로 (번역은 그대로 쓰고 대응만 단락 단위로)
    return [list(p) for p in zip(en, ko)] if len(en) == len(ko) else [[" ".join(en), " ".join(ko)]]


PH_HINT = {"math": "수식", "eq": "수식 블록", "note": "각주 표시", "cite": "인용", "ref": "참조", "tag": "번호", "img": "그림"}


def _hint(p: dict) -> str:
    detail = p.get("tex") or p.get("text") or ""
    return f"{PH_HINT.get(p['k'], p['k'])} {detail[:40]}".strip()


PROMPT = """아래 JSON의 각 단위(u)는 이 논문의 한 단락·제목·캡션·각주이고, en은 그 영어 문장 목록입니다.
자연스러운 한국어 학술 문체로 번역하세요.
규칙:
- ⟦0⟧, ⟦1⟧ … 은 수식·인용·참조·번호 자리표시입니다(ph에 무엇인지 적혀 있음). 각 자리표시를 글자 그대로, 정확히 한 번씩, 문장의 알맞은 위치에 남기세요. 빼거나 새로 만들거나 풀어 쓰지 마세요.
- ko는 en과 같은 개수·순서의 문장 목록입니다 (ko[i]는 en[i]의 번역). 문장을 합치거나 나누지 마세요.
- 전문 용어는 이 요청 안에서 처음 나올 때만 한국어(English) 형태로 쓰고, 그 뒤로는 한국어로만 쓰세요. 모델·데이터셋·고유명사 이름은 원문 그대로 두세요.
- t가 "title"이면 제목이므로 짧은 명사구로 번역하세요.
- JSON만 출력하세요: {"u":[{"id":"…","ko":["…"]}]}

입력:
"""


def build_prompt(todo: list[dict]) -> str:
    rows = []
    for it in todo:
        row = {"id": it["id"], "en": it["en"]}
        if it["kind"] == "title":
            row["t"] = "title"
        if it["ph"]:
            row["ph"] = [_hint(p) for p in it["ph"]]
        rows.append(row)
    return PROMPT + json.dumps({"u": rows}, ensure_ascii=False)


_units: OrderedDict = OrderedDict()  # arxiv_id -> (soup, units): soup이 바뀌면(새로 파싱) 다시 만듦


async def paper_units(arxiv_id: str) -> dict:
    soup = await core.paper_soup(arxiv_id)
    hit = _units.get(arxiv_id)
    if hit and hit[0] is soup:
        _units.move_to_end(arxiv_id)
        return hit[1]
    units = await asyncio.to_thread(collect_units, soup)
    _units[arxiv_id] = (soup, units)
    while len(_units) > 4:
        _units.popitem(last=False)
    return units


async def _generate(arxiv_id: str, paper: dict, todo: list[dict]) -> dict:
    """한 번의 Claude 호출로 여러 단위 번역. JSON이 깨지면 502 (아무것도 저장 안 함). 단위별 검사에 실패한 것만 빠짐"""
    text = await core.complete_text(paper, build_prompt(todo), MAX_TOKENS)  # API 오류·max_tokens 잘림은 502
    try:
        data = core.parse_json_loose(text)
    except ValueError as e:
        raise HTTPException(502, "번역 응답 형식 오류") from e
    rows = data.get("u") if isinstance(data, dict) else data
    if not isinstance(rows, list):
        raise HTTPException(502, "번역 응답 형식 오류")
    by_id = {it["id"]: it for it in todo}
    got = {}
    for row in rows:
        rid = row.get("id") if isinstance(row, dict) else None
        it = by_id.get(rid) if isinstance(rid, str) else None  # 목록·객체 id는 해시 불가 → 그 줄만 버림
        if it is None or it["id"] in got:
            continue
        try:
            got[it["id"]] = clean_ko(row.get("ko"), len(it["ph"]))
        except ValueError as e:
            log.warning("section-translate %s %s: %s", arxiv_id, it["id"], e)
    if got:
        new = {by_id[i]["key"]: ko for i, ko in got.items()}
        core.update_json(core.task_path(arxiv_id, CACHE_NAME), lambda c: {**(c if isinstance(c, dict) else {}), **new}, {})
    return got


class TranslateBody(BaseModel):
    ids: list[str] = Field(default_factory=list, max_length=MAX_IDS)
    force: bool = False  # '다시 번역': 캐시 무시하고 새로 (덮어씀)


@router.post("/api/section-translate/{arxiv_id}")
async def translate(arxiv_id: str, body: TranslateBody):
    """{ids} → {id: {s: [[en, ko], ...], ph: [...], fp} | {skip: true} | {err}}. 모르는 id는 응답에 없음"""
    paper = await core.get_paper(arxiv_id)
    units = await paper_units(arxiv_id)
    cache = core.read_json(core.task_path(arxiv_id, CACHE_NAME), {})
    cache = cache if isinstance(cache, dict) else {}
    out, todo = {}, []
    for uid in dict.fromkeys(i for i in body.ids if isinstance(i, str) and len(i) <= 200):
        if uid not in units:
            continue
        kind, el = units[uid]
        text, ph = unit_source(el)
        if should_skip(text, kind):
            out[uid] = {"skip": True}
            continue
        it = {"id": uid, "kind": kind, "ph": ph, "en": [text] if kind == "title" else split_sentences(text),
              "key": f"{uid}:{text_hash(text, ph)}", "fp": fingerprint(core.el_text(el))}
        ko = None if body.force else cache.get(it["key"])
        if isinstance(ko, list) and ko and all(isinstance(s, str) for s in ko):
            out[uid] = {"s": pairs(it["en"], ko), "ph": ph, "fp": it["fp"]}
        else:
            todo.append(it)
    if todo:
        if len(todo) > 1 and sum(len(" ".join(it["en"])) for it in todo) > MAX_CHARS:
            raise HTTPException(413, "한 번에 번역하기에 너무 깁니다.")
        key = ("section-translate", arxiv_id, body.force, *(it["key"] for it in todo))
        got = await core.singleflight(key, lambda: _generate(arxiv_id, paper, todo))
        for it in todo:
            ko = got.get(it["id"])
            out[it["id"]] = {"s": pairs(it["en"], ko), "ph": it["ph"], "fp": it["fp"]} if ko else {"err": "번역 형식 오류"}
    return out
