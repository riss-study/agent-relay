# 중계 서버 와이어 프로토콜 (team-relay 플러그인 0.10.2 호환)

이 문서는 서버와 플러그인 사이의 계약이다. 처음에는 기존 team-relay 0.10.2 플러그인 소스에서 플러그인이 보내는 필드와 읽는 필드를 옮겨 적어 서버만 만들었고, 2026-11-26 부터는 이 저장소의 `plugin/server.ts` 가 같은 계약으로 붙는다. 0.10.2 플러그인도 그대로 붙을 수 있다.

기준: GitHub `hohre12/claude-team-relay` 태그 `v0.10.2`, `PROTO = 5`. 2026-11-04 확인.

## 1. 전송

- 웹소켓 텍스트 프레임 하나에 JSON 객체 하나. 모든 프레임에 `type` 문자열이 있다.
- URL은 플러그인이 `normalizeUrl`로 만든다. 스킴이 없으면 `ws://`를 붙이고 경로가 `/ws`로 끝나지 않으면 `/ws`를 붙인다. 서버의 웹소켓 끝점은 `/ws`로 둔다.
- 플러그인은 `ws://`를 거부하지 않는다. 외부망에서 쓰려면 참가할 때 주소를 `wss://relay.example.com`처럼 스킴까지 적게 안내한다. 서버 앞단(TLS 종료)은 평문 포트를 열지 않는다.
- 플러그인이 보내는 요청에는 정수 `id`가 붙는다(1부터 증가). 서버는 응답에 같은 `id`를 넣는다. 오류도 같은 `id`로 보낸다. 응답이 5초 안에 없으면 플러그인은 실패로 처리하고 늦게 온 응답은 버린다.
- 서버가 먼저 보내는 프레임(푸시)에는 `id`를 넣지 않는다.
- 오류 프레임은 `{type: "error", id, reason, detail?}`다. 플러그인은 `detail`이 있으면 그것을, 없으면 `reason`을 사용자에게 보여준다. `reason`은 6절의 코드를 쓴다.

## 2. 접속 수명

### 2.1 선접속 (규약과 방 메모리 받기)

팀 세션(`TEAM_RELAY_GATEWAY=1`)이 뜰 때마다 플러그인은 MCP 연결을 맺기 전에 소켓을 하나 열어 아래를 보내고, `welcome`을 받으면 바로 닫는다. 1.5초 안에 안 오면 포기하고 저장본으로 시작한다.

```json
{"type":"hello","v":5,"plugin":"0.10.2","token":"...","gateway":false,"id":0}
```

서버는 이 접속을 방 담당으로 세지 않고 온라인 상태로도 세지 않는다. `welcome`의 `protocol`과 `memory`, `memoryText`만 쓴다.

### 2.2 본접속

```json
{"type":"hello","v":5,"plugin":"0.10.2","token":"...","gateway":true,
 "session":"<CLAUDE_CODE_SESSION_ID>","rooms":["web3"],
 "dir":"/Users/me/proj","name":"세션 이름(선택)","id":1}
```

- `rooms`는 이 세션이 받고 싶은 방이다. 설정에 세션 바인딩이 있으면 그것, 없고 소속 방이 하나뿐이면 그 방, 아니면 빈 배열이다.
- 서버는 `rooms` 중 같은 멤버의 다른 세션이 이미 받고 있는 방은 주지 않는다(`lost`). 세션 시작만으로는 남의 담당을 뺏지 않는다.
- 같은 세션 id로 다시 붙으면(재접속) 그 세션의 담당을 그대로 돌려준다.
- `dir`과 `name`은 기록용이다. 받지 않아도 동작에 지장이 없다.

성공 응답:

```json
{"type":"welcome","id":1,"v":5,
 "rooms":{"web3":"규영","infra":"kyu"},
 "held":["web3"],"lost":[],
 "protocol":{"rev":12,"instructions":"<규약 전문>"},
 "memory":{"web3":{"rev":3,"text":"<방 메모리 완성 문장>"}},
 "memoryText":"<모든 방 메모리를 합친 완성 문장, 없으면 빈 문자열>",
 "roster":{"web3":{"online":["규영","선혁"],"offline":["민수"]}},
 "unresponsive":[],"away":["민수"]}
```

