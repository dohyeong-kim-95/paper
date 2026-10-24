"""entry-routes: /abs·/pdf·/html 리다이렉트, /share 공유 타깃, HTML 없는 논문의 초록 페이지, 하이라이트 공유 API"""
import html
import json
import os
import re
import time
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit

from tests.helpers import CoreTestCase, core
from features import entry_routes as er
from features.entry_routes import find_arxiv_id

ROOT = Path(__file__).resolve().parent.parent

EVIL_ATOM = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2403.00003v1</id>
    <published>2024-03-01T00:00:00Z</published>
    <title>Title &lt;script&gt;alert(1)&lt;/script&gt; with $x^2$</title>
    <summary>Abstract with &lt;img src=x onerror=alert(1)&gt; and $\\alpha$.</summary>
    <author><name>Eve "Quote" O'Neil</name></author>
  </entry>
</feed>"""


class RedirectTests(CoreTestCase):
    def go(self, url):
        r = self.client.get(url, follow_redirects=False)
        self.assertEqual(r.status_code, 307, url)
        return r.headers["location"]

    def test_arxiv_url_swap(self):
        self.assertEqual(self.go("/abs/2401.04088v2"), "/paper/2401.04088v2")
        self.assertEqual(self.go("/pdf/2401.04088.pdf"), "/paper/2401.04088")
        self.assertEqual(self.go("/pdf/2401.04088v3"), "/paper/2401.04088v3")
        self.assertEqual(self.go("/html/2401.04088v1"), "/paper/2401.04088v1")
        self.assertEqual(self.go("/html/2401.04088v1/"), "/paper/2401.04088v1")

    def test_no_id_goes_home_with_error(self):
        loc = self.go("/abs/hello")
        self.assertTrue(loc.startswith("/?"))
        self.assertEqual(parse_qs(urlsplit(loc).query), {"err": ["noid"], "q": ["hello"]})

    def test_share_target(self):
        self.assertEqual(self.go("/share?text=look%20https://arxiv.org/abs/2401.04088"), "/paper/2401.04088")
        self.assertEqual(self.go("/share?url=https%3A%2F%2Farxiv.org%2Fpdf%2F2401.04088v2.pdf"), "/paper/2401.04088v2")
        self.assertEqual(self.go("/share?title=Mixtral&text=arXiv:2401.04088"), "/paper/2401.04088")
        loc = self.go("/share?text=hello")
        self.assertEqual(parse_qs(urlsplit(loc).query), {"err": ["noid"], "q": ["hello"]})
        self.assertEqual(self.go("/share"), "/?err=noid")
        self.assertEqual(self.claude.calls, [])
        self.assertEqual(self.http.calls, [])  # 리다이렉트는 네트워크 없이

    def test_find_arxiv_id_prefers_url_and_strong_forms(self):
        self.assertEqual(find_arxiv_id("https://huggingface.co/papers/2401.04088", "", ""), "2401.04088")
        self.assertEqual(find_arxiv_id("https://www.alphaxiv.org/abs/2401.04088v2"), "2401.04088v2")
        # 글 속 날짜 같은 번호보다 arXiv 주소가 먼저
        self.assertEqual(find_arxiv_id("", "1234.56789 people liked https://arxiv.org/abs/2401.04088"), "2401.04088")
        self.assertEqual(find_arxiv_id("https://example.com/2301.00001", "see arXiv: 2401.04088"), "2401.04088")
        self.assertEqual(find_arxiv_id("", "plain 2401.04088 id"), "2401.04088")
        self.assertIsNone(find_arxiv_id("", "hello", None))

    def test_manifest_share_target(self):
        m = json.loads((ROOT / "static" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(m["id"], "/")
        self.assertEqual(m["scope"], "/")
        st = m["share_target"]
        self.assertEqual((st["action"], st["method"]), ("/share", "GET"))
        self.assertEqual(st["params"], {"title": "title", "text": "text", "url": "url"})

    def test_feature_loaded(self):
        self.assertIn("entry_routes", core.FEATURES)
        self.assertIn("entry-routes.js", core.feature_assets()["names"])


class AbstractPageTests(CoreTestCase):
    def missing(self, aid):
        # arxiv.org/html/<id> 와 ar5iv.labs.arxiv.org/html/<id> 둘 다 404
        self.http.route(f"arxiv.org/html/{aid}", "nope", status=404)

    def test_abstract_page_from_arxiv_api(self):
        self.missing("2301.00001")
        self.http.arxiv()
        r = self.client.get("/paper/2301.00001")
        self.assertEqual(r.status_code, 200)
        self.assertIn('data-page="abstract"', r.text)
        self.assertIn('data-arxiv-id="2301.00001"', r.text)
        self.assertIn("<title>Sparse Mixtures of Experts for Everyone</title>", r.text)
        self.assertIn("A. Author, B. Author", r.text)
        self.assertIn("routing each token to two experts", r.text)
        self.assertIn('href="https://arxiv.org/pdf/2301.00001"', r.text)
        self.assertIn("12 pages, 4 figures", r.text)
        self.assertIn("arXiv:2301.00001v2 · 2023-01-01 · cs.LG", r.text)
        self.assertIn("/features.js", r.text)
        api_calls = [u for u in self.http.calls if "export.arxiv.org" in u]
        self.assertEqual(len(api_calls), 1)
        self.assertIn("id_list=2301.00001", api_calls[0])
        # 두 번째는 디스크 캐시 (arXiv API를 다시 부르지 않음)
        self.assertEqual(self.client.get("/paper/2301.00001").status_code, 200)
        self.assertEqual(len([u for u in self.http.calls if "export.arxiv.org" in u]), 1)
        self.assertTrue(core.task_path("2301.00001", "entry-routes.abs").exists())
        self.assertEqual(self.claude.calls, [])  # 초록 번역·PDF 질문 없음 (Claude 호출 0)

    def test_escapes_arxiv_strings(self):
        self.missing("2403.00003")
        self.http.arxiv(EVIL_ATOM)
        r = self.client.get("/paper/2403.00003")
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("<script>alert", r.text)
        self.assertNotIn("<img src=x", r.text)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", r.text)
        self.assertIn("Eve &quot;Quote&quot; O&#x27;Neil", r.text)
        # 메타데이터 JSON 속성도 이스케이프 (따옴표가 속성을 끝내지 않고, 되돌리면 원래 JSON)
        meta = json.loads(html.unescape(re.search(r'data-er="([^"]*)"', r.text).group(1)))
        self.assertEqual(meta["title"], "Title <script>alert(1)</script> with $x^2$")
        self.assertEqual(meta["authors"], ['Eve "Quote" O\'Neil'])

    def test_version_and_suffix(self):
        self.missing("2301.00001")
        self.http.arxiv()
        r = self.client.get("/paper/2301.00001v2")
        self.assertEqual(r.status_code, 200)
        self.assertIn('href="https://arxiv.org/pdf/2301.00001v2"', r.text)
        r = self.client.get("/paper/2301.00001.pdf", follow_redirects=False)
        self.assertEqual((r.status_code, r.headers["location"]), (307, "/paper/2301.00001"))

    def test_falls_back_to_404_page(self):
        self.missing("2499.99999")
        r = self.client.get("/paper/2499.99999")  # arXiv API도 막힘 (ConnectError)
        self.assertEqual(r.status_code, 404)
        self.assertIn("HTML 버전이 없습니다", r.text)
        self.http.arxiv()  # 픽스처에 없는 id (오류 항목만)
        self.assertEqual(self.client.get("/paper/2499.99999").status_code, 404)
        self.http.calls.clear()
        r = self.client.get("/paper/not-an-id")
        self.assertEqual(r.status_code, 404)
        self.assertFalse([u for u in self.http.calls if "export.arxiv.org" in u])

    def test_seeded_paper_is_not_touched(self):
        r = self.client.get(f"/paper/{self.paper_id}")
        self.assertEqual(r.status_code, 200)
        self.assertIn('data-page="paper"', r.text)
        self.assertEqual(self.http.calls, [])


class ShareApiTests(CoreTestCase):
    ITEMS = [
        {"quote": "routes each token to two experts", "prefix": "model that ", "suffix": ". The", "color": "yellow", "note": "핵심"},
        {"quote": "load balancing loss", "q": "왜 필요해?", "a": "전문가가 **고르게** 쓰이도록"},
    ]

    def setUp(self):
        super().setUp()
        er._hits.clear()
        er._disk["dir"] = None

    def post_raw(self, body):
        # 짝 없는 서로게이트는 ASCII 이스케이프(\udc00)로만 JSON에 실을 수 있음 (브라우저 JSON.stringify와 같게)
        return self.client.post("/api/entry-routes/share", content=json.dumps(body).encode(),
                                headers={"content-type": "application/json"})

    def test_lone_surrogates_are_dropped_not_500(self):
        body = {"arxiv_id": self.paper_id, "title": "T \ud83d", "items": [
            {"quote": "emoji cut \ud83d", "prefix": "\udc00xyz", "note": "메모 😀 ok", "a": "답 \udbff"}]}
        r = self.post_raw(body)
        self.assertEqual(r.status_code, 200, r.text)
        rec = json.loads(next(self.cache.glob("*.entry-routes.share.json")).read_text(encoding="utf-8"))
        item = rec["items"][0]
        self.assertEqual((rec["title"], item["quote"], item["prefix"], item["a"]), ("T ", "emoji cut ", "xyz", "답 "))
        self.assertEqual(item["note"], "메모 😀 ok")  # 온전한 짝은 그대로
        # 반쪽만 있던 인용은 빈 글 → 422
        self.assertEqual(self.post_raw({"arxiv_id": self.paper_id, "items": [{"quote": "\udc00"}]}).status_code, 422)

    def test_rate_limit_per_client(self):
        with mock.patch.object(er, "SHARE_RATE", (2, 600)):
            codes = [self.client.post("/api/entry-routes/share", json={"arxiv_id": self.paper_id, "items": self.ITEMS}).status_code
                     for _ in range(3)]
        self.assertEqual(codes, [200, 200, 429])
        self.assertEqual(len(list(self.cache.glob("*.entry-routes.share.json"))), 2)

    def test_disk_cap_prunes_old_shares_then_refuses(self):
        def post():
            return self.client.post("/api/entry-routes/share", json={"arxiv_id": self.paper_id, "items": self.ITEMS})

        old = self.cache / "oldshare0001.entry-routes.share.json"
        old.write_text("x" * 1900, encoding="utf-8")
        long_ago = time.time() - er.SHARE_KEEP - 86400
        os.utime(old, (long_ago, long_ago))
        with mock.patch.object(er, "SHARE_DISK_MAX", 2000):
            r = post()
            self.assertEqual(r.status_code, 200)  # 상한에 닿아 오래된 공유를 지우고 저장
            self.assertFalse(old.exists())
            (self.cache / "newshare0001.entry-routes.share.json").write_text("x" * 1900, encoding="utf-8")
            er._disk["dir"] = None
            self.assertEqual(post().status_code, 507)  # 최근 공유만으로 꽉 참: 지우지 않고 거절
        self.assertTrue((self.cache / "newshare0001.entry-routes.share.json").exists())
        sid = r.json()["id"]
        self.assertEqual(self.client.get(f"/api/entry-routes/share/{sid}").status_code, 200)

    def test_create_and_read(self):
        r = self.client.post("/api/entry-routes/share", json={"arxiv_id": self.paper_id, "title": "T", "items": self.ITEMS})
        self.assertEqual(r.status_code, 200)
        sid = r.json()["id"]
        self.assertRegex(sid, r"^[A-Za-z0-9_-]{8,32}$")
        self.assertEqual(r.json()["url"], f"/paper/{self.paper_id}#s={sid}")
        g = self.client.get(f"/api/entry-routes/share/{sid}")
        self.assertEqual(g.status_code, 200)
        self.assertEqual(g.headers.get("x-offline-cacheable"), "1")
        data = g.json()
        self.assertEqual((data["arxiv_id"], data["title"]), (self.paper_id, "T"))
        self.assertEqual(data["items"][0]["note"], "핵심")
        self.assertEqual(data["items"][1]["a"], "전문가가 **고르게** 쓰이도록")
        self.assertEqual(data["items"][1]["color"], "")
        # 두 번 만들면 다른 id
        sid2 = self.client.post("/api/entry-routes/share", json={"arxiv_id": self.paper_id, "items": self.ITEMS[:1]}).json()["id"]
        self.assertNotEqual(sid, sid2)
        self.assertEqual(self.claude.calls, [])

    def test_validation(self):
        post = lambda body: self.client.post("/api/entry-routes/share", json=body).status_code  # noqa: E731
        self.assertEqual(post({"arxiv_id": "../etc", "items": self.ITEMS}), 400)
        self.assertEqual(post({"arxiv_id": "x2401.00001", "items": self.ITEMS}), 400)
        self.assertEqual(post({"arxiv_id": self.paper_id, "items": []}), 422)
        self.assertEqual(post({"arxiv_id": self.paper_id, "items": [{"quote": ""}]}), 422)
        self.assertEqual(post({"arxiv_id": self.paper_id, "items": [{"quote": "q", "color": "red;}"}]}), 422)
        big = [{"quote": "q" * 1000, "note": "n" * 4000, "a": "a" * 8000} for _ in range(30)]
        self.assertEqual(post({"arxiv_id": self.paper_id, "items": big}), 413)
        self.assertEqual(list(self.cache.glob("*.entry-routes.share.json")), [])

    def test_read_unknown_or_bad_id(self):
        self.assertEqual(self.client.get("/api/entry-routes/share/abcdefghijkl").status_code, 404)
        self.assertEqual(self.client.get("/api/entry-routes/share/..%2F..%2Fx").status_code, 404)
        self.assertEqual(self.client.get("/api/entry-routes/share/short").status_code, 404)
        (self.cache / "abcdefghijkl.entry-routes.share.json").write_text("not json", encoding="utf-8")
        self.assertEqual(self.client.get("/api/entry-routes/share/abcdefghijkl").status_code, 404)
