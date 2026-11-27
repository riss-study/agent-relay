# agent-relay

Claude Code 세션끼리 메시지를 중계하는 서버와 그 플러그인(`plugin/`). 프로토콜은 `docs/wire-protocol.md` 이고 team-relay 플러그인 0.10.2 로도 붙을 수 있다.

## 실행

```sh
npm install
npm start                              # .env 를 읽고 ws://localhost:8765/ws 를 연다
npm test                               # node:test, 실제 소켓으로 왕복 검사
npm run check                          # tsc 타입 검사
npm run user -- add 이메일 비밀번호 [이름]   # 슈퍼관리자 계정을 명령으로 넣거나 비밀번호를 되돌릴 때
```

`.env` 파일(git 에 올라가지 않는다)에 `ADMIN_LOGIN`(이메일), `ADMIN_PASS`, `ADMIN_NAME` 을 적으면 서버가 처음 시작할 때 그 계정을 슈퍼관리자(system_admin)로 user 표에 넣는다. 이미 있으면 건드리지 않으므로 비밀번호는 페이지에서 바꾸고, 잊었으면 `npm run user -- add` 로 되돌린다. 다른 환경변수도 이 파일에 적을 수 있다. 환경변수: `PORT`(8765), `RELAY_HOST`(기본 127.0.0.1, 같은 LAN 에서 평문으로 쓰려면 0.0.0.0), `ADMIN_TOKEN`(관리자 HTTP 에 필요), `RELAY_STATE`(sqlite 파일 경로, 기본 `state.db`), `RELAY_INSTRUCTIONS`(규약 파일, 기본 `server/instructions.md`), `COOKIE_SECURE`(1 이면 로그인 쿠키에 Secure 를 붙인다. TLS 프록시 뒤에서 켠다), `SESSION_TTL_MS`(로그인 유지 시간, 기본 14일), `LOGIN_DELAY_MS`(틀린 로그인의 응답 지연, 기본 1초).

## 채팅 기록 페이지

`http://localhost:8765/chat` 에서 계정으로 로그인하면 내가 속한 방의 기록을 방별 채팅창으로 본다. 방 목록, 날짜 구분, 스레드만 보기, 검색, 다크 모드가 있고 30초마다 새 메시지를 가져온다. 로그인은 DB 의 session 표에 있어서 서버를 재시작해도 유지되고, 14일 동안 안 쓰면 만료된다.

계정과 방은 이렇게 돈다.

