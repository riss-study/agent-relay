// ============================================================================
// web.ts : 채팅 기록 페이지의 HTTP. 요청을 받아 account.ts, rooms.ts, view.ts 를 부른다
// ----------------------------------------------------------------------------
// 역할: system_admin(슈퍼관리자, 모든 방을 보고 승인 없이 들어간다), admin(방을 만들고 가입을 승인한다), member.
// 흐름: 가입하면 pending, 관리자가 승인하면 approved 가 되어 로그인한다. 방 코드로 참가 신청하면 pending,
//       방장이 승인하면 joined, 나가면 left 다. 나간 방은 참가 구간 안의 기록만 보인다.
//
// 보안
//   로그인 쿠키 sid 는 HttpOnly, SameSite=Strict, 토큰은 DB 에 해시로. COOKIE_SECURE=1 이면 Secure 를 붙인다(TLS 프록시 뒤)
//   POST 는 content-type: application/json 과 같은 출처(sec-fetch-site)만 받는다. 폼 전송으로는 못 부른다
//   본문은 64KB 까지. 로그인은 아이디당 10분에 5번 틀리면 잠기고, 가입은 IP 당 한 시간에 5번
//   임시 비밀번호를 받은 계정은 비밀번호를 바꾸기 전에는 다른 요청이 막힌다
//   /chat 은 CSP(인라인 스크립트 해시), nosniff, frame 거부 헤더를 받는다
//   관리 행위는 전부 audit 표에 남는다
//
// HTTP (전부 JSON)
//   GET  /chat                        페이지 (server/chat.html)
//   POST /signup {login, pass, name}  가입 신청
//   POST /login {user, pass}          승인된 계정만. 틀리면 1초 뒤 401, 잠기면 429, 비활성화면 403 disabled
//   POST /logout
//   GET  /chat/data                   내 정보, 방 목록, 기록, 대기 목록, (슈퍼관리자) 계정과 관리 이력
//   POST /me/password {current, next} 내 비밀번호 바꾸기. 다른 로그인은 모두 끊긴다
//   POST /rooms {name}                방 만들기 (admin 이상). 만든 계정이 방장
//   POST /rooms/join {code}           방 코드로 참가 신청. 슈퍼관리자는 바로 참가
//   POST /rooms/<방>/approve {user}   참가 승인 (방장 또는 슈퍼관리자)
//   POST /rooms/<방>/reject {user}    참가 거절
//   POST /rooms/<방>/remove {user}    계정 내보내기 (방장 또는 슈퍼관리자). 그 계정의 플러그인 멤버도 방에서 빠진다
//   POST /rooms/<방>/leave            나가기
//   POST /rooms/<방>/owner {user}     방장 지정. 지정된 계정은 바로 참가된다
//   POST /rooms/<방>/code {label?}    내 플러그인 참가 코드 발급 (참가 중인 방만). label 이 없으면 계정 이름
//   POST /rooms/<방>/kick {member}    플러그인 멤버 하나를 방에서 내보내기. 계정의 방 소속은 그대로다
//   POST /rooms/<방>/recode           방 코드 재발급. 이전 코드는 바로 못 쓴다
//   POST /rooms/<방>/archive          방 보관 (방장 또는 슈퍼관리자). 모두 내보내고 슈퍼관리자만 본다
//   POST /rooms/<방>/unarchive        방 복원 (슈퍼관리자)
//   POST /members/<멤버id>/revoke     플러그인 멤버 토큰 폐기 (그 멤버의 계정 본인 또는 슈퍼관리자)
//   POST /users/<id>/approve, reject  가입 승인과 거절 (admin 이상)
//   POST /users/<id>/role {role}      역할 바꾸기 (슈퍼관리자)
//   POST /users/<id>/disable, enable  계정 비활성화와 복구 (admin 이상. 슈퍼관리자 계정은 슈퍼관리자만)
//   POST /users/<id>/password {next}  임시 비밀번호 지정 (슈퍼관리자). 그 계정은 다음 로그인 때 바꿔야 한다
// ============================================================================

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db, state, kickMember, revokeMember } from './relay.ts'
import { ROLES, type Role, type User, SESSION_TTL_MS, audit, createSession, deleteSession, isAdmin, isSuper, login, loginFailed, loginLocked, loginOk, overLimit, passProblem, sessionUser, setDisabled, setPassword, setRole, signup, userById, verifyPassword } from './account.ts'
import { archiveRoom, createRoom, issueCode, joinRoom, leaveRoom, membersOf, membership, newRoomCode, ownsMember, rejectJoin, requestJoin, roomByCode, roomByName, roomNameProblem, setOwner, unarchiveRoom, unlinkMember } from './rooms.ts'
import { data } from './view.ts'

