"""확장 기반(ext-hooks) 테스트: 질문 메시지 구성, 공용 Claude 헬퍼, 캐시 작업, 기능 로더·에셋 번들, arXiv, 피드백"""
import asyncio
import json
import sys
import tempfile
import textwrap
import time
from pathlib import Path
from unittest import mock

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from tests.helpers import (AsyncCoreTestCase, CoreTestCase, PAPER_ID, api_error, core, fixture, seed_paper)


def stream_app(name="overview.v1", prompt="3줄 요약 / 스냅샷", max_tokens=100):
    # cached_stream을 쓰는 가짜 기능 라우트
    app = FastAPI()

    @app.get("/s/{arxiv_id}")
    async def s(arxiv_id: str):
        return await core.cached_stream(arxiv_id, name, prompt, max_tokens)
    return app


class AskTests(CoreTestCase):
    def ask(self, **body):
        return self.client.post("/api/ask", json={"arxiv_id": self.paper_id, **body})

    def test_first_turn_has_highlight_context_section(self):
        r = self.ask(selection="We propose a sparse mixture", context="Paragraph text $x^{2}$.",
                     section="1 Introduction", question="쉽게 설명해줘")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.text, "ok")
        first = self.claude.last["messages"][0]["content"]
        self.assertEqual(first, "<highlight>\nWe propose a sparse mixture\n</highlight>\n"
                                "<context>\n<section>1 Introduction</section>\nParagraph text $x^{2}$.\n</context>\n\n쉽게 설명해줘")
        self.assertEqual(self.claude.kinds, ["stream"])
        self.assertEqual(self.claude.last["cache_control"], {"type": "ephemeral"})
        self.assert_shared_call()

    def test_follow_up_keeps_first_turn_bytes(self):
        body = dict(selection="SEL", context="CTX", section="2 Method")
        self.ask(question="Q1 <style>짧게</style>", **body)
        first_bytes = self.claude.last["messages"][0]["content"]
        history = [{"role": "user", "content": "Q1 <style>짧게</style>"}, {"role": "assistant", "content": "A1"}]
        self.ask(question="Q2", history=history, **body)
        msgs = self.claude.last["messages"]
        self.assertEqual(msgs[0]["content"], first_bytes)
        self.assertEqual(msgs[1], {"role": "assistant", "content": "A1"})
        self.assertEqual(msgs[2], {"role": "user", "content": "Q2"})  # 하이라이트는 첫 턴에만
        history += [{"role": "user", "content": "Q2"}, {"role": "assistant", "content": "A2"}]
        self.ask(question="Q3", history=history, **body)
        self.assertEqual(self.claude.last["messages"][:3], msgs[:3])

    def test_only_selection_matches_old_format(self):
        self.ask(selection="S", question="Q")
        self.assertEqual(self.claude.last["messages"][0]["content"], "<highlight>\nS\n</highlight>\n\nQ")

    def test_empty_question_400(self):
        self.assertEqual(self.ask(question="  ").status_code, 400)
        self.assertEqual(self.claude.calls, [])

    def test_api_error_mid_stream(self):
        self.claude.push({"chunks": ["부분 ", "답"], "error": api_error("down"), "error_at": 1})
        r = self.ask(question="Q")
        self.assertTrue(r.text.startswith("부분 "))
        self.assertIn("[오류]", r.text)

    def test_unknown_paper_404(self):
        r = self.client.post("/api/ask", json={"arxiv_id": "9999.99999", "question": "Q"})
        self.assertEqual(r.status_code, 404)