- 가입: 페이지에서 이메일, 비밀번호(8자 이상), 이름으로 신청하면 `pending` 상태다. 관리자 이상이 승인해야 로그인된다.
- 역할: `system_admin`(슈퍼관리자)은 모든 방을 보고 승인 없이 들어간다. `admin`(관리자)은 방을 만들고 가입을 승인한다. `member` 는 참가 신청만 한다. 역할은 슈퍼관리자가 바꾼다.
- 방: 관리자 이상이 만들면 방 코드(`RM-XXXX-XXXX`)가 생기고 만든 계정이 방장이다. 방장은 다른 멤버를 방장으로 지정할 수 있고, 지정된 계정은 바로 참가된다. 방 코드는 방장과 슈퍼관리자만 본다.
- 참가: 방 코드를 입력하면 참가 신청이 들어가고 방장이 승인하면 들어온다. 참가와 나가기는 history 에 kind `join`, `leave` 로 남아 채팅창에 보이고, 구간은 membership_log 에 쌓인다. 기록은 내가 그 방에 있었던 구간 안의 것만 보인다.
- 플러그인: 참가 중인 방에서 "플러그인 참가 코드"를 받아 Claude Code 에서 `/agent-relay:join` 하면 그 이름의 멤버가 된다. 이름 칸을 비우면 계정 이름이고, 세션마다 다른 이름("이경환 노트북")을 적으면 계정 하나가 멤버 여럿을 가져서 같은 계정의 Claude 세션끼리도 대화한다(user_member 표). 같은 이름으로 다시 코드를 받으면 기존 멤버에 방만 더해져 다른 PC 에서 토큰 없이 참가해도 같은 신원이다. 방의 다른 사람이 쓰는 이름은 코드가 나오지 않는다. 방장 계정의 멤버가 플러그인으로 들어오면 플러그인 쪽 방장이 아직 그 계정의 멤버가 아닐 때 그 멤버로 바뀐다.
- 나가기: 기록은 지우지 않는다. 나간 방은 "나간 방" 묶음에 남아 참가했던 구간의 기록을 그대로 볼 수 있고, 플러그인에서는 그 방이 빠진다. 다시 들어오려면 방 코드로 신청하고 방장 승인을 받는다. 방장이 계정을 내보내도 같은 길이다.
- 관리: 슈퍼관리자는 계정 목록에서 역할을 바꾸고, 임시 비밀번호를 정하고(그 계정은 다음 로그인 때 바꿔야 한다), 각 계정의 플러그인 멤버(이름, 들어간 방, 접속 여부)를 보고 토큰을 폐기한다. 관리자는 가입을 승인하고 멤버 계정을 비활성화한다(로그인이 막히고 플러그인 토큰이 모두 폐기된다. 복구할 수 있다). 자기 멤버는 누구나 폐기할 수 있다. 방장은 방 패널에서 계정을 내보내거나, 플러그인 멤버 하나만 내보내거나(계정의 방 참가는 그대로다), 방 코드를 재발급하거나, 방을 보관한다. 보관된 방은 모두가 나가지고 슈퍼관리자만 보며 복원할 수 있다.
- 이력: 가입, 로그인과 실패, 승인, 역할, 비밀번호, 방 생성과 보관, 내보내기, 토큰 폐기 같은 행위는 audit 표에 누가 언제 무엇을 했는지 남고 슈퍼관리자가 "관리 이력"에서 본다. 메시지 기록에는 보낸 시점의 이름이 같이 저장되어 멤버가 방에서 빠지거나 토큰이 폐기된 뒤에도 이름이 보인다.
- 보안: 비밀번호는 scrypt, 세션 토큰은 sha256 해시로만 저장한다. 쿠키는 HttpOnly 와 SameSite=Strict 이고 POST 는 JSON 본문과 같은 출처(sec-fetch-site)만 받아 폼 전송으로는 못 부른다. 본문은 64KB 까지다. 로그인은 아이디당 10분에 5번 틀리면 잠기고 IP 당 10분에 30번까지, 가입은 IP 당 한 시간에 5번까지다. 페이지는 CSP(인라인 스크립트 해시), nosniff, frame 거부 헤더를 받는다. 관리자 HTTP 토큰은 상수 시간으로 비교한다.

## 관리자 HTTP

전부 POST 이고 JSON 본문과 `authorization: Bearer $ADMIN_TOKEN` 헤더를 받는다. 플러그인에는 없는 운영 기능이다.

```sh
# 초대코드 발급. owner:true 면 참가자가 그 방의 방장이 된다
curl -X POST -H "authorization: Bearer $ADMIN_TOKEN" \
  -d '{"room":"web3","name":"규영","owner":true}' localhost:8765/admin/invite
# 방장 바꾸기
curl -X POST -H "authorization: Bearer $ADMIN_TOKEN" -d '{"room":"web3","name":"규영"}' localhost:8765/admin/owner
# 토큰 폐기. 그 사람을 모든 방에서 지우고 열린 세션에 revoked 를 보내 끊는다. 다시 쓰려면 새 초대코드로 참가한다
curl -X POST -H "authorization: Bearer $ADMIN_TOKEN" -d '{"room":"web3","name":"규영"}' localhost:8765/admin/revoke
```

받은 `TR-` 코드로 플러그인에서 `/agent-relay:join` 한다. 코드는 1회용이고 72시간 뒤 만료된다.

## 외부망 배포

서버는 평문 웹소켓만 열고 기본으로 127.0.0.1 에만 묶인다. 외부에서 쓰려면 TLS 를 종료하는 프록시를 앞에 두고, 팀원에게는 참가 주소를 `wss://relay.example.com` 처럼 스킴까지 적어 주라고 안내한다(플러그인은 스킴이 없으면 `ws://` 를 붙인다). Caddy 면 아래 두 줄이면 인증서까지 자동이다.

```
relay.example.com {
    reverse_proxy 127.0.0.1:8765
}
```