플러그인이 읽는 필드와 쓰임은 아래와 같다.

| 필드 | 쓰임 |
| --- | --- |
| `v` | 서버 프로토콜 버전. 3 미만이면 `team_reply`를, 4 미만이면 `team_memory`를 막는다. 5 미만이면 `session_info`를 안 보낸다. 5로 둔다 |
| `rooms` | 방 이름에서 그 방의 내 라벨로 가는 맵. 로컬 설정의 진실로 저장된다 |
| `held` | 이 세션이 실제로 받게 된 방 |
| `lost` | 받지 못한 방. 비어 있지 않으면 사용자에게 알린다 |
| `protocol.rev`, `protocol.instructions` | 규약. rev가 바뀌면 캐시를 갱신한다. 본접속에서 받은 것은 다음 세션부터 적용된다 |
| `memory` | 방마다 `{rev, text}`. 시스템 프롬프트에 넣은 rev와 다르면 `[방 메모리 갱신]` 알림을 낸다 |
| `memoryText` | 시스템 프롬프트에 붙일 완성 문장. 이 필드가 없으면 플러그인은 메모리를 모르는 서버로 본다 |
| `roster`, `unresponsive`, `away` | 참가 직후와 서버 변경 때 출력에만 쓴다 |

실패 응답은 `{type:"error", id, reason}`이다. `reason`이 `auth_failed`나 `plugin_outdated`면 플러그인은 재접속을 멈춘다. 그 외 사유면 1초에서 두 배씩 최대 30초 간격으로 재접속한다.

### 2.3 하트비트

본접속이 살아 있는 동안 플러그인은 30초마다 `{type:"doctor", id}`를 보낸다. 응답은 4절의 `doctor`와 같다. 세션 이름이 바뀌었으면 하트비트 직전에 `{type:"session_info", name, id}`를 보낸다. 응답 type은 보지 않지만 응답은 해야 한다(안 하면 5초 뒤 실패로 기록하고 다음 박동에 다시 보낸다).

### 2.4 끊김

- 소켓이 닫히면 플러그인이 재접속한다. 서버는 그 세션의 담당을 바로 풀지 말고 잠시 유지해야 재접속 뒤 `held`가 같게 나온다. 유지 시간은 서버가 정한다.
- 서버가 이 세션을 끊고 싶으면 `id` 없이 `{type:"error", reason:"replaced_by_new_gateway"}` 또는 `{type:"error", reason:"revoked"}`를 보낸다. 플러그인은 재접속하지 않는다. `revoked`는 도구를 불러도 재접속하지 않는다.

## 3. 참가

```json
{"type":"join","v":5,"plugin":"0.10.2","code":"TR-AB12-CD34","token":"<기존 토큰, 처음이면 없음>","id":1}
```

- `token`이 있으면 같은 신원에 방만 추가한다. 없으면 새 멤버를 만들고 토큰을 발급한다.
- 초대코드는 `TR-`로 시작하는 한 줄이다. 1회용이고 72시간 뒤 만료된다. 코드는 방과 라벨에 묶여 있다.
- 플러그인은 `join` 직후 같은 소켓으로 `hello`(gateway true, `rooms`에 새 방 하나)를 보낸다.

성공 응답:

```json
{"type":"joined","id":1,"token":"...","name":"규영","rooms":{"web3":"규영","infra":"kyu"}}
```

`rooms`는 그 멤버의 모든 소속 방이다. 플러그인은 기존 설정에 없던 방을 "새 방"으로 보고 이 세션이 그 방을 담당하게 한다. 실패는 `error`로 보내고 `detail`에 사람이 읽을 사유를 적으면 그대로 보여준다.

## 4. 요청과 응답

