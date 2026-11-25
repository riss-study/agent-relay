// ============================================================================
// plugin.test.ts : 플러그인을 실제 프로세스로 띄워 MCP(stdio)와 중계 서버 사이를 검사한다
// ----------------------------------------------------------------------------
// 중계 서버는 이 프로세스 안에서 빈 포트로 띄우고, 상대 팀원은 test-client 로 대신한다.
// 실행: node --test plugin/plugin.test.ts
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Client as BaseClient, type F } from '../server/test-client.ts'

process.env.ADMIN_TOKEN = 'adm'
process.env.RELAY_STATE = join(mkdtempSync(join(tmpdir(), 'relay-plugin-')), 'state.db')
const { start } = await import('../server/relay.ts')
const port = await start(0)
const url = `ws://localhost:${port}`
const dir = mkdtempSync(join(tmpdir(), 'relay-plugin-cfg-'))

async function invite(room: string, name: string): Promise<string> {
  const r = await fetch(`http://localhost:${port}/admin/invite`, { method: 'POST', headers: { authorization: 'Bearer adm' }, body: JSON.stringify({ room, name }) })
  return ((await r.json()) as { code: string }).code
}

/** 플러그인 프로세스 하나. JSON-RPC 요청을 보내고 응답과 채널 알림을 따로 모은다 */
class Plugin {
  proc: ChildProcess
  private n = 0
  private pending = new Map<number, (r: any) => void>()
  private notes: any[] = []
  private waiters: Array<(n: any) => void> = []
  constructor(env: Record<string, string>) {
    this.proc = spawn(process.execPath, [join(import.meta.dirname, 'server.ts')], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] })
    createInterface({ input: this.proc.stdout! }).on('line', line => {
      const m = JSON.parse(line)
      if (m.id !== undefined) { this.pending.get(m.id)?.(m); this.pending.delete(m.id); return }
      this.notes.push(m); this.waiters.shift()?.(this.notes.shift())
    })
  }
  req(method: string, params: unknown = {}): Promise<any> {
    const id = ++this.n
    this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise(r => this.pending.set(id, r))
  }
  async tool(name: string, args: unknown = {}): Promise<string> { return (await this.req('tools/call', { name, arguments: args })).result.content[0].text as string }
  notification(): Promise<any> {
    if (this.notes.length) return Promise.resolve(this.notes.shift())
    return new Promise(r => this.waiters.push(r))
  }
  kill(): void { this.proc.kill() }
}

const teamEnv = (cfg: string, session: string): Record<string, string> => ({ AGENT_RELAY_TEAM: '1', AGENT_RELAY_CONFIG: join(dir, cfg), CLAUDE_CODE_SESSION_ID: session })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

test('참가, 수신 알림, 답장, 상태, 재시작 자동 접속', async () => {
  const a = new Plugin(teamEnv('a.json', 's-a'))
  const init = await a.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
  assert.equal(init.result.capabilities.experimental['claude/channel'] !== undefined, true)
  assert.match(init.result.instructions, /team_reply/) // 토큰이 없어도 내장 최소본이 들어간다
  const tools = (await a.req('tools/list')).result.tools as Array<{ name: string }>
  assert.equal(tools.length, 13)
  assert.match(await a.tool('team_status'), /연결돼 있지 않습니다/)

  // 참가하면 토큰이 저장되고 같은 소켓으로 hello 까지 끝나 방을 받는다
  const joined = await a.tool('team_join', { address: `localhost:${port}`, code: await invite('web3', '규영') })
  assert.match(joined, /참가했습니다. 이름: 규영/)
  assert.match(joined, /받는 방: web3/)
  const cfg = JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8'))
  assert.equal(cfg.url, `ws://localhost:${port}/ws`)
  assert.ok(cfg.token)
  assert.deepEqual(cfg.sessions['s-a'], ['web3'])

  // 상대가 보내면 채널 알림으로 온다
  const b = new BaseClient(url); await b.open()
  const bj = await b.req({ type: 'join', v: 5, plugin: 't', code: await invite('web3', '선혁') })
  assert.equal((await b.req({ type: 'hello', v: 5, plugin: 't', token: bj.token, gateway: true, session: 's-b', rooms: ['web3'] })).type, 'welcome')
  assert.equal((await b.req({ type: 'send', to: '규영', text: '배포 언제?' })).state, 'delivered')
  const n = await a.notification()
  assert.equal(n.method, 'notifications/claude/channel')
  assert.equal(n.params.content, '배포 언제?')
  assert.equal(n.params.meta.from, '선혁')
  assert.equal(n.params.meta.room, 'web3')
  assert.match(n.params.meta.thread, /^t-/)

  // 같은 스레드로 답하면 상대에게 푸시가 간다
  assert.match(await a.tool('team_reply', { thread: n.params.meta.thread, message: '내일 오전' }), /선혁에게 전달됨/)
  const push = await b.nextPush()
  assert.equal(push.type, 'message'); assert.equal(push.from, '규영'); assert.equal(push.text, '내일 오전')

  const st = await a.tool('team_status')
  assert.match(st, /받는 중 web3 \(나: 규영\)/)
  assert.match(st, /접속 선혁/)
  assert.match(await a.tool('team_doctor'), /O 서버 연결/)
  assert.match(await a.tool('team_history', { peer: '선혁' }), /선혁 -> 규영 \(t-.*\): 배포 언제\?/)
  assert.match(await a.tool('team_send', { to: '없는사람', message: 'x' }), /팀원이 이 세션이 받는 방에 없습니다/)

  // 다시 켜면 저장된 토큰으로 자동 접속하고 서버가 배포한 규약이 instructions 에 들어간다
  a.kill()
  await sleep(100)
  const a2 = new Plugin(teamEnv('a.json', 's-a'))
  const init2 = await a2.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
  assert.match(init2.result.instructions, /왕복이 세 번을 넘으면/) // server/instructions.md 의 문장
  assert.equal((await b.req({ type: 'send', to: '규영', text: '다시 왔어?' })).state, 'delivered')
  assert.equal((await a2.notification()).params.content, '다시 왔어?')

  // 팀 세션이 아니면 서버에 붙지 않고 안내문만 돌려준다
  const plain = new Plugin({ AGENT_RELAY_CONFIG: join(dir, 'a.json'), CLAUDE_CODE_SESSION_ID: 's-p' })
  assert.match((await plain.req('initialize', { protocolVersion: '2025-06-18' })).result.instructions, /팀 세션이 아니다/)
  assert.match(await plain.tool('team_send', { to: '선혁', message: 'x' }), /팀 세션이 아닙니다/)
  assert.match(await plain.tool('team_doctor'), /X 팀 세션/)
  plain.kill(); a2.kill(); b.ws.close()
})
