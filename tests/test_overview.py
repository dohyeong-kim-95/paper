"""overview: 한눈에 보기 스트림·방법론·prewarm 훅·arXiv 메타·제목 이름 PDF"""
import asyncio
import json
from unittest import mock

import httpx

from features import overview
from tests.helpers import AsyncCoreTestCase, CoreTestCase, PAPER_ID, api_error, core


class OverviewStreamTests(CoreTestCase):
    def url(self, suffix=""):
        return f"/api/overview/{self.paper_id}{suffix}"

    def test_streams_chunks_and_caches(self):
        self.claude.push({"chunks": ["## 3줄 요약\n", "- 하나\n", "## 핵심 질문"]})
        r = self.client.get(self.url())
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.text, "## 3줄 요약\n- 하나\n## 핵심 질문")
        self.assertEqual(r.headers["x-offline-cacheable"], "1")
        path = self.cache / f"{PAPER_ID}.overview.v1.json"
        self.assertEqual(json.loads(path.read_text()), r.text)

        r2 = self.client.get(self.url())  # 두 번째: Claude 호출 없이 같은 본문
        self.assertEqual(r2.text, r.text)
        self.assertEqual(len(self.claude.calls), 1)

    def test_shared_prefix_and_prompt(self):
        self.claude.push({"chunks": ["a", "b", "c"]})
        self.client.get(self.url())
        self.assertEqual(self.claude.kinds, ["stream"])
        self.assert_shared_call()
        self.assertEqual(self.claude.last["max_tokens"], overview.OVERVIEW_TOKENS)
        self.assertNotIn("cache_control", self.claude.last)  # 일회성 작업: 캐시 지점은 system 하나
        prompt = self.claude.user_texts()[0]
        self.assertTrue(prompt.startswith(core.TASK_PREAMBLE))
        for s in ("3줄 요약", "스냅샷", "무엇을 풀려고 하나?", "핵심 아이디어는?", "어떻게 검증했나?", "결과는?",
                  "한계와 남은 문제는?", "| 과제 |", "| 코드 |", '→ "'):
            self.assertIn(s, prompt)
        # 그림 id 목록(최상위 그림·표만)과 결정적 코드 링크
        self.assertIn("- S2.F1: Figure 1: Architecture", prompt)
        self.assertIn("- S2.T1: Table 1:", prompt)
        self.assertNotIn("S2.F2.sf1", prompt)
        self.assertNotIn("alg1", prompt)
        self.assertIn("[[fig:", prompt)
        self.assertIn("https://github.com/example/sparse-moe", prompt)

    def test_api_error_not_cached_then_502_until_retry(self):
        self.claude.push({"chunks": ["## 3줄", " 요약"], "error": api_error(), "error_at": 1}, {"chunks": ["ok"]})
        r = self.client.get(self.url())
        self.assertTrue(r.text.startswith("## 3줄"))
        self.assertTrue(r.text.rsplit("\n", 1)[-1].startswith("[오류]"))
        self.assertFalse((self.cache / f"{PAPER_ID}.overview.v1.json").exists())
        self.assertEqual(self.client.get(self.url()).status_code, 502)  # 기억된 실패: 과금 없이
        self.assertEqual(len(self.claude.calls), 1)
        self.assertEqual(self.client.get(self.url("?retry=1")).text, "ok")
        self.assertEqual(len(self.claude.calls), 2)

    def test_truncation_is_failure(self):
        self.claude.push({"chunks": ["long"], "stop_reason": "max_tokens"})
        self.assertIn("[오류]", self.client.get(self.url()).text)
        self.assertFalse((self.cache / f"{PAPER_ID}.overview.v1.json").exists())

    def test_cache_hit_skips_index_and_corrupt_cache_regenerates(self):
        core.write_json(core.task_path(self.paper_id, overview.OVERVIEW), "cached text")
        with mock.patch.object(core, "paper_index", side_effect=AssertionError("색인 불필요")):
            self.assertEqual(self.client.get(self.url()).text, "cached text")
        core.task_path(self.paper_id, overview.OVERVIEW).write_text("{broken")
        self.claude.push({"chunks": ["new"]})
        self.assertEqual(self.client.get(self.url()).text, "new")
        self.assertIn("3줄 요약", self.claude.user_texts()[0])  # 빈 프롬프트로 생성하지 않음

    def test_unknown_paper_404_without_claude(self):
        self.assertEqual(self.client.get("/api/overview/2499.99999").status_code, 404)
        self.assertEqual(self.claude.calls, [])

    def test_method_stream(self):
        self.claude.push({"chunks": ["### 한 줄 요약\n", "x"]})
        r = self.client.get(self.url("/method"))
        self.assertEqual(r.text, "### 한 줄 요약\nx")
        self.assertTrue((self.cache / f"{PAPER_ID}.overview.method.v1.json").exists())
        self.assert_shared_call()
        self.assertEqual(self.claude.last["max_tokens"], overview.METHOD_TOKENS)
        prompt = self.claude.user_texts()[0]
        for s in ("단계별 설명", "핵심 수식", "$$", "[[fig:", "S2.F1"):
            self.assertIn(s, prompt)
        self.assertEqual(self.client.get(self.url("/method")).text, r.text)
        self.assertEqual(len(self.claude.calls), 1)


