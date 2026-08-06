# 웹훅 미들웨어 설계

2026-08-06

## 목적

모든 웹훅을 한 곳에서 받아, 사용자가 등록한 구독 규칙에 맞는 것만 골라 사용자에게 재발송하는 미들웨어.
1차 소스는 GitLab, 목적지는 Hiworks 차세대메신저. 소스는 이후 확장(Sentry 등).

## 확정 사항

| 항목 | 결정 |
|---|---|
| 웹훅 소스 | GitLab (adapter 구조로 확장 가능하게) |
| 재발송 목적지 | Hiworks 차세대메신저 |
| 메시지 형태 | 포맷팅된 요약 (예: `[a-repo] MR 생성: 제목 (작성자) 링크`) |
| 발송 주체 | 봇/서비스 계정 (토큰은 서버 env) |
| 스택 | Node + Express + better-sqlite3 |
| 배포 | 사내 VM (SQLite 파일 영속 OK, GitLab 도달 가능해야 함) |
| 프론트 | 사용자 제공 HTML + JSON API (JS 연결은 구현 시) |

## 아키텍처

단일 Node 프로세스, 4개 파트:

1. **Auth** — Hiworks OAuth 로그인(프로젝트 로컬 `oauth-integration` 스킬 flow) → 세션 쿠키. 로그인 사용자만 UI/API 접근.
2. **Web UI** — 정적 HTML(로그인, 대시보드) + `/api/subscriptions` CRUD API.
3. **Inbound** — `POST /webhooks/gitlab`. `X-Gitlab-Token` secret 검증. 즉시 200 응답, 처리 비동기.
4. **Dispatcher** — source adapter가 payload를 `(repo, event_type, 요약 메시지)`로 정규화 → 구독 매칭(다수 매칭 시 각각 발송) → 봇 토큰으로 차세대메신저 발송.

소스 추가 = adapter 파일 1개 + 인바운드 라우트 1개.

## 데이터 모델 (SQLite)

- `users` — id, office_no, user_no, name, created_at
- `subscriptions` — id, user_id, source(`gitlab`), repo(프로젝트 경로), event_type, enabled, created_at
- `delivery_logs` — id, subscription_id, summary, status(success/fail), error, created_at

## 이벤트 scope (GitLab)

`object_kind` + action 기반:
- `merge_request.open` / `merge_request.merge` / `merge_request.close` / `merge_request.update`
- `push`
- `pipeline` (failed 중심)
- `issue.open` / `issue.close`
- `note` (댓글)

UI에서 체크박스로 선택. 확정 목록은 구현 시 조정.

## 실패 처리

- 발송 실패: 1회 재시도 후 `delivery_logs`에 실패 기록. 큐 없음(트래픽 낮음, 필요 시 추가).
- 웹훅 수신은 항상 200 (GitLab 재시도 폭주 방지).

## 보안

- 인바운드: GitLab secret token 검증
- UI/API: OAuth 세션
- 봇 토큰: env, 코드/DB에 저장 금지

## 테스트

- 매칭 로직 + 메시지 포맷터 단위 테스트
- GitLab 샘플 payload fixture 기반

## 리스크

- **차세대메신저 봇 발송 API 미확인** — 구현 1단계에서 `hiworks` CLI로 검증. 불가 시 쪽지(memo API) fallback.

## 사용자 제공 필요 항목

- HTML: 로그인 화면, 대시보드(구독 목록 + 추가 폼). 발송 로그 화면은 선택.
- Hiworks OAuth client_id/secret + redirect URI 등록
- 봇 계정 토큰
- 배포 VM 주소
- GitLab 각 repo에 웹훅 URL + secret 등록 (repo 관리자)