응답 type이 아래 표의 성공 type과 다르면 플러그인은 실패로 보고 `detail`이나 `reason`을 보여준다.

### 발신

| 요청 | 필드 | 성공 응답 |
| --- | --- | --- |
| `send` | `to`, `text`, `room?`, `expect?`(`reply` 또는 `none`, 기본 `reply`) | `sent` |
| `reply` | `thread`, `text`, `expect?`(기본 `none`) | `sent` (`to` 포함) |
| `ack` | `thread`, `status`(`working` 또는 `approval_pending`) | `ack_ok` |

`sent` 응답:

```json
{"type":"sent","id":7,"state":"delivered","thread":"t-1a2b3c4d","to":"선혁",
 "note":"unresponsive","openThread":"t-9f8e7d6c"}
```

- `state`는 `delivered`(상대 세션에 바로 넣음) 또는 `queued`(보관)다.
- `note`는 선택이다. `unresponsive`면 상대가 최근 무응답, `away`면 퇴근 중이라고 표시한다.
- `openThread`는 `send`에서만 쓴다. 받는 사람이 나에게 보낸 질문 중 아직 답하지 않은 스레드가 있으면 그 id를 넣는다. 플러그인이 "답장이었으면 team_reply로 다시 보내라"고 안내한다.
- `reply`의 `to`는 서버가 스레드에서 정한 상대 라벨이다.

`send`의 `to`는 라벨이다. `room`이 없으면 이 세션이 담당하는 방에서 찾는다. 같은 라벨이 여러 방에 있으면 `ambiguous_name:<라벨>:<방1,방2>`로 거절한다. 담당하지 않는 방으로는 보낼 수 없다(사유는 서버가 정한다. 플러그인은 `detail`을 그대로 보여준다).

### 상태

| 요청 | 필드 | 성공 응답 |
| --- | --- | --- |
| `away` | `on`(boolean) | `away_ok` `{away, pending}` |
| `room` | `rooms[]` | `room_ok` `{held, lost, stolen}` |
| `status` | 없음 | `status` |
| `doctor` | 없음 | `doctor` |
| `session_info` | `name` | 아무 type이나 같은 id로 응답 |

- `away_ok.pending`은 출근(`on: false`)할 때 곧 배달될 보관 건수다.
- `room`은 담당을 바꾸는 요청이다. `rooms`에 적은 방은 같은 멤버의 다른 세션이 받고 있어도 가져온다. 가져온 방은 `stolen`에 넣고 잃은 세션에는 `{type:"room_lost", room}`을 푸시한다. `rooms`에 없는 기존 담당 방은 푼다. 소속이 아닌 방은 `lost`에 넣는다.
- `status` 응답: `rooms`(방에서 라벨), `held`, `heldByOther`(같은 멤버의 다른 세션이 받는 방), `myAway`(boolean), `roster`, `unresponsive[]`, `away[]`.
- `doctor` 응답: `rooms`, `held`, `heldByOther`, `queueForMe`(나를 기다리는 보관 건수), `away`(boolean), `serverTime`(밀리초 epoch), `protocolRev`(정수 또는 null), `audit`(boolean, 히스토리 제공 여부).

### 기록

`history` 요청: `peer?`, `room?`, `thread?`, `limit?`(기본 20, 최대 100), `before?`(밀리초 ts, 이 값 이전만).

```json
{"type":"history","id":3,"more":true,
 "entries":[{"ts":1730700000000,"room":"web3","from":"규영","to":"선혁",
             "text":"...","thread":"t-1a2b3c4d","truncated":false}]}
```

`entries`는 오래된 것이 앞이다. 플러그인은 `entries[0].ts`를 다음 페이지의 `before`로 안내한다. 히스토리를 끈 서버는 `history_disabled`로 거절한다. 조회 범위는 요청한 멤버가 주고받은 것만이다. 방 단위 공개 옵션을 넣더라도 이 플러그인은 `scope` 인자를 보내지 않으므로 서버 쪽 방 설정으로만 범위가 넓어진다.