집 회선처럼 통신사가 80 과 443 을 막는 곳에서는 다른 포트로 열고 인증서는 DNS 방식으로 받는다. 지금 서버가 이 구성이다. `caddy add-package github.com/caddy-dns/duckdns` 로 모듈을 넣고, 토큰은 `~/.config/agent-relay/duckdns.env` 에 두고 `caddy run --envfile` 로 읽힌다. 공유기는 외부 8443 을 이 PC 의 8443 으로 보낸다. 참가 주소는 `wss://agent-relay.duckdns.org:8443` 이다.

```
agent-relay.duckdns.org:8443 {
    tls {
        dns duckdns {env.DUCKDNS_TOKEN}
    }
    reverse_proxy 127.0.0.1:8765
}
```

`/admin/*` 도 같은 주소로 노출되니 `ADMIN_TOKEN` 은 길게 둔다. 프록시의 유휴 끊김 시간은 플러그인 하트비트(30초)보다 길게 둔다.

## 플러그인

`plugin/` 이 Claude Code 플러그인이다. 의존성 없이 Node 24 가 `plugin/server.ts` 를 바로 실행하는 MCP stdio 서버이고, 팀 메시지는 `notifications/claude/channel` 알림으로 세션에 들어간다. 저장소 루트의 `.claude-plugin/marketplace.json` 이 마켓플레이스라 GitHub 저장소(`riss-study/agent-relay`)를 등록하면 설치된다. 로컬에서 개발할 때는 저장소 경로를 대신 적어도 된다.

```text
/plugin marketplace add riss-study/agent-relay
/plugin install agent-relay@agent-relay
```

`/plugin install agent-relay --marketplace riss-study/agent-relay` 한 줄로도 된다(Claude Code 2.1.275 이상). 팀 세션은 `AGENT_RELAY_TEAM=1 claude --dangerously-load-development-channels plugin:agent-relay@agent-relay` 로 켠다. 이 환경변수가 없는 세션은 서버에 붙지 않고 도구가 안내문만 돌려준다. 설정 파일은 `~/.claude/channels/relay/config.json`(`AGENT_RELAY_CONFIG` 로 바꿈)이고 파일 하나가 멤버 하나다. 도구는 team_join, team_send, team_reply, team_ack, team_status, team_doctor, team_room, team_away, team_history, team_agree, team_memory, team_owner, team_server 열세 개이고 슬래시 명령은 `/agent-relay:join`, `status`, `room`, `away`, `doctor`, `server`, `owner` 다. 팀원 쪽 절차는 `docs/claude-code-guide.md` 에 있다.

## 파일

- `server/relay.ts`: 서버 전부. 위에서 아래로 설정값, 저장 상태, 접속 상태, 도우미, 요청 처리, 주기 작업, 관리자 HTTP, 시작 순서다. 구역마다 주석이 있다.
- `server/frames.ts`: 플러그인과 주고받는 프레임 타입. 런타임 코드가 없어 플러그인 쪽에서도 그대로 import 할 수 있다.
- `server/web.ts`: 페이지 HTTP 라우터. 경로마다 권한을 보고 아래 모듈을 부른다. 경로 목록과 보안 규칙은 파일 머리 주석에 있다.
- `server/schema.ts`: 페이지 쪽 표와 마이그레이션. 버전 목록에 항목을 뒤에 붙이면 다음 시작 때 한 번 돈다.
- `server/account.ts`: 계정, 비밀번호, 역할, 로그인 세션, 시도 제한, 관리 이력(audit).
- `server/rooms.ts`: 방, 방 소속과 참가 구간, 계정에 묶인 플러그인 멤버, 참가 코드.
- `server/view.ts`: 페이지가 가져가는 자료 한 덩어리. 누가 무엇을 보는지가 여기 있다.
- `server/user.ts`: 슈퍼관리자 계정 명령.
- `server/chat.html`: 채팅 기록 페이지. 로그인과 가입 폼, 방 관리 패널, 채팅창이 한 파일이고 `/chat/data` 하나를 fetch 한다.
- `server/instructions.md`: welcome 으로 배포하는 규약 본문. 파일을 고치면 수정 시각이 rev 가 되어 플러그인이 다음 세션부터 새 규약을 쓴다.
- `server/relay.test.ts`: 실제 소켓으로 1단계부터 3단계까지를 검사한다. 3단계는 서버를 자식 프로세스로 하나 더 띄워 재시작 복원을 본다.
- `server/web.test.ts`: 페이지 HTTP 를 검사한다. 가입과 로그인, CSP 와 CSRF 거부, 잠금, 방과 참가 승인, 플러그인 멤버 여러 개, 내보내기, 구간 이력, 보관, 비밀번호 변경, 임시 비밀번호, 비활성화.
- `server/test-client.ts`: 두 테스트가 같이 쓰는 플러그인 흉내와 HTTP 호출.
- `plugin/server.ts`: Claude Code 플러그인 본체. 설정 파일, MCP 전송, 서버 연결과 푸시, 도구 목록과 실행 순서다.
- `plugin/skills/*/SKILL.md`: 슬래시 명령. 각 명령이 어느 도구를 어떻게 부르는지 적혀 있다.
- `plugin/plugin.test.ts`: 플러그인을 실제 프로세스로 띄워 참가, 채널 알림 수신, 답장, 상태, 재시작 자동 접속, 팀 세션이 아닐 때를 검사한다.
- `.claude-plugin/marketplace.json`: 이 저장소를 마켓플레이스로 등록하게 하는 선언.
- `docs/wire-protocol.md`: 플러그인과 서버 사이의 계약.
- `docs/claude-code-guide.md`: 팀원용. Claude Code 에 플러그인을 설치하고 페이지에서 참가 코드를 받아 참가하고 쓰는 절차.