class PromptTests(CoreTestCase):
    def test_no_figures_no_code(self):
        idx = {"figures": [], "code_links": []}
        p = overview.overview_prompt(idx)
        self.assertNotIn("[[fig:", p)
        self.assertNotIn("그림 목록", p)
        self.assertIn("'없음'", p)
        self.assertNotIn("[[fig:", overview.method_prompt(idx))

    def test_figure_list_caps(self):
        figs = [{"id": f"S1.F{i}", "kind": "figure", "top": True, "caption": "c" * 300} for i in range(40)]
        lines = overview.figure_list({"figures": figs}).splitlines()
        self.assertEqual(len(lines), 30)
        self.assertLessEqual(len(lines[0]), len("- S1.F0: ") + 100)


class PrewarmHookTests(AsyncCoreTestCase):
    async def wait_file(self, path):
        for _ in range(200):
            if path.exists():
                return True
            await asyncio.sleep(0.01)
        return False

    async def test_hook_starts_generation_in_background(self):
        self.claude.push({"chunks": ["요약 ", "끝"], "delay": 0.01})
        await overview.prewarm_overview(self.paper_id)  # 본문을 안 읽어도 끝까지 생성·저장
        self.assertTrue(await self.wait_file(self.cache / f"{PAPER_ID}.overview.v1.json"))
        self.assertEqual(self.claude.kinds, ["stream"])
        # 화면의 GET은 디스크 적중
        resp = await overview.overview(self.paper_id)
        body = "".join([c if isinstance(c, str) else c.decode() async for c in resp.body_iterator])
        self.assertEqual(body, "요약 끝")
        self.assertEqual(len(self.claude.calls), 1)

    async def test_hook_is_registered_and_swallows_failures(self):
        self.assertIn(overview.prewarm_overview, core.PREWARM_HOOKS)
        await overview.prewarm_overview("2499.99999")  # HTML 없는 논문: 404를 삼킴
        core._failures[(self.paper_id, overview.OVERVIEW)] = (core.time.time(), 502, "x")
        await overview.prewarm_overview(self.paper_id)  # 기억된 실패: 502를 삼킴, 호출 없음
        self.assertEqual(self.claude.calls, [])


class MetaTests(CoreTestCase):
    def test_meta_from_arxiv_cached(self):
        self.http.arxiv()
        r = self.client.get(f"/api/overview/{self.paper_id}v1/meta")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["x-offline-cacheable"], "1")
        m = r.json()
        self.assertEqual((m["id"], m["version"], m["primary_category"]), (PAPER_ID, "v1", "cs.CL"))
        self.assertTrue(m["published"].startswith("2024-01-02"))
        self.assertEqual(m["abs_url"], f"https://arxiv.org/abs/{PAPER_ID}")
        self.assertIn("id_list=2401.00001", self.http.calls[0])
        self.assertEqual(self.client.get(f"/api/overview/{self.paper_id}/meta").json(), m)
        self.assertEqual(len(self.http.calls), 1)  # 디스크 캐시
        self.assertEqual(self.claude.calls, [])

    def test_meta_network_error_not_cached_and_stale_fallback(self):
        r = self.client.get(f"/api/overview/{self.paper_id}/meta")  # 라우트 없음 → ConnectError
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"id": PAPER_ID})
        self.assertNotIn("x-offline-cacheable", r.headers)
        self.assertFalse(core.task_path(PAPER_ID, "overview.meta").exists())
        # 오래된 캐시는 네트워크 실패 때 그대로
        core.write_json(core.task_path(PAPER_ID, "overview.meta"), {"ts": 0, "meta": {"id": PAPER_ID, "version": "v9"}})
        self.assertEqual(self.client.get(f"/api/overview/{self.paper_id}/meta").json()["version"], "v9")

    def test_meta_bad_id(self):
        self.assertEqual(self.client.get("/api/overview/not-an-id/meta").status_code, 400)
        self.assertEqual(self.http.calls, [])


class PdfTests(CoreTestCase):
    def test_pdf_named_by_title(self):
        self.http.route("arxiv.org/pdf/2401.00001", b"%PDF-1.5 fake", headers={"content-type": "application/pdf"})
        r = self.client.get(f"/api/overview/{self.paper_id}/pdf")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.content, b"%PDF-1.5 fake")
        self.assertEqual(r.headers["content-type"], "application/pdf")
        cd = r.headers["content-disposition"]
        self.assertIn('attachment; filename="Sparse Mixtures for Everyone A Test Paper.pdf"', cd)
        self.assertIn("filename*=UTF-8''Sparse%20Mixtures%20for%20Everyone%20A%20Test%20Paper.pdf", cd)

    def test_pdf_failures(self):
        self.assertEqual(self.client.get("/api/overview/xyz/pdf").status_code, 400)
        self.assertEqual(self.client.get(f"/api/overview/{self.paper_id}/pdf").status_code, 502)  # 네트워크 없음
        self.http.route("arxiv.org/pdf/", "<html>captcha</html>")
        self.assertEqual(self.client.get(f"/api/overview/{self.paper_id}/pdf").status_code, 502)

    def test_filename_rules(self):
        self.assertEqual(overview.pdf_filename('A/B: "C"?', "2401.1"), "A B C.pdf")
        self.assertEqual(overview.pdf_filename("", "2401.00001"), "2401.00001.pdf")
        self.assertEqual(len(overview.pdf_filename("x" * 500, "i")), 124)
        cd = overview.content_disposition("한글 제목.pdf")
        self.assertIn('filename="__ __.pdf"', cd)
        self.assertIn("filename*=UTF-8''%ED%95%9C%EA%B8%80%20%EC%A0%9C%EB%AA%A9.pdf", cd)


if __name__ == "__main__":
    import unittest
    unittest.main()
