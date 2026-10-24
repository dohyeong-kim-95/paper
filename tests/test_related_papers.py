"""related-papers: 참고한·비슷한 논문 (arXiv, 7일 캐시), 인용한 논문 (Semantic Scholar), 선택 구절 '관련 연구'"""
import asyncio
import json
import time
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlsplit

import httpx

from features import related_papers as rp
from tests.helpers import PAPER_ID, AsyncCoreTestCase, CoreTestCase, api_error, core, fixture

SEARCH_XML = fixture("related-papers_search.xml")
CITES_JSON = fixture("related-papers_citations.json")


def is_search(url: str) -> bool:
    return "export.arxiv.org" in url and "search_query=" in url


def is_ids(url: str) -> bool:
    return "export.arxiv.org" in url and "id_list=" in url


def query_of(url: str) -> dict:
    return parse_qs(urlsplit(url).query)


class Base(CoreTestCase):
    def setUp(self):
        super().setUp()
        rp._terms.clear()
        rp._search.clear()
        self.addCleanup(rp._terms.clear)
        self.addCleanup(rp._search.clear)

    def route_arxiv(self, search_xml=SEARCH_XML):
        self.http.route(is_ids, fixture("arxiv_atom.xml"), headers={"content-type": "application/atom+xml"})
        self.http.route(is_search, search_xml, headers={"content-type": "application/atom+xml"})

    def cache_file(self, name="related-papers"):
        return core.task_path(PAPER_ID, name)


class PureTests(unittest.TestCase):
    def test_keywords_drop_stopwords_math_and_plural_duplicates(self):
        self.assertEqual(rp.keywords("Sparse Mixtures for Everyone: A Test Paper"), ["sparse", "mixtures", "everyone", "test"])
        self.assertEqual(rp.keywords("Experts and expert routing with $x^2$ via KD"), ["experts", "routing", "kd"])
        self.assertEqual(len(rp.keywords("alpha beta gamma delta epsilon zeta eta theta", 6)), 6)
        self.assertEqual(rp.keywords("The and of a"), [])

    def test_clean_terms_strip_query_syntax(self):
        self.assertEqual(rp.clean_terms(['Mixture of Experts', 'ti:"x" OR (y)', "the of", "", 7, "mixture of experts"]),
                         ["mixture of experts", "ti x or y", "7"])
        self.assertEqual(rp.clean_terms("not a list"), [])
        self.assertEqual(len(rp.clean_terms([f"term{i}" for i in range(9)])), rp.MAX_TERMS)

    def test_build_query_quotes_phrases(self):
        self.assertEqual(rp.build_query(["sparse", "mixture of experts", "top-2"]),
                         '(ti:sparse OR abs:sparse) AND (ti:"mixture of experts" OR abs:"mixture of experts") '
                         'AND (ti:"top-2" OR abs:"top-2")')
        self.assertIn(" OR (ti:b", rp.build_query(["a1", "b"], "OR"))

    def test_parse_citations_sorted_openable_only_new_ids(self):
        rows = rp.parse_citations(json.loads(CITES_JSON))
        self.assertEqual([r["title"] for r in rows],
                         ["A Survey of Mixture of Experts", "Expert Pruning at Scale", "Old Style Id Paper",
                          "Sparse Routers in Production"])
        self.assertEqual([r["id"] for r in rows], ["2501.01234", "2503.04567", None, None])
        self.assertEqual(rows[0]["s2_url"], "https://www.semanticscholar.org/paper/aaa111")
        self.assertEqual(rows[2]["abs_url"], "https://arxiv.org/abs/hep-th/9901001")
        self.assertEqual(rows[3]["doi"], "10.1000/prod.2024")
        with self.assertRaises(ValueError):
            rp.parse_citations([1, 2])