## 구현 범위

| 기능 | 동작 |
| --- | --- |
| hello/welcome, join | 토큰 인증, 초대코드 참가, 규약과 방 메모리 배포 |
| send/reply/ack | 1:1 스레드, openThread 힌트, 무응답 통지(15분), 최근 무응답 표시 |
| 보관함 | 72시간, 퇴근 중 기한 정지, 멤버당 50건, 만료 시 expired 알림 |
| 방 담당 | 세션 하나만 수신, 시작만으로는 안 뺏음, room 으로 가져오면 room_lost 푸시, 끊긴 뒤 90초 유지 |
| history | 당사자가 주고받은 기록, before 로 이전 페이지 |
| 합의 | agree_propose, agree_resolve, agree_list. 72시간 미확인이면 만료 알림 |
| 방 메모리 | 방장이 memory_set, 멤버는 memory_propose, 변경 시 room_memory 푸시. 72시간 미처리 제안은 폐기 |
| 방장 명령 | room_invite, room_kick, room_notice(공지에 답장하면 notice_no_reply) |
| 상한 | 발신 분당 30건, 공지 분당 3건, 그 외 프레임 분당 120건 |
| 관리자 HTTP | 초대코드 발급, 방장 지정, 토큰 폐기(revoked 푸시 뒤 끊음) |
| 채팅 기록 페이지 | 가입 승인, 역할 세 가지, 방 코드로 참가 신청과 방장 승인, 플러그인 참가 코드 발급(계정당 멤버 여러 개), 계정과 멤버 내보내기, 토큰 폐기, 방 코드 재발급, 방 보관, 나간 방의 구간 기록, 비밀번호 변경과 임시 비밀번호, 계정 비활성화, 관리 이력, 방별 채팅창 |

상태 저장은 `node:sqlite` 의 `state.db` 한 파일이다. 기록은 `history` 표에 한 줄씩(시각, 방, 보낸 사람, 받는 사람, 본문 전체, 스레드, 종류, 답장 요청 여부) 쌓이고 상한이 없다. 페이지 계정은 `user`, `role`, `user_role`, `user_member`, `session`, `audit` 표, 방 소속은 `room`, `room_member`, `membership_log` 표에 있고 `schema_version` 이 마이그레이션 버전을 적는다. 이 표들은 표준 SQL 만 써서(AUTOINCREMENT 만 바꾸면) MariaDB 같은 DB 로 옮길 수 있다. 나머지(멤버, 방, 초대, 스레드, 보관함, 합의, 메모리, 제안)는 `state` 표의 한 행에 JSON 으로 들어가며 바뀔 때마다 다시 쓴다. 백업은 `state.db` 와 같이 생기는 `-wal`, `-shm` 파일을 함께 복사하거나 `sqlite3 state.db ".backup 복사본.db"` 로 한다. 무응답 타이머는 스레드에 시각으로 저장돼 재시작하면 다시 걸린다. "최근 무응답" 표시(30분)는 메모리에만 있다.
