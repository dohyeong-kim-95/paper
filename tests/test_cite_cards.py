"""cite-cards: 인용 카드 보강 (arXiv 일괄·제목 검색, Semantic Scholar, Crossref) + GitHub 미리보기. Claude 호출 없음"""
import asyncio
import json
import time
from unittest import mock

import httpx

from features import cite_cards as cc
from tests.helpers import AsyncCoreTestCase, CoreTestCase, core, fixture

S2_BIB1 = {
    "paperId": "abc", "title": "Sparse Mixtures of Experts for Everyone", "venue": "ICML", "year": 2023,
    "citationCount": 42, "tldr": {"model": "tldr@v2", "text": "Two experts per token match dense models."},
    "externalIds": {"ArXiv": "2301.00001", "DOI": "10.1000/sparse.2023"},
    "authors": [{"name": "A. Author"}, {"name": "B. Author"}], "abstract": None,
}
CROSSREF_BIB3 = {"status": "ok", "message": {
    "DOI": "10.1000/jml.2021.123", "title": ["Load Balancing for Learned Routers"],
    "author": [{"given": "E.", "family": "Scholar"}], "container-title": ["Journal of Machine Learning"],
    "issued": {"date-parts": [[2021, 5]]}, "is-referenced-by-count": 7,
    "abstract": "<jats:p>We balance <jats:italic>load</jats:italic> across routers.</jats:p>",
}}