class MessageBuilderTests(CoreTestCase):
    def test_build_first_turn_variants(self):
        f = core.build_first_turn
        self.assertEqual(f("", "", "Q"), "Q")
        self.assertEqual(f("S", "", "Q"), "<highlight>\nS\n</highlight>\n\nQ")
        self.assertEqual(f("", "C", "Q"), "<context>\nC\n</context>\n\nQ")
        self.assertEqual(f("", "", "Q", "Sec"), "<context>\n<section>Sec</section>\n</context>\n\nQ")

    def test_build_messages_question_optional_with_history(self):
        body = core.Ask(arxiv_id="x", selection="S", question="",
                        history=[{"role": "user", "content": "Q1"}, {"role": "assistant", "content": "A1"}])
        msgs = core.build_messages(body)
        self.assertEqual(len(msgs), 2)
        self.assertTrue(msgs[0]["content"].startswith("<highlight>"))
        with self.assertRaises(HTTPException):
            core.build_messages(core.Ask(arxiv_id="x"))

    def test_mark_cache_renders_same_text(self):
        msgs = [{"role": "user", "content": "Q"}, {"role": "assistant", "content": "A"}]
        core.mark_cache(msgs)
        self.assertEqual(msgs[1]["content"], [{"type": "text", "text": "A", "cache_control": {"type": "ephemeral"}}])


class CompleteTextTests(AsyncCoreTestCase):
    async def test_preamble_and_no_top_level_cache(self):
        self.claude.push("hello")
        out = await core.complete_text(self.paper, "JSON만", 300)
        self.assertEqual(out, "hello")
        call = self.claude.last
        self.assertEqual(call["messages"], [{"role": "user", "content": f"{core.TASK_PREAMBLE}\n\nJSON만"}])
        self.assertNotIn("cache_control", call)  # 일회성 작업: system 표시만 캐시 지점
        self.assertEqual(call["max_tokens"], 300)
        self.assert_shared_call()

    async def test_max_tokens_and_api_error_are_502(self):
        self.claude.push({"text": "잘린", "stop_reason": "max_tokens"}, {"error": api_error()})
        for _ in range(2):
            with self.assertRaises(HTTPException) as cm:
                await core.complete_text(self.paper, "p")
            self.assertEqual(cm.exception.status_code, 502)


class CachedTaskTests(AsyncCoreTestCase):
    async def test_concurrent_calls_make_one_claude_call(self):
        self.claude.push({"text": '설명입니다\n```json\n{"terms": [1, 2]}\n```', "delay": 0.05})
        a, b = await asyncio.gather(
            core.cached_task(self.paper_id, "glossary.v1", "JSON만"),
            core.cached_task(self.paper_id, "glossary.v1", "JSON만"))
        self.assertEqual(a, {"terms": [1, 2]})
        self.assertEqual(b, a)
        self.assertEqual(len(self.claude.calls), 1)
        path = self.cache / f"{PAPER_ID}.glossary.v1.json"
        self.assertEqual(json.loads(path.read_text()), {"terms": [1, 2]})
        self.assertEqual(list(self.cache.glob("*.tmp")), [])
        # 디스크 적중: 호출 없음
        self.assertEqual(await core.cached_task(self.paper_id, "glossary.v1", "JSON만"), a)
        self.assertEqual(len(self.claude.calls), 1)
        self.assertTrue(self.claude.user_texts()[0].startswith(core.TASK_PREAMBLE))

    async def test_invalid_json_502_not_cached_and_negative_cache(self):
        self.claude.push("JSON 아님", '{"ok": true}')
        with self.assertRaises(HTTPException) as cm:
            await core.cached_task(self.paper_id, "skim.v1", "p")
        self.assertEqual(cm.exception.status_code, 502)
        self.assertFalse((self.cache / f"{PAPER_ID}.skim.v1.json").exists())
        # 10분 안에는 다시 부르지 않음 (매번 과금 방지)
        with self.assertRaises(HTTPException):
            await core.cached_task(self.paper_id, "skim.v1", "p")
        self.assertEqual(len(self.claude.calls), 1)
        # 사용자가 '다시'를 누르면 retry=True
        self.assertEqual(await core.cached_task(self.paper_id, "skim.v1", "p", retry=True), {"ok": True})
        self.assertEqual(len(self.claude.calls), 2)

    async def test_truncated_output_is_failure(self):
        self.claude.push({"text": '{"terms": [', "stop_reason": "max_tokens"})
        with self.assertRaises(HTTPException):
            await core.cached_task(self.paper_id, "glossary.v1", "p", max_tokens=10)
        self.assertFalse(any(self.cache.iterdir()))

    async def test_validate_and_text_mode(self):
        self.claude.push('{"items": [{"f": "goal"}, {"f": "bogus"}]}', "  텍스트 결과  ")
        keep = lambda v: {"items": [i for i in v["items"] if i["f"] != "bogus"]}  # noqa: E731
        self.assertEqual(await core.cached_task(self.paper_id, "skim.v1", "p", validate=keep), {"items": [{"f": "goal"}]})
        self.assertEqual(await core.cached_task(self.paper_id, "audio.brief.v1", "p", as_json=False), "텍스트 결과")

        def bad(v):
            raise ValueError("모양이 틀림")
        self.claude.push('{"x": 1}')
        with self.assertRaises(HTTPException):
            await core.cached_task(self.paper_id, "quiz.S1.v1", "p", validate=bad)
        self.assertFalse((self.cache / f"{PAPER_ID}.quiz.S1.v1.json").exists())

    async def test_cancelled_waiter_does_not_cancel_shared_work(self):
        self.claude.push({"text": '{"v": 1}', "delay": 0.1})
        t1 = asyncio.create_task(core.cached_task(self.paper_id, "gists.v1", "p"))
        t2 = asyncio.create_task(core.cached_task(self.paper_id, "gists.v1", "p"))
        await asyncio.sleep(0.02)
        t1.cancel()
        self.assertEqual(await t2, {"v": 1})
        with self.assertRaises(asyncio.CancelledError):
            await t1
        self.assertTrue((self.cache / f"{PAPER_ID}.gists.v1.json").exists())
        self.assertEqual(len(self.claude.calls), 1)

    async def test_task_path_is_sanitized(self):
        p = core.task_path("../../etc", "quiz/../../S1.v1")
        self.assertEqual(p.parent, self.cache)
        self.assertNotIn("/", p.name)