class RelatedTests(Base):
    def test_cited_and_similar(self):
        self.route_arxiv()
        r = self.client.get(f"/api/related-papers/{PAPER_ID}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers.get("x-offline-cacheable"), "1")
        d = r.json()
        cited = [c["id"] for c in d["cited"]]
        self.assertIn("2301.00001", cited)  # 참고문헌 글의 arXiv:2301.00001
        self.assertIn("2302.00002", cited)  # 참고문헌 링크 arxiv.org/abs/2302.00002
        self.assertNotIn(PAPER_ID, cited)
        first = d["cited"][0]
        self.assertEqual((first["id"], first["label"], first["bib_id"], first["cites"]), ("2301.00001", "[1]", "bib.bib1", 1))
        self.assertEqual(first["title"], "Sparse Mixtures of Experts for Everyone")
        similar = [s["id"] for s in d["similar"]]
        self.assertNotIn(PAPER_ID, similar)
        self.assertEqual(similar, ["2305.11111", "2306.22222", "2307.33333"])
        self.assertEqual(d["similar"][0]["authors"], ["G. One", "H. Two", "I. Three"])
        self.assertEqual(d["similar"][0]["n_authors"], 5)
        self.assertEqual(d["terms"], ["sparse", "mixtures", "everyone", "test"])
        self.assertNotIn("error", d)
        self.assertEqual(self.claude.calls, [])  # Claude 호출 없음
        # 한 번의 id_list + 제목 AND 검색 (결과가 3개라 OR 보충 없음)
        ids = [u for u in self.http.calls if is_ids(u)]
        searches = [u for u in self.http.calls if is_search(u)]
        self.assertEqual((len(ids), len(searches)), (1, 1))
        self.assertEqual(query_of(ids[0])["id_list"], ["2301.00001,2302.00002"])
        q = query_of(searches[0])
        self.assertEqual(q["sortBy"], ["relevance"])
        self.assertIn("(ti:sparse OR abs:sparse) AND (ti:mixtures OR abs:mixtures)", q["search_query"][0])
        self.assertTrue(self.cache_file().exists())

    def test_cited_ordered_by_in_text_citations(self):
        soup = core.BeautifulSoup('<p><a href="#bib.b2">2</a><a href="#bib.b2">2</a><a href="#bib.b1">1</a></p>'
                                  '<section class="ltx_bibliography"><a href="#bib.b1">x</a></section>', "html.parser")
        self.assertEqual(rp.cite_counts(soup), {"bib.b2": 2, "bib.b1": 1})

    def test_second_call_within_ttl_makes_no_http(self):
        self.route_arxiv()
        first = self.client.get(f"/api/related-papers/{PAPER_ID}").json()
        n = len(self.http.calls)
        second = self.client.get(f"/api/related-papers/{PAPER_ID}")
        self.assertEqual(len(self.http.calls), n)
        self.assertEqual(second.json(), first)
        self.assertEqual(second.headers.get("x-offline-cacheable"), "1")
        # 7일이 지나면 다시 받음
        core.write_json(self.cache_file(), {**first, "ts": time.time() - rp.TTL - 5})
        self.client.get(f"/api/related-papers/{PAPER_ID}")
        self.assertGreater(len(self.http.calls), n)

    def test_http_error_gives_empty_lists_not_cached(self):
        r = self.client.get(f"/api/related-papers/{PAPER_ID}")  # 등록 안 된 URL → ConnectError
        self.assertEqual(r.status_code, 200)
        d = r.json()
        self.assertEqual((d["cited"], d["similar"]), ([], []))
        self.assertEqual(d["error"], rp.ARXIV_DOWN)
        self.assertIsNone(r.headers.get("x-offline-cacheable"))
        self.assertFalse(self.cache_file().exists())
        # 망이 돌아오면 바로 다시 받음 (실패를 기억하지 않음)
        self.route_arxiv()
        d = self.client.get(f"/api/related-papers/{PAPER_ID}").json()
        self.assertNotIn("error", d)
        self.assertTrue(d["cited"])
        self.assertTrue(self.cache_file().exists())

    def test_status_error_and_partial_failure_not_cached(self):
        self.http.route(is_ids, fixture("arxiv_atom.xml"))
        self.http.route(is_search, "busy", status=503)
        d = self.client.get(f"/api/related-papers/{PAPER_ID}").json()
        self.assertEqual(d["error"], rp.ARXIV_DOWN)
        self.assertEqual(d["similar"], [])
        self.assertIn("2301.00001", [c["id"] for c in d["cited"]])  # 받은 쪽은 보여줌
        self.assertFalse(self.cache_file().exists())

    def test_stale_result_beats_empty_on_error(self):
        old = {"ts": time.time() - rp.TTL - 100, "title": "t", "terms": [], "cited": [{"id": "2301.00001"}], "similar": []}
        core.write_json(self.cache_file(), old)
        r = self.client.get(f"/api/related-papers/{PAPER_ID}")
        d = r.json()
        self.assertTrue(d["stale"])
        self.assertEqual(d["cited"], [{"id": "2301.00001"}])
        self.assertNotIn("error", d)
        self.assertEqual(core.read_json(self.cache_file())["ts"], old["ts"])  # 덮어쓰지 않음

    def test_few_and_hits_broaden_with_or(self):
        only_self = fixture("arxiv_atom.xml")  # 검색 결과: 2301, 2302, 자기 자신 → 2개뿐
        self.route_arxiv(search_xml=only_self)
        d = self.client.get(f"/api/related-papers/{PAPER_ID}").json()
        searches = [query_of(u)["search_query"][0] for u in self.http.calls if is_search(u)]
        self.assertEqual(len(searches), 2)
        self.assertIn(" AND ", searches[0])
        self.assertIn(" OR (ti:", searches[1])
        self.assertEqual([s["id"] for s in d["similar"]], ["2301.00001", "2302.00002"])

    def test_unknown_paper_is_404(self):
        r = self.client.get("/api/related-papers/2999.99999")
        self.assertEqual(r.status_code, 404)
        self.assertFalse(core.task_path("2999.99999", "related-papers").exists())


class ConcurrencyTests(AsyncCoreTestCase):
    async def test_concurrent_requests_share_one_fetch(self):
        self.http.route(is_ids, fixture("arxiv_atom.xml"))
        self.http.route(is_search, SEARCH_XML)
        a, b = await asyncio.gather(rp.related(PAPER_ID), rp.related(PAPER_ID))
        self.assertEqual(json.loads(a.body), json.loads(b.body))
        self.assertEqual(len([u for u in self.http.calls if is_ids(u)]), 1)
        self.assertEqual(len([u for u in self.http.calls if is_search(u)]), 1)


class CitationsTests(Base):
    def url(self):
        return f"/api/related-papers/{PAPER_ID}/citations"

    def test_citing_sorted_and_cached(self):
        self.http.route("api.semanticscholar.org", CITES_JSON, headers={"content-type": "application/json"})
        r = self.client.get(self.url())
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers.get("x-offline-cacheable"), "1")
        d = r.json()
        self.assertEqual([c["citations"] for c in d["citing"]], [120, 45, 45, 7])
        self.assertEqual(d["citing"][0]["id"], "2501.01234")
        self.assertEqual((d["total"], d["more"]), (4, False))
        call = self.http.calls[0]
        self.assertIn("/graph/v1/paper/arXiv:2401.00001/citations", call)
        self.assertEqual(query_of(call)["fields"], ["title,year,externalIds,citationCount"])
        n = len(self.http.calls)
        self.assertEqual(self.client.get(self.url()).json(), d)
        self.assertEqual(len(self.http.calls), n)  # 7일 캐시

    def test_version_id_queries_base_id(self):
        self.http.route("api.semanticscholar.org", CITES_JSON)
        self.client.get(f"/api/related-papers/{PAPER_ID}v2/citations")
        self.assertIn("arXiv:2401.00001/citations", self.http.calls[0])

    def test_errors_not_cached(self):
        for status, code in ((429, "rate_limited"), (404, "not_found"), (500, "network")):
            with self.subTest(status):
                self.http.routes.clear()
                self.http.route("api.semanticscholar.org", "{}", status=status)
                r = self.client.get(self.url())
                self.assertEqual(r.status_code, 200)
                self.assertEqual(r.json(), {"citing": [], "total": 0, "error": code})
                self.assertIsNone(r.headers.get("x-offline-cacheable"))
        self.http.routes.clear()
        self.http.route("api.semanticscholar.org", "not json")
        self.assertEqual(self.client.get(self.url()).json()["error"], "network")
        self.http.routes.clear()  # 망 끊김
        self.assertEqual(self.client.get(self.url()).json()["error"], "network")
        self.assertFalse(self.cache_file("related-papers.citations").exists())

    def test_api_key_header(self):
        seen = {}

        async def get(url, params=None, headers=None, **kw):
            seen["headers"] = headers
            return httpx.Response(200, content=CITES_JSON.encode(), request=httpx.Request("GET", url))

        with mock.patch.dict("os.environ", {"S2_API_KEY": "k"}), mock.patch.object(core.http, "get", get):
            self.client.get(self.url())
        self.assertEqual(seen["headers"], {"x-api-key": "k"})

    def test_bad_id_400(self):
        self.assertEqual(self.client.get("/api/related-papers/nonsense/citations").status_code, 400)
        self.assertEqual(self.http.calls, [])


