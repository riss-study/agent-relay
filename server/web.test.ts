// ============================================================================
// web.test.ts : 채팅 기록 페이지의 HTTP 를 실제 포트로 검사한다
// ----------------------------------------------------------------------------
// 실행: npm test. 세 test 가 순서대로 돌며 계정과 방을 이어서 쓴다.
//   1. 가입과 로그인, 보안: CSP 와 CSRF 거부, 비밀번호 규칙, 로그인 잠금, 승인 전 로그인 거절, 관리 이력
//   2. 방: 만들기, 코드로 참가 신청과 승인, 플러그인 멤버 여러 개, 내보내기, 코드 재발급, 토큰 폐기, 계정 내보내기와 참가 구간, 보관
//   3. 계정: 비밀번호 변경과 세션 끊김, 임시 비밀번호, 비활성화와 복구
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.RELAY_STATE = join(mkdtempSync(join(tmpdir(), 'relay-web-')), 'state.db')
process.env.LOGIN_DELAY_MS = '10'
import { Client, api } from './test-client.ts'
const { start } = await import('./relay.ts')
const { addUser } = await import('./web.ts')
const port = await start(0)
const base = `http://localhost:${port}`
const url = `ws://localhost:${port}`
const call = (path: string, body: unknown, cookie = '', headers: Record<string, string> = {}) => api(base, path, body, cookie, headers)
const plugin = async (code: string, token?: string): Promise<{ c: Client; j: any }> => {
  const c = new Client(url); await c.open()
  const j = await c.req({ type: 'join', v: 5, plugin: '0.10.2', code, token })
  assert.equal(j.type, 'joined', JSON.stringify(j))
  return { c, j }
}

let boss = '', kim = '', adm = '' // 로그인 쿠키
let kimId = 0, admId = 0
let devCode = ''

test('가입과 로그인, 보안', async () => {
  addUser('boss@x.io', 'boss-pass', '대표') // .env 의 슈퍼관리자와 같은 경로

  // 페이지는 CSP 와 프레임 거부 헤더를 받는다
  const page = await fetch(`${base}/chat`)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'sha256-/)
  assert.equal(page.headers.get('x-frame-options'), 'DENY')
  assert.equal((await call('/chat/data', null)).status, 401)

  // POST 는 JSON 과 같은 출처만. 폼 전송이나 다른 사이트의 요청은 거절한다
  assert.equal((await fetch(`${base}/login`, { method: 'POST', body: 'user=a&pass=b' })).status, 415)
  assert.equal((await call('/login', { user: 'boss@x.io', pass: 'boss-pass' }, '', { 'sec-fetch-site': 'cross-site' })).status, 403)

  // 가입: 비밀번호 8자, 이메일 모양, 중복은 대소문자 구분 없이 막는다
  assert.equal((await call('/signup', { login: 'kim@x.io', pass: 'short', name: '김' })).body.error, 'weak_pass')
  assert.equal((await call('/signup', { login: 'not-mail', pass: 'kim-pass-1', name: '김' })).status, 400)
  assert.equal((await call('/signup', { login: 'Kim@x.io', pass: 'kim-pass-1', name: '김' })).status, 200)
  assert.equal((await call('/signup', { login: 'kim@x.io', pass: 'kim-pass-1', name: '김' })).status, 409)
  assert.equal((await call('/login', { user: 'kim@x.io', pass: 'kim-pass-1' })).body.error, 'pending')

  // 로그인 잠금: 한 아이디로 5번 틀리면 429
  for (let i = 0; i < 5; i++) assert.equal((await call('/login', { user: 'ghost@x.io', pass: 'x' })).status, 401)
  assert.equal((await call('/login', { user: 'ghost@x.io', pass: 'x' })).body.error, 'locked')

  assert.equal((await call('/login', { user: 'boss@x.io', pass: 'wrong' })).status, 401)
  const li = await call('/login', { user: 'boss@x.io', pass: 'boss-pass' })
  assert.equal(li.status, 200)
  assert.match(li.headers.get('set-cookie') ?? '', /^sid=.+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+$/)
  boss = li.cookie
  const d0 = (await call('/chat/data', null, boss)).body
  assert.deepEqual(d0.me.roles, ['system_admin'])
  assert.equal(d0.pendingUsers[0].login, 'kim@x.io')
  kimId = d0.pendingUsers[0].id
  assert.equal((await call(`/users/${kimId}/approve`, {}, boss)).status, 200)
  kim = (await call('/login', { user: 'kim@x.io', pass: 'kim-pass-1' })).cookie
  assert.equal((await call('/chat/data', null, kim)).body.me.name, '김')

  // 일반 관리자 계정 하나. 가입 승인과 방 만들기는 되고 역할과 비밀번호는 못 건드린다
  assert.equal((await call('/signup', { login: 'adm@x.io', pass: 'adm-pass-1', name: '관리' })).status, 200)
  admId = (await call('/chat/data', null, boss)).body.pendingUsers[0].id
  assert.equal((await call(`/users/${admId}/approve`, {}, kim)).status, 403) // 멤버는 승인 못 한다
  assert.equal((await call(`/users/${admId}/approve`, {}, boss)).status, 200)
  assert.equal((await call(`/users/${admId}/role`, { role: 'admin' }, boss)).status, 200)
  adm = (await call('/login', { user: 'adm@x.io', pass: 'adm-pass-1' })).cookie
  const da = (await call('/chat/data', null, adm)).body
  assert.deepEqual(da.me.roles, ['admin'])
  assert.ok(da.users.length >= 3) // 관리자도 계정 목록을 본다
  assert.equal(da.audit.length, 0) // 관리 이력은 슈퍼관리자만
  assert.equal((await call(`/users/${kimId}/role`, { role: 'admin' }, adm)).status, 403)
  assert.equal((await call(`/users/${kimId}/password`, { next: 'whatever-1' }, adm)).status, 403)

  // 관리 이력
  const acts = (await call('/chat/data', null, boss)).body.audit.map((a: any) => a.action)
  for (const a of ['signup', 'login_fail', 'login', 'user_approve', 'user_role']) assert.ok(acts.includes(a), a)

  // 로그아웃하면 쿠키가 죽는다
  const tmp = (await call('/login', { user: 'kim@x.io', pass: 'kim-pass-1' })).cookie
  assert.equal((await call('/logout', {}, tmp)).status, 200)
  assert.equal((await call('/chat/data', null, tmp)).status, 401)
})

