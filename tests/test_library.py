"""library: 클라이언트 전용 기능 (서버 라우트 없음). 번들·페이지 연결과, 인용 표시(CiteSee)에 쓰는
JS의 arXiv id 찾기가 서버 paper_index의 참고문헌 색인과 같은 결과를 내는지 확인"""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

from bs4 import BeautifulSoup

from tests.helpers import CoreTestCase, core, fixture

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")


def js_arxiv_ids(items: list[dict]) -> list:
    """static/features/library.js의 arxivIdOf(text, hrefs)를 node로 실행"""
    code = ("const L = require(process.argv[1]); const items = JSON.parse(process.argv[2]);"
            "console.log(JSON.stringify(items.map(i => L.arxivIdOf(i.text, i.hrefs))));")
    r = subprocess.run([NODE, "-e", code, str(ROOT / "static/features/library.js"), json.dumps(items)],
                       capture_output=True, text=True, timeout=60, check=True)
    return json.loads(r.stdout)


class LibraryBundleTests(CoreTestCase):
    def test_bundle_and_pages_include_library(self):
        core._bundles.clear()
        names = core.feature_assets()["names"]
        self.assertIn("library.js", names)
        self.assertIn("library.css", names)
        js = self.client.get("/features.js").text
        self.assertIn("/* ---- library.js ---- */", js)
        self.assertIn("features/library.js", js)
        self.assertIn(".lib-cite-seen", self.client.get("/features.css").text)
        for url in ("/", f"/paper/{self.paper_id}"):
            with self.subTest(url):
                r = self.client.get(url)
                self.assertEqual(r.status_code, 200)
                self.assertIn("library.js", r.text)

    def test_no_server_routes_or_claude_calls(self):
        # 계약: library는 클라이언트 전용 (/api/library 없음), Claude 호출 없음
        self.assertFalse([r.path for r in core.app.routes if "library" in getattr(r, "path", "")])
        self.client.get("/")
        self.client.get(f"/paper/{self.paper_id}")
        self.assertEqual(self.claude.calls, [])


@unittest.skipUnless(NODE, "node가 없음")
class LibraryCiteIdTests(unittest.TestCase):
    def check(self, html: str) -> dict:
        bib = core.build_index(BeautifulSoup(html, "html.parser"))["bib"]
        items = [{"text": b["text"], "hrefs": b["hrefs"]} for b in bib.values()]
        client = dict(zip(bib, js_arxiv_ids(items)))
        for bib_id, b in bib.items():
            if b["arxiv_id"]:  # 서버가 찾은 id는 클라이언트도 똑같이 찾음 (클라이언트는 CoRR abs/ 등을 더 찾음)
                self.assertEqual(client[bib_id], b["arxiv_id"], bib_id)
        return client

    def test_sample_paper_bibliography(self):
        self.assertEqual(self.check(fixture("sample_ltx.html")),
                         {"bib.bib1": "2301.00001", "bib.bib2": None, "bib.bib3": None, "bib.bib4": "2302.00002"})

    def test_citation_shapes(self):
        self.assertEqual(self.check(fixture("library_bib.html")), {
            "bib.bib1": "2301.00001",   # arXiv:…v3 → 버전 뗌
            "bib.bib2": "2402.11111",   # 링크만 (pdf)
            "bib.bib3": None,           # 쪽 번호·DOI 숫자는 오탐 아님
            "bib.bib4": "2310.12345",   # arXiv DOI
            "bib.bib5": "2205.01068",   # CoRR abs/
            "bib.bib6": "1706.03762",   # abs 링크
        })


if __name__ == "__main__":
    unittest.main()
