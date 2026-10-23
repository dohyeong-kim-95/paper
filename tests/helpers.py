"""테스트 공용 도구: 가짜 Claude / 가짜 HTTP / 임시 캐시 / 픽스처 논문.

사용 예 (기능 테스트):
    from tests.helpers import CoreTestCase, core

    class OverviewTests(CoreTestCase):
        def test_it(self):
            self.claude.push({"chunks": ["a", "b"]})
            r = self.client.get(f"/api/overview/{self.paper_id}")
            self.assertEqual(r.text, "ab")
            self.assert_shared_call()

네트워크·API 키 없이 돈다. 모든 Claude 호출은 tearDown에서 system/REQUEST_OPTS 공유 여부를 자동 검사한다.
"""
import asyncio
import copy
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

os.environ.setdefault("ANTHROPIC_API_KEY", "test")

import anthropic  # noqa: E402
import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import app as core  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"
PAPER_ID = "2401.00001"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def seed_paper(arxiv_id: str = PAPER_ID, name: str = "sample_ltx.html") -> dict:
    """픽스처 HTML을 clean_article로 정리해 core.papers에 넣음 (네트워크 없이 /paper/<id> 등 사용 가능)"""
    paper = core.clean_article(fixture(name), f"https://arxiv.org/html/{arxiv_id}")
    core.papers[arxiv_id] = paper
    return paper


def reset_core_state():
    for d in (core._inflight, core._live, core._failures, core._soups, core._indexes, core._images, core._warm_at):
        d.clear()
    core._arxiv_next = 0.0


def api_error(msg: str = "boom") -> anthropic.APIError:
    """스트림 중간/호출 시 던질 anthropic 오류 (SDK 2.x는 httpx2 기반)"""
    try:
        import httpx2 as hx
    except ImportError:  # 옛 SDK
        hx = httpx
    return anthropic.APIConnectionError(message=msg, request=hx.Request("POST", "https://api.anthropic.com/v1/messages"))


# ---------- 가짜 Claude ----------
class _Msg:
    def __init__(self, text: str, stop_reason: str = "end_turn"):
        self.content = [SimpleNamespace(type="text", text=text)]
        self.stop_reason = stop_reason


class _Stream:
    def __init__(self, item: dict):
        self.item = item

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    @property
    def text_stream(self):
        item = self.item

        async def gen():
            for i, chunk in enumerate(item["chunks"]):
                if item.get("error_at") == i:
                    raise item["error"]
                if item.get("delay"):
                    await asyncio.sleep(item["delay"])
                yield chunk
            if item.get("error_at") == len(item["chunks"]):
                raise item["error"]
        return gen()

    async def get_final_message(self):
        return _Msg("".join(self.item["chunks"]), self.item.get("stop_reason", "end_turn"))


class FakeClaude:
    """core.client 대체. 응답 대본을 순서대로 소비.
    항목: "텍스트" 또는 dict(text=, chunks=[...], stop_reason='end_turn'|'max_tokens', error=예외, error_at=청크번호, delay=초)
    - create: error가 있으면 호출 시 던짐, 아니면 text(또는 chunks 합) 반환
    - stream: chunks(없으면 text 한 덩어리)를 흘리고 error_at에서 error를 던짐
    기록: self.calls (kwargs 깊은 복사), self.kinds ('create'|'stream')"""

    def __init__(self, *script):
        self.script = list(script)
        self.calls: list[dict] = []
        self.kinds: list[str] = []
        self.default = "ok"
        self.messages = SimpleNamespace(create=self._create, stream=self._stream)

    def push(self, *items):
        self.script.extend(items)
        return self

    def _next(self) -> dict:
        item = self.script.pop(0) if self.script else self.default
        if isinstance(item, str):
            item = {"text": item}
        item = dict(item)
        item.setdefault("chunks", [item.get("text", "")] if "text" in item else ["ok"])
        item.setdefault("text", "".join(item["chunks"]))
        return item

    def _record(self, kind, kwargs):
        self.kinds.append(kind)
        self.calls.append(copy.deepcopy(kwargs))

    async def _create(self, **kwargs):
        self._record("create", kwargs)
        item = self._next()
        if item.get("delay"):
            await asyncio.sleep(item["delay"])
        if item.get("error") is not None and item.get("error_at") is None:
            raise item["error"]
        return _Msg(item["text"], item.get("stop_reason", "end_turn"))

    def _stream(self, **kwargs):
        self._record("stream", kwargs)
        return _Stream(self._next())

    @property
    def last(self) -> dict:
        return self.calls[-1]

    def user_texts(self, call: dict | None = None) -> list[str]:
        """호출의 user 메시지 텍스트들 (블록 리스트도 펼침)"""
        out = []
        for m in (call or self.last)["messages"]:
            if m["role"] != "user":
                continue
            c = m["content"]
            out.append(c if isinstance(c, str) else "".join(b.get("text", "") for b in c if b.get("type") == "text"))
        return out

    def install(self, tc: unittest.TestCase):
        p = mock.patch.object(core, "client", self)
        p.start()
        tc.addCleanup(p.stop)
        return self


