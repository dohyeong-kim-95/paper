"""reading-settings: 서버 쪽은 없음 (클라이언트 전용). 기능 번들에 실려 나가는지, 첫 페인트 전 적용 스크립트와
설정 키가 맞는지, 논문을 열어도 Claude를 부르지 않는지만 확인. 동작은 tests/js·tests/browser에서."""
from tests.helpers import CoreTestCase, core


class ReadingSettingsBundleTests(CoreTestCase):
    def setUp(self):
        super().setUp()
        core._bundles.clear()
        self.addCleanup(core._bundles.clear)

    def test_paper_page_applies_settings_before_paint_and_ships_feature(self):
        r = self.client.get(f"/paper/{self.paper_id}")
        self.assertEqual(r.status_code, 200)
        head = r.text.split("</head>")[0]
        # base.html의 첫 페인트 전 스크립트가 이 기능의 키를 읽음 (CSS보다 먼저)
        self.assertIn('localStorage.getItem("pr:reading-settings")', head)
        self.assertLess(head.index("pr:reading-settings"), head.index("style.css"))
        self.assertIn("reading-settings.js", core.feature_assets()["names"])
        self.assertIn("reading-settings.css", core.feature_assets()["names"])
        self.assertEqual(self.claude.calls, [])

    def test_bundles_contain_script_and_styles(self):
        js = self.client.get("/features.js").text
        self.assertIn("/* ---- reading-settings.js ---- */", js)
        self.assertIn('registerFeature(\\"reading-settings\\"', js)
        css = self.client.get("/features.css").text
        for rule in (".rs-peek", "#paper .rs-recolor", "#paper .rs-ovf", "#paper.rs-focus", ".rs-tr-both"):
            self.assertIn(rule, css)
