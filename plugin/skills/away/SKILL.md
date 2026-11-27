---
name: away
description: 퇴근(on)이면 메시지가 서버에 보관되고 출근(off)이면 한꺼번에 온다. 사용법은 /agent-relay:away on|off
argument-hint: 'on | off'
---

사용자가 `/agent-relay:away <on|off>` 를 실행했다. 인자가 `on` 이나 `off` 가 아니면 사용법을 안내하고 멈춘다. `team_away` 를 `mode` 로 호출하고 결과를 보여 준다. 출근 때 보관분이 2건 이상 오면 하나씩 반응하기 전에 누가 무엇을 보냈는지 먼저 정리해 보고한다.