### 합의

| 요청 | 필드 | 성공 응답 |
| --- | --- | --- |
| `agree_propose` | `to`, `summary`, `details?`, `thread?`, `room?` | `agree_ok` `{agree, state}` |
| `agree_resolve` | `agree`, `result`(`confirm` 또는 `reject`), `reason?` | `agree_resolved` `{agree, result}` |
| `agree_list` | `peer?` | `agrees` |

- `agree`는 합의 id다. `state`는 `delivered` 또는 `queued`다.
- 제안은 상대에게 `message` 푸시로 간다. `kind: "agree_propose"`와 `agree: <id>`를 실어야 상대 플러그인이 confirm에 쓸 id를 안다.
- `agrees` 응답: `entries[]`는 확정분 `{agree, ts, room, a, b, summary, details?}`, `pending[]`은 내가 당사자인 미확정분 `{agree, a, b, summary}`.
- 실패 사유 `agree_not_found`, `agree_not_mine`.

### 방 메모리

| 요청 | 필드 | 성공 응답 |
| --- | --- | --- |
| `memory_get` | `room` | `memory` `{memory, proposals[], owner}` |
| `memory_set` | `room`, `rev`, `description`, `items[]` | `memory_ok` `{memory}` |
| `memory_propose` | `room`, `text` | `memory_proposed` `{proposal, to}` |
| `memory_resolve` | `proposal`, `result`(`approve` 또는 `reject`), `replace?`(1에서 3), `reason?` | `memory_resolved` `{room, memory}` |

- 메모리 문서 모양은 `{description, items: [{text}], rev, updatedAt?, updatedBy?}`다.
- `memory_get.owner`가 false면 플러그인이 쓰기를 막는다. 쓰기는 `rev`를 들고 오고, 현재 rev와 다르면 `memory_conflict`로 거절한다.
- `memory_proposed.to`는 `owner`(방장에게 바로 전달), `queued`(방장 오프라인), `self`(제안자가 방장), 그 외 문자열(방장 없음, 관리자 처리) 중 하나다. `proposal`은 `mp-`로 시작하는 id다.
- 제안은 방장에게 `message` 푸시(`kind: "memory_propose"`)로 가고 본문에 제안 id를 적는다. 플러그인은 id를 본문에서 읽는다.
- 한도: 설명 1개, 항목 3개, 칸마다 150자, 본문에 `team_` 도구 이름 금지. 사유는 6절.
- 메모리가 바뀌면 그 방을 받는 모든 세션에 `{type:"room_memory", room, rev, text}`를 푸시한다. `text`는 완성 문장이다(비면 빈 문자열).

### 방장

| 요청 | 필드 | 성공 응답 |
| --- | --- | --- |
| `room_invite` | `room`, `name` | `room_invite_ok` `{code}` |
| `room_kick` | `room`, `name` | `room_kick_ok` |
| `room_notice` | `room`, `text` | `room_notice_ok` `{delivered, queued, skipped[]}` |

- 방장이 아니면 `not_room_owner`, 대상이 방에 없으면 `not_in_room`, 공지 한도 초과면 `notice_rate_limited`.
- 공지는 방 전원에게 `message` 푸시(`kind: "notice"`)로 간다. 공지에 `reply`하면 `notice_no_reply`로 거절한다.
- `kick`은 그 방에서만 뺀다. 그 방의 보관분은 폐기하고 보낸 사람에게 `expired`를 푸시한다.

## 5. 서버가 먼저 보내는 프레임

`id` 없이 보낸다.

| type | 필드 | 플러그인 동작 |
| --- | --- | --- |
| `message` | `from`, `room`, `text`, `ts`, `thread?`, `expect?`, `kind?`, `agree?`, `queued?` | channel 알림으로 대화에 넣는다 |
| `expired` | `to`, `room`, `preview` | "[보관 만료]" 알림 |
| `noack` | `to`, `room`, `thread` | "[무응답]" 알림 |
| `room_lost` | `room` | 담당에서 빼고 "[수신 이전]" 알림 |
| `room_memory` | `room`, `rev`, `text` | 아는 rev와 다르면 "[방 메모리 갱신]" 알림 |
| `error` | `reason`: `replaced_by_new_gateway` 또는 `revoked` | 재접속 없이 알림 |

