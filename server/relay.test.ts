// ============================================================================
// relay.test.ts : 서버를 실제 포트에 띄우고 플러그인처럼 소켓으로 말을 걸어 검사한다
// ----------------------------------------------------------------------------
// 실행: npm test   (node:test 사용, 외부 테스트 프레임워크 없음)
// 기한 같은 숫자는 환경변수로 짧게 줘서 몇백 ms 안에 끝나게 한다. 환경변수는 relay.ts 를
// import 하기 전에 넣어야 해서 파일 맨 위에서 설정하고 동적 import 를 쓴다.
//
// 세 개의 test 가 있다. 페이지 쪽은 web.test.ts 에 있다.
//   1. 1단계: 참가, 발신, 답장, 무응답, 보관과 재접속, 퇴근과 출근, 담당 이전
//   2. 2단계: 기록, 합의, 방 메모리, 방장 명령(초대, 공지, 제외), 발신 상한
//   3. 3단계: 관리자 HTTP(방장 지정, 토큰 폐기), 재시작 뒤 무응답 타이머 복원(자식 프로세스로 서버를 하나 더 띄운다)
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

process.env.RELAY_STATE = join(mkdtempSync(join(tmpdir(), 'relay-')), 'state.db') // 임시 폴더의 sqlite 파일
process.env.ADMIN_TOKEN = 'adm'
process.env.RELAY_HOLD_GRACE_MS = '200' // 끊긴 세션의 담당 유지 시간
process.env.RELAY_NOACK_MS = '300' // 무응답 판정 시간
process.env.RELAY_SEND_PER_MIN = '8' // 발신 상한 (2단계 테스트에서 넘겨 본다)
import { Client as BaseClient, type F } from './test-client.ts'
const { start } = await import('./relay.ts')
const port = await start(0) // 0 이면 빈 포트를 골라 준다
const url = `ws://localhost:${port}`

/** 이 서버 주소로 묶인 클라이언트 */
class Client extends BaseClient { constructor() { super(url) } }

/** 관리자 HTTP 로 초대코드를 받는다 */
async function invite(room: string, name: string, owner = false): Promise<string> {
  const r = await fetch(`http://localhost:${port}/admin/invite`, { method: 'POST', headers: { authorization: 'Bearer adm' }, body: JSON.stringify({ room, name, owner }) })
  return ((await r.json()) as { code: string }).code
}

