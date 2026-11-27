// 상태줄 모듈. MCP 서버(server.ts)가 쓰는 state-<세션>.json 을 5초마다 읽어 프롬프트 아래 한 줄로 띄운다.
// statusline.sh 와 같은 규칙이다. settings.json 을 건드리지 않으니 플러그인만 설치하면 어느 PC 에서나 뜬다.
// 팀 세션(AGENT_RELAY_TEAM=1)이 아니면 아무것도 하지 않는다.
import type { Register } from 'claude-code'

const POLL = 5000
const STALE = 90000 // 하트비트가 30초라 이보다 낡으면 플러그인이 죽은 것이다

type State = { updatedAt?: number; connected?: boolean; away?: boolean; held?: string[]; queued?: number; lastError?: string }
const ERR: Record<string, string> = { not_joined: '미참가', revoked: '차단됨', auth_failed: '토큰 무효', plugin_outdated: '구버전' }

/** 상태 파일 하나를 상태줄 한 줄로. null 이면 파일이 없는 것이라 줄을 지운다 */
export function line(st: State | null, now: number): string | undefined {
  if (!st) return undefined
  if (now - (st.updatedAt ?? 0) > STALE) return '[team X 플러그인 미동작]'
  if (st.lastError) return `[team X ${ERR[st.lastError] ?? st.lastError}]`
  if (!st.connected) return '[team X 연결없음]'
  if (st.away) return '[team 퇴근]'
  const held = st.held ?? []
  if (!held.length) return '[team 담당없음]'
  return `[team O ${held.join(' ')}${st.queued ? ` 보관 ${st.queued}` : ''}]`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if ((await $.env.get('AGENT_RELAY_TEAM')) !== '1') return next(e)
    const cfg = await $.env.get('AGENT_RELAY_CONFIG')
    const dir = cfg ? cfg.replace(/\/[^/]*$/, '') : `${await $.env.get('HOME')}/.claude/channels/relay`
    const path = `${dir}/state-${await $.session.id()}.json`
    const tick = async (): Promise<void> => {
      let st: State | null = null
      try { st = JSON.parse(await $.fs.read(path)) as State } catch { /* 아직 없거나 지워짐 */ }
      $.ui.status(line(st, await $.clock.now()))
    }
    await tick()
    $.clock.every(POLL, tick)
    return next(e)
  })
}
