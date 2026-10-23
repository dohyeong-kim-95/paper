"""daily-feed: 카테고리·저자 피드(1시간 캐시, HTTP 전 검증), 한국어 제목·한 줄 요약(id별 디스크 캐시), 서재 기반 분야 추천"""
import json
from unittest import mock
from urllib.parse import parse_qs, urlsplit

from features import daily_feed as df
from tests.helpers import CoreTestCase, api_error, core


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


def ko_reply(ids) -> str:
    items = [{"id": i, "t": f"제목 {i}", "b": f"요약 {i}"} for i in ids]
    return "```json\n" + json.dumps({"items": items}, ensure_ascii=False) + "\n```"


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


class KoTests(FeedBase):
    def test_korean_titles_and_blurbs(self):
        self.http.arxiv()
        self.claude.push(ko_reply(["2301.00001", "2302.00002", "2401.00001v1", "9999.99999"]))
        r = self.client.get("/api/daily-feed/ko?cat=cs.CL")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers.get("x-offline-cacheable"), "1")
        data = r.json()
        self.assertEqual(set(data), {"2301.00001", "2302.00002", "2401.00001"})  # 모르는 id는 버림, v1은 떼어 냄
        self.assertEqual(data["2302.00002"], {"t": "제목 2302.00002", "b": "요약 2302.00002"})
        self.assertEqual(len(self.claude.calls), 1)
        call = self.claude.last
        self.assert_shared_call(call, paper={"text": call["system"][1]["text"][len("<paper>\n"):-len("\n</paper>")]})
        self.assertIn("[2302.00002] Efficient Expert Routing", call["system"][1]["text"])  # 제목·초록이 '논문' 자리에
        user = self.claude.user_texts()[0]
        self.assertTrue(user.startswith(core.TASK_PREAMBLE))
        self.assertIn("2301.00001, 2302.00002, 2401.00001", user)
        self.assertNotIn("cache_control", call)  # 일회성: system 표시 하나만
        # 디스크 캐시: 다시 불러도 Claude·arXiv 호출 없음
        self.assertEqual(self.client.get("/api/daily-feed/ko?cat=cs.CL").json(), data)
        self.assertEqual(len(self.claude.calls), 1)
        self.assertEqual(len(self.http.calls), 1)
        saved = core.read_json(df.ko_path())
        self.assertEqual(saved["2301.00001"]["t"], "제목 2301.00001")
        self.assertIn("ts", saved["2301.00001"])

    def test_only_missing_papers_are_translated(self):
        core.write_json(df.ko_path(), {"2301.00001": {"t": "이미", "b": "있음", "ts": 1}})
        self.http.arxiv()
        self.claude.push(ko_reply(["2302.00002", "2401.00001"]))
        data = self.client.get("/api/daily-feed/ko?cat=cs.CL").json()
        self.assertEqual(data["2301.00001"], {"t": "이미", "b": "있음"})
        self.assertEqual(len(data), 3)
        user = self.claude.user_texts()[0]
        self.assertNotIn("2301.00001", user)
        self.assertNotIn("2301.00001", self.claude.last["system"][1]["text"])

    def test_chunks_of_ten_run_in_parallel(self):
        self.http.arxiv(atom(25))
        ids = [f"2610.{i:05d}" for i in range(1, 26)]
        self.claude.push(ko_reply(ids), ko_reply(ids), ko_reply(ids))
        data = self.client.get("/api/daily-feed/ko?cat=cs.CL").json()
        self.assertEqual(len(data), 25)
        self.assertEqual(len(self.claude.calls), 3)
        sizes = [len(self.claude.user_texts(c)[0].rsplit("id: ", 1)[1].split(", ")) for c in self.claude.calls]
        self.assertEqual(sorted(sizes), [5, 10, 10])
        for c in self.claude.calls:
            self.assertLessEqual(c["max_tokens"], 250 * 10 + 300)

    def test_bad_json_is_502_remembered_and_retry_bypasses(self):
        self.http.arxiv()
        self.claude.push("요약을 만들 수 없습니다")
        r = self.client.get("/api/daily-feed/ko?cat=cs.CL")
        self.assertEqual(r.status_code, 502)
        self.assertIsNone(core.read_json(df.ko_path()))  # 실패는 저장 안 함
        self.assertEqual(self.client.get("/api/daily-feed/ko?cat=cs.CL").status_code, 502)
        self.assertEqual(len(self.claude.calls), 1)  # 10분 동안 다시 과금하지 않음
        self.claude.push(ko_reply(["2301.00001", "2302.00002", "2401.00001"]))
        r = self.client.get("/api/daily-feed/ko?cat=cs.CL&retry=1")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json()), 3)

    def test_partial_failure_returns_what_succeeded(self):
        self.http.arxiv(atom(15))
        ids = [f"2610.{i:05d}" for i in range(1, 16)]
        self.claude.push(ko_reply(ids), {"error": api_error("down")})
        r = self.client.get("/api/daily-feed/ko?cat=cs.CL")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json()), 10)
        self.client.get("/api/daily-feed/ko?cat=cs.CL")  # 실패한 묶음은 잠시 다시 안 부름
        self.assertEqual(len(self.claude.calls), 2)
        self.claude.push(ko_reply(ids))
        self.assertEqual(len(self.client.get("/api/daily-feed/ko?cat=cs.CL&retry=1").json()), 15)

    def test_truncated_reply_fails(self):
        self.http.arxiv()
        self.claude.push({"text": ko_reply(["2301.00001"]), "stop_reason": "max_tokens"})
        self.assertEqual(self.client.get("/api/daily-feed/ko?cat=cs.CL").status_code, 502)

    def test_ko_validates_before_any_call(self):
        self.assertEqual(self.client.get("/api/daily-feed/ko?cat=cs.CL;x").status_code, 400)
        self.assertEqual(self.client.get("/api/daily-feed/ko", params={"author": "a:b"}).status_code, 400)
        self.assertEqual(self.http.calls, [])
        self.assertEqual(self.claude.calls, [])

    def test_ko_for_author_feed(self):
        self.http.arxiv()
        self.claude.push(ko_reply(["2301.00001", "2302.00002", "2401.00001"]))
        r = self.client.get("/api/daily-feed/ko", params={"author": "Alice Kim"})
        self.assertEqual(len(r.json()), 3)

    def test_disk_map_is_pruned(self):
        old = {f"1{i:03d}.00001": {"t": "t", "b": "b", "ts": i} for i in range(20)}
        core.write_json(df.ko_path(), old)
        self.http.arxiv()
        self.claude.push(ko_reply(["2301.00001", "2302.00002", "2401.00001"]))
        with mock.patch.object(df, "KO_KEEP", 10):
            self.client.get("/api/daily-feed/ko?cat=cs.CL")
        saved = core.read_json(df.ko_path())
        self.assertEqual(len(saved), 10)
        self.assertIn("2401.00001", saved)
        self.assertNotIn("1000.00001", saved)  # 가장 오래된 것부터 버림

    def test_clean_ko(self):
        self.assertEqual(df.clean_ko([{"id": "1", "t": "a", "b": "b"}, {"id": "2", "t": "", "b": "x"}, "z"], {"1", "2"}),
                         {"1": {"t": "a", "b": "b"}})
        with self.assertRaises(ValueError):
            df.clean_ko({"items": [{"id": "x", "t": "a", "b": "b"}]}, {"1"})
        with self.assertRaises(ValueError):
            df.clean_ko({"nope": 1}, {"1"})


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

    def test_failure_is_empty_and_not_cached(self):
        self.assertEqual(self.client.get("/api/daily-feed/suggest?ids=2301.00001").json(), {"cats": []})
        self.http.arxiv()
        self.assertEqual(self.client.get("/api/daily-feed/suggest?ids=2301.00001").json(), {"cats": ["cs.LG"]})

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
        self.assertTrue({"/api/daily-feed", "/api/daily-feed/ko", "/api/daily-feed/suggest"} <= paths, paths)

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