/** 초대코드로 참가하고 바로 hello(gateway:true) 까지 마친 클라이언트를 돌려준다 */
async function joinAs(room: string, name: string, session: string, opts: { token?: string; owner?: boolean } = {}): Promise<{ c: Client; token: string }> {
  const c = new Client()
  await c.open()
  const j = await c.req({ type: 'join', v: 5, plugin: '0.10.2', code: await invite(room, name, opts.owner), token: opts.token })
  assert.equal(j.type, 'joined', JSON.stringify(j))
  const w = await c.req({ type: 'hello', v: 5, plugin: '0.10.2', token: j.token, gateway: true, session, rooms: [room] })
  assert.equal(w.type, 'welcome', JSON.stringify(w))
  return { c, token: j.token as string }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

test('1단계: 참가, 발신, 답장, 보관, 담당 이전', async () => {
  assert.equal((await fetch(`http://localhost:${port}/admin/invite`, { method: 'POST' })).status, 401) // 토큰 없이는 거절
  const a = await joinAs('web3', '규영', 's-a')
  const b = await joinAs('web3', '선혁', 's-b')

  // 잘못된 토큰, 구버전 플러그인, 인증 전 요청
  const bad = new Client(); await bad.open()
  assert.equal((await bad.req({ type: 'hello', v: 5, plugin: '0.10.2', token: 'nope', gateway: false })).reason, 'auth_failed')
  assert.equal((await bad.req({ type: 'hello', v: 4, plugin: '0.9.0', token: a.token, gateway: false })).reason, 'plugin_outdated')
  assert.equal((await bad.req({ type: 'send', to: '선혁', text: 'x' })).reason, 'auth_failed')
  bad.ws.close()

  // 발신: 상대가 온라인이면 바로 배달된다
  const sent = await a.c.req({ type: 'send', to: '선혁', text: '배포 언제?' })
  assert.equal(sent.type, 'sent'); assert.equal(sent.state, 'delivered')
  const got = await b.c.nextPush()
  assert.equal(got.type, 'message'); assert.equal(got.from, '규영'); assert.equal(got.thread, sent.thread); assert.equal(got.expect, 'reply')
  assert.equal((await a.c.req({ type: 'send', to: '없음', text: 'x' })).reason, 'unknown_member')

  // 답하기 전에 선혁이 새 대화를 열면 "답 기다리는 스레드가 있다"는 openThread 힌트가 붙는다
  const hint = await b.c.req({ type: 'send', to: '규영', text: '내일요', expect: 'none' })
  assert.equal(hint.openThread, sent.thread)
  await a.c.nextPush()

  // 답장: 상대와 방은 서버가 스레드에서 정한다. 답장했으니 무응답 통지는 오지 않는다
  const rep = await b.c.req({ type: 'reply', thread: sent.thread, text: '내일 오전' })
  assert.equal(rep.type, 'sent'); assert.equal(rep.to, '규영')
  assert.equal((await a.c.nextPush()).text, '내일 오전')

  // 무응답: ack 도 reply 도 없으면 NOACK_MS 뒤에 보낸 사람에게 noack 가 온다
  const q = await a.c.req({ type: 'send', to: '선혁', text: '질문2' })
  await b.c.nextPush()
  await sleep(400)
  const noack = await a.c.nextPush()
  assert.equal(noack.type, 'noack'); assert.equal(noack.thread, q.thread)
  // 무응답 판정을 받은 상대에게 보내면 note:unresponsive 가 붙는다
  assert.equal((await a.c.req({ type: 'send', to: '선혁', text: '질문3', expect: 'none' })).note, 'unresponsive')
  await b.c.nextPush()

  // 상태 조회
  const st = await a.c.req({ type: 'status' })
  assert.deepEqual(st.held, ['web3']); assert.deepEqual((st.roster as any).web3.online.sort(), ['규영', '선혁'])
  assert.deepEqual(st.unresponsive, ['선혁'])
  const d = await a.c.req({ type: 'doctor' })
  assert.equal(d.type, 'doctor'); assert.equal(typeof d.serverTime, 'number'); assert.equal(d.audit, true)

  // 선혁 접속 끊김: 보관됐다가 재접속하면 queued:true 로 배달된다. 담당(held)은 그대로 돌려받는다
  b.c.ws.close()
  await sleep(50)
  const q2 = await a.c.req({ type: 'send', to: '선혁', text: '보관될 것', expect: 'none' })
  assert.equal(q2.state, 'queued')
  const b2 = new Client(); await b2.open()
  const w = await b2.req({ type: 'hello', v: 5, plugin: '0.10.2', token: b.token, gateway: true, session: 's-b', rooms: ['web3'] })
  assert.deepEqual(w.held, ['web3'])
  const late = await b2.nextPush()
  assert.equal(late.text, '보관될 것'); assert.equal(late.queued, true)

  // 퇴근: 보관되고 note:away. 출근하면 pending 건수를 알려주고 배달한다
  assert.equal((await b2.req({ type: 'away', on: true })).away, true)
  const q3 = await a.c.req({ type: 'send', to: '선혁', text: '퇴근 중 발신', expect: 'none' })
  assert.equal(q3.state, 'queued'); assert.equal(q3.note, 'away')
  const back = await b2.req({ type: 'away', on: false })
  assert.equal(back.pending, 1)
  assert.equal((await b2.nextPush()).text, '퇴근 중 발신')

  // 규영의 두 번째 세션: 시작만으로는 담당을 못 가져가고(lost), room 으로 가져오면 stolen 과 room_lost
  const a2 = new Client(); await a2.open()
  const w2 = await a2.req({ type: 'hello', v: 5, plugin: '0.10.2', token: a.token, gateway: true, session: 's-a2', rooms: ['web3'] })
  assert.deepEqual(w2.held, []); assert.deepEqual(w2.lost, ['web3'])
  const r = await a2.req({ type: 'room', rooms: ['web3'] })
  assert.deepEqual(r.stolen, ['web3']); assert.deepEqual(r.held, ['web3'])
  assert.deepEqual(await a.c.nextPush(), { type: 'room_lost', room: 'web3' })
  assert.deepEqual((await a.c.req({ type: 'status' })).heldByOther, ['web3'])

  // 같은 토큰으로 두 번째 방 참가: 기존 신원에 방만 추가된다
  const c = new Client(); await c.open()
  const j = await c.req({ type: 'join', v: 5, plugin: '0.10.2', code: await invite('infra', 'kyu'), token: a.token })
  assert.deepEqual(j.rooms, { web3: '규영', infra: 'kyu' })
  assert.equal((await c.req({ type: 'join', v: 5, plugin: '0.10.2', code: 'TR-0000-0000' })).reason, 'invalid_code')

  // 끊긴 세션의 담당은 HOLD_GRACE_MS 뒤에 풀려서 새 세션이 받을 수 있다
  a2.ws.close()
  await sleep(300)
  const w3 = await c.req({ type: 'hello', v: 5, plugin: '0.10.2', token: a.token, gateway: true, session: 's-a3', rooms: ['web3', 'infra'] })
  assert.deepEqual(w3.held, ['web3', 'infra'])
  for (const x of [a.c, b2, c]) x.ws.close()
})

test('2단계: 기록, 합의, 방 메모리, 방장 명령, 발신 상한', async () => {
  // 별도의 방 "ops". 지민이 방장이고 하늘이 멤버
  const owner = await joinAs('ops', '지민', 's-o', { owner: true })
  const mem = await joinAs('ops', '하늘', 's-m')

  // 기록: 주고받은 것이 오래된 순으로 나오고 당사자만 본다
  const s1 = await owner.c.req({ type: 'send', to: '하늘', text: '첫 질문' })
  await mem.c.nextPush()
  await sleep(2) // 질문과 답의 ts 가 같은 밀리초에 찍히면 아래 before 검사가 둘을 못 가른다
  await mem.c.req({ type: 'reply', thread: s1.thread, text: '첫 답' })
  await owner.c.nextPush()
  const h = await owner.c.req({ type: 'history', peer: '하늘' })
  assert.equal(h.type, 'history')
  assert.deepEqual((h.entries as any[]).map(e => [e.from, e.to, e.text]), [['지민', '하늘', '첫 질문'], ['하늘', '지민', '첫 답']])
  assert.equal((await owner.c.req({ type: 'history', limit: 1 })).more, true)
  const th = await owner.c.req({ type: 'history', thread: s1.thread, limit: 1 })
  assert.equal((th.entries as any[])[0].text, '첫 답')
  const prev = await owner.c.req({ type: 'history', peer: '하늘', before: (th.entries as any[])[0].ts }) // 이전 페이지
  assert.deepEqual((prev.entries as any[]).map(e => e.text), ['첫 질문']); assert.equal(prev.more, false)

  // 합의: 제안하면 kind:agree_propose 메시지가 가고 confirm 하면 목록에 남는다
  const ag = await owner.c.req({ type: 'agree_propose', to: '하늘', summary: '금요일 배포 금지', details: '주말 호출 방지' })
  assert.equal(ag.type, 'agree_ok'); assert.equal(ag.state, 'delivered')
  const prop = await mem.c.nextPush()
  assert.equal(prop.kind, 'agree_propose'); assert.equal(prop.agree, ag.agree)
  assert.equal((await owner.c.req({ type: 'agree_resolve', agree: ag.agree, result: 'confirm' })).reason, 'agree_not_mine') // 제안자는 확정 못 한다
  assert.deepEqual(((await mem.c.req({ type: 'agree_list' })).pending as any[]).map(p => p.summary), ['금요일 배포 금지'])
  const res = await mem.c.req({ type: 'agree_resolve', agree: ag.agree, result: 'confirm' })
  assert.equal(res.type, 'agree_resolved'); assert.equal(res.result, 'confirm')
  const sys = await owner.c.nextPush()
  assert.equal(sys.from, '_system'); assert.match(String(sys.text), /합의 확정/)
  const list = await owner.c.req({ type: 'agree_list' })
  assert.equal((list.entries as any[]).length, 1); assert.equal((list.entries as any[])[0].details, '주말 호출 방지')
  assert.equal((await mem.c.req({ type: 'agree_resolve', agree: ag.agree, result: 'reject' })).reason, 'agree_not_found') // 이미 처리됨

  // 방 메모리: 방장만 쓴다. rev 가 어긋나면 거절. 바뀌면 그 방 담당 세션 전부에 room_memory 푸시
  const g0 = await mem.c.req({ type: 'memory_get', room: 'ops' })
  assert.equal(g0.owner, false); assert.equal((g0.memory as any).rev, 0)
  assert.equal((await mem.c.req({ type: 'memory_set', room: 'ops', rev: 0, description: 'x', items: [] })).reason, 'not_room_owner')
  assert.equal((await owner.c.req({ type: 'memory_set', room: 'ops', rev: 9, description: 'x', items: [] })).reason, 'memory_conflict')
  assert.equal((await owner.c.req({ type: 'memory_set', room: 'ops', rev: 0, description: '', items: [{ text: 'team_send 금지' }] })).reason, 'memory_tool_name')
  assert.equal((await owner.c.req({ type: 'memory_set', room: 'ops', rev: 0, description: '', items: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }] })).reason, 'memory_too_many_items')
  const set = await owner.c.req({ type: 'memory_set', room: 'ops', rev: 0, description: '운영 방', items: [{ text: '배포는 오전에만' }] })
  assert.equal(set.type, 'memory_ok'); assert.equal((set.memory as any).rev, 1)
  const rm = await mem.c.nextPush()
  assert.equal(rm.type, 'room_memory'); assert.equal(rm.rev, 1); assert.match(String(rm.text), /배포는 오전에만/)
  await owner.c.nextPush() // 방장 세션에도 같은 푸시가 간다

  // 메모리 제안: 방장에게 kind:memory_propose 로 가고, approve 하면 메모리에 들어가며 제안자에게 알림
  const mp = await mem.c.req({ type: 'memory_propose', room: 'ops', text: '금요일 배포 금지' })
  assert.equal(mp.type, 'memory_proposed'); assert.equal(mp.to, 'owner'); assert.match(String(mp.proposal), /^mp-/)
  const pm = await owner.c.nextPush()
  assert.equal(pm.kind, 'memory_propose'); assert.match(String(pm.text), new RegExp(String(mp.proposal)))
  assert.equal((await mem.c.req({ type: 'memory_resolve', proposal: mp.proposal, result: 'approve' })).reason, 'not_room_owner')
  const mr = await owner.c.req({ type: 'memory_resolve', proposal: mp.proposal, result: 'approve' })
  assert.equal(mr.type, 'memory_resolved'); assert.equal((mr.memory as any).items.length, 2); assert.equal((mr.memory as any).rev, 2)
  assert.equal((await mem.c.nextPush()).type, 'room_memory')
  assert.match(String((await mem.c.nextPush()).text), /메모리 제안 승인/)
  await owner.c.nextPush()
  assert.equal((await owner.c.req({ type: 'memory_resolve', proposal: mp.proposal, result: 'approve' })).reason, 'proposal_not_found')
  // 선접속(gateway:false) welcome 에 메모리 완성 문장이 실린다
  const peek = new Client(); await peek.open()
  const pw = await peek.req({ type: 'hello', v: 5, plugin: '0.10.2', token: mem.token, gateway: false })
  assert.equal((pw.memory as any).ops.rev, 2); assert.match(String(pw.memoryText), /금요일 배포 금지/)
  peek.ws.close()

  // 방장 명령: 초대코드 발급으로 새 멤버가 들어오고, 공지는 전원에게 kind:notice 로 간다
  assert.equal((await mem.c.req({ type: 'room_invite', room: 'ops', name: '새싹' })).reason, 'not_room_owner')
  const inv = await owner.c.req({ type: 'room_invite', room: 'ops', name: '새싹' })
  assert.match(String(inv.code), /^TR-/)
  const nw = new Client(); await nw.open()
  const nj = await nw.req({ type: 'join', v: 5, plugin: '0.10.2', code: inv.code })
  assert.equal(nj.name, '새싹')
  await nw.req({ type: 'hello', v: 5, plugin: '0.10.2', token: nj.token, gateway: true, session: 's-n', rooms: ['ops'] })
  const nt = await owner.c.req({ type: 'room_notice', room: 'ops', text: '오늘 배포 없음' })
  assert.equal(nt.type, 'room_notice_ok'); assert.equal(nt.delivered, 2); assert.equal(nt.queued, 0)
  const notice = await nw.nextPush()
  assert.equal(notice.kind, 'notice')
  assert.equal((await nw.req({ type: 'reply', thread: notice.thread, text: 'x' })).reason, 'notice_no_reply')
  await mem.c.nextPush()

  // 제외: 그 방에서만 빠진다. 보내려 하면 unknown_member
  assert.equal((await owner.c.req({ type: 'room_kick', room: 'ops', name: '없음' })).reason, 'not_in_room')
  assert.equal((await owner.c.req({ type: 'room_kick', room: 'ops', name: '새싹' })).type, 'room_kick_ok')
  assert.equal((await owner.c.req({ type: 'send', to: '새싹', text: 'x' })).reason, 'unknown_member')

  // 발신 상한: 분당 RELAY_SEND_PER_MIN(8) 건을 넘으면 rate_limited. 하늘은 지금까지 2건(답장, 메모리 제안) 보냈다
  let limited: unknown
  for (let i = 0; i < 7; i++) limited = (await mem.c.req({ type: 'send', to: '지민', text: `n${i}`, expect: 'none' })).reason
  assert.equal(limited, 'rate_limited')

  // 모르는 type
  assert.equal((await owner.c.req({ type: 'whatever' })).reason, 'unsupported')
  for (const x of [owner.c, mem.c, nw]) x.ws.close()
})

