---
name: oauth-integration
description: '가비아 사내 서비스에 하이웍스 OAuth 인증을 직접 연동할 때 사용하는 가이드입니다. 로컬(Dev)과 운영/스테이징(Prod, Stage, Gabia) 환경별 클라이언트 등록과 인증 플로우 구현 절차를 다룹니다.'
---

# Gabia Hiworks OAuth Integration Guide

## Overview

가비아 사내 서비스(로컬 앱, 백엔드 서비스 등)에 하이웍스 OAuth 인증을 붙일 때 당신(AI 에이전트)이 따라야 하는 표준 연동 절차입니다.
로컬 환경(Dev)과 운영/스테이징 환경(Prod, Stage, Gabia)은 인증 클라이언트 등록 주체와 방식이 다릅니다.

## When to Use

- 사용자가 "OAuth 연동해줘", "하이웍스 로그인 붙여줘" 라고 할 때
- Coolify 등 외부 인프라에 배포 시 인증 연동이 필요할 때
- 로컬 환경과 프로덕션 환경의 환경 변수(`.env`) 세팅이 필요할 때

## Workflow Instructions

### 1단계: 환경 식별 및 설정 파일 생성

사용자가 구현하려는 서비스의 환경에 맞게 환경변수를 구성하세요.

#### 로컬 개발 환경 (Dev)

로컬 개발 시에는 Dev 환경(`devoffice`)을 사용하며, 클라이언트를 새로 발급받을 필요 없이 사내 공용 Dev 클라이언트를 사용할 수 있습니다.

```env
# .env.local
HIWORKS_PROFILE=dev
HIWORKS_CLIENT_ID=Q6OTXYUFf8QFfNb7K352RqXcZ6rRyDdr
REDIRECT_URI=http://127.0.0.1:3000/auth/callback  # 로컬 포트에 맞게 수정
AUTH_URL=https://auth-api.devoffice.hiworks.com
TOKEN_URL=https://auth-api.devoffice.hiworks.com/oauth/token
ME_URL=https://cache-api.devoffice.hiworks.com/me
```

_주의_: 만약 개발용으로 별도의 클라이언트 등록이 필요하다면, `https://devoffice.hiworks.com`에서 `PHPSESSID` 쿠키를 추출하여 2단계의 등록 API를 찔러야 한다고 사용자에게 안내하세요.

#### 운영/스테이징 환경 (Prod, Stage, Gabia)

프로덕션 환경은 **반드시** 고유한 클라이언트 ID를 발급받아 환경 변수로 주입해야 합니다.

```env
# .env.production (또는 k8s/Coolify secret)
HIWORKS_PROFILE=gabia
HIWORKS_CLIENT_ID={{발급받은_CLIENT_ID}}
HIWORKS_CLIENT_SECRET={{발급받은_CLIENT_SECRET}}
REDIRECT_URI=https://myapp.gabia.com/auth/callback
AUTH_URL=https://auth-api.gabiaoffice.hiworks.com
TOKEN_URL=https://auth-api.gabiaoffice.hiworks.com/oauth/token
ME_URL=https://cache-api.gabiaoffice.hiworks.com/me
```

### 2단계: 클라이언트 등록 (사용자 안내)

Prod, Stage, Gabia 환경에 클라이언트를 등록하려면 사용자의 액션이 필요합니다.
에이전트는 사용자가 직접 cURL을 찌를 수 있도록 다음 안내 메시지를 렌더링하세요.

```markdown
**[운영/스테이징 클라이언트 등록 가이드]**
운영 환경에 연동하려면 브라우저에서 `https://login.gabiaoffice.hiworks.com` 에 로그인한 후, 쿠키에서 `PHPSESSID` 값을 찾아 아래 API를 직접 호출해야 합니다.

curl --location 'https://auth-api.gabiaoffice.hiworks.com/oauth/clients' \
 --header 'Authorization-Type: User' \
 --header 'X-Client-Party: SECOND' \
 --header 'Cookie: PHPSESSID=<당신의\_PHPSESSID>' \
 --header 'Content-Type: application/json' \
 --data '{
"title": "서비스 이름",
"corp_name": "Gabia",
"service_url": "https://서비스도메인",
"legal_term_url": "https://서비스도메인/terms",
"privacy_policy_url": "https://서비스도메인/privacy",
"callback_url": "https://서비스도메인/auth/callback"
}'

결과로 받은 `client_id`와 `client_secrets`를 프로덕션 환경 변수에 등록해주세요.
```

### 3단계: 인증 플로우 코드 작성

서비스(Node.js, Python 등)에 맞게 OAuth 인증 플로우 코드를 작성하세요.
반드시 다음 3가지 순서가 코드로 구현되어야 합니다.

1. **로그인 리다이렉트 (`GET /login`)**:
   - `AUTH_URL/oauth/authorize?response_type=code&client_id=...&redirect_uri=...`
2. **콜백 처리 (`GET /auth/callback`)**:
   - 쿼리스트링으로 받은 `code`를 `TOKEN_URL`로 POST 요청하여 Access Token 교환 (`grant_type=authorization_code`).
3. **사용자 정보 조회 (`GET /me`)**:
   - 발급받은 Access Token을 Bearer 헤더에 담아 `ME_URL`을 호출.
   - 응답받은 `user_no`, `office_user_no`, `roles` 등을 세션이나 JWT에 저장.

## Anti-patterns

- `devoffice` 도메인과 `gabiaoffice` 도메인을 혼용해서 하드코딩하는 행위 (반드시 환경 변수에서 분리)
- `client_secret`을 코드베이스에 하드코딩하는 행위
- `REDIRECT_URI`를 localhost와 실서버 도메인으로 분리하지 않고 작성하는 행위
