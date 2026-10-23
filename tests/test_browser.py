"""브라우저 테스트: 진짜 서버(가짜 Claude·시드 논문)를 띄우고 tests/browser/*.browser.js 를 node + Playwright로 실행.
node, playwright 모듈(NODE_PATH), Chromium 중 하나라도 없으면 건너뜀. 기능도 tests/browser/<group>.browser.js 를 둘 수 있음
(인자: 서버 포트. /api/ask 등은 page.route로 가로채고, 바깥 네트워크는 막을 것)."""
import shutil
import socket
import subprocess
import threading
import time
import unittest
from pathlib import Path

import uvicorn

from tests.helpers import CoreTestCase, core

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")


@unittest.skipUnless(NODE, "node가 없음")
class BrowserTests(CoreTestCase):
    def start_server(self) -> int:
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        server = uvicorn.Server(uvicorn.Config(core.app, log_level="warning", lifespan="off"))
        thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
        thread.start()

        def stop():
            server.should_exit = True
            thread.join(10)
            sock.close()
        self.addCleanup(stop)
        for _ in range(500):
            if server.started:
                break
            time.sleep(0.01)
        self.assertTrue(server.started, "서버가 뜨지 않음")
        return sock.getsockname()[1]

    def test_browser_files(self):
        if subprocess.run([NODE, "-e", "require.resolve('playwright')"], capture_output=True).returncode:
            self.skipTest("playwright 모듈 없음")
        files = sorted((ROOT / "tests" / "browser").glob("*.browser.js"))
        self.assertTrue(files)
        port = self.start_server()
        for f in files:
            with self.subTest(f.name):
                r = subprocess.run([NODE, str(f), str(port)], cwd=ROOT, capture_output=True, text=True, timeout=300)
                if r.stdout.startswith("SKIP"):
                    self.skipTest(r.stdout.strip())
                self.assertEqual(r.returncode, 0, f"{f.name}\n{r.stdout[-6000:]}\n{r.stderr[-3000:]}")
