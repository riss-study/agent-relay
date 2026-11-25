// ============================================================================
// frames.ts : 플러그인과 서버가 주고받는 JSON 프레임의 타입 정의
// ----------------------------------------------------------------------------
// 웹소켓 텍스트 프레임 하나에 JSON 객체 하나가 실린다. 모든 객체에는 type 문자열이 있다.
// 플러그인이 보내는 "요청"에는 정수 id 가 붙고, 서버의 "응답"은 같은 id 를 돌려준다.
// 서버가 먼저 보내는 "푸시"(message, expired 등)에는 id 가 없다.
//
// 이 파일에는 런타임 코드가 없다(상수 PROTO 하나 제외). 그래서 플러그인 저장소에서도 이 파일을
// 그대로 import 해 양쪽이 같은 타입으로 컴파일 검사를 받을 수 있다.
// 필드 하나하나의 뜻은 docs/wire-protocol.md 에 있다.
// ============================================================================

/** 프로토콜 버전. 플러그인 0.10.2 는 5 를 보내고, 서버가 5 미만이면 기능을 일부 막는다 */
export const PROTO = 5

/** 모든 프레임의 공통 모양. 요청 처리 코드는 일단 이 타입으로 받아서 type 으로 분기한다 */
export type Frame = Record<string, unknown> & { type: string; id?: number }

// ============================================================================
// 플러그인이 보내는 요청
// ============================================================================

/** 접속 인증. gateway:true 면 수신 세션으로 등록되고 rooms 를 담당하려 한다 */
export interface HelloReq {
  type: 'hello'; id: number; v: number; plugin: string; token: string
  gateway: boolean; session?: string; rooms?: string[]; dir?: string; name?: string
}
/** 초대코드로 참가. token 이 있으면 기존 신원에 방만 추가한다 */
export interface JoinReq { type: 'join'; id: number; v: number; plugin: string; code: string; token?: string }
/** 새 대화 시작. to 는 상대 라벨, room 을 생략하면 담당 방에서 찾는다 */
export interface SendReq { type: 'send'; id: number; to: string; text: string; room?: string; expect?: 'reply' | 'none' }
/** 스레드 답장. 상대와 방은 스레드가 정한다 */
export interface ReplyReq { type: 'reply'; id: number; thread: string; text: string; expect?: 'reply' | 'none' }
/** "처리 중" 알림. 무응답 타이머를 해제한다 */
export interface AckReq { type: 'ack'; id: number; thread: string; status: 'working' | 'approval_pending' }
/** 퇴근(on:true), 출근(on:false) */
export interface AwayReq { type: 'away'; id: number; on: boolean }
/** 이 세션의 담당 방을 rooms 로 바꾼다. 다른 세션이 담당 중이면 뺏어 온다 */
export interface RoomReq { type: 'room'; id: number; rooms: string[] }
/** 세션 이름이 바뀌었을 때 알림 */
export interface SessionInfoReq { type: 'session_info'; id: number; name: string }
/** 내가 주고받은 기록 조회. before 는 밀리초 ts, 그 이전만 */
export interface HistoryReq { type: 'history'; id: number; peer?: string; room?: string; thread?: string; limit?: number; before?: number }
/** 합의 제안. to 에게 summary 를 확인해 달라고 보낸다 */
export interface AgreeProposeReq { type: 'agree_propose'; id: number; to: string; summary: string; details?: string; thread?: string; room?: string }
/** 받은 합의 제안을 확정하거나 거절한다 */
export interface AgreeResolveReq { type: 'agree_resolve'; id: number; agree: string; result: 'confirm' | 'reject'; reason?: string }
/** 내가 당사자인 합의 목록 */
export interface AgreeListReq { type: 'agree_list'; id: number; peer?: string }
/** 방 메모리 조회 */
export interface MemoryGetReq { type: 'memory_get'; id: number; room: string }
/** 방 메모리 쓰기(방장만). rev 가 현재와 다르면 거절된다 */
export interface MemorySetReq { type: 'memory_set'; id: number; room: string; rev: number; description: string; items: Array<{ text: string }> }
/** 방 메모리 수정 제안(방장이 아닌 멤버) */
export interface MemoryProposeReq { type: 'memory_propose'; id: number; room: string; text: string }
/** 제안 처리(방장만). replace 는 3칸이 다 찼을 때 바꿀 항목 번호 */
export interface MemoryResolveReq { type: 'memory_resolve'; id: number; proposal: string; result: 'approve' | 'reject'; replace?: number; reason?: string }
/** 방장 명령: 초대코드 발급, 멤버 제외, 공지 */
export interface RoomInviteReq { type: 'room_invite'; id: number; room: string; name: string }
export interface RoomKickReq { type: 'room_kick'; id: number; room: string; name: string }
export interface RoomNoticeReq { type: 'room_notice'; id: number; room: string; text: string }

// ============================================================================
// 서버 응답
// ============================================================================

/** 방 하나의 접속 현황. 값은 라벨이다 */
export interface Roster { online: string[]; offline: string[] }

