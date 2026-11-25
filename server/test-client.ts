// ============================================================================
// test-client.ts : 테스트에서 쓰는 플러그인 흉내. relay.test.ts 와 web.test.ts 가 같이 쓴다
// ----------------------------------------------------------------------------
// 요청에 id 를 붙이고 같은 id 의 응답을 기다린다. id 없는 프레임(푸시)은 pushes 에 쌓아 두고 nextPush() 로 하나씩 꺼낸다.
// ============================================================================

export type F = Record<string, unknown> & { type: string }

export class Client {
  ws: WebSocket
  pushes: F[] = []
  waiters: Array<(f: F) => void> = []
  private n = 0
  private pending = new Map<number, (f: F) => void>()
  constructor(url: string) {
    this.ws = new WebSocket(`${url}/ws`) // Node 22 부터 전역 WebSocket 이 있다
    this.ws.onmessage = ev => {
      const f = JSON.parse(String(ev.data)) as F
      if (typeof f.id === 'number' && this.pending.has(f.id)) { this.pending.get(f.id)!(f); this.pending.delete(f.id); return }
      this.pushes.push(f)
      this.waiters.shift()?.(f)
    }
  }
  open(): Promise<void> { return new Promise(r => { this.ws.onopen = () => r() }) }
  req(f: Record<string, unknown>): Promise<F> {
    const id = ++this.n
    this.ws.send(JSON.stringify({ ...f, id }))
    return new Promise(r => this.pending.set(id, r))
  }
  nextPush(): Promise<F> {
    if (this.pushes.length) return Promise.resolve(this.pushes.shift()!)
    return new Promise(r => this.waiters.push(f => { this.pushes.shift(); r(f) }))
  }
}

/** 페이지 HTTP 호출. body 가 null 이면 GET. 응답의 set-cookie 를 돌려줘서 다음 호출에 이어 쓴다 */
export async function api(base: string, path: string, body: unknown, cookie = '', headers: Record<string, string> = {}): Promise<{ status: number; body: any; cookie: string; headers: Headers }> {
  const r = await fetch(`${base}${path}`, {
    method: body === null ? 'GET' : 'POST',
    headers: { cookie, ...(body === null ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === null ? undefined : JSON.stringify(body),
  })
  return { status: r.status, body: await r.json().catch(() => ({})), cookie: r.headers.get('set-cookie')?.split(';')[0] ?? cookie, headers: r.headers }
}
