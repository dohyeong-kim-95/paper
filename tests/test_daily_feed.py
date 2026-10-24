"""daily-feed: 카테고리·저자 피드(1시간 캐시, HTTP 전 검증), 서재 기반 분야 추천. Claude는 부르지 않음 (계약 §8.1)"""
from urllib.parse import parse_qs, urlsplit

from features import daily_feed as df
from tests.helpers import CoreTestCase, core


def atom(n: int, start: int = 1, cat: str = "cs.CL") -> str:
    # n편짜리 Atom 피드 (최근 것부터)
    entries = "".join(f"""
  <entry>
    <id>http://arxiv.org/abs/2610.{start + i:05d}v1</id>
    <updated>2026-10-22T1{i % 10}:00:00Z</updated>
    <published>2026-10-22T1{i % 10}:00:00Z</published>
    <title>Paper number {start + i}</title>
    <summary>Abstract of paper {start + i}. {'word ' * 150}</summary>
    <author><name>Author {i}</name></author><author><name>Second {i}</name></author>
    <author><name>Third {i}</name></author><author><name>Fourth {i}</name></author>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="{cat}"/>
    <category term="{cat}"/>
  </entry>""" for i in range(n))
    return f'<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">{entries}</feed>'


class FeedBase(CoreTestCase):
    def setUp(self):
        super().setUp()
        df.reset()
        self.addCleanup(df.reset)

    def params(self, i=-1):
        return {k: v[0] for k, v in parse_qs(urlsplit(self.http.calls[i]).query).items()}


class FeedTests(FeedBase):
    def test_category_feed(self):
        self.http.arxiv()
        r = self.client.get("/api/daily-feed?cat=cs.CL")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers.get("x-offline-cacheable"), "1")
        data = r.json()
        self.assertIsInstance(data, list)
        self.assertEqual([x["id"] for x in data], ["2301.00001", "2302.00002", "2401.00001"])  # 오류 항목 제외
        first = data[0]
        self.assertEqual(first["title"], "Sparse Mixtures of Experts for Everyone")
        self.assertEqual(first["authors"], ["A. Author", "B. Author"])
        self.assertEqual(first["cat"], "cs.LG")
        self.assertTrue(first["published"].startswith("2023-01-01"))
        self.assertEqual(self.params(), {"search_query": "cat:cs.CL", "sortBy": "submittedDate",
                                         "sortOrder": "descending", "max_results": "30", "start": "0"})
        self.assertEqual(self.claude.calls, [])  # 피드 자체는 Claude를 안 부름

    def test_authors_and_summary_are_clipped(self):
        self.http.arxiv(atom(3))
        data = self.client.get("/api/daily-feed?cat=cs.CL").json()
        self.assertEqual(len(data[0]["authors"]), 3)
        self.assertEqual(data[0]["n_authors"], 4)
        self.assertLessEqual(len(data[0]["summary"]), 401)
        self.assertTrue(data[0]["summary"].endswith("…"))

    def test_bad_category_is_rejected_before_http(self):
        self.http.arxiv()
        for bad in ("cs.CL; drop", "CS.CL", "cs.CL OR cat:x", "cs.CL\n", 'cs.CL"', "a" * 41, ""):
            r = self.client.get("/api/daily-feed", params={"cat": bad})
            self.assertIn(r.status_code, (400, 422), bad)
        self.assertEqual(self.client.get("/api/daily-feed").status_code, 400)
        self.assertEqual(self.http.calls, [])

    def test_valid_category_shapes(self):
        for cat in ("cs.CL", "stat.ML", "q-bio.NC", "physics.comp-ph", "hep-th"):
            self.assertEqual(df.check_cat(cat), cat)

    def test_cached_for_an_hour(self):
        self.http.arxiv()
        self.client.get("/api/daily-feed?cat=cs.CL")
        self.client.get("/api/daily-feed?cat=cs.CL")
        self.assertEqual(len(self.http.calls), 1)  # 두 번째는 HTTP 0회
        self.client.get("/api/daily-feed?cat=cs.LG")
        self.assertEqual(len(self.http.calls), 2)  # 분야마다 따로
        ts, entries = df._feeds["cat:cs.CL"]
        df._feeds["cat:cs.CL"] = (ts - df.TTL - 1, entries)  # 1시간 지남
        self.client.get("/api/daily-feed?cat=cs.CL")
        self.assertEqual(len(self.http.calls), 3)

    def test_failure_without_cache_is_502_and_not_cached(self):
        r = self.client.get("/api/daily-feed?cat=cs.CL")  # 라우트 없음 → ConnectError
        self.assertEqual(r.status_code, 502)
        self.assertNotIn("cat:cs.CL", df._feeds)
        self.http.arxiv()
        self.assertEqual(self.client.get("/api/daily-feed?cat=cs.CL").status_code, 200)

    def test_failure_with_stale_cache_returns_old_list(self):
        self.http.arxiv()
        self.client.get("/api/daily-feed?cat=cs.CL")
        ts, entries = df._feeds["cat:cs.CL"]
        df._feeds["cat:cs.CL"] = (ts - df.TTL - 1, entries)
        self.http.routes.clear()
        self.http.route("export.arxiv.org", "busy", status=503)
        r = self.client.get("/api/daily-feed?cat=cs.CL")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json()), 3)

    def test_empty_result_cached_briefly(self):
        self.http.arxiv(atom(0))
        self.assertEqual(self.client.get("/api/daily-feed?cat=xx.YY").json(), [])
        self.client.get("/api/daily-feed?cat=xx.YY")
        self.assertEqual(len(self.http.calls), 1)
        ts, entries = df._feeds["cat:xx.YY"]
        df._feeds["cat:xx.YY"] = (ts - df.EMPTY_TTL - 1, entries)
        self.client.get("/api/daily-feed?cat=xx.YY")
        self.assertEqual(len(self.http.calls), 2)

    def test_author_feed(self):
        self.http.arxiv()
        r = self.client.get("/api/daily-feed", params={"author": "  Alice   Kim "})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.params()["search_query"], 'au:"Alice Kim"')
        self.assertEqual(self.params()["sortBy"], "submittedDate")
        self.assertEqual(self.client.get("/api/daily-feed", params={"author": "José Müller-Lüdenscheidt"}).status_code, 200)
        self.assertEqual(self.client.get("/api/daily-feed", params={"author": "김철수"}).status_code, 200)

    def test_bad_author_is_rejected_before_http(self):
        self.http.arxiv()
        for bad in ('x" OR cat:cs', "Kim (KAIST)", "au:Kim", "1984", "K", "a" * 61, "Kim\" AND ti:x"):
            self.assertEqual(self.client.get("/api/daily-feed", params={"author": bad}).status_code, 400, bad)
        self.assertEqual(self.http.calls, [])