`message`의 필드는 그대로 `<channel>` 태그 속성이 된다. `from`이 `_system`이면 플러그인이 `kind`를 `system`으로 바꾼다. `queued`는 보관됐다가 늦게 배달될 때 `true`다. `kind`로 쓰는 값은 `notice`, `agree_propose`, `memory_propose`, `system`이다.

메시지는 그 방을 받는 세션 하나에만 보낸다. 받는 세션이 없거나 상대가 퇴근 중이면 보관한다.

## 6. 오류 사유 코드

플러그인이 문장으로 바꾸는 코드다. 같은 코드를 쓰면 플러그인 안내문을 그대로 쓸 수 있다.

```
인증    auth_failed, plugin_outdated, revoked, replaced_by_new_gateway
발신    unknown_member, ambiguous_name:<라벨>:<방,방>, queue_full:<n>, rate_limited
답장    unknown_thread, not_in_thread, thread_mismatch, peer_gone, left_room,
        notice_no_reply, thread_required
방장    not_room_owner, not_in_room, notice_rate_limited
합의    agree_not_found, agree_not_mine
메모리  memory_conflict, memory_item_text_required, memory_too_long,
        memory_too_many_items, memory_tool_name, memory_full, proposal_not_found
기록    history_disabled
```

목록에 없는 사유는 `detail`에 사람이 읽을 문장을 넣는다. 플러그인은 모르는 사유를 그대로 출력한다.

## 7. 서버가 정하는 동작

플러그인은 아래를 검사하지 않는다. 가이드와 플러그인 안내문이 전제하는 값이다.

| 항목 | 값 |
| --- | --- |
| 보관 기한 | 72시간. 퇴근 중에는 기한이 멈춘다. 만료되면 보낸 사람에게 `expired` |
| 무응답 판정 | `expect: reply`인 메시지에 15분 동안 `reply`도 `ack`도 없으면 보낸 사람에게 `noack`. `ack`나 `reply`가 오면 해제 |
| 초대코드 | 1회용, 72시간, `TR-` 접두 |
| 보관함 상한 | 멤버당 n건. 넘으면 `queue_full:<n>` |
| 발신 상한 | 분당 메시지 수. 넘으면 `rate_limited`. 비발신 프레임(doctor 등)은 분당 120건 안에서 허용 |
| 공지 상한 | 분당 횟수. 넘으면 `notice_rate_limited` |
| 메모리 제안 | 72시간 안에 처리되지 않으면 폐기하고 제안자에게 알림 |
| 합의 제안 | 72시간 안에 확인되지 않으면 만료하고 제안자에게 알림 |
| 규약 본문 | `welcome.protocol.instructions`. 서버가 작성해 배포한다. 플러그인에는 보안 경계 세 줄짜리 최소본만 들어 있다 |
| 방장 지정 | 서버 관리 기능. 플러그인에는 없다 |
| 토큰 폐기 | 서버 관리 기능. 연결을 끊고 `revoked`를 보낸다 |

## 8. 이 플러그인으로는 못 하는 것

플러그인을 고치지 않는 한 아래는 서버에 넣어도 플러그인이 호출하지 못한다.

- 내용 검색 도구(`team_search`). 플러그인에 그 도구가 없다.
- 지난 대화 조회의 `scope` 인자. 방 공개 범위는 서버 방 설정으로만 적용된다.
- `ws://` 거부. 참가 주소에 `wss://`를 적도록 안내로 막는다.
- 작업 폴더 경로 숨김. `hello.dir`은 항상 전체 경로로 온다. 서버가 저장하지 않으면 된다.

이것들이 필요해지면 그때 플러그인을 포크한다.