def atom(title: str, aid: str = "2205.01234") -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><entry>
<id>http://arxiv.org/abs/{aid}v1</id><published>2022-05-01T00:00:00Z</published><updated>2022-05-01T00:00:00Z</updated>
<title>{title}</title><summary>An abstract about {title}.</summary><author><name>C. Writer</name></author>
</entry></feed>"""


def js(obj):
    return json.dumps(obj)


EMPTY_FEED = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>ArXiv Query</title><id>http://arxiv.org/api/x</id></feed>"""
ERROR_FEED = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/api/errors#incorrect_id_format_for_2313.00001</id>
<title>Error</title><summary>incorrect id format for 2313.00001</summary></entry></feed>"""


class Base(CoreTestCase):
    def setUp(self):
        super().setUp()
        cc._down.clear()
        self.addCleanup(cc._down.clear)

    def get(self, bib_id):
        return self.client.get(f"/api/cite-cards/{self.paper_id}/{bib_id}")

    def stored(self):
        return core.read_json(core.task_path(self.paper_id, "cite-cards"), None)

    def tearDown(self):
        super().tearDown()
        self.assertEqual(self.claude.calls, [], "cite-cards는 Claude를 부르지 않음")


class CiteCardTests(Base):
    def test_arxiv_entry_enriched_with_one_batch_and_s2(self):
        self.http.arxiv().route("semanticscholar.org/graph/v1/paper/arXiv:2301.00001", js(S2_BIB1))
        r = self.get("bib.bib1")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers.get("x-offline-cacheable"), "1")
        d = r.json()
        self.assertEqual(d["label"], "[1]")
        self.assertIn("Sparse mixtures of experts for everyone", d["bib_text"])
        e = d["enriched"]
        self.assertEqual(e["arxiv_id"], "2301.00001")
        self.assertEqual(e["title"], "Sparse Mixtures of Experts for Everyone")  # arXiv 우선
        self.assertTrue(e["summary"].startswith("We study sparse mixtures"))
        self.assertEqual((e["venue"], e["citations"], e["year"]), ("ICML", 42, 2023))
        self.assertEqual(e["tldr"], "Two experts per token match dense models.")
        self.assertEqual(e["sources"], ["arxiv", "s2"])
        self.assertFalse(d["partial"])
        # 참고문헌의 arXiv id 전부(bib1, bib4)를 한 번의 id_list로
        arxiv_calls = [u for u in self.http.calls if "export.arxiv.org" in u]
        self.assertEqual(len(arxiv_calls), 1)
        self.assertIn("id_list=2301.00001%2C2302.00002", arxiv_calls[0])
        cache = self.stored()
        self.assertEqual(cache["bib.bib4"]["arxiv"]["title"], "Efficient Expert Routing")
        self.assertIn("_batch", cache)

    def test_second_request_served_from_cache_with_zero_http_calls(self):
        self.http.arxiv().route("arXiv:2301.00001", js(S2_BIB1))
        first = self.get("bib.bib1").json()
        n = len(self.http.calls)
        second = self.get("bib.bib1").json()
        self.assertEqual(len(self.http.calls), n)
        self.assertEqual(first, second)

    def test_other_arxiv_entry_reuses_batch(self):
        self.http.arxiv().route("semanticscholar.org", None, status=404)
        self.get("bib.bib1")
        before = len([u for u in self.http.calls if "export.arxiv.org" in u])
        d = self.get("bib.bib4").json()
        after = len([u for u in self.http.calls if "export.arxiv.org" in u])
        self.assertEqual(before, after, "bib4는 첫 탭의 일괄 조회로 이미 캐시됨")
        self.assertEqual(d["enriched"]["arxiv_id"], "2302.00002")
        self.assertEqual(d["enriched"]["sources"], ["arxiv"])  # S2 404 = 없음 (캐시)
        self.assertFalse(d["partial"])

    def test_title_search_dissimilar_title_gives_null(self):
        self.http.arxiv(atom("Completely Different Topic Here")).route("search/match", None, status=404)
        d = self.get("bib.bib2").json()
        self.assertIsNone(d["enriched"])
        self.assertFalse(d["partial"])
        q = next(u for u in self.http.calls if "export.arxiv.org" in u)
        self.assertIn("search_query=ti%3A%22attention+mechanisms+revisited%22", q)
        self.assertIn("max_results=3", q)
        # 없음도 캐시 → 다시 묻지 않음
        n = len(self.http.calls)
        self.assertIsNone(self.get("bib.bib2").json()["enriched"])
        self.assertEqual(len(self.http.calls), n)

    def test_title_search_similar_title_enriches(self):
        self.http.arxiv(atom("Attention Mechanisms: Revisited")).route("search/match", None, status=404)
        e = self.get("bib.bib2").json()["enriched"]
        self.assertEqual(e["arxiv_id"], "2205.01234")
        self.assertEqual(e["authors"], ["C. Writer"])

    def test_s2_title_match_needs_similar_title(self):
        self.http.arxiv(atom("Nothing Alike")).route("search/match", js({"data": [{**S2_BIB1, "title": "Attention Mechanisms Revisited", "externalIds": {}}]}))
        e = self.get("bib.bib2").json()["enriched"]
        self.assertEqual(e["sources"], ["s2"])
        self.assertEqual(e["venue"], "ICML")
        self.cache_dir_reset()
        self.http.routes.clear()
        self.http.arxiv(atom("Nothing Alike")).route("search/match", js({"data": [{**S2_BIB1, "title": "Unrelated"}]}))
        self.assertIsNone(self.get("bib.bib2").json()["enriched"])

    def cache_dir_reset(self):
        core.task_path(self.paper_id, "cite-cards").unlink()

    def test_doi_entry_uses_s2_and_crossref_not_arxiv(self):
        self.http.route("DOI:10.1000/jml.2021.123", js({**S2_BIB1, "title": "Load balancing", "venue": "", "tldr": None,
                                                        "citationCount": 9, "externalIds": {"DOI": "10.1000/jml.2021.123"}}))
        self.http.route("api.crossref.org/works/10.1000/jml.2021.123", js(CROSSREF_BIB3))
        d = self.get("bib.bib3").json()
        e = d["enriched"]
        self.assertFalse(any("export.arxiv.org" in u for u in self.http.calls))
        self.assertEqual(e["title"], "Load Balancing for Learned Routers")  # Crossref가 S2보다 우선
        self.assertEqual(e["venue"], "Journal of Machine Learning")  # S2 venue가 비어 Crossref
        self.assertEqual(e["citations"], 9)  # 인용 수는 S2 먼저
        self.assertEqual(e["summary"], "We balance load across routers.")
        self.assertEqual(e["year"], 2021)
        self.assertEqual(e["authors"], ["E. Scholar"])
        self.assertEqual(sorted(e["sources"]), ["crossref", "s2"])

    def test_unknown_bib_and_paper_404(self):
        self.assertEqual(self.get("bib.bib99").status_code, 404)
        self.assertEqual(self.client.get("/api/cite-cards/2401.99999/bib.bib1").status_code, 404)
        self.assertFalse(any("arxiv.org/api" in u or "semanticscholar" in u for u in self.http.calls))

    def test_network_failure_returns_bib_text_and_caches_nothing(self):
        r = self.get("bib.bib1")  # 모든 외부 요청이 ConnectError
        self.assertEqual(r.status_code, 200)
        d = r.json()
        self.assertIsNone(d["enriched"])
        self.assertTrue(d["partial"])
        self.assertIn("arXiv:2301.00001", d["bib_text"])
        self.assertIsNone(r.headers.get("x-offline-cacheable"))
        self.assertIsNone(self.stored())
        # arXiv는 다음 탭에서 다시 시도 (온라인 복귀), S2는 잠시 쉼
        self.http.arxiv()
        d = self.get("bib.bib1").json()
        self.assertEqual(d["enriched"]["arxiv_id"], "2301.00001")
        self.assertTrue(d["partial"])
        self.assertEqual(sum("semanticscholar" in u for u in self.http.calls), 1)

    def test_s2_rate_limit_marks_down_and_keeps_arxiv(self):
        self.http.arxiv().route("semanticscholar.org", "rate limited", status=429)
        d = self.get("bib.bib1").json()
        self.assertEqual(d["enriched"]["sources"], ["arxiv"])
        self.assertTrue(d["partial"])
        self.assertNotIn("s2", self.stored()["bib.bib1"])
        n = len(self.http.calls)
        self.get("bib.bib4")  # arXiv는 캐시, S2는 쉬는 중 → 외부 호출 0
        self.assertEqual(len(self.http.calls), n)

    def expire_misses(self, src="arxiv"):
        """캐시된 '없음'의 확인 시각을 MISS_TTL보다 오래 전으로"""
        def old(c):
            for k, v in c.items():
                if isinstance(v, dict) and src in v.get("_miss", {}):
                    v["_miss"][src] -= cc.MISS_TTL + 1
            return c
        core.update_json(core.task_path(self.paper_id, "cite-cards"), old, {})

    def test_empty_arxiv_batch_is_not_cached_as_not_found(self):
        for feed in (EMPTY_FEED, ERROR_FEED):  # 일시적인 빈 페이지 / 오류 항목뿐인 피드
            with self.subTest(feed=feed[-40:]):
                self.http.routes.clear()
                core.task_path(self.paper_id, "cite-cards").unlink(missing_ok=True)
                self.http.arxiv(feed).route("semanticscholar.org", None, status=404)
                r = self.get("bib.bib1")
                d = r.json()
                self.assertIsNone(d["enriched"])
                self.assertTrue(d["partial"], "arXiv 결과를 모름 → 부분 응답")
                self.assertIsNone(r.headers.get("x-offline-cacheable"))
                cache = self.stored() or {}
                self.assertFalse(any("arxiv" in v for k, v in cache.items() if k.startswith("bib.")), cache)
                # arXiv 회복 → 다음 탭(bib4)에서 다시 묻고 보강
                self.http.routes.clear()
                self.http.arxiv().route("semanticscholar.org", None, status=404)
                n = sum("export.arxiv.org" in u for u in self.http.calls)
                d4 = self.get("bib.bib4").json()
                self.assertEqual(sum("export.arxiv.org" in u for u in self.http.calls), n + 1)
                self.assertEqual(d4["enriched"]["arxiv_id"], "2302.00002")
                self.assertFalse(d4["partial"])

    def test_id_missing_from_nonempty_batch_is_a_miss_with_ttl(self):
        # 응답에 bib1(2301.00001)만 있고 bib4(2302.00002)는 없음 → bib4만 '없음' (시각과 함께)
        self.http.arxiv(atom("Sparse Mixtures of Experts for Everyone", "2301.00001")).route("semanticscholar.org", None, status=404)
        self.assertEqual(self.get("bib.bib1").json()["enriched"]["arxiv_id"], "2301.00001")
        cache = self.stored()
        self.assertIsNone(cache["bib.bib4"]["arxiv"])
        self.assertLessEqual(abs(cache["bib.bib4"]["_miss"]["arxiv"] - time.time()), 5)
        self.assertEqual(cache["bib.bib1"]["_miss"], {"s2": mock.ANY}, "bib1은 arXiv에서 찾음 (S2 404만 '없음')")
        n = len(self.http.calls)
        d4 = self.get("bib.bib4").json()  # bib4 자신의 S2 조회(404)만
        self.assertFalse(any("export.arxiv.org" in u for u in self.http.calls[n:]), "TTL 안의 '없음'은 다시 묻지 않음")
        self.assertIsNone(d4["enriched"])
        self.assertFalse(d4["partial"])
        n = len(self.http.calls)
        # TTL이 지나면 bib4만 다시 조회 (이미 찾은 bib1은 일괄 조회에 넣지 않음)
        self.expire_misses()
        self.http.routes.clear()
        self.http.arxiv()
        d4 = self.get("bib.bib4").json()
        q = [u for u in self.http.calls[n:] if "export.arxiv.org" in u]
        self.assertEqual(len(q), 1)
        self.assertEqual(httpx.URL(q[0]).params.get("id_list"), "2302.00002")
        self.assertEqual(d4["enriched"]["arxiv_id"], "2302.00002")
        self.assertNotIn("arxiv", self.stored()["bib.bib4"].get("_miss", {}))

    def test_legacy_cached_none_without_timestamp_is_refetched(self):
        core.write_json(core.task_path(self.paper_id, "cite-cards"),
                        {"_batch": 1, "bib.bib1": {"arxiv": None, "s2": None}, "bib.bib4": {"arxiv": None}})
        self.http.arxiv().route("semanticscholar.org", None, status=404)
        d = self.get("bib.bib1").json()
        self.assertEqual(d["enriched"]["arxiv_id"], "2301.00001")
        self.assertEqual(sum("semanticscholar" in u for u in self.http.calls), 1)

    def test_title_search_miss_expires(self):
        self.http.arxiv(EMPTY_FEED).route("search/match", None, status=404)
        self.assertIsNone(self.get("bib.bib2").json()["enriched"])
        self.expire_misses()
        self.http.routes.clear()
        self.http.arxiv(atom("Attention Mechanisms: Revisited")).route("search/match", None, status=404)
        self.assertEqual(self.get("bib.bib2").json()["enriched"]["arxiv_id"], "2205.01234")

    def test_malformed_ids_stay_out_of_the_batch(self):
        idx = asyncio.run(core.paper_index(self.paper_id))
        idx = {**idx, "bib": {**idx["bib"], "bib.bad": {**idx["bib"]["bib.bib4"], "id": "bib.bad", "arxiv_id": "2313.00001"}}}
        self.http.arxiv()
        asyncio.run(cc.arxiv_batch(self.paper_id, idx, "2301.00001"))
        q = next(u for u in self.http.calls if "export.arxiv.org" in u)
        self.assertNotIn("2313.00001", q)
        n = len(self.http.calls)
        self.assertIsNone(asyncio.run(cc.arxiv_batch(self.paper_id, idx, "2313.00001")))
        self.assertEqual(len(self.http.calls), n, "형식이 틀린 id는 arXiv에 묻지 않음")

    def test_short_title_guess_skips_search(self):
        idx = {"bib": {"b": {"id": "b", "title_guess": "Notes.", "arxiv_id": None, "doi": None}}}
        self.assertEqual(cc.title_query(idx["bib"]["b"]), "")
        self.assertEqual(asyncio.run(cc.arxiv_title(idx["bib"]["b"])), None)
        self.assertEqual(self.http.calls, [])


class ArxivQueueTests(AsyncCoreTestCase):
    async def test_deep_queue_fails_fast_without_reserving_a_slot(self):
        with mock.patch.object(core, "ARXIV_INTERVAL", 3.0):
            core._arxiv_next = time.monotonic() + 20  # 다른 기능들로 대기열이 이미 20초
            before = core._arxiv_next
            with self.assertRaises(cc.SourceDown):
                await cc.arxiv_call(id_list=["2301.00001"])
            self.assertEqual(core._arxiv_next, before, "취소될 요청으로 자리를 예약하지 않음")
            self.assertEqual(self.http.calls, [])
            # 대기열이 얕으면 그대로 조회
            self.http.arxiv()
            core._arxiv_next = time.monotonic() + 0.01
            self.assertEqual(len(await cc.arxiv_call(id_list=["2301.00001"])), 3)


class CiteCardConcurrencyTests(AsyncCoreTestCase):
    def setUp(self):
        super().setUp()
        cc._down.clear()

    async def test_concurrent_taps_share_one_arxiv_batch(self):
        self.http.route("export.arxiv.org", lambda url: fixture("arxiv_atom.xml"))
        self.http.route("semanticscholar.org", None, status=404)
        a, b, c = await asyncio.gather(*(cc.cite_card(self.paper_id, x) for x in ("bib.bib1", "bib.bib4", "bib.bib1")))
        self.assertEqual(sum("export.arxiv.org" in u for u in self.http.calls), 1)
        self.assertEqual(json.loads(a.body)["enriched"]["arxiv_id"], "2301.00001")
        self.assertEqual(json.loads(b.body)["enriched"]["arxiv_id"], "2302.00002")
        self.assertEqual(json.loads(c.body), json.loads(a.body))
        cache = core.read_json(core.task_path(self.paper_id, "cite-cards"))
        self.assertEqual(set(k for k in cache if k.startswith("bib.")), {"bib.bib1", "bib.bib4"})


class GithubTests(Base):
    REPO = {"full_name": "example/sparse-moe", "description": "Sparse MoE", "stargazers_count": 1234, "forks_count": 5,
            "language": "Python", "pushed_at": "2026-10-01T00:00:00Z", "topics": ["moe", "llm"], "archived": False,
            "license": {"spdx_id": "MIT"}, "homepage": "javascript:alert(1)"}

    def test_repo_preview_cached(self):
        self.http.route("api.github.com/repos/example/sparse-moe", js(self.REPO))
        r = self.client.get("/api/cite-cards/github", params={"repo": "example/sparse-moe"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers.get("x-offline-cacheable"), "1")
        d = r.json()
        self.assertEqual((d["stars"], d["language"], d["license"]), (1234, "Python", "MIT"))
        self.assertIsNone(d["homepage"], "http(s)가 아닌 홈페이지는 버림")
        self.client.get("/api/cite-cards/github", params={"repo": "Example/Sparse-MoE.git"})
        self.assertEqual(len(self.http.calls), 1, "같은 저장소는 디스크 캐시 (대소문자·.git 무시)")

    def test_rejects_non_repo_input_without_fetching(self):
        for bad in ("example", "../etc/passwd", "a/b/c", "https://evil.example/x", "ex ample/x", "-x/y/../z"):
            self.assertEqual(self.client.get("/api/cite-cards/github", params={"repo": bad}).status_code, 400, bad)
        self.assertEqual(self.http.calls, [])

    def test_missing_repo_404_is_cached(self):
        self.http.route("repos/nobody/none", "{}", status=404)
        for _ in range(3):
            r = self.client.get("/api/cite-cards/github", params={"repo": "nobody/none"})
            self.assertEqual(r.status_code, 404)
            self.assertIsNone(r.headers.get("x-offline-cacheable"))
        self.assertEqual(len(self.http.calls), 1, "없음도 캐시 (비인증 GitHub API는 시간당 60회)")
        # 수명이 지나면 다시 확인 (그새 공개된 저장소)
        path = core.task_path("github", "cite-cards.nobody.none")
        core.write_json(path, {**core.read_json(path), "ts": int(time.time()) - cc.GH_TTL - 1})
        self.http.routes.clear()
        self.http.route("repos/nobody/none", js({**self.REPO, "full_name": "nobody/none"}))
        self.assertEqual(self.client.get("/api/cite-cards/github", params={"repo": "nobody/none"}).json()["full_name"], "nobody/none")
        self.assertEqual(len(self.http.calls), 2)

    def test_missing_repo_404_and_rate_limit_503_then_stale(self):
        self.http.route("repos/nobody/none", "{}", status=404)
        self.assertEqual(self.client.get("/api/cite-cards/github", params={"repo": "nobody/none"}).status_code, 404)
        self.http.route("repos/example/limited", "{}", status=403)
        self.assertEqual(self.client.get("/api/cite-cards/github", params={"repo": "example/limited"}).status_code, 503)
        n = len(self.http.calls)
        self.client.get("/api/cite-cards/github", params={"repo": "example/other"})
        self.assertEqual(len(self.http.calls), n, "제한에 걸리면 잠시 GitHub를 부르지 않음")
        # 오래된 캐시는 GitHub가 안 될 때 그대로 사용
        core.write_json(core.task_path("github", "cite-cards.example.stale"), {"ts": 0, "data": {"full_name": "example/stale"}})
        r = self.client.get("/api/cite-cards/github", params={"repo": "example/stale"})
        self.assertEqual(r.json()["full_name"], "example/stale")


class PureTests(Base):
    def test_similar_and_norm(self):
        self.assertEqual(cc.norm_title("Attention: Mechanisms (Revisited)!"), "attention mechanisms revisited")
        self.assertEqual(cc.norm_title("Scaling $O(n^2)$ attention"), "scaling attention")
        self.assertGreaterEqual(cc.similar("Sparse mixtures of experts for everyone.", "Sparse Mixtures of Experts for Everyone"), 0.9)
        self.assertLess(cc.similar("Attention mechanisms revisited", "Attention is all you need"), 0.9)

    def test_merge_priorities_and_empty(self):
        self.assertIsNone(cc.merge({}))
        self.assertIsNone(cc.merge({"arxiv": None, "s2": None}))
        m = cc.merge({"arxiv": {"title": "A", "summary": "", "venue": None},
                      "s2": {"title": "B", "summary": "S2 abs", "venue": "NeurIPS", "citations": 0, "tldr": "t"}})
        self.assertEqual((m["title"], m["summary"], m["venue"], m["citations"], m["tldr"]), ("A", "S2 abs", "NeurIPS", 0, "t"))

    def test_slim_s2_drops_arxiv_venue(self):
        self.assertIsNone(cc.slim_s2({**S2_BIB1, "venue": "arXiv.org"})["venue"])
        self.assertEqual(cc.slim_s2({"title": "x"})["authors"], [])

    def test_valid_arxiv_id(self):
        for ok in ("2301.00001", "0704.0001", "1412.9999", "1501.00001", "9912.12345"):
            self.assertTrue(cc.valid_arxiv_id(ok), ok)
        for bad in ("2313.00001", "2300.00001", "1501.0001", "1412.00001", "0703.0001", "2301.000011", "", None, "hep-th/9901001"):
            self.assertFalse(cc.valid_arxiv_id(bad), bad)

    def test_known_and_put(self):
        now = time.time()
        e = cc.put({}, {"arxiv": None, "s2": {"title": "x"}}, now)
        self.assertEqual(e["_miss"], {"arxiv": int(now)})
        self.assertTrue(cc.known(e, "arxiv", now) and cc.known(e, "s2", now))
        self.assertFalse(cc.known(e, "arxiv", now + cc.MISS_TTL + 1))
        self.assertTrue(cc.known(e, "s2", now + cc.MISS_TTL + 1), "찾은 메타는 만료 없음")
        self.assertFalse(cc.known(e, "crossref", now))
        self.assertFalse(cc.known({"arxiv": None}, "arxiv", now), "시각 없는 옛 '없음'은 만료")
        self.assertFalse(cc.known({"arxiv": None, "_miss": {"arxiv": "bad"}}, "arxiv", now))
        e2 = cc.put(e, {"arxiv": {"title": "y"}, "s2": None}, now)
        self.assertEqual(e2["arxiv"], {"title": "y"})
        self.assertEqual(e2["s2"], {"title": "x"}, "찾은 메타를 '없음'으로 덮지 않음")
        self.assertNotIn("_miss", e2)
        self.assertEqual(e["_miss"], {"arxiv": int(now)}, "원본은 그대로")

    def test_sources(self):
        self.assertEqual(cc.sources({"arxiv_id": "1", "doi": "d"}), ["arxiv", "s2"])
        self.assertEqual(cc.sources({"arxiv_id": None, "doi": "d"}), ["s2", "crossref"])
        self.assertEqual(cc.sources({"arxiv_id": None, "doi": None}), ["arxiv", "s2"])

    def test_get_json_maps_status(self):
        self.http.route("x.test/404", "", status=404).route("x.test/500", "", status=500).route("x.test/bad", "not json")
        self.http.route("x.test/err", httpx.ReadTimeout("slow"))
        self.assertIsNone(asyncio.run(cc.get_json("https://x.test/404")))
        for u in ("500", "bad", "err", "unrouted"):
            with self.assertRaises(cc.SourceDown):
                asyncio.run(cc.get_json(f"https://x.test/{u}"))