test('방: 참가 승인, 플러그인 멤버, 내보내기, 구간 이력, 보관', async () => {
  assert.equal((await call('/rooms', { name: 'dev' }, kim)).status, 403)
  assert.equal((await call('/rooms', { name: 'a/b' }, boss)).status, 400)
  assert.equal((await call('/rooms', { name: 'dev' }, boss)).status, 200)
  assert.equal((await call('/rooms', { name: 'dev' }, boss)).status, 409)
  const dev = (await call('/chat/data', null, boss)).body.rooms.find((r: any) => r.name === 'dev')
  assert.equal(dev.owner, '대표'); assert.match(dev.code, /^RM-/); assert.equal(dev.status, 'joined')
  devCode = dev.code

  // 참가 신청과 승인. 김에게는 방 코드가 안 보이고 자기 참가 시각 이후만 보인다
  assert.equal((await call('/rooms/join', { code: 'RM-0000-0000' }, kim)).status, 404)
  assert.equal((await call('/rooms/join', { code: devCode.toLowerCase() }, kim)).body.status, 'pending')
  assert.equal((await call('/rooms/join', { code: devCode }, kim)).status, 409)
  assert.equal((await call('/rooms/dev/approve', { user: kimId }, kim)).status, 403)
  assert.equal((await call('/rooms/dev/approve', { user: kimId }, boss)).status, 200)
  const dk = (await call('/chat/data', null, kim)).body
  assert.equal(dk.rooms[0].status, 'joined'); assert.equal(dk.rooms[0].code, null)
  assert.deepEqual(dk.messages.map((m: any) => m.text), ['김 님이 참가했습니다'])
  // 관리자도 참가 신청해서 승인받는다
  assert.equal((await call('/rooms/join', { code: devCode }, adm)).body.status, 'pending')
  assert.equal((await call('/rooms/dev/approve', { user: admId }, boss)).status, 200)

  // 플러그인 멤버: 같은 이름은 같은 멤버, 다른 이름은 다른 멤버. 다른 사람의 이름은 못 쓴다
  const { c: c1, j: j1 } = await plugin((await call('/rooms/dev/code', {}, kim)).body.code)
  assert.equal(j1.name, '김')
  const { c: c2, j: j2 } = await plugin((await call('/rooms/dev/code', {}, kim)).body.code)
  assert.equal(j2.token, j1.token); c2.ws.close()
  assert.equal((await call('/rooms/dev/code', { label: '대표' }, kim)).status, 409)
  const { c: c4, j: j4 } = await plugin((await call('/rooms/dev/code', { label: '김 노트북' }, kim)).body.code, j1.token)
  assert.equal(j4.name, '김 노트북'); assert.notEqual(j4.token, j1.token)
  const { c: c3, j: j3 } = await plugin((await call('/rooms/dev/code', {}, boss)).body.code)
  const { c: c5, j: j5 } = await plugin((await call('/rooms/dev/code', {}, adm)).body.code)
  for (const [c, j, s] of [[c1, j1, 's-kim'], [c4, j4, 's-kim2'], [c3, j3, 's-boss'], [c5, j5, 's-adm']] as const) await c.req({ type: 'hello', v: 5, plugin: '0.10.2', token: j.token, gateway: true, session: s, rooms: ['dev'] })
  assert.equal((await c3.req({ type: 'memory_get', room: 'dev' })).owner, true) // 방장 계정의 멤버가 플러그인 방장
  assert.equal((await c1.req({ type: 'send', to: '대표', text: '안녕하세요' })).type, 'sent'); await c3.nextPush()
  assert.equal((await c1.req({ type: 'send', to: '김 노트북', text: '나야' })).type, 'sent')
  assert.equal((await c4.nextPush()).text, '나야')
  const dk2 = (await call('/chat/data', null, kim)).body
  assert.ok(dk2.messages.some((m: any) => m.from === '김' && m.to === '대표' && m.text === '안녕하세요'))
  assert.deepEqual([...dk2.me.labels.dev].sort(), ['김', '김 노트북'])

  // 플러그인 멤버 내보내기(방장), 코드 재발급, 토큰 폐기(본인)
  const note = (await call('/chat/data', null, boss)).body.rooms.find((r: any) => r.name === 'dev').pluginMembers.find((m: any) => m.name === '김 노트북')
  assert.equal(note.user, '김')
  assert.equal((await call('/rooms/dev/kick', { member: note.id }, kim)).status, 403)
  assert.equal((await call('/rooms/dev/kick', { member: note.id }, boss)).status, 200)
  assert.equal((await c4.req({ type: 'send', to: '대표', text: 'x' })).type, 'error')
  assert.equal((await call('/chat/data', null, kim)).body.rooms[0].status, 'joined')
  const newCode = (await call('/rooms/dev/recode', {}, boss)).body.code
  assert.notEqual(newCode, devCode)
  assert.equal((await call('/rooms/join', { code: devCode }, kim)).status, 404)
  devCode = newCode
  const bossMember = (await call('/chat/data', null, boss)).body.rooms.find((r: any) => r.name === 'dev').pluginMembers.find((m: any) => m.name === '대표')
  assert.equal((await call(`/members/${bossMember.id}/revoke`, {}, kim)).status, 404) // 남의 멤버는 못 지운다
  assert.equal((await call(`/members/${note.id}/revoke`, {}, kim)).status, 200)
  assert.deepEqual((await call('/chat/data', null, kim)).body.me.members.map((m: any) => m.label), ['김'])
  const c6 = new Client(url); await c6.open()
  assert.equal((await c6.req({ type: 'hello', v: 5, plugin: '0.10.2', token: j4.token, gateway: false })).reason, 'auth_failed'); c6.ws.close()

  // 계정 내보내기: 김은 나간 방으로 보고, 빠져 있는 동안의 메시지는 못 본다. 다시 승인되면 구간이 둘이 된다
  assert.equal((await call('/rooms/dev/remove', { user: kimId }, adm)).status, 403)
  assert.equal((await call('/rooms/dev/remove', { user: kimId }, boss)).status, 200)
  assert.equal((await c1.req({ type: 'send', to: '대표', text: 'x' })).type, 'error')
  const left = (await call('/chat/data', null, kim)).body.rooms.find((r: any) => r.name === 'dev')
  assert.equal(left.status, 'left'); assert.equal(left.intervals.length, 1); assert.ok(left.intervals[0].left_at)
  await new Promise(r => setTimeout(r, 5)) // 나간 시각보다 뒤에 보내졌다는 것이 분명하게
  assert.equal((await c3.req({ type: 'send', to: '관리', text: '김 없을 때' })).type, 'sent'); await c5.nextPush()
  assert.equal((await call('/rooms/join', { code: devCode }, kim)).body.status, 'pending')
  assert.equal((await call('/rooms/dev/approve', { user: kimId }, boss)).status, 200)
  const back = (await call('/chat/data', null, kim)).body
  const devMsgs = back.messages.filter((m: any) => m.room === 'dev').map((m: any) => m.text)
  assert.ok(!devMsgs.includes('김 없을 때'))
  assert.ok(devMsgs.includes('김 님이 내보내졌습니다 (대표)'), JSON.stringify(devMsgs))
  assert.equal(devMsgs.filter((t: string) => t === '김 님이 참가했습니다').length, 2)
  assert.equal(back.rooms.find((r: any) => r.name === 'dev').intervals.length, 2)
  assert.ok((await call('/chat/data', null, boss)).body.messages.some((m: any) => m.text === '김 없을 때')) // 슈퍼관리자는 전부

  // 보관: 모두 나가지고 슈퍼관리자만 본다. 복원하면 나간 방으로 돌아온다
  assert.equal((await call('/rooms/dev/archive', {}, adm)).status, 403)
  assert.equal((await call('/rooms/dev/archive', {}, boss)).status, 200)
  assert.equal((await c5.req({ type: 'send', to: '대표', text: 'x' })).type, 'error')
  assert.ok(!(await call('/chat/data', null, kim)).body.rooms.some((r: any) => r.name === 'dev'))
  assert.equal((await call('/rooms/join', { code: devCode }, kim)).status, 404)
  assert.equal((await call('/chat/data', null, boss)).body.rooms.find((r: any) => r.name === 'dev').archived, true)
  assert.equal((await call('/rooms/dev/unarchive', {}, boss)).status, 200)
  assert.equal((await call('/chat/data', null, kim)).body.rooms.find((r: any) => r.name === 'dev').status, 'left')
  for (const c of [c1, c3, c4, c5]) c.ws.close()
})