def assert_shared_call(tc: unittest.TestCase, kwargs: dict, paper: dict | None = None):
    """논문 캐시를 공유하는 호출인지: system·model·thinking·output_config가 같고 structured outputs·tools 없음"""
    if paper is not None:
        tc.assertEqual(kwargs["system"], core.system_blocks(paper))
    else:
        tc.assertEqual(len(kwargs["system"]), 2)
        tc.assertEqual(kwargs["system"][0], {"type": "text", "text": core.SYSTEM_PROMPT})
        tc.assertTrue(kwargs["system"][1]["text"].startswith("<paper>\n"))
        tc.assertEqual(kwargs["system"][1]["cache_control"], {"type": "ephemeral"})
    for k, v in core.REQUEST_OPTS.items():
        tc.assertEqual(kwargs.get(k), v, f"{k}가 REQUEST_OPTS와 다름")
    tc.assertNotIn("format", kwargs.get("output_config", {}), "output_config.format 금지 (캐시 깨짐)")
    tc.assertNotIn("tools", kwargs)
    tc.assertNotIn("output_format", kwargs)


# ---------- 가짜 HTTP (core.http.get) ----------
class FakeHTTP:
    """core.http.get 대체. route(match, body|Response|예외|callable)로 응답 등록, 처음 맞는 것 사용.
    match: URL 부분 문자열 또는 callable(url)->bool. 등록 안 된 URL은 ConnectError (네트워크 차단).
    기록: self.calls (params까지 붙인 전체 URL)"""

    def __init__(self):
        self.routes = []
        self.calls: list[str] = []

    def route(self, match, body=None, status: int = 200, headers: dict | None = None):
        self.routes.append((match, body, status, headers or {}))
        return self

    def arxiv(self, xml: str | None = None):
        """export.arxiv.org 응답을 Atom 픽스처로"""
        return self.route("export.arxiv.org", xml if xml is not None else fixture("arxiv_atom.xml"),
                          headers={"content-type": "application/atom+xml"})

    async def get(self, url, params=None, **kwargs):
        full = str(httpx.URL(str(url), params=params)) if params else str(url)
        self.calls.append(full)
        req = httpx.Request("GET", full)
        for match, body, status, headers in self.routes:
            if not (match(full) if callable(match) else match in full):
                continue
            if isinstance(body, BaseException):
                raise body
            if callable(body):
                body = body(full)
            if isinstance(body, httpx.Response):
                body.request = req
                return body
            content = body.encode() if isinstance(body, str) else (body or b"")
            return httpx.Response(status, content=content, headers=headers, request=req)
        raise httpx.ConnectError("network disabled in tests", request=req)

    def install(self, tc: unittest.TestCase):
        p = mock.patch.object(core.http, "get", self.get)
        p.start()
        tc.addCleanup(p.stop)
        return self


# ---------- 기본 테스트 케이스 ----------
class _CoreSetup:
    paper_id = PAPER_ID

    def _setup_core(self):
        reset_core_state()
        tmp = tempfile.mkdtemp(prefix="paper-test-")
        self.addCleanup(shutil.rmtree, tmp, True)
        self.cache = Path(tmp)
        for name, value in (("CACHE_DIR", self.cache), ("ARXIV_INTERVAL", 0.0)):
            p = mock.patch.object(core, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.claude = FakeClaude().install(self)
        self.http = FakeHTTP().install(self)
        self.paper = seed_paper(self.paper_id)
        self.addCleanup(core.papers.pop, self.paper_id, None)
        self.addCleanup(reset_core_state)

    def assert_shared_call(self, kwargs: dict | None = None, paper: dict | None = None):
        assert_shared_call(self, kwargs if kwargs is not None else self.claude.last, paper or self.paper)

    def _check_all_calls(self):
        # 모든 테스트 공통: 어떤 Claude 호출이든 논문 캐시를 공유해야 함
        for kw in self.claude.calls:
            assert_shared_call(self, kw)


class CoreTestCase(_CoreSetup, unittest.TestCase):
    def setUp(self):
        self._setup_core()
        self.client = self.enterContext(TestClient(core.app))

    def tearDown(self):
        self._check_all_calls()


class AsyncCoreTestCase(_CoreSetup, unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._setup_core()

    def tearDown(self):
        self._check_all_calls()