// relay.ts 가 쓰는 것들. relay.ts 는 web.ts 만 import 한다
export { migrate } from './schema.ts'
export { addUser, seedAdmin } from './account.ts'
export { linkMember, userMember } from './rooms.ts'

const CHAT_HTML = join(dirname(fileURLToPath(import.meta.url)), 'chat.html')
const BODY_MAX = 64 * 1024
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1'
const LOGIN_DELAY_MS = Number(process.env.LOGIN_DELAY_MS ?? 1000) // 틀린 로그인의 응답 지연. 테스트에서 줄인다

type Body = Record<string, unknown>
type Result = [number, unknown]
const str = (v: unknown): string => String(v ?? '').trim()

// ── 로그인 뒤 라우트 ──────────────────────────────────────────────────────────
// [경로 정규식, 처리 함수]. 처리 함수는 [상태 코드, 응답] 을 돌려준다. 권한 검사는 각 함수 앞쪽에 모아 둔다

const routes: Array<[RegExp, (u: User, b: Body, m: RegExpExecArray) => Result]> = [
  [/^\/me\/password$/, (u, b) => {
    const next = String(b.next ?? '')
    const p = passProblem(next)
    if (p) return [400, { error: 'weak_pass', detail: p }]
    if (!verifyPassword(u.id, String(b.current ?? ''))) return [403, { error: 'wrong_pass', detail: '현재 비밀번호가 틀립니다' }]
    setPassword(u.id, next, false)
    audit(u.id, 'password_change', `user:${u.login}`)
    return [200, { ok: true }]
  }],
  [/^\/rooms$/, (u, b) => {
    if (!isAdmin(u)) return [403, { error: 'forbidden' }]
    const name = str(b.name)
    const p = roomNameProblem(name)
    if (p) return [400, { error: 'invalid', detail: p }]
    if (roomByName(name)) return [409, { error: 'room_exists' }]
    createRoom(name, u)
    audit(u.id, 'room_create', `room:${name}`)
    return [200, { name }]
  }],
  [/^\/rooms\/join$/, (u, b) => {
    const r = roomByCode(str(b.code))
    if (!r || r.archived_at) return [404, { error: 'unknown_code' }]
    const ms = membership(r.name, u.id)
    if (ms?.status === 'joined') return [409, { error: 'already_joined' }]
    if (ms?.status === 'pending') return [409, { error: 'already_pending' }]
    if (isSuper(u)) { joinRoom(r.name, u); return [200, { room: r.name, status: 'joined' }] }
    requestJoin(r.name, u)
    return [200, { room: r.name, status: 'pending' }]
  }],
  [/^\/rooms\/([^/]+)\/(approve|reject|remove|owner|leave|code|kick|recode|archive|unarchive)$/, (u, b, m) => {
    const room = decodeURIComponent(m[1]!)
    const action = m[2]!
    const r = roomByName(room)
    const owner = r?.owner_id === u.id || isSuper(u)
    if (action === 'leave') {
      if (membership(room, u.id)?.status !== 'joined') return [404, { error: 'not_joined' }]
      leaveRoom(room, u)
      return [200, { ok: true }]
    }
    if (action === 'code') {
      if (r?.archived_at) return [404, { error: 'archived' }]
      if (!isSuper(u) && membership(room, u.id)?.status !== 'joined') return [403, { error: 'not_joined' }]
      if (isSuper(u) && membership(room, u.id)?.status !== 'joined') joinRoom(room, u)
      const x = issueCode(room, u, str(b.label) || u.name, r?.owner_id === u.id)
      return 'code' in x ? [200, x] : [x.error === 'label_taken' ? 409 : 400, x]
    }
    if (!r || !owner) return [403, { error: 'not_room_owner' }]
    if (action === 'unarchive') {
      if (!isSuper(u)) return [403, { error: 'forbidden' }]
      unarchiveRoom(room, u)
      audit(u.id, 'room_unarchive', `room:${room}`)
      return [200, { ok: true }]
    }
    if (r.archived_at) return [404, { error: 'archived' }]
    if (action === 'archive') {
      archiveRoom(room, u)
      audit(u.id, 'room_archive', `room:${room}`)
      return [200, { ok: true }]
    }
    if (action === 'recode') {
      const code = newRoomCode()
      db.prepare('UPDATE room SET code = ? WHERE name = ?').run(code, room)
      audit(u.id, 'room_recode', `room:${room}`)
      return [200, { code }]
    }
    if (action === 'kick') {
      const t = state.members[str(b.member)]
      if (!t || !(room in t.rooms)) return [404, { error: 'not_in_room' }]
      audit(u.id, 'member_kick', `room:${room}`, { member: t.rooms[room] })
      kickMember(t, room)
      return [200, { ok: true }]
    }
    const target = userById(Number(b.user))
    if (!target) return [404, { error: 'unknown_user' }]
    if (action === 'owner') {
      setOwner(room, target)
      audit(u.id, 'room_owner', `room:${room}`, { user: target.login })
      return [200, { owner: target.name }]
    }
    if (action === 'remove') {
      if (target.id === u.id) return [400, { error: 'self', detail: '자기 자신은 나가기로 하세요' }]
      if (membership(room, target.id)?.status !== 'joined') return [404, { error: 'not_joined' }]
      leaveRoom(room, target, `${target.name} 님이 내보내졌습니다 (${u.name})`)
      audit(u.id, 'room_remove', `room:${room}`, { user: target.login })
      return [200, { ok: true }]
    }
    if (membership(room, target.id)?.status !== 'pending') return [404, { error: 'not_pending' }]
    if (action === 'approve') joinRoom(room, target)
    else rejectJoin(room, target.id)
    audit(u.id, `room_${action}`, `room:${room}`, { user: target.login })
    return [200, { ok: true }]
  }],
  [/^\/members\/([^/]+)\/revoke$/, (u, _b, m) => {
    const target = state.members[m[1]!]
    if (!target || !(ownsMember(u.id, m[1]!) || isSuper(u))) return [404, { error: 'unknown_member' }]
    audit(u.id, 'member_revoke', `member:${target.id}`, { rooms: target.rooms })
    revokeMember(target)
    unlinkMember(target.id)
    return [200, { ok: true }]
  }],
  [/^\/users\/(\d+)\/(approve|reject|role|disable|enable|password)$/, (u, b, m) => {
    const target = userById(Number(m[1]))
    const action = m[2]!
    if (!target) return [404, { error: 'unknown_user' }]
    if (!isAdmin(u)) return [403, { error: 'forbidden' }]
    if (target.id === u.id) return [400, { error: 'self', detail: '자기 계정에는 할 수 없습니다' }]
    if (isSuper(target) && !isSuper(u)) return [403, { error: 'forbidden', detail: '슈퍼관리자 계정은 슈퍼관리자만 다룹니다' }]
    if (action === 'role') {
      const role = str(b.role) as Role
      if (!isSuper(u) || !ROLES.includes(role)) return [403, { error: 'forbidden' }]
      setRole(target.id, role)
      audit(u.id, 'user_role', `user:${target.login}`, { role })
      return [200, { ok: true }]
    }
    if (action === 'password') {
      if (!isSuper(u)) return [403, { error: 'forbidden' }]
      const p = passProblem(String(b.next ?? ''))
      if (p) return [400, { error: 'weak_pass', detail: p }]
      setPassword(target.id, String(b.next), true)
      audit(u.id, 'user_temp_password', `user:${target.login}`)
      return [200, { ok: true }]
    }
    if (action === 'disable' || action === 'enable') {
      if (target.status !== 'approved') return [403, { error: 'forbidden' }]
      setDisabled(target.id, action === 'disable')
      if (action === 'disable') for (const mem of membersOf(target.id)) { revokeMember(mem); unlinkMember(mem.id) } // 플러그인으로도 못 들어오게
      audit(u.id, `user_${action}`, `user:${target.login}`)
      return [200, { ok: true }]
    }
    if (target.status !== 'pending') return [403, { error: 'forbidden' }]
    if (action === 'approve') db.prepare("UPDATE user SET status = 'approved' WHERE id = ?").run(target.id)
    else { db.prepare('DELETE FROM user WHERE id = ?').run(target.id); db.prepare('DELETE FROM user_role WHERE user_id = ?').run(target.id) }
    audit(u.id, `user_${action}`, `user:${target.login}`)
    return [200, { ok: true }]
  }],
]

