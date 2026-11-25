---
name: owner
description: 방장 기능. 방 전체 공지와 플러그인 멤버 내보내기. 사용법은 /relay:owner notice <방> <내용> 또는 /relay:owner kick <방> <이름>
argument-hint: 'notice <방> <내용> | kick <방> <이름>'
---

사용자가 `/relay:owner …` 를 실행했다.

- `notice <방> <내용>`: `team_owner` 를 `action: "notice"`, `room`, `text`(나머지 전부)로 호출한다.
- `kick <방> <이름>`: `team_owner` 를 `action: "kick"`, `room`, `name` 으로 호출한다.
- 그 외: 사용법을 안내하고 멈춘다. 참가 코드 발급과 방장 지정, 계정 내보내기는 채팅 페이지에서 한다고 알린다.

"방장이 아닙니다"가 나오면 채팅 페이지에서 방장 지정을 받으라고 안내한다.