class CachedStreamTests(CoreTestCase):
    def setUp(self):
        super().setUp()
        self.sclient = self.enterContext(TestClient(stream_app()))

    def test_second_get_identical_with_zero_calls(self):
        self.claude.push({"chunks": ["## 3줄 ", "요약", " 끝"]})
        r1 = self.sclient.get(f"/s/{self.paper_id}")
        self.assertEqual(r1.text, "## 3줄 요약 끝")
        self.assertEqual(r1.headers["x-offline-cacheable"], "1")
        self.assertEqual(json.loads((self.cache / f"{PAPER_ID}.overview.v1.json").read_text()), r1.text)
        r2 = self.sclient.get(f"/s/{self.paper_id}")
        self.assertEqual(r2.text, r1.text)
        self.assertEqual(len(self.claude.calls), 1)
        self.assertIn("3줄 요약", self.claude.user_texts()[0])
        self.assertNotIn("cache_control", self.claude.last)

    def test_error_mid_stream_not_cached(self):
        self.claude.push({"chunks": ["a", "b"], "error": api_error(), "error_at": 1})
        r = self.sclient.get(f"/s/{self.paper_id}")
        self.assertTrue(r.text.startswith("a"))
        self.assertTrue(r.text.rstrip().split("\n")[-1].startswith("[오류]"))
        self.assertFalse((self.cache / f"{PAPER_ID}.overview.v1.json").exists())

    def test_any_exception_or_truncation_not_cached(self):
        self.claude.push({"chunks": ["a"], "error": RuntimeError("x"), "error_at": 1},
                         {"chunks": ["a"], "stop_reason": "max_tokens"})
        with self.assertLogs("paper", "ERROR"):
            self.assertIn("[오류]", self.sclient.get(f"/s/{self.paper_id}").text)
        self.assertEqual(self.sclient.get(f"/s/{self.paper_id}").text, "a")
        self.assertFalse((self.cache / f"{PAPER_ID}.overview.v1.json").exists())

    def test_unknown_paper_404_before_streaming(self):
        self.assertEqual(self.sclient.get("/s/9999.99999").status_code, 404)