test('계정: 비밀번호 변경, 임시 비밀번호, 비활성화', async () => {
  // 비밀번호 변경: 현재 비밀번호가 맞아야 하고, 바꾸면 모든 로그인이 끊긴다
  assert.equal((await call('/me/password', { current: 'nope', next: 'kim-pass-2' }, kim)).body.error, 'wrong_pass')
  assert.equal((await call('/me/password', { current: 'kim-pass-1', next: 'short' }, kim)).body.error, 'weak_pass')
  assert.equal((await call('/me/password', { current: 'kim-pass-1', next: 'kim-pass-2' }, kim)).status, 200)
  assert.equal((await call('/chat/data', null, kim)).status, 401)
  assert.equal((await call('/login', { user: 'kim@x.io', pass: 'kim-pass-1' })).status, 401)
  kim = (await call('/login', { user: 'kim@x.io', pass: 'kim-pass-2' })).cookie

  // 임시 비밀번호: 그걸로 로그인하면 비밀번호를 바꾸기 전에는 다른 요청이 막힌다
  assert.equal((await call(`/users/${kimId}/password`, { next: 'temp-pass-1' }, boss)).status, 200)
  assert.equal((await call('/chat/data', null, kim)).status, 401)
  const tl = await call('/login', { user: 'kim@x.io', pass: 'temp-pass-1' })
  assert.equal(tl.body.mustChangePass, true)
  kim = tl.cookie
  assert.equal((await call('/chat/data', null, kim)).body.me.mustChangePass, true)
  assert.equal((await call('/rooms/join', { code: devCode }, kim)).body.error, 'must_change_pass')
  assert.equal((await call('/me/password', { current: 'temp-pass-1', next: 'kim-pass-3' }, kim)).status, 200)
  kim = (await call('/login', { user: 'kim@x.io', pass: 'kim-pass-3' })).cookie
  assert.equal((await call('/chat/data', null, kim)).body.me.mustChangePass, false)

  // 비활성화: 세션과 로그인이 막히고 플러그인 토큰도 폐기된다. 관리자는 슈퍼관리자를 못 건드린다
  const bossId = (await call('/chat/data', null, boss)).body.me.id
  assert.equal((await call(`/users/${bossId}/disable`, {}, adm)).status, 403)
  assert.equal((await call(`/users/${bossId}/disable`, {}, boss)).body.error, 'self')
  const kimMembers = (await call('/chat/data', null, kim)).body.me.members
  assert.equal(kimMembers.length, 1)
  assert.equal((await call(`/users/${kimId}/disable`, {}, adm)).status, 200) // 관리자도 멤버 계정은 비활성화한다
  assert.equal((await call('/chat/data', null, kim)).status, 401)
  assert.equal((await call('/login', { user: 'kim@x.io', pass: 'kim-pass-3' })).body.error, 'disabled')
  const ku = (await call('/chat/data', null, boss)).body.users.find((u: any) => u.id === kimId)
  assert.equal(ku.disabled, true); assert.deepEqual(ku.members, [])
  assert.equal((await call(`/users/${kimId}/enable`, {}, boss)).status, 200)
  assert.equal((await call('/login', { user: 'kim@x.io', pass: 'kim-pass-3' })).status, 200)

  const acts = (await call('/chat/data', null, boss)).body.audit.map((a: any) => a.action)
  for (const a of ['password_change', 'user_temp_password', 'user_disable', 'user_enable', 'room_archive', 'room_unarchive', 'room_remove', 'member_kick', 'member_revoke', 'room_recode']) assert.ok(acts.includes(a), a)
})
