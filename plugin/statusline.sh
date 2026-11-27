#!/bin/sh
# agent-relay 상태줄. Claude Code 가 stdin 으로 주는 JSON 의 session_id 로 이 세션의 상태 파일을 찾아 한 줄을 찍는다.
# 플러그인과 독립이라 플러그인이 죽어도(파일이 90초 넘게 낡으면) 그 사실을 보여 준다. 의존성 없음.
# 플러그인이 켜질 때 이 파일을 ~/.claude/channels/relay/statusline.sh 로 복사하므로 설정에는 그 경로를 적는다.
DIR="${AGENT_RELAY_STATE_DIR:-$HOME/.claude/channels/relay}"
SID=$(sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
[ -n "$SID" ] || exit 0
F="$DIR/state-$SID.json"
[ -f "$F" ] || exit 0 # 팀 세션이 아니면 파일이 없다. 아무것도 띄우지 않는다
RAW=$(cat "$F")
field() { printf '%s' "$RAW" | sed -n "s/.*\"$1\":\([^,}]*\).*/\1/p" | tr -d '"'; }

NOW=$(date +%s); U=$(field updatedAt)
[ $(( NOW - ${U:-0} / 1000 )) -le 90 ] || { printf '[team X 플러그인 미동작]'; exit 0; }

case "$(field lastError)" in
  '') ;;
  not_joined) printf '[team X 미참가]'; exit 0 ;;
  revoked) printf '[team X 차단됨]'; exit 0 ;;
  auth_failed) printf '[team X 토큰 무효]'; exit 0 ;;
  plugin_outdated) printf '[team X 구버전]'; exit 0 ;;
  *) printf '[team X %s]' "$(field lastError)"; exit 0 ;;
esac
[ "$(field connected)" = true ] || { printf '[team X 연결없음]'; exit 0; }
[ "$(field away)" = true ] && { printf '[team 퇴근]'; exit 0; }

HELD=$(printf '%s' "$RAW" | sed -n 's/.*"held":\[\([^]]*\)\].*/\1/p' | tr -d '"' | tr ',' ' ')
[ -n "$HELD" ] || { printf '[team 담당없음]'; exit 0; }
Q=$(field queued)
if [ "${Q:-0}" -gt 0 ]; then printf '[team O %s 보관 %s]' "$HELD" "$Q"; else printf '[team O %s]' "$HELD"; fi
