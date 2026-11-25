// ============================================================================
// rooms.ts : 방, 방 소속, 참가 구간 이력, 계정에 묶인 플러그인 멤버
// ----------------------------------------------------------------------------
// 방 소속은 계정(user) 기준이고 플러그인 멤버(토큰)는 계정에 묶인다(user_member).
// 참가와 나가기는 room_member(지금 상태)와 membership_log(구간 이력) 둘 다에 적고, history 에도
// sender 'system' 줄로 남겨 채팅창에 보인다. 어떤 기록도 지우지 않는다.
// ============================================================================

import { randomBytes } from 'node:crypto'
import { db, state, save, sessions as pluginSessions, roomMembers, kickMember, newInviteCode, PENDING_TTL_MS, type Member } from './relay.ts'
import { type User, NAME_MAX } from './account.ts'

export interface RoomRow { name: string; code: string; owner_id: number | null; archived_at: number | null }
export interface Membership { room: string; user_id: number; status: string; joined_at: number | null; left_at: number | null }
export interface Interval { joined_at: number; left_at: number | null }

export const roomByName = (name: string): RoomRow | undefined => db.prepare('SELECT name, code, owner_id, archived_at FROM room WHERE name = ?').get(name) as RoomRow | undefined
export const roomByCode = (code: string): RoomRow | undefined => db.prepare('SELECT name, code, owner_id, archived_at FROM room WHERE code = ?').get(code.trim().toUpperCase()) as RoomRow | undefined
export const membership = (room: string, userId: number): Membership | undefined => db.prepare('SELECT * FROM room_member WHERE room = ? AND user_id = ?').get(room, userId) as Membership | undefined
export const membershipsOf = (userId: number): Membership[] => db.prepare('SELECT * FROM room_member WHERE user_id = ?').all(userId) as unknown as Membership[]
/** 이 계정이 이 방에 있었던 구간들. 나간 방의 기록은 이 구간 안만 보인다 */
export const intervalsOf = (userId: number, room: string): Interval[] => db.prepare('SELECT joined_at, left_at FROM membership_log WHERE user_id = ? AND room = ? ORDER BY joined_at').all(userId, room) as unknown as Interval[]
export const newRoomCode = (): string => `RM-${randomBytes(2).toString('hex').toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`
/** 방 이름 규칙. 통과하면 null */
export const roomNameProblem = (name: string): string | null =>
  !name || name.length > NAME_MAX || /[\p{Cc}/]/u.test(name) ? `방 이름은 1자에서 ${NAME_MAX}자 사이이고 빗금을 쓸 수 없습니다` : null

/** 참가와 나가기 같은 일을 history 에 남긴다. 보낸 사람 칸은 'system' 이고 페이지는 본문만 보여 준다 */
export function event(room: string, kind: 'join' | 'leave' | 'system', text: string, ts = Date.now()): void {
  db.prepare("INSERT INTO history (ts, room, sender, receiver, text, thread, kind, expect) VALUES (?, ?, 'system', '', ?, NULL, ?, NULL)").run(ts, room, text, kind)
}

// ── 계정에 묶인 플러그인 멤버 ────────────────────────────────────────────────

/** 계정의 플러그인 멤버들. 상태에서 사라진 멤버(폐기된 토큰)는 뺀다 */
export const membersOf = (userId: number): Member[] =>
  (db.prepare('SELECT member_id FROM user_member WHERE user_id = ?').all(userId) as Array<{ member_id: string }>).flatMap(r => state.members[r.member_id] ?? [])

/** 계정의 멤버 중 이름이 label 인 것. join 때 같은 이름이면 새 멤버를 만들지 않고 이 멤버에 방을 더한다 */
export function userMember(userId: number, label: string): Member | undefined {
  const r = db.prepare('SELECT member_id FROM user_member WHERE user_id = ? AND label = ?').get(userId, label) as { member_id: string } | undefined
  return r ? state.members[r.member_id] : undefined
}

/** 멤버가 묶인 계정 이름. 관리자 HTTP 초대코드로 들어온 멤버는 빈칸 */
export const memberOwnerName = (memberId: string): string =>
  (db.prepare('SELECT u.name FROM user_member um JOIN user u ON u.id = um.user_id WHERE um.member_id = ?').get(memberId) as { name: string } | undefined)?.name ?? ''
/** 계정에 묶인 멤버의 이름(label). 방에서 빠진 멤버의 옛 기록에 이름을 붙일 때 쓴다 */
export const memberLabel = (memberId: string): string | undefined => (db.prepare('SELECT label FROM user_member WHERE member_id = ?').get(memberId) as { label: string } | undefined)?.label
export const ownsMember = (userId: number, memberId: string): boolean => !!db.prepare('SELECT 1 FROM user_member WHERE user_id = ? AND member_id = ?').get(userId, memberId)
export const unlinkMember = (memberId: string): void => { db.prepare('DELETE FROM user_member WHERE member_id = ?').run(memberId) }

/** join 때 relay.ts 가 부른다. 멤버를 계정에 묶고, 그 계정이 방장인 방에 이 계정의 멤버가 아직 방장이 아니면 이 멤버를 플러그인 방장으로 둔다 */
export function linkMember(userId: number, m: Member, label: string): void {
  db.prepare('INSERT OR IGNORE INTO user_member (user_id, member_id, label) VALUES (?, ?, ?)').run(userId, m.id, label)
  const mine = new Set(membersOf(userId).map(x => x.id))
  for (const r of db.prepare('SELECT name FROM room WHERE owner_id = ?').all(userId) as Array<{ name: string }>) {
    const room = (state.rooms[r.name] ??= {})
    if (!room.owner || !mine.has(room.owner)) room.owner = m.id
  }
}