class CachedStreamAsyncTests(AsyncCoreTestCase):
    async def consume(self, resp, limit=None):
        out = []
        async for chunk in resp.body_iterator:
            out.append(chunk if isinstance(chunk, str) else chunk.decode())
            if limit and len(out) >= limit:
                break
        return "".join(out)

    async def test_client_disconnect_keeps_generating_and_caches(self):
        self.claude.push({"chunks": ["one ", "two ", "three"], "delay": 0.02})
        resp = await core.cached_stream(self.paper_id, "overview.v1", "p")
        it = resp.body_iterator
        await it.__anext__()
        await it.aclose()  # 사용자가 떠남
        path = self.cache / f"{PAPER_ID}.overview.v1.json"
        for _ in range(100):
            if path.exists():
                break
            await asyncio.sleep(0.01)
        self.assertEqual(json.loads(path.read_text()), "one two three")

    async def test_concurrent_gets_share_one_generation(self):
        self.claude.push({"chunks": ["x", "y", "z"], "delay": 0.02})
        r1 = await core.cached_stream(self.paper_id, "overview.v1", "p")
        r2 = await core.cached_stream(self.paper_id, "overview.v1", "p")
        a, b = await asyncio.gather(self.consume(r1), self.consume(r2))
        self.assertEqual((a, b), ("xyz", "xyz"))
        self.assertEqual(len(self.claude.calls), 1)


