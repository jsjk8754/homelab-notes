# Particle experience provenance

## User-supplied reference

사용자가 이 프로젝트의 동작·시각 참고 자료로 제공한 로컬 `video-site-replica/dist/`의 세 파일을 확인했다.

| Reference file | SHA-256 | 참고한 범위 |
| --- | --- | --- |
| `particles.js` | `0b9fc501b2fda31624c4d7b4c316f04a186e5836f0bd4cb67c4e5ed14d79e61d` | 하나의 WebGL 입자 풀, 장면별 target geometry, spring·pointer·ripple motion, Canvas 2D fallback |
| `app.js` | `71862e9302280f820c1feb73a7eef73868b136df1cecfa020cd7288db145fce8` | scroll progress, 여섯 장면 상태, 현재 장면 접근성, 장면 내비게이션, 테마와 입력 이벤트 연결 |
| `style.css` | `8e0c6f26b70a6792e7da9883a845afefee49c5ae7371eaa5c389c131fe652fd6` | 전체 화면 고정 canvas, scene overlay, ink/paper 팔레트, 작은 레이블과 넓은 여백, 검색 pill 배치 |

이 폴더에서 해당 소스의 라이선스를 설명하는 파일은 확인하지 못했다. 따라서 라이선스는 **unknown**으로 기록하며, 사용자 제공 및 기술적 출처를 기록하는 것이 사용·재배포 권리를 주장하는 것은 아니다.

## Local adaptation

현재 홈의 실행 경로는 다음 세 파일이다. 사용하지 않는 이전 hero 전용 엔진과 SVG 발행 흐름은 제거했다.

- `assets/js/particles.js` — 전체 viewport에서 유지되는 하나의 입자 풀과 여섯 target geometry
- `assets/js/experience.js` — 스크롤, hash, 장면 접근성, 테마, reduced motion과 renderer lifecycle
- `assets/css/experience.css` — 전체 화면 장면 구성과 향상 전 일반 문서 fallback

참고 소스의 제품 이름, 문구, 폼 동작과 장면 의미는 가져오지 않았다. 로컬 장면은 Homelab Notes의 정보 구조에 맞게 다음 순서로 다시 정의했다.

1. `Alcedo` title
2. network tree
3. project card와 code outline
4. note sheets
5. Hugo·Velog·GitHub publishing flow
6. search pill

입자 좌표는 로컬 DOM 레이아웃과 viewport에서 다시 계산한다. 제목은 자체 호스팅한 Instrument Serif의 `Alcedo`를 샘플링하고, 프로젝트·노트·검색 윤곽은 현재 DOM의 bounding rectangle을 기준으로 만든다. 랜덤 시드, particle budget, scene stops, 모바일 좌표, 색과 public API도 이 사이트에 맞게 별도로 정의한다.

## Continuous-pool contract

여섯 장면은 서로 다른 입자 인스턴스를 만들지 않는다. breakpoint가 바뀌어 pool을 다시 할당하는 경우를 제외하면 같은 particle buffer가 장면 진행값에 따라 다음 target으로 이동한다. 첫 진입에는 입자로 만든 `Alcedo`만 보이고, 헤더와 장면 내비게이션은 intro를 벗어난 뒤 나타난다.

DOM section은 캔버스가 담당하지 않는 제목, 설명, 링크, 검색 입력과 접근성 이름을 제공한다. WebGL을 사용할 수 없으면 Canvas 2D renderer를 시도하고, renderer가 준비되지 않거나 초기화가 실패하면 향상 클래스를 제거해 이 section을 일반 문서 흐름으로 되돌리는 것이 설계 계약이다. reduced motion에서는 animation loop 대신 현재 target의 정적 frame을 사용한다.

## Font licensing

참고 파티클 소스와 사이트 폰트의 출처는 별개다. Instrument Serif와 자체 호스팅한 Noto Serif KR WOFF2 subset은 `static/fonts/`에 각각의 SIL Open Font License 1.1 문서를 포함한다. 이 폰트 라이선스는 참고 파티클 소스에 적용되지 않으며 그 소스의 unknown 라이선스 상태를 바꾸지 않는다.

## Validation status

이 문서는 출처와 구현 의도를 기록한다. 새 revision의 실제 브라우저 렌더링, 여섯 장면 morph의 시각적 일치, 모바일·reduced motion·fallback 동작 및 GitHub Pages 배포는 별도 검증 기록이 생기기 전까지 완료로 주장하지 않는다.