// ── 페이지 헤더 ───────────────────────────────────────────────────────────────

/** chat.html 과 그 인라인 스크립트의 CSP 해시. 파일을 고치면 서버를 다시 띄운다 */
function page(): { html: Buffer; csp: string } {
  const html = readFileSync(CHAT_HTML)
  const scripts = [...html.toString().matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => `'sha256-${createHash('sha256').update(m[1]!).digest('base64')}'`)
  return { html, csp: `default-src 'none'; script-src ${scripts.join(' ')}; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` }
}
let cached: ReturnType<typeof page> | undefined
const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'cache-control': 'no-store' }
const ip = (req: IncomingMessage): string => req.socket.remoteAddress ?? ''
const cookieOf = (req: IncomingMessage): string | undefined => /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
const setCookie = (token: string, maxAge = Math.floor(SESSION_TTL_MS / 1000)): string => `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${COOKIE_SECURE ? '; Secure' : ''}`

// ── 진입점 ────────────────────────────────────────────────────────────────────

export function web(req: IncomingMessage, res: ServerResponse): void {
  const reply = (code: number, body: unknown, headers: Record<string, string> = {}): void => { res.writeHead(code, { 'content-type': 'application/json', ...SECURITY_HEADERS, ...headers }); res.end(JSON.stringify(body)) }
  const url = (req.url ?? '').split('?')[0]!
  const token = cookieOf(req)
  const u = sessionUser(token)
  if (req.method === 'GET' && url === '/chat') {
    cached ??= page()
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': cached.csp, ...SECURITY_HEADERS })
    return void res.end(cached.html)
  }
  if (req.method === 'GET' && url === '/chat/data') return u ? reply(200, data(u)) : reply(401, { error: 'unauthorized' })
  if (req.method === 'GET' && url === '/favicon.ico') { res.writeHead(204); return void res.end() }
  if (req.method !== 'POST') return reply(404, { error: 'not_found' })
  // 다른 사이트의 폼이나 스크립트가 쿠키를 업고 부르지 못하게. 브라우저가 아닌 호출은 sec-fetch-site 를 안 보낸다
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return reply(403, { error: 'csrf' })
  if ((req.headers['content-type'] ?? '').split(';')[0]!.trim() !== 'application/json') return reply(415, { error: 'json_required' })
  let raw = ''
  req.on('data', c => { raw += c; if (raw.length > BODY_MAX) { reply(413, { error: 'too_large' }); req.destroy() } })
  req.on('end', () => {
    if (res.writableEnded) return
    let b: Body
    try { b = JSON.parse(raw || '{}') } catch { return reply(400, { error: 'bad_json' }) }
    if (typeof b !== 'object' || b === null || Array.isArray(b)) return reply(400, { error: 'bad_json' })
    if (url === '/signup') {
      if (overLimit(`signup:${ip(req)}`, 5, 3600_000)) return reply(429, { error: 'too_many', detail: '가입 시도가 너무 많습니다. 한 시간 뒤에 다시 하세요' })
      const err = signup(str(b.login).toLowerCase(), String(b.pass ?? ''), str(b.name))
      if (err) return reply(err.error === 'login_taken' ? 409 : 400, err)
      audit(null, 'signup', `user:${str(b.login).toLowerCase()}`)
      return reply(200, { ok: true, status: 'pending' })
    }
    if (url === '/login') {
      const key = str(b.user).toLowerCase()
      if (loginLocked(key) || overLimit(`login-ip:${ip(req)}`, 30, 600_000)) return reply(429, { error: 'locked', detail: '시도가 너무 많습니다. 10분 뒤에 다시 하세요' })
      const r = login(key, String(b.pass ?? ''))
      if ('error' in r) {
        if (r.error === 'unauthorized') { loginFailed(key); audit(null, 'login_fail', `user:${key}`, { ip: ip(req) }); return void setTimeout(() => reply(401, { error: 'unauthorized' }), LOGIN_DELAY_MS) }
        return reply(403, { error: r.error, detail: r.error === 'pending' ? '관리자 승인을 기다리는 계정입니다' : '비활성화된 계정입니다' })
      }
      loginOk(key)
      audit(r.user.id, 'login', `user:${key}`, { ip: ip(req) })
      return reply(200, { ok: true, name: r.user.name, mustChangePass: r.user.mustChangePass }, { 'set-cookie': setCookie(createSession(r.user.id)) })
    }
    if (url === '/logout') {
      if (token) deleteSession(token)
      return reply(200, { ok: true }, { 'set-cookie': setCookie('', 0) })
    }
    if (!u) return reply(401, { error: 'unauthorized' })
    if (u.mustChangePass && url !== '/me/password') return reply(403, { error: 'must_change_pass', detail: '먼저 비밀번호를 바꾸세요' })
    for (const [re, fn] of routes) {
      const m = re.exec(url)
      if (m) { const [code, out] = fn(u, b, m); return reply(code, out) }
    }
    reply(404, { error: 'not_found' })
  })
}
