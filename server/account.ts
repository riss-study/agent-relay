// ============================================================================
// account.ts : 계정, 비밀번호, 역할, 로그인 세션, 시도 제한, 관리 이력
// ----------------------------------------------------------------------------
// 비밀번호는 scrypt 해시("salt$hash")로만 둔다. 세션 토큰도 sha256 해시로만 둔다. DB 가 새어도 토큰은 못 쓴다.
// 로그인 실패 횟수와 가입 시도 횟수는 메모리에 둔다. 서버는 프로세스 하나다.
// ============================================================================

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { db } from './relay.ts'

export const ROLES = ['system_admin', 'admin', 'member'] as const
export type Role = (typeof ROLES)[number]
export interface User { id: number; login: string; name: string; status: string; disabled: boolean; mustChangePass: boolean; roles: Role[] }

export const PASS_MIN = 8
export const NAME_MAX = 40
export const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS ?? 14 * 86400_000) // 마지막 사용 뒤 이 시간이 지나면 다시 로그인한다
export const LOGIN_FAILS = 5 // 한 아이디로 10분에 이만큼 틀리면 잠근다
const LOCK_MS = 10 * 60_000

// ── 비밀번호 ────────────────────────────────────────────────────────────────

const hashPass = (pass: string, salt = randomBytes(16).toString('hex')): string => `${salt}$${scryptSync(pass, salt, 32).toString('hex')}`
const checkPass = (pass: string, stored: string): boolean => timingSafeEqual(Buffer.from(hashPass(pass, stored.split('$')[0])), Buffer.from(stored))
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

/** 비밀번호 규칙. 통과하면 null, 아니면 사람이 읽을 이유 */
export const passProblem = (pass: string): string | null =>
  pass.length < PASS_MIN ? `비밀번호는 ${PASS_MIN}자 이상이어야 합니다` : pass.length > 200 ? '비밀번호가 너무 깁니다' : null

// ── 조회 ────────────────────────────────────────────────────────────────────

interface UserRow { id: number; login: string; name: string; status: string; disabled_at: number | null; must_change_pass: number }
const toUser = (r: UserRow): User => ({
  id: r.id, login: r.login, name: r.name, status: r.status, disabled: r.disabled_at !== null, mustChangePass: r.must_change_pass === 1,
  roles: (db.prepare('SELECT r.name FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = ?').all(r.id) as Array<{ name: Role }>).map(x => x.name),
})
const COLS = 'id, login, name, status, disabled_at, must_change_pass'

