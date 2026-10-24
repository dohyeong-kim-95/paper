"""offline-save: 같은 출처 그림 프록시, 서비스워커·기능 번들에 확장이 실리는지"""
import unittest

from tests.helpers import CoreTestCase

IMG = "https://arxiv.org/html/2401.00001v1/x1.png"
SVG = "https://arxiv.org/html/2401.00001v1/x3.svg"


class OfflineSaveImageTests(CoreTestCase):
    def get(self, u: str):
        return self.client.get(f"/api/offline-save/img/{self.paper_id}", params={"u": u})

    def test_proxies_paper_image_with_real_bytes(self):
        self.http.route("x1.png", b"\x89PNG-bytes", headers={"content-type": "image/png"})
        r = self.get(IMG)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.content, b"\x89PNG-bytes")
        self.assertEqual(r.headers["content-type"], "image/png")
        self.assertEqual(r.headers["x-content-type-options"], "nosniff")
        # SW가 API 캐시에 한 벌 더 저장하지 않게 (SAVED에만)
        self.assertNotIn("x-offline-cacheable", r.headers)
        self.assertEqual(self.http.calls, [IMG])
        self.assertEqual(self.claude.calls, [], "Claude 호출 없음")

    def test_foreign_or_unknown_url_is_400_without_fetch(self):
        for u in ("https://evil.example/x1.png", "https://arxiv.org/html/2401.00001v1/other.png", "http://127.0.0.1/x"):
            with self.subTest(u=u):
                r = self.get(u)
                self.assertEqual(r.status_code, 400)
        self.assertEqual(self.http.calls, [])

    def test_unsupported_or_failed_image_is_404(self):
        # SVG(지원 안 되는 형식)·네트워크 실패 → 404 → SW가 기본 precache로 넘김
        self.http.route("x3.svg", b"<svg/>", headers={"content-type": "image/svg+xml"})
        self.assertEqual(self.get(SVG).status_code, 404)
        u2 = "https://arxiv.org/html/2401.00001v1/x2.png"  # 등록 안 된 주소 = 네트워크 끊김
        self.assertEqual(self.get(u2).status_code, 404)

    def test_unknown_paper_is_error_without_image_fetch(self):
        r = self.client.get("/api/offline-save/img/2501.99999", params={"u": IMG})
        self.assertGreaterEqual(r.status_code, 400)
        self.assertFalse(any("x1.png" in c for c in self.http.calls), "그림은 받지 않음")

    def test_missing_u_is_422(self):
        self.assertEqual(self.client.get(f"/api/offline-save/img/{self.paper_id}").status_code, 422)


class OfflineSaveAssetTests(CoreTestCase):
    def test_sw_and_extension_bundle(self):
        r = self.client.get("/sw.js")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.headers["content-type"].startswith("text/javascript"))
        self.assertIn("paper-v2", r.text)
        ext = self.client.get("/features.sw.js").text
        self.assertIn("offline-save.sw.js", ext)
        self.assertIn("offline-save:save", ext)
        js = self.client.get("/features.js").text
        self.assertIn("offline-save.js", js)
        self.assertNotIn("/* ---- offline-save.sw.js ---- */", js, "*.sw.js는 페이지 번들에 안 들어감")
        self.assertIn(".os-banner", self.client.get("/features.css").text)

    def test_paper_page_loads_bundle(self):
        r = self.client.get(f"/paper/{self.paper_id}")
        self.assertEqual(r.status_code, 200)
        self.assertIn("offline-save.js", r.text)  # data-features 목록
        self.assertIn('navigator.serviceWorker.register("/sw.js")', r.text)


if __name__ == "__main__":
    unittest.main()
