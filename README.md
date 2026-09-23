# Homelab Notes

[사이트 보기](https://jsjk8754.github.io/homelab-notes/) · [Velog](https://velog.io/@alcedo)

홈랩과 보안 실습을 기술 포트폴리오로 정리하는 Hugo 사이트입니다. 검증된 기술 글과 프로젝트는 이 사이트에, 편하게 읽는 개그톤 이야기는 [Velog @alcedo](https://velog.io/@alcedo)에 올립니다. GitHub 저장소에는 글에서 참조하는 설정, 코드, 재현 절차를 함께 남깁니다.

## 글의 역할

- `content/projects/`: 문제, 선택 근거, 구현, 검증 결과와 한계를 담은 대표 프로젝트
- `content/notes/`: 명령어, 개념, 장애 해결처럼 다시 찾을 기술 노트
- `stories/`: Velog에 직접 게시하기 전 보관하는 개그톤 초안. GitHub Pages에는 표시되지 않습니다.
- `static/`: 공개 이미지와 다운로드 파일. 비밀번호, 토큰, 공인 IP, 내부 호스트 이름처럼 노출하면 안 되는 정보는 넣지 않습니다.

## 처음 설정할 항목

`hugo.toml`에서 다음 값을 확인합니다.

- `baseURL`: 기본값은 `https://jsjk8754.github.io/homelab-notes/`
- `title`: 사이트 이름인 `Homelab Notes`
- `params.author`: `Alcedo`
- `params.velogURL`: `https://velog.io/@alcedo`

저장소 이름이나 개인 도메인을 바꾸면 `baseURL`도 함께 바꿉니다. GitHub Actions 배포에서는 Pages가 알려주는 실제 주소를 빌드에 전달하므로 사용자/프로젝트 Pages의 하위 경로를 모두 지원합니다.

## 로컬에서 쓰기

[Hugo 0.166.0](https://github.com/gohugoio/hugo/releases/tag/v0.166.0)과 Python 3을 준비합니다. 이 사이트는 Hugo extended 기능이나 Node.js 패키지를 요구하지 않습니다.

```sh
make serve
```

초안까지 포함한 미리보기가 열립니다. 새 글은 영문 소문자 슬러그로 만듭니다.

```sh
make new-note SLUG=proxmox-backup-check
make new-project SLUG=homelab-network-segmentation
```

생성된 `content/.../index.md`의 `draft = true`를 유지한 채 작성하고, 공개할 준비가 끝나면 `draft = false`로 바꿉니다. 스크린샷은 계정, 도메인, IP, 토큰, QR 코드가 보이지 않는지 먼저 확인합니다.

## 빌드 검증

```sh
make check
```

검증은 임시 디렉터리에 프로덕션 사이트를 만들고 다음 항목을 확인합니다.

- `/homelab-notes/` 같은 하위 경로에서 내부 링크와 이미지/CSS 파일이 실제로 존재하는지
- 모든 HTML 페이지에 제목과 자기 자신을 가리키는 canonical URL이 있는지
- sitemap URL이 생성 결과와 일치하는지
- `draft = true` 글이 결과물에 포함되지 않았는지
- 홈, 소개, 프로젝트, 노트 페이지가 생성됐는지

Hugo가 다른 위치에 있다면 `HUGO_BIN=/path/to/hugo make check`처럼 지정할 수 있습니다.

## Velog 초안 만들기

도구는 파일만 변환하며 Velog에 로그인하거나 게시하지 않습니다.

```sh
python3 scripts/export-velog.py content/notes/proxmox-backup-check/index.md \
  --output /tmp/proxmox-backup-check.velog.md
```

TOML 또는 YAML front matter를 제거하고, 페이지 번들에 상대 경로로 넣은 이미지·PDF·동영상 링크를 `hugo.toml`의 `baseURL`을 사용한 절대 URL로 바꿉니다. `stories/`처럼 Hugo의 `content/` 밖에 있는 파일이 상대 이미지를 사용한다면 공개될 위치를 명시합니다.

```sh
python3 scripts/export-velog.py stories/backup-disaster.md \
  --article-url https://jsjk8754.github.io/homelab-notes/notes/proxmox-backup-check/ \
  --output /tmp/backup-disaster.velog.md
```

변환된 초안을 읽고 비밀정보와 링크를 다시 확인한 뒤 Velog 편집기에 직접 붙여 넣습니다.

## GitHub Pages 배포

저장소의 **Settings → Pages → Build and deployment → Source**를 **GitHub Actions**로 한 번 설정합니다. 이후 동작은 다음과 같습니다.

- pull request: 사이트 빌드와 전체 링크 검증만 실행
- `main` push: 같은 검증을 통과한 결과만 GitHub Pages에 배포
- 수동 실행: `main`의 Actions 화면에서 필요할 때 재배포

워크플로는 Hugo 릴리스 파일의 SHA-256을 확인하고, 빌드 작업에는 `contents: read`, 배포 작업에만 `pages: write`와 `id-token: write` 권한을 사용합니다. 배포가 실패하면 Actions의 `Build and deploy Hugo site` 실행에서 먼저 `Build and verify site` 단계를 확인합니다.
