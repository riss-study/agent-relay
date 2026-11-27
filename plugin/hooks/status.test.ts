import { expect, mock, test } from 'claude-code/testing'

const FILE = '/home/me/.claude/channels/relay/state-s1.json'

test('팀 세션이면 상태 파일을 읽어 상태줄을 띄우고, 바뀌면 따라간다', async ($, on) => {
  const clock = mock.clock(on, { now: 100000 })
  mock.env(on, { AGENT_RELAY_TEAM: '1', HOME: '/home/me' })
  let file = JSON.stringify({ updatedAt: 100000, connected: true, held: ['web3'], queued: 0, lastError: '' })
  on('fs.read', (_, e) => (e.path === FILE ? { value: file } : { deny: 'missing' }))
  on('session.id', () => ({ value: 's1' }))
  const shown: Array<string | undefined> = []
  on('ui.status', (_, e) => { shown.push(e.text); return { value: undefined } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(shown.at(-1)).toBe('[team O web3]')

  file = JSON.stringify({ updatedAt: 100000, connected: true, away: true, held: ['web3'] })
  await clock.advance(5000)
  expect(shown.at(-1)).toBe('[team 퇴근]')

  file = JSON.stringify({ updatedAt: 100000, connected: true, held: ['web3'], queued: 2 })
  await clock.advance(5000)
  expect(shown.at(-1)).toBe('[team O web3 보관 2]')

  await clock.advance(95000) // 파일이 90초 넘게 낡으면 플러그인이 죽은 것
  expect(shown.at(-1)).toBe('[team X 플러그인 미동작]')
})

test('팀 세션이 아니면 아무것도 띄우지 않는다', async ($, on) => {
  mock.clock(on)
  mock.env(on, { AGENT_RELAY_TEAM: '' })
  let asked = 0
  on('ui.status', () => { asked++; return { value: undefined } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(asked).toBe(0)
})
