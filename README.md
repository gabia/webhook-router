# webhook-middleware

GitLab 웹훅을 수신해 사용자별 규칙에 맞는 이벤트만 Hiworks 메신저+ webhook URL로 재발송하는 미들웨어.

## 실행

```bash
npm install
cp .env.example .env   # 값 채우기
npm start              # http://127.0.0.1:3000
```

Node 22 LTS 이상 필요 (`--env-file` 및 `node --test`의 glob 인자 지원).

## 테스트

```bash
npm test
```

## 설정 흐름

1. 하이웍스 로그인 → 대시보드에서 규칙 생성 (repo 경로, action, 메신저+ webhook URL)
2. GitLab repo → Settings → Webhooks: URL `https://<서버>/webhooks/gitlab`, Secret token은 `.env`의 `GITLAB_WEBHOOK_SECRET`과 동일하게. Trigger는 Issues / Merge requests / Pipelines 체크.
3. 메신저+ 채팅방에서 웹훅 생성해 URL 발급 → 규칙의 전송 대상 URL에 등록.

## 운영 배포 메모

- 운영 OAuth 클라이언트 등록 절차: `.claude/skills/oauth-integration/SKILL.md`
- env를 운영값으로 교체 (`gabiaoffice` 도메인, 발급받은 client_id/secret, 실서버 REDIRECT_URI)