export function userById(id: number): User | undefined {
  const r = db.prepare(`SELECT ${COLS} FROM user WHERE id = ?`).get(id) as UserRow | undefined
  return r && toUser(r)
}
export function userByLogin(login: string): User | undefined {
  const r = db.prepare(`SELECT ${COLS} FROM user WHERE login = ?`).get(login.trim().toLowerCase()) as UserRow | undefined
  return r && toUser(r)
}
export const userName = (id: number | null): string => (id === null ? '' : ((db.prepare('SELECT name FROM user WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? ''))
export const isSuper = (u: User): boolean => u.roles.includes('system_admin')
export const isAdmin = (u: User): boolean => isSuper(u) || u.roles.includes('admin')

// ── 만들기와 바꾸기 ─────────────────────────────────────────────────────────

export function setRole(userId: number, role: Role): void {
  db.prepare('DELETE FROM user_role WHERE user_id = ?').run(userId)
  db.prepare('INSERT INTO user_role (user_id, role_id) SELECT ?, id FROM role WHERE name = ?').run(userId, role)
}

/** 승인된 계정을 만들고 역할을 준다. 같은 아이디면 비밀번호와 이름을 그 값으로 바꾼다. `npm run user -- add` 가 부른다 */
export function addUser(login: string, pass: string, name = login, role: Role = 'system_admin'): void {
  db.prepare("INSERT INTO user (login, pass_hash, name, status, created_at) VALUES (?, ?, ?, 'approved', ?) ON CONFLICT(login) DO UPDATE SET pass_hash = excluded.pass_hash, name = excluded.name, status = 'approved', disabled_at = NULL")
    .run(login.trim().toLowerCase(), hashPass(pass), name, Date.now())
  setRole(userByLogin(login)!.id, role)
}

/** .env 의 슈퍼관리자. 없을 때만 만든다. 페이지에서 바꾼 비밀번호를 재시작이 덮어쓰지 않게 하기 위해서다 */
export function seedAdmin(login: string, pass: string, name: string): void {
  if (!userByLogin(login)) addUser(login, pass, name)
}

/** 가입 신청. pending 계정을 만들고 member 역할을 준다. 실패하면 이유를 돌려준다 */
export function signup(login: string, pass: string, name: string): { error: string; detail?: string } | null {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(login) || login.length > 120) return { error: 'invalid', detail: '이메일 모양이 아닙니다' }
  const p = passProblem(pass)
  if (p) return { error: 'weak_pass', detail: p }
  if (!name || name.length > NAME_MAX || /[\p{Cc}]/u.test(name)) return { error: 'invalid', detail: `이름은 1자에서 ${NAME_MAX}자 사이여야 합니다` }
  if (userByLogin(login)) return { error: 'login_taken' }
  db.prepare("INSERT INTO user (login, pass_hash, name, status, created_at) VALUES (?, ?, ?, 'pending', ?)").run(login, hashPass(pass), name, Date.now())
  setRole(userByLogin(login)!.id, 'member')
  return null
}

/** 비밀번호를 바꾸고 그 계정의 로그인 세션을 모두 끊는다. mustChange 면 다음 로그인 때 바꾸게 한다(관리자가 준 임시 비밀번호) */
export function setPassword(userId: number, pass: string, mustChange: boolean): void {
  db.prepare('UPDATE user SET pass_hash = ?, must_change_pass = ? WHERE id = ?').run(hashPass(pass), mustChange ? 1 : 0, userId)
  killSessions(userId)
}
export const verifyPassword = (userId: number, pass: string): boolean =>
  checkPass(pass, (db.prepare('SELECT pass_hash FROM user WHERE id = ?').get(userId) as { pass_hash: string }).pass_hash)

/** 비활성화하면 세션이 끊기고 로그인이 막힌다. 플러그인 멤버는 web.ts 가 같이 폐기한다 */
export function setDisabled(userId: number, on: boolean): void {
  db.prepare('UPDATE user SET disabled_at = ? WHERE id = ?').run(on ? Date.now() : null, userId)
  if (on) killSessions(userId)
}

// ── 로그인 ───────────────────────────────────────────────────────────────────

export type LoginResult = { user: User } | { error: 'unauthorized' | 'pending' | 'disabled' }

/** 아이디와 비밀번호를 본다. 없는 아이디도 해시 한 번을 돌려 시간 차이를 줄인다 */
export function login(loginId: string, pass: string): LoginResult {
  const row = db.prepare('SELECT id, pass_hash FROM user WHERE login = ?').get(loginId.trim().toLowerCase()) as { id: number; pass_hash: string } | undefined
  if (!row) { hashPass(pass); return { error: 'unauthorized' } }
  if (!checkPass(pass, row.pass_hash)) return { error: 'unauthorized' }
  const u = userById(row.id)!
  if (u.disabled) return { error: 'disabled' }
  if (u.status !== 'approved') return { error: 'pending' }
  return { user: u }
}

// ── 세션 ─────────────────────────────────────────────────────────────────────

export function createSession(userId: number): string {
  const token = randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO session (token_hash, user_id, created_at, seen_at) VALUES (?, ?, ?, ?)').run(sha(token), userId, Date.now(), Date.now())
  return token
}

let lastSweep = 0
/** 쿠키 토큰의 주인. 만료됐거나 비활성화된 계정이면 없다. 1분에 한 번만 seen_at 을 갱신한다 */
export function sessionUser(token: string | undefined): User | undefined {
  if (!token) return undefined
  const now = Date.now()
  if (now - lastSweep > 3600_000) { db.prepare('DELETE FROM session WHERE seen_at < ?').run(now - SESSION_TTL_MS); lastSweep = now }
  const h = sha(token)
  const s = db.prepare('SELECT user_id, seen_at FROM session WHERE token_hash = ?').get(h) as { user_id: number; seen_at: number } | undefined
  if (!s || s.seen_at < now - SESSION_TTL_MS) return undefined
  if (now - s.seen_at > 60_000) db.prepare('UPDATE session SET seen_at = ? WHERE token_hash = ?').run(now, h)
  const u = userById(s.user_id)
  return u && !u.disabled && u.status === 'approved' ? u : undefined
}
export const deleteSession = (token: string): void => { db.prepare('DELETE FROM session WHERE token_hash = ?').run(sha(token)) }
export const killSessions = (userId: number): void => { db.prepare('DELETE FROM session WHERE user_id = ?').run(userId) }

// ── 시도 제한 ────────────────────────────────────────────────────────────────
// ponytail: 횟수는 메모리에만 둔다. 재시작하면 비워지고, 서버가 여러 대면 표로 옮긴다

const hits = new Map<string, number[]>()
/** key 가 windowMs 안에 max 번을 넘겼으면 true. 넘기지 않았으면 이번 시도를 적는다 */
export function overLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now()
  const list = (hits.get(key) ?? []).filter(t => t > now - windowMs)
  if (list.length >= max) { hits.set(key, list); return true }
  list.push(now)
  hits.set(key, list)
  return false
}
/** 로그인 실패를 적는다. LOGIN_FAILS 번이면 LOCK_MS 동안 잠긴다 */
export const loginFailed = (key: string): void => { overLimit(`login:${key}`, LOGIN_FAILS, LOCK_MS) }
export const loginLocked = (key: string): boolean => (hits.get(`login:${key}`) ?? []).filter(t => t > Date.now() - LOCK_MS).length >= LOGIN_FAILS
export const loginOk = (key: string): void => { hits.delete(`login:${key}`) }

// ── 관리 이력 ────────────────────────────────────────────────────────────────

/** 누가(actor) 무엇을(action) 어디에(target) 했는지 남긴다. detail 은 JSON 한 덩어리 */
export function audit(actor: number | null, action: string, target: string, detail: Record<string, unknown> = {}): void {
  db.prepare('INSERT INTO audit (ts, actor_id, action, target, detail) VALUES (?, ?, ?, ?, ?)').run(Date.now(), actor, action, target, JSON.stringify(detail))
}
export interface AuditRow { id: number; ts: number; actor: string; action: string; target: string; detail: Record<string, unknown> }
export const auditList = (limit = 200): AuditRow[] =>
  (db.prepare('SELECT a.id, a.ts, a.action, a.target, a.detail, u.name AS actor FROM audit a LEFT JOIN user u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT ?').all(limit) as Array<Omit<AuditRow, 'detail'> & { detail: string }>)
    .map(r => ({ ...r, actor: r.actor ?? '', detail: JSON.parse(r.detail) as Record<string, unknown> }))