/** welcome 과 status 가 공유하는 "그 멤버가 보는 현황" */
export interface MemberView {
  rooms: Record<string, string> // 방 이름에서 내 라벨
  held: string[] // 이 세션이 담당하는 방
  heldByOther: string[] // 같은 멤버의 다른 세션이 담당하는 방
  roster: Record<string, Roster>
  unresponsive: string[] // 최근 무응답 판정이 난 라벨
  away: string[] // 퇴근 중인 라벨
}

/** 방 메모리 문서. 설명 한 칸과 항목 최대 3개 */
export interface MemoryDoc { description: string; items: Array<{ text: string }>; rev: number; updatedAt?: number; updatedBy?: string }

/** hello 성공 응답. 규약 본문과 방 메모리가 같이 온다 */
export interface Welcome extends MemberView {
  type: 'welcome'; id: number; v: number
  lost: string[] // 담당하려 했지만 못 받은 방
  protocol: { rev: number; instructions: string }
  memory: Record<string, { rev: number; text: string }>
  memoryText: string // 시스템 프롬프트에 붙일 완성 문장. 없으면 빈 문자열
}
/** join 성공 응답. rooms 는 그 멤버의 모든 소속 방 */
export interface Joined { type: 'joined'; id: number; token: string; name: string; rooms: Record<string, string> }
/** send, reply 성공 응답 */
export interface Sent {
  type: 'sent'; id: number; state: 'delivered' | 'queued'; thread: string; to: string
  note?: 'unresponsive' | 'away' // 상대 상태 참고
  openThread?: string // send 에서만: 상대가 나에게 물어놓고 답을 기다리는 스레드가 있으면 그 id
}
export interface AckOk { type: 'ack_ok'; id: number }
export interface AwayOk { type: 'away_ok'; id: number; away: boolean; pending: number }
export interface RoomOk { type: 'room_ok'; id: number; held: string[]; lost: string[]; stolen: string[] }
export interface Status extends MemberView { type: 'status'; id: number; myAway: boolean }
/** 30초 하트비트의 응답. 플러그인 자가 진단(team_doctor)도 이걸 읽는다 */
export interface Doctor {
  type: 'doctor'; id: number; rooms: Record<string, string>; held: string[]; heldByOther: string[]
  queueForMe: number; away: boolean; serverTime: number; protocolRev: number | null; audit: boolean
}
export interface HistoryEntryWire { ts: number; room: string; from: string; to: string; text: string; thread?: string; truncated?: boolean }
export interface History { type: 'history'; id: number; entries: HistoryEntryWire[]; more: boolean }
export interface AgreeOk { type: 'agree_ok'; id: number; agree: string; state: 'delivered' | 'queued' }
export interface AgreeResolved { type: 'agree_resolved'; id: number; agree: string; result: 'confirm' | 'reject' }
export interface Agrees {
  type: 'agrees'; id: number
  entries: Array<{ agree: string; ts: number; room: string; a: string; b: string; summary: string; details?: string }>
  pending: Array<{ agree: string; a: string; b: string; summary: string }>
}
export interface Memory { type: 'memory'; id: number; memory: MemoryDoc; proposals: Array<{ id: string; fromLabel: string; text: string }>; owner: boolean }
export interface MemoryOk { type: 'memory_ok'; id: number; memory: MemoryDoc }
/** to 는 owner(방장에게 전달), queued(방장 오프라인), self(내가 방장), 그 외 문자열(방장 없음) */
export interface MemoryProposed { type: 'memory_proposed'; id: number; proposal: string; to: string }
export interface MemoryResolved { type: 'memory_resolved'; id: number; room: string; memory: MemoryDoc }
export interface RoomInviteOk { type: 'room_invite_ok'; id: number; code: string }
export interface RoomKickOk { type: 'room_kick_ok'; id: number }
export interface RoomNoticeOk { type: 'room_notice_ok'; id: number; delivered: number; queued: number; skipped: string[] }
/** 실패 응답. reason 은 docs/wire-protocol.md 6절의 코드, detail 은 사람이 읽을 문장 */
export interface ErrorFrame { type: 'error'; id?: number; reason: string; detail?: string }

// ============================================================================
// 서버 푸시 (id 없음). 플러그인은 이걸 <channel> 태그로 세션 대화에 넣는다
// ============================================================================

/** 팀원 메시지. 필드가 그대로 channel 태그 속성이 된다 */
export interface MessagePush {
  type: 'message'; from: string; room: string; text: string; ts: number
  thread?: string; expect?: 'reply' | 'none'
  kind?: 'notice' | 'agree_propose' | 'memory_propose' | 'system'
  agree?: string // kind:agree_propose 일 때 합의 id
  queued?: true // 보관됐다가 늦게 배달될 때
}
/** 보관 기한이 지나 폐기됨 (보낸 사람에게) */
export interface ExpiredPush { type: 'expired'; to: string; room: string; preview: string }
/** 상대가 기한 안에 답도 ack 도 안 함 (보낸 사람에게) */
export interface NoackPush { type: 'noack'; to: string; room: string; thread: string }
/** 다른 세션이 이 방 담당을 가져감 */
export interface RoomLostPush { type: 'room_lost'; room: string }
/** 방 메모리가 바뀜. text 는 완성 문장 */
export interface RoomMemoryPush { type: 'room_memory'; room: string; rev: number; text: string }