export interface MemberInfo { id: string; label: string; rooms: string[]; online: boolean }
/** 계정의 플러그인 멤버 목록. 페이지의 계정 관리와 내 멤버 관리가 쓴다 */
export function memberList(userId: number): MemberInfo[] {
  return (db.prepare('SELECT member_id, label FROM user_member WHERE user_id = ?').all(userId) as Array<{ member_id: string; label: string }>)
    .flatMap(r => {
      const m = state.members[r.member_id]
      return m ? [{ id: m.id, label: r.label, rooms: Object.keys(m.rooms), online: [...pluginSessions.values()].some(s => s.member === m.id && s.sock !== null) }] : []
    })
}

// ── 참가와 나가기 ────────────────────────────────────────────────────────────

export function joinRoom(room: string, u: User): void {
  const now = Date.now()
  db.prepare("INSERT INTO room_member (room, user_id, status, joined_at, left_at) VALUES (?, ?, 'joined', ?, NULL) ON CONFLICT(room, user_id) DO UPDATE SET status = 'joined', joined_at = excluded.joined_at, left_at = NULL").run(room, u.id, now)
  db.prepare('INSERT INTO membership_log (room, user_id, joined_at, left_at) VALUES (?, ?, ?, NULL)').run(room, u.id, now)
  event(room, 'join', `${u.name} 님이 참가했습니다`, now)
}
export function requestJoin(room: string, u: User): void {
  db.prepare("INSERT INTO room_member (room, user_id, status) VALUES (?, ?, 'pending') ON CONFLICT(room, user_id) DO UPDATE SET status = 'pending'").run(room, u.id)
}
export const rejectJoin = (room: string, userId: number): void => { db.prepare("DELETE FROM room_member WHERE room = ? AND user_id = ? AND status = 'pending'").run(room, userId) }

/** 방에서 뺀다. 본인이 나가든 방장이 내보내든 같은 길이다. 구간 이력을 닫고 플러그인 멤버도 그 방에서 뺀다 */
export function leaveRoom(room: string, u: User, text = `${u.name} 님이 나갔습니다`): void {
  const now = Date.now()
  db.prepare("UPDATE room_member SET status = 'left', left_at = ? WHERE room = ? AND user_id = ?").run(now, room, u.id)
  db.prepare('UPDATE membership_log SET left_at = ? WHERE room = ? AND user_id = ? AND left_at IS NULL').run(now, room, u.id)
  for (const m of membersOf(u.id)) if (room in m.rooms) kickMember(m, room)
  event(room, 'leave', text, now) // 나간 시각과 같은 ts 라야 나간 사람의 구간 안에 들어간다
}

/** 방장 지정. 지정된 계정은 바로 참가되고, 그 계정의 플러그인 멤버가 방에 있으면 플러그인 쪽 방장도 바뀐다 */
export function setOwner(room: string, u: User): void {
  db.prepare('UPDATE room SET owner_id = ? WHERE name = ?').run(u.id, room)
  if (membership(room, u.id)?.status !== 'joined') joinRoom(room, u)
  const m = membersOf(u.id).find(x => room in x.rooms)
  if (m) { (state.rooms[room] ??= {}).owner = m.id; save() }
}

export function createRoom(name: string, owner: User): void {
  db.prepare('INSERT INTO room (name, code, owner_id, created_at) VALUES (?, ?, ?, ?)').run(name, newRoomCode(), owner.id, Date.now())
  state.rooms[name] ??= {}
  setOwner(name, owner)
}

/** 방 보관. 모든 계정을 내보내고(구간 이력을 닫고) 플러그인 멤버도 전부 뺀다. 기록은 남고 슈퍼관리자만 본다 */
export function archiveRoom(room: string, by: User): void {
  const now = Date.now()
  db.prepare('UPDATE room SET archived_at = ? WHERE name = ?').run(now, room)
  db.prepare("UPDATE room_member SET status = 'left', left_at = ? WHERE room = ? AND status != 'left'").run(now, room)
  db.prepare('UPDATE membership_log SET left_at = ? WHERE room = ? AND left_at IS NULL').run(now, room)
  for (const m of roomMembers(room)) kickMember(m, room)
  event(room, 'system', `${by.name} 님이 방을 보관했습니다`, now)
}
export function unarchiveRoom(room: string, by: User): void {
  db.prepare('UPDATE room SET archived_at = NULL WHERE name = ?').run(room)
  event(room, 'system', `${by.name} 님이 방을 복원했습니다`)
}

/** 플러그인 참가 코드. 계정 id 를 묶어 두면 join 때 relay.ts 가 이 계정의 멤버로 연결한다 */
export function issueCode(room: string, u: User, label: string, owner: boolean): { code: string } | { error: string; detail?: string } {
  if (label.length > NAME_MAX || /[\p{Cc}]/u.test(label)) return { error: 'invalid', detail: `이름은 ${NAME_MAX}자 이하여야 합니다` }
  // 이 방의 다른 플러그인 멤버 이름이나 다른 계정 이름과 겹치면 안 된다. 계정 이름은 그 사람이 코드를 받을 때 기본값이라서다
  const otherUser = db.prepare("SELECT 1 FROM room_member rm JOIN user u ON u.id = rm.user_id WHERE rm.room = ? AND rm.user_id != ? AND rm.status != 'left' AND u.name = ?").get(room, u.id, label)
  const mine = new Set(membersOf(u.id).map(x => x.id))
  if (otherUser || roomMembers(room).some(x => x.rooms[room] === label && !mine.has(x.id))) return { error: 'label_taken', detail: `'${label}' 이름은 이 방에서 다른 사람이 씁니다` }
  const code = newInviteCode()
  state.invites[code] = { room, name: label, owner, expires: Date.now() + PENDING_TTL_MS, user: u.id }
  save()
  return { code }
}
