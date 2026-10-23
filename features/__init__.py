# 기능 패키지. 기능 모듈(features/x.py)이 app보다 먼저 import되어도(예: 테스트가 `from features.x import f`로 시작)
# app이 먼저 끝까지 로드되어 load_feature_routers가 완성된 모듈의 router를 등록하도록 여기서 app을 불러 둠.
# (없으면 순환 import로 반쯤 만들어진 모듈을 보고 router 없이 넘어가 모든 엔드포인트가 404)
import app  # noqa: F401,E402