class FeatureLoaderTests(CoreTestCase):
    def make_pkg(self, files: dict) -> tuple[Path, str]:
        tmp = Path(tempfile.mkdtemp(prefix="featpkg-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(tmp, True))
        name = f"fakefeatures_{int(time.time() * 1e6)}"
        pkg = tmp / name
        pkg.mkdir()
        (pkg / "__init__.py").write_text("")
        for fname, src in files.items():
            (pkg / fname).write_text(textwrap.dedent(src))
        sys.path.insert(0, str(tmp))
        self.addCleanup(sys.path.remove, str(tmp))
        self.addCleanup(lambda: [sys.modules.pop(m) for m in list(sys.modules) if m.startswith(name)])
        return pkg, name

    def test_loads_router_modules_and_survives_broken_ones(self):
        pkg, name = self.make_pkg({
            "ping.py": """
                from fastapi import APIRouter
                import app as core
                router = APIRouter()

                @router.get("/api/ping/{x}")
                async def ping(x: str):
                    return {"pong": x, "model": core.MODEL}
            """,
            "broken.py": "raise RuntimeError('import 실패')\n",
            "_private.py": "raise RuntimeError('불리면 안 됨')\n",
            "helper_only.py": "VALUE = 1\n",
        })
        target = FastAPI()
        with self.assertLogs("paper", "ERROR") as logs:
            loaded = core.load_feature_routers(target, pkg, name)
        self.assertEqual(loaded, ["helper_only", "ping"])
        self.assertTrue(any("broken.py" in m for m in logs.output))
        r = TestClient(target).get("/api/ping/1")
        self.assertEqual(r.json(), {"pong": "1", "model": core.MODEL})

    def test_real_features_package_loaded_at_import(self):
        self.assertIsInstance(core.FEATURES, list)
        self.assertTrue((Path(core.BASE_DIR) / "features" / "__init__.py").exists())


class FeatureAssetTests(CoreTestCase):
    def add_feature_file(self, name, src):
        path = core.FEATURES_STATIC / name
        self.assertFalse(path.exists(), f"{name}이 이미 있음")
        path.write_text(src, encoding="utf-8")
        self.addCleanup(path.unlink, True)  # 실패해도 사용자에게 서빙되지 않게 반드시 삭제
        return path

    def test_bundle_wraps_each_file_and_page_includes_it(self):
        self.add_feature_file("zz.js", "const askBtn = 1; window.__zz = askBtn; // 끝 주석")
        self.add_feature_file("zz.css", ".zz { color: red; }")
        self.add_feature_file("zz.sw.js", "self.PR_SW.routes.push({test: () => false});")
        js = self.client.get("/features.js")
        self.assertEqual(js.status_code, 200)
        self.assertIn("text/javascript", js.headers["content-type"])
        self.assertIn("/* ---- zz.js ---- */\n;(function(){try{\nconst askBtn = 1;", js.text)
        self.assertIn('catch(e){console.error("[feature] zz.js", e)}})();', js.text)
        self.assertNotIn("PR_SW", js.text, "*.sw.js는 페이지 번들에서 제외")
        self.assertIn("PR_SW", self.client.get("/features.sw.js").text)
        self.assertIn(".zz { color: red; }", self.client.get("/features.css").text)

        fa = core.feature_assets()
        page = self.client.get(f"/paper/{self.paper_id}").text
        self.assertIn(f'<script defer src="{fa["js"]}" data-features="', page)
        self.assertIn("zz.js", page.split("data-features=")[1].split(">")[0])
        self.assertIn(f'<link rel="stylesheet" href="{fa["css"]}">', page)
        home = self.client.get("/").text
        self.assertIn(fa["js"], home, "홈 화면에도 기능 번들 (library, daily-feed 등)")

    def test_etag_and_versioned_immutable(self):
        self.add_feature_file("zz.js", "window.__zz = 2;")
        etag = core.feature_bundle("js")[2]
        r = self.client.get("/features.js", headers={"If-None-Match": f'"{etag}"'})
        self.assertEqual(r.status_code, 304)
        self.assertIn("immutable", self.client.get(f"/features.js?v={etag}").headers["cache-control"])
        self.assertEqual(self.client.get("/features.js?v=old").headers["cache-control"], "no-cache")

    def test_bundle_rebuilds_when_file_changes(self):
        path = self.add_feature_file("zz.js", "window.__a = 1;")
        first = core.feature_bundle("js")[2]
        path.write_text("window.__a = 2; // 바뀜", encoding="utf-8")
        self.assertNotEqual(core.feature_bundle("js")[2], first)


class TemplateTests(CoreTestCase):
    def test_home_page_loads_shared_scripts(self):
        html = self.client.get("/").text
        self.assertIn('data-page="home"', html)
        for name in ("store.js", "ui.js", "anchor.js", "app.js", "render.js", "style.css"):
            self.assertRegex(html, rf"/static/{name}\?v=\w+")
        self.assertIn('id="home-sections"', html)
        self.assertIn("pr:reading-settings", html, "첫 페인트 전 읽기 설정 스크립트")

    def test_paper_page_landmarks(self):
        html = self.client.get(f"/paper/{self.paper_id}").text
        self.assertIn('data-page="paper"', html)
        self.assertIn(f'data-arxiv-id="{self.paper_id}"', html)
        for frag in ('id="bar-actions"', 'id="bar-more"', 'id="fab-stack"', 'id="back-chip"', 'id="sel-bar"',
                     'id="sheet-pill"', 'id="status-strip"', 'id="sheet-tools"', 'id="presets"', 'id="sr-live"',
                     'role="dialog"', 'aria-live="polite"', "interactive-widget=resizes-content",
                     "window.PREWARM = fetch", "const ARXIV_ID", 'aria-label="음성으로 질문"'):
            self.assertIn(frag, html)
        self.assertNotIn('id="ask-btn"', html)
        # 공용 스크립트는 기능 번들보다 먼저, voice.js는 app.js 다음
        order = [html.index(f"/static/{n}") for n in ("store.js", "ui.js", "anchor.js", "app.js", "voice.js")]
        self.assertEqual(order, sorted(order))
        self.assertLess(order[-1], html.index("/features.js"))
        self.assertLess(html.index("/features.js"), html.index("marked.min.js"), "기능이 CDN 스크립트를 기다리지 않게")
        self.assertNotIn("shouldBeRemoved", html)

    def test_service_worker_and_manifest(self):
        r = self.client.get("/sw.js")
        self.assertEqual(r.status_code, 200)
        self.assertIn("text/javascript", r.headers["content-type"])
        for frag in ("paper-v2", "X-Offline-Cacheable", "/features.js", "/features.css", "importScripts(\"/features.sw.js\")"):
            self.assertIn(frag, r.text)
        manifest = json.loads((core.STATIC_DIR / "manifest.json").read_text())
        self.assertEqual(manifest["id"], "/")
        self.assertEqual(manifest["share_target"]["action"], "/share")


class SharedHelperTests(AsyncCoreTestCase):
    def test_parse_json_loose(self):
        p = core.parse_json_loose
        self.assertEqual(p('```json\n["a","b"]\n```'), ["a", "b"])
        self.assertEqual(p('설명: [1] 참고\n```\n{"x": 1}\n```'), {"x": 1})
        self.assertEqual(p('앞말 {"x": [1, 2]} 뒷말'), {"x": [1, 2]})
        for bad in ("없음", "{깨짐", ""):
            with self.assertRaises(ValueError):
                p(bad)

    def test_safe_id_and_atomic_write(self):
        self.assertEqual(core.safe_id("2401.04088v2"), "2401.04088v2")
        self.assertEqual(core.safe_id("a/b c"), "a_b_c")
        path = self.cache / "sub" / "x.json"
        core.write_json(path, {"한": 1})
        self.assertEqual(core.read_json(path), {"한": 1})
        self.assertEqual(core.update_json(path, lambda v: {**v, "b": 2}), {"한": 1, "b": 2})
        self.assertEqual([p.name for p in path.parent.iterdir()], ["x.json"])
        self.assertEqual(core.read_json(self.cache / "none.json", "fb"), "fb")

    async def test_get_paper_ar5iv_fallback_fetches_once_and_writes_cache(self):
        core.papers.pop("2402.00002", None)
        self.addCleanup(core.papers.pop, "2402.00002", None)
        self.http.route("//arxiv.org/html/2402.00002", "not found", status=404)
        self.http.route("ar5iv.labs.arxiv.org/html/2402.00002", fixture("sample_ltx.html"))
        a, b = await asyncio.gather(core.get_paper("2402.00002"), core.get_paper("2402.00002"))
        self.assertIs(a, b)
        self.assertEqual(len(self.http.calls), 2)  # arXiv 실패 1 + ar5iv 1 (동시 요청은 공유)
        self.assertTrue((self.cache / "2402.00002.json").exists())
        core.papers.pop("2402.00002")
        await core.get_paper("2402.00002")  # 디스크 캐시
        self.assertEqual(len(self.http.calls), 2)

    async def test_paper_index(self):
        idx = await core.paper_index(self.paper_id)
        self.assertIs(idx, await core.paper_index(self.paper_id))
        self.assertIs(await core.paper_soup(self.paper_id), await core.paper_soup(self.paper_id))
        self.assertEqual([s["id"] for s in idx["sections"]], ["S1", "S2", "S2.SS1", "A1"])
        self.assertEqual(idx["sections"][2]["title"], "Training objective")
        self.assertEqual(idx["sections"][2]["tag"], "2.1")
        bib = idx["bib"]
        self.assertEqual(bib["bib.bib1"]["arxiv_id"], "2301.00001")
        self.assertIsNone(bib["bib.bib2"]["arxiv_id"])
        self.assertEqual(bib["bib.bib2"]["title_guess"], "Attention mechanisms revisited.")
        self.assertEqual(bib["bib.bib3"]["doi"], "10.1000/jml.2021.123")
        self.assertEqual(bib["bib.bib4"]["arxiv_id"], "2302.00002")
        figs = {f["id"]: f for f in idx["figures"]}
        self.assertTrue(figs["S2.F2"]["top"])
        self.assertFalse(figs["S2.F2.sf1"]["top"])
        self.assertTrue(figs["S2.F2"]["caption"].startswith("Figure 2:"))
        self.assertEqual(figs["S2.T1"]["kind"], "table")
        self.assertEqual(figs["alg1"]["kind"], "algorithm")
        self.assertIn("https://arxiv.org/html/2401.00001v1/x1.png", idx["img_set"])
        self.assertEqual(idx["code_links"], ["https://github.com/example/sparse-moe"])
        self.assertIn("S1.I1.i1.p1", idx["paras"])

    async def test_el_text_math_and_footnotes(self):
        soup = await core.paper_soup(self.paper_id)
        p1 = soup.find(id="S1.p1")
        text = core.el_text(p1)
        self.assertIn("grows as $x^{2}$ for a model", text)
        self.assertNotIn("trained jointly", text)  # 각주 본문 제외
        self.assertIn("trained jointly", core.el_text(p1, skip_notes=False))

    async def test_fetch_image_allowlist_and_cache(self):
        png = "https://arxiv.org/html/2401.00001v1/x1.png"
        self.http.route("x1.png", b"\x89PNG....", headers={"content-type": "image/png"})
        self.http.route("x3.svg", b"<svg/>", headers={"content-type": "image/svg+xml"})
        with self.assertRaises(HTTPException) as cm:
            await core.fetch_image(self.paper_id, "http://169.254.169.254/latest")
        self.assertEqual(cm.exception.status_code, 400)
        self.assertEqual(self.http.calls, [])
        self.assertEqual(await core.fetch_image(self.paper_id, png), ("image/png", b"\x89PNG...."))
        await core.fetch_image(self.paper_id, png)
        self.assertEqual(len(self.http.calls), 1)
        self.assertIsNone(await core.fetch_image(self.paper_id, "https://arxiv.org/html/2401.00001v1/x3.svg"))


class FixtureCoverageTests(CoreTestCase):
    """공용 픽스처가 모든 기능 브리프가 기대는 구조를 갖췄는지 (기능 브랜치는 이 파일을 고치지 말 것)"""

    def test_fixture_structures(self):
        html = self.paper["html"]
        for frag in ('id="S1"', 'id="S2"', 'id="S2.SS1"', 'id="A1"', 'class="ltx_abstract"',
                     'id="S1.p1"', 'id="S1.I1.i1.p1"', 'class="ltx_itemize"', 'id="S1.p3"',
                     'id="S2.E1"', 'class="ltx_equationgroup', 'id="S2.E2"', 'id="S2.E3"', 'id="S2.Ex1"', 'id="A1.E4"',
                     'alttext="\\displaystyle', 'display="inline"', 'display="block"', 'ltx_tag_equation',
                     'id="S2.F1"', 'id="S2.F2"', 'class="ltx_flex_figure"', 'id="S2.F2.sf1"', "x3.svg", 'class="ltx_picture"',
                     'id="S2.T1"', 'class="ltx_tabular', 'id="alg1"', "ltx_float_algorithm", "ltx_listing",
                     'id="Thmtheorem1"', "ltx_proof", 'href="#bib.bib1"', 'id="bib.bib1"', 'id="bib.bib2"',
                     "arXiv:2301.00001", "https://arxiv.org/abs/2302.00002", "https://doi.org/10.1000/jml.2021.123",
                     "ltx_note ltx_role_footnote", "ltx_note_outer", "https://github.com/example/sparse-moe",
                     'href="#S2.E1"', 'href="#S2.F2.sf1"', 'href="#Thmtheorem1"', 'href="#A1"', "한국어로 작성된 문단"):
            self.assertIn(frag, html)
        self.assertIn("https://arxiv.org/html/2401.00001v1/x1.png", html, "이미지는 절대경로")
        self.assertIn("$x^{2}$", self.paper["text"])


class ArxivTests(AsyncCoreTestCase):
    def test_parse_atom(self):
        entries = core.parse_atom(fixture("arxiv_atom.xml"))
        self.assertEqual([e["id"] for e in entries], ["2301.00001", "2302.00002", "2401.00001"])  # 오류 항목 제외
        e = entries[0]
        self.assertEqual(e["title"], "Sparse Mixtures of Experts for Everyone")
        self.assertEqual(e["version"], "v2")
        self.assertEqual(e["authors"], ["A. Author", "B. Author"])
        self.assertEqual(e["year"], 2023)
        self.assertEqual(e["primary_category"], "cs.LG")
        self.assertEqual(e["doi"], "10.1000/sparse.2023")
        self.assertTrue(e["summary"].startswith("We study sparse mixtures"))
        with self.assertRaises(ValueError):
            core.parse_atom("<not xml")

    async def test_arxiv_query_params_and_errors(self):
        self.http.arxiv()
        out = await core.arxiv_query(id_list=["2301.00001"])
        self.assertEqual(out[0]["id"], "2301.00001")
        self.assertIn("id_list=2301.00001", self.http.calls[0])
        await core.arxiv_query(search='cat:cs.CL', max_results=30, sort_by="submittedDate")
        self.assertIn("sortBy=submittedDate", self.http.calls[1])
        self.assertIn("search_query=cat%3Acs.CL", self.http.calls[1])
        self.http.routes.clear()
        with self.assertRaises(httpx.HTTPError):
            await core.arxiv_query(id_list=["2301.00001"])
        self.http.route("export.arxiv.org", "oops", status=500)
        with self.assertRaises(httpx.HTTPError):
            await core.arxiv_query(id_list=["2301.00001"])

    async def test_throttle_spaces_requests(self):
        self.http.arxiv()
        with mock.patch.object(core, "ARXIV_INTERVAL", 0.05):
            t0 = time.monotonic()
            await asyncio.gather(*(core.arxiv_query(id_list=["2301.00001"]) for _ in range(3)))
            self.assertGreaterEqual(time.monotonic() - t0, 0.09)


class PrewarmTests(CoreTestCase):
    def test_prewarm_once_within_ttl_and_hooks_run(self):
        seen = []

        async def hook(arxiv_id):
            seen.append(arxiv_id)
        core.on_prewarm(hook)
        self.addCleanup(core.PREWARM_HOOKS.remove, hook)
        for _ in range(2):
            self.assertEqual(self.client.post(f"/api/prewarm/{self.paper_id}").json(), {"ok": True})
        self.assertEqual(self.claude.kinds, ["create"])
        self.assertEqual(self.claude.last["max_tokens"], 0)
        for _ in range(50):
            if len(seen) == 2:
                break
            time.sleep(0.01)
        self.assertEqual(seen, [self.paper_id, self.paper_id])


class FeedbackTests(CoreTestCase):
    def test_appends_jsonl(self):
        for vote in ("up", "down"):
            r = self.client.post("/api/feedback", json={"kind": "glossary", "vote": vote, "arxiv_id": self.paper_id,
                                                        "target": "KD", "question": "q" * 1000})
            self.assertEqual(r.json(), {"ok": True})
        lines = (self.cache / "feedback.jsonl").read_text().splitlines()
        self.assertEqual(len(lines), 2)
        rec = json.loads(lines[1])
        self.assertEqual((rec["kind"], rec["vote"], rec["target"]), ("glossary", "down", "KD"))
        self.assertEqual(len(rec["question"]), 300)
        self.assertIn("ts", rec)

    def test_rejects_bad_input(self):
        self.assertEqual(self.client.post("/api/feedback", json={"vote": "meh"}).status_code, 422)
        self.assertEqual(self.client.post("/api/feedback", json={"vote": "up", "kind": "../x"}).status_code, 422)
        self.assertFalse((self.cache / "feedback.jsonl").exists())


class SeedTests(CoreTestCase):
    def test_seed_paper_other_id(self):
        paper = seed_paper("2499.00001")
        self.addCleanup(core.papers.pop, "2499.00001", None)
        r = self.client.get("/paper/2499.00001")
        self.assertEqual(r.status_code, 200)
        self.assertIn("Sparse Mixtures for Everyone", r.text)
        self.assertEqual(paper["title"], "Sparse Mixtures for Everyone: A Test Paper")