class PassageTests(Base):
    def test_terms_from_claude(self):
        self.claude.push('```json\n{"terms": ["Knowledge Distillation", "router compression", "mixture of experts"]}\n```')
        text = "Knowledge distillation (KD) compresses the router, and the KD loss is cheap."
        r = self.client.post(f"/api/related-papers/{PAPER_ID}/terms", json={"q": text})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"terms": ["knowledge distillation", "router compression", "mixture of experts"], "ai": True})
        self.assert_shared_call()
        self.assertLessEqual(self.claude.last["max_tokens"], 200)
        self.assertIn(text, self.claude.user_texts()[0])
        self.assertTrue(self.claude.user_texts()[0].startswith(core.TASK_PREAMBLE))
        # 같은 구절은 다시 묻지 않음
        self.client.post(f"/api/related-papers/{PAPER_ID}/terms", json={"q": text})
        self.assertEqual(len(self.claude.calls), 1)

    def test_terms_fallback_on_failure(self):
        text = "The balancing coefficient is set following prior work on load balancing."
        for item in ({"error": api_error()}, "검색어가 없습니다", '{"terms": ["the of"]}',
                     {"text": '{"terms": ["a"', "stop_reason": "max_tokens"}):
            with self.subTest(item=str(item)[:30]):
                self.claude.push(item)
                r = self.client.post(f"/api/related-papers/{PAPER_ID}/terms", json={"q": text})
                self.assertEqual(r.status_code, 200)
                self.assertEqual(r.json(), {"terms": ["balancing", "coefficient", "prior", "load"], "ai": False})
        self.assertEqual(len(self.claude.calls), 4)  # 실패는 기억하지 않음 → 다음에 다시 시도

    def test_terms_validation(self):
        self.assertEqual(self.client.post(f"/api/related-papers/{PAPER_ID}/terms", json={"q": "  a "}).status_code, 400)
        self.assertEqual(self.client.post(f"/api/related-papers/{PAPER_ID}/terms", json={"q": "x" * 7000}).status_code, 422)
        self.assertEqual(self.claude.calls, [])

    def test_search(self):
        self.http.route(is_search, SEARCH_XML)
        url = f"/api/related-papers/{PAPER_ID}/search?t=mixture of experts&t=Routing&t=the"
        d = self.client.get(url).json()
        self.assertEqual(d["terms"], ["mixture of experts", "routing"])
        self.assertEqual([h["id"] for h in d["hits"]], ["2305.11111", "2306.22222", "2307.33333"])  # 자기 자신 제외
        q = query_of(self.http.calls[0])["search_query"][0]
        self.assertEqual(q, '(ti:"mixture of experts" OR abs:"mixture of experts") AND (ti:routing OR abs:routing)')
        n = len(self.http.calls)
        self.assertEqual(self.client.get(url).json(), d)
        self.assertEqual(len(self.http.calls), n)  # 메모리 캐시

    def test_old_style_ids_are_not_openable(self):
        old = SEARCH_XML.replace("http://arxiv.org/abs/2306.22222v1", "http://arxiv.org/abs/hep-th/9901001v1", 1)
        self.http.route(is_search, old)
        hits = self.client.get(f"/api/related-papers/{PAPER_ID}/search?t=routing").json()["hits"]
        self.assertEqual([h["id"] for h in hits], ["2305.11111", None, "2307.33333"])
        self.assertEqual(hits[1]["abs_url"], "https://arxiv.org/abs/hep-th/9901001")  # arXiv 링크는 남김

    def test_valid_new_id(self):
        for good in ("0704.0001", "1412.9999", "1501.00001", "2310.12345"):
            self.assertTrue(rp.valid_new_id(good), good)
        for bad in ("1910.1234", "2013.12345", "2300.12345", "1412.12345", "hep-th/9901001", ""):
            self.assertFalse(rp.valid_new_id(bad), bad)

    def test_empty_id_list_reply_is_error_not_cached(self):
        self.http.route(is_ids, '<feed xmlns="http://www.w3.org/2005/Atom"></feed>')
        self.http.route(is_search, SEARCH_XML)
        d = self.client.get(f"/api/related-papers/{PAPER_ID}").json()
        self.assertEqual(d["error"], rp.ARXIV_DOWN)
        self.assertEqual(d["cited"], [])
        self.assertTrue(d["similar"])
        self.assertFalse(self.cache_file().exists())

    def test_search_errors(self):
        self.assertEqual(self.client.get(f"/api/related-papers/{PAPER_ID}/search?t=the").status_code, 400)
        self.assertEqual(self.client.get(f"/api/related-papers/{PAPER_ID}/search").status_code, 400)
        r = self.client.get(f"/api/related-papers/{PAPER_ID}/search?t=routing")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"terms": ["routing"], "hits": [], "error": rp.ARXIV_DOWN})
        self.http.route(is_search, SEARCH_XML)
        self.assertEqual(len(self.client.get(f"/api/related-papers/{PAPER_ID}/search?t=routing").json()["hits"]), 3)


if __name__ == "__main__":
    unittest.main()