class SuggestTests(FeedBase):
    def test_primary_categories_ranked(self):
        self.http.arxiv()
        r = self.client.get("/api/daily-feed/suggest?ids=2301.00001,2302.00002v2,2401.00001,bad,../x")
        self.assertEqual(r.json(), {"cats": ["cs.CL", "cs.LG"]})
        p = self.params()
        self.assertEqual(p["id_list"], "2301.00001,2302.00002,2401.00001")
        self.client.get("/api/daily-feed/suggest?ids=2401.00001,2302.00002,2301.00001")  # 같은 집합 → 메모리 캐시
        self.assertEqual(len(self.http.calls), 1)

    def test_no_valid_ids_no_http(self):
        self.assertEqual(self.client.get("/api/daily-feed/suggest?ids=x,y").json(), {"cats": []})
        self.assertEqual(self.client.get("/api/daily-feed/suggest").json(), {"cats": []})
        self.assertEqual(self.http.calls, [])

    def test_failure_is_502_and_not_cached(self):
        # 빈 추천(200 {"cats": []})과 구분해야 클라이언트가 기본값을 저장하지 않고 다음 방문에 다시 물음
        r = self.client.get("/api/daily-feed/suggest?ids=2301.00001")  # 라우트 없음 → ConnectError
        self.assertEqual(r.status_code, 502)
        self.http.route("export.arxiv.org", "busy", status=503)
        self.assertEqual(self.client.get("/api/daily-feed/suggest?ids=2301.00001").status_code, 502)
        self.assertEqual(df._suggest, {})
        self.http.routes.clear()
        self.http.arxiv()
        self.assertEqual(self.client.get("/api/daily-feed/suggest?ids=2301.00001").json(), {"cats": ["cs.LG"]})

    def test_no_matching_papers_is_empty_200(self):
        self.http.arxiv()
        r = self.client.get("/api/daily-feed/suggest?ids=2999.99999")
        self.assertEqual((r.status_code, r.json()), (200, {"cats": []}))

    def test_rank_cats(self):
        entries = [{"primary_category": "cs.CV", "categories": ["cs.CV", "cs.LG"]},
                   {"primary_category": "cs.LG", "categories": ["cs.LG"]},
                   {"primary_category": "I.2.7", "categories": []},
                   {"primary_category": "cs.CV", "categories": ["cs.CV"]}]
        self.assertEqual(df.rank_cats(entries), ["cs.CV", "cs.LG"])


class LoaderTests(FeedBase):
    def test_router_registered(self):
        self.assertIn("daily_feed", core.FEATURES)
        paths = set(core.app.openapi()["paths"])
        self.assertTrue({"/api/daily-feed", "/api/daily-feed/suggest"} <= paths, paths)
        self.assertNotIn("/api/daily-feed/ko", paths)  # 한국어 요약은 범위 밖 (§8.1)

    def test_home_page_bundles_feature(self):
        r = self.client.get("/")
        self.assertEqual(r.status_code, 200)
        self.assertIn("daily-feed.js", r.text)
        self.assertIn("daily-feed.css", r.text)
        js = self.client.get("/features.js").text
        self.assertIn("/* ---- daily-feed.js ---- */", js)
        self.assertIn(".df-card", self.client.get("/features.css").text)


if __name__ == "__main__":
    import unittest
    unittest.main()