/** 관리자 HTTP 호출. 상태 코드와 본문을 돌려준다 */
async function adminPost(path: string, body: unknown, token = 'adm'): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://localhost:${port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() }
}

test('3단계: 방장 지정, 토큰 폐기, 재시작 뒤 무응답 복원', async () => {
  // 방장 없이 둘이 참가한다
  const a = await joinAs('adm', '가람', 's-a')
  const b = await joinAs('adm', '나래', 's-b')
  assert.equal((await a.c.req({ type: 'memory_set', room: 'adm', rev: 0, description: 'x', items: [] })).reason, 'not_room_owner')

  // 관리자 호출: 토큰이 틀리면 401, 모르는 경로는 404, 방에 없는 이름은 404
  assert.equal((await adminPost('/admin/owner', { room: 'adm', name: '가람' }, 'wrong')).status, 401)
  assert.equal((await adminPost('/admin/nothing', {})).status, 404)
  assert.equal((await adminPost('/admin/owner', { room: 'adm', name: '없음' })).status, 404)

  // 방장 지정: 지정 뒤에는 memory_set 이 되고 memory_get.owner 가 true 다
  assert.equal((await adminPost('/admin/owner', { room: 'adm', name: '가람' })).status, 200)
  assert.equal((await a.c.req({ type: 'memory_set', room: 'adm', rev: 0, description: 'x', items: [] })).type, 'memory_ok')
  assert.equal((await a.c.req({ type: 'memory_get', room: 'adm' })).owner, true)
  await b.c.nextPush() // room_memory

  // 토큰 폐기: 나래의 열린 세션에 revoked 가 가고 소켓이 닫힌다. 그 토큰은 더 못 쓰고, 방에서도 사라진다
  const closed = new Promise<void>(r => { b.c.ws.onclose = () => r() })
  const rv = await adminPost('/admin/revoke', { room: 'adm', name: '나래' })
  assert.equal(rv.status, 200); assert.deepEqual(rv.body.rooms, ['adm'])
  assert.equal((await b.c.nextPush()).reason, 'revoked')
  await closed
  const again = new Client(); await again.open()
  assert.equal((await again.req({ type: 'hello', v: 5, plugin: '0.10.2', token: b.token, gateway: false })).reason, 'auth_failed')
  again.ws.close()
  assert.equal((await a.c.req({ type: 'send', to: '나래', text: 'x' })).reason, 'unknown_member')
  assert.deepEqual((await a.c.req({ type: 'status' })).roster, { adm: { online: ['가람'], offline: [] } })
  a.c.ws.close()

  // 재시작 복원: 답을 기다리는 스레드(noackAt 1초 뒤)가 든 state.db 로 서버를 새로 띄우면,
  // 접속한 보낸 사람에게 noack 가 오고 저장된 상태에서 noackAt 이 지워진다
  const seedPath = join(mkdtempSync(join(tmpdir(), 'relay-')), 'state.db')
  const seed = new DatabaseSync(seedPath)
  seed.exec('CREATE TABLE state (id INTEGER PRIMARY KEY, json TEXT NOT NULL)')
  seed.prepare('INSERT INTO state VALUES (1, ?)').run(JSON.stringify({
    members: { x: { id: 'x', token: 'tx', rooms: { r: '보낸이' }, away: false }, y: { id: 'y', token: 'ty', rooms: { r: '받는이' }, away: false } },
    threads: { t1: { id: 't1', room: 'r', a: 'x', b: 'y', awaiting: 'y', noackAt: Date.now() + 1000 } },
  }))
  seed.close()
  const child = spawn(process.execPath, [join(import.meta.dirname, 'relay.ts')], { env: { ...process.env, RELAY_STATE: seedPath, PORT: '0' }, stdio: ['ignore', 'ignore', 'pipe'] })
  const childPort = await new Promise<string>(r => child.stderr.on('data', d => { const m = /:(\d+)\/ws/.exec(String(d)); if (m) r(m[1]!) }))
  const x = new WebSocket(`ws://localhost:${childPort}/ws`)
  const got = new Promise<any>(r => { x.onmessage = ev => { const f = JSON.parse(String(ev.data)); if (f.type === 'noack') r(f) } })
  await new Promise(r => { x.onopen = () => r(null) })
  x.send(JSON.stringify({ type: 'hello', id: 1, v: 5, plugin: '0.10.2', token: 'tx', gateway: true, session: 's-x', rooms: ['r'] }))
  const noack = await got
  assert.equal(noack.thread, 't1'); assert.equal(noack.to, '받는이')
  await sleep(200) // 저장 지연(100ms)보다 길게
  const saved = new DatabaseSync(seedPath).prepare('SELECT json FROM state').get() as { json: string }
  assert.equal(JSON.parse(saved.json).threads.t1.noackAt, undefined)
  x.close(); child.kill()
})
