"""vocab: 클라이언트 전용 기능 (static/features/vocab.js/.css). 번들·페이지에 실리는지, 서버 쪽 라우트·Claude 호출이 없는지.
동작(저장·간격 반복·홈 복습)은 tests/js/vocab.test.js 와 tests/browser/vocab.browser.js 에서 확인"""
import re

from tests.helpers import CoreTestCase, core


class VocabBundleTests(CoreTestCase):
    def test_bundles_include_vocab(self):
        js = self.client.get("/features.js")
        self.assertEqual(js.status_code, 200)
        self.assertIn("/* ---- vocab.js ---- */", js.text)
        self.assertIn("[feature] vocab.js", js.text)  # 파일별 try/catch: 오류가 나도 다른 기능은 돎
        css = self.client.get("/features.css")
        self.assertIn("/* ---- vocab.css ---- */", css.text)
        self.assertIn(".vo-card", css.text)

    def test_home_and_paper_pages_load_it(self):
        for url in ("/", f"/paper/{self.paper_id}"):
            with self.subTest(url):
                r = self.client.get(url)
                self.assertEqual(r.status_code, 200)
                names = re.search(r'data-features="([^"]*)"', r.text).group(1).split()
                self.assertIn("vocab.js", names)
                self.assertIn("vocab.css", names)

    def test_no_server_side(self):
        # 단어장은 PaperStore(pr:vocab)만 씀: 전용 API 없음, 페이지를 열어도 Claude 호출 없음
        paths = [getattr(r, "path", "") for r in core.app.routes]
        self.assertFalse([p for p in paths if p.startswith("/api/vocab")])
        self.client.get("/")
        self.assertEqual(self.claude.calls, [])
