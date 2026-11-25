// ============================================================================
// view.ts : 페이지가 30초마다 가져가는 자료 한 덩어리(GET /chat/data)
// ----------------------------------------------------------------------------
// 누가 무엇을 보는가.
//   슈퍼관리자  모든 방(보관된 방 포함)과 모든 기록, 계정 목록, 관리 이력
//   그 외       참가 중이거나 신청 중이거나 나간 방. 기록은 참가 구간(membership_log) 안의 것만
//   관리자 이상 가입 대기 목록과 계정 목록
// ============================================================================

import { db, state, roomMembers, type HistoryEntry } from './relay.ts'
import { type User, auditList, isAdmin, isSuper, userById, userName } from './account.ts'
import { type Interval, type RoomRow, intervalsOf, memberLabel, memberList, memberOwnerName, membersOf, membershipsOf, roomByName } from './rooms.ts'

export function data(u: User): unknown {
  const superUser = isSuper(u)
  const mine = membershipsOf(u.id)
  const statusOf = (room: string): string | null => mine.find(x => x.room === room)?.status ?? null
  // 방 목록. 슈퍼관리자는 표에 있는 방과 플러그인만 쓰는 방 전부
  const names = superUser
    ? [...new Set([...(db.prepare('SELECT name FROM room').all() as unknown as RoomRow[]).map(r => r.name), ...Object.keys(state.rooms), ...(db.prepare('SELECT DISTINCT room FROM history').all() as Array<{ room: string }>).map(r => r.room)])]
    : mine.map(x => x.room).filter(name => !roomByName(name)?.archived_at)
  const rooms = names.map(name => {
    const r = roomByName(name)
    const owner = r?.owner_id === u.id || superUser
    const members = db.prepare("SELECT rm.user_id AS id, u.name, rm.status FROM room_member rm JOIN user u ON u.id = rm.user_id WHERE rm.room = ? AND rm.status != 'left'").all(name) as Array<{ id: number; name: string; status: string }>
    return {
      name, status: statusOf(name), owner: userName(r?.owner_id ?? null), isOwner: owner, archived: !!r?.archived_at,
      code: owner ? r?.code ?? null : null, // 방 코드는 방장과 슈퍼관리자만 본다
      members: owner ? members : members.filter(m => m.status === 'joined'),
      intervals: intervalsOf(u.id, name),
      pluginMembers: roomMembers(name).map(m => ({ id: m.id, name: m.rooms[name]!, user: memberOwnerName(m.id) })),
    }
  })
  // 기록. 슈퍼관리자는 전부, 그 외는 참가 구간 안의 것만
  const windows = new Map<string, Interval[]>(superUser ? [] : names.map(n => [n, intervalsOf(u.id, n)]))
  // 나간 시각과 같은 ms 의 줄은 나갔다는 알림(system)만 포함한다. 같은 ms 에 온 남의 메시지는 나간 뒤 것으로 본다
  const inWindow = (e: HistoryEntry): boolean => (windows.get(e.room) ?? []).some(w => e.ts >= w.joined_at && (w.left_at === null || e.ts < w.left_at || (e.ts === w.left_at && e.sender === 'system')))
  // 이름은 기록에 적힌 당시 이름, 없으면(옛 기록) 지금 방 안 이름, 그래도 없으면 계정에 묶인 이름, 마지막으로 멤버 id
  const labelOf = (memberId: string, room: string, saved: string | null): string => saved ?? state.members[memberId]?.rooms[room] ?? memberLabel(memberId) ?? memberId
  const seen = new Set<string>()
  const messages = []
  for (const e of db.prepare('SELECT * FROM history ORDER BY ts, rowid').all() as unknown as HistoryEntry[]) {
    if (superUser ? !names.includes(e.room) : !inWindow(e)) continue
    // 공지는 받는 사람 수만큼 줄이 있다. 같은 ts 와 보낸 사람이면 하나만 보여 준다
    const key = e.kind === 'notice' ? `${e.ts}|${e.room}|${e.sender}` : ''
    if (key) { if (seen.has(key)) continue; seen.add(key) }
    const system = e.sender === 'system'
    messages.push({ ts: e.ts, room: e.room, from: system ? '' : labelOf(e.sender, e.room, e.sender_name), to: key || system ? '' : labelOf(e.receiver, e.room, e.receiver_name), text: e.text, thread: e.thread, kind: e.kind, expect: e.expect })
  }
  const labels: Record<string, string[]> = {} // 방 이름에서 그 방에 있는 내 멤버 이름들로. 페이지가 내 말풍선을 가르는 데 쓴다
  for (const m of membersOf(u.id)) for (const [room, label] of Object.entries(m.rooms)) (labels[room] ??= []).push(label)
  const pendingUsers = isAdmin(u) ? db.prepare("SELECT id, login, name FROM user WHERE status = 'pending' ORDER BY id").all() : []
  const users = isAdmin(u) // 관리자도 계정을 비활성화할 수 있어서 목록을 본다. 역할과 임시 비밀번호 단추는 페이지가 슈퍼관리자에게만 보여 준다
    ? (db.prepare("SELECT id FROM user WHERE status = 'approved' ORDER BY id").all() as Array<{ id: number }>).map(x => { const t = userById(x.id)!; return { id: t.id, login: t.login, name: t.name, roles: t.roles, disabled: t.disabled, members: memberList(t.id) } })
    : []
  return {
    me: { id: u.id, login: u.login, name: u.name, roles: u.roles, mustChangePass: u.mustChangePass, labels, members: memberList(u.id) },
    rooms, messages, pendingUsers, users, audit: superUser ? auditList() : [],
  }
}
