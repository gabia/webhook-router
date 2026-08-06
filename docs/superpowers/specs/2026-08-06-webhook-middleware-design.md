# 웹훅 미들웨어 설계

2026-08-06 (v2 — HTML 목업 + 메신저+ 웹훅 가이드 반영)

## 목적

모든 웹훅을 한 곳에서 받아, 사용자가 등록한 규칙에 맞는 것만 골라 지정한 URL로 재발송하는 미들웨어.
1차 소스는 GitLab(Sentry는 UI만 선반영, 수신은 추후). 주 목적지는 Hiworks 메신저+ incoming webhook URL.

## 확정 사항

| 항목 | 결정 |
|---|---|
| 웹훅 소스 | GitLab 수신 구현. Sentry는 UI 존재, 수신 어댑터 추후 |
| 재발송 목적지 | 규칙당 URL 다중 등록. 메신저+ incoming webhook URL이 주 용도 (봇 토큰 불필요) |
| 발송 포맷 | 메신저+ 형식 `{text, cards}` — text=요약, cards=상세 항목 |
| UI | 사용자 제공 목업(`GitLab 웹훅 필터링 시스템/Webhook Rules.dc.html`) 그대로 전부 구현 |
| 스택 | Node + Express + better-sqlite3 |
| 배포 | 사내 VM (SQLite 파일 영속 OK, GitLab 도달 가능해야 함) |
| 인증 | Hiworks OAuth (프로젝트 로컬 `oauth-integration` 스킬 flow) |

## 아키텍처

단일 Node 프로세스, 4개 파트:

1. **Auth** — Hiworks OAuth 로그인 → 세션 쿠키. 로그인 사용자만 UI/API 접근. 로그인 HTML은 추후 사용자 제공.
2. **Web UI** — 목업 HTML + `/api/rules` CRUD API. 목업은 x-dc/DCLogic 런타임(support.js) 기반으로 이미 전체 인터랙션 동작 — seed 데이터를 API 호출로 교체하는 방식 우선, 런타임이 서빙 환경에서 안 돌면 바닐라 JS 변환.
3. **Inbound** — `POST /webhooks/gitlab`. `X-Gitlab-Token` secret 검증. 즉시 200 응답, 처리 비동기.
4. **Dispatcher** — source adapter가 payload를 `(repo, action, author, 요약)`으로 정규화 → 규칙 매칭 → 메신저+ 포맷으로 각 destination URL에 POST.

소스 추가 = adapter 파일 1개 + 인바운드 라우트 1개.

## 규칙 모델 (목업 기준)

`rules` 테이블:
- id, user_id(소유자)
- name, description
- source (`gitlab` | `sentry`) — 생성 후 변경 불가
- repo (프로젝트 경로 1개)
- actions (JSON 배열): `issue.open/close/update`, `mr.open/merge/close`, `pipeline.success/failed`
- authors (JSON 배열, 빈 배열 = 모든 작성자 허용) — GitLab username 기준 필터
- destinations (JSON 배열, URL 1개 이상)
- active (토글)
- created_at

기타 테이블:
- `users` — id, office_user_no, user_no, name, created_at
- `delivery_logs` — id, rule_id, summary, status(success/fail), error, created_at

UI 부가 기능(목업 포함): 통계 카드(전체/활성/URL 수), 검색, 페이지네이션, 상세 드로어(페이로드 미리보기 포함), 2단계 생성 모달.

## 매칭 로직

GitLab payload → adapter 정규화:
- `object_kind=issue` + action(open/close/update) → `issue.*`
- `object_kind=merge_request` + action(open/merge/close) → `mr.*`
- `object_kind=pipeline` + status(success/failed) → `pipeline.*`
- repo = `project.path_with_namespace`
- author = `user.username`

매칭 조건: `active && source && repo 일치 && action ∈ actions && (authors 비었거나 author ∈ authors)`.
매칭된 규칙마다 각 destination URL로 발송.

## 발송 포맷 (메신저+ 가이드 기준)

```json
{
  "text": "✅ [backend/api-gateway] MR 병합: 제목 (@author)",
  "cards": [{
    "color": "#2EB67D",
    "items": [
      {"label": "프로젝트", "content": "backend/api-gateway"},
      {"label": "작성자", "content": "@author"},
      {"label": "링크", "content": "https://gitlab.../mr/123"}
    ]
  }]
}
```

- 색상: 성공 `#2EB67D`, 정보 `#36C5F0`, 경고 `#ECB22E`, 실패 `#E01E5A`
- 제한: 카드 ≤10, 카드당 항목 ≤10, 전체 ≈5000자 이내

## 실패 처리

- 발송 실패: 1회 재시도 후 `delivery_logs`에 실패 기록. 큐 없음(트래픽 낮음, 필요 시 추가).
- 웹훅 수신은 항상 200 (GitLab 재시도 폭주 방지).

## 보안

- 인바운드: GitLab secret token 검증
- UI/API: OAuth 세션. 규칙은 소유자만 조회/수정
- destination URL은 비밀값에 준함(URL 아는 자는 채팅방에 발송 가능) — 로그에 전체 URL 남기지 않기

## 테스트

- 매칭 로직 + 메신저+ 포맷터 단위 테스트
- GitLab 샘플 payload fixture 기반

## 사용자 제공 필요 항목

- 로그인 화면 HTML (추후)
- Hiworks OAuth: 로컬은 공용 Dev 클라이언트로 즉시 가능, 운영 배포 시 클라이언트 등록
- 배포 VM 주소 (추후)
- GitLab 각 repo에 웹훅 URL + secret 등록 (repo 관리자)
