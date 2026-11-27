// ============================================================================
// schema.ts : 페이지 쪽 표와 마이그레이션
// ----------------------------------------------------------------------------
// 플러그인 상태(state, history)는 relay.ts 가 만들고, 계정과 방 소속 쪽 표는 여기서 만든다.
// 표준 SQL 만 쓴다. MariaDB 로 옮길 때는 AUTOINCREMENT 를 AUTO_INCREMENT 로 바꾸면 된다.
// 배열의 n 번째 항목이 버전 n+1 이다. 한 번 실행된 버전은 schema_version 에 적혀 다시 돌지 않으니
// 이미 배포된 항목은 고치지 말고 새 항목을 뒤에 붙인다.
//
//   user(id, login, pass_hash, name, status, disabled_at, must_change_pass, created_at)
//        status: pending | approved. disabled_at 이 있으면 로그인과 플러그인 참가가 막힌다
//   role(id, name), user_role(user_id, role_id)
//   user_member(user_id, member_id, label)      계정에 묶인 플러그인 멤버. label 은 그 멤버의 이름
//   room(name, code, owner_id, archived_at, created_at)
//   room_member(room, user_id, status, joined_at, left_at)   지금 상태. status: pending | joined | left
//   membership_log(id, room, user_id, joined_at, left_at)    참가 구간 이력. 나간 방의 기록은 이 구간 안만 보인다
//   session(token_hash, user_id, created_at, seen_at)         로그인 쿠키. 토큰은 해시로만 둔다
//   audit(id, ts, actor_id, action, target, detail)           관리 행위 이력
// ============================================================================

import { db } from './relay.ts'

const MIGRATIONS: string[] = [
  // 1. 계정, 역할, 방, 방 소속. 이미 이 표가 있는 DB 에서는 IF NOT EXISTS 로 그냥 지나간다
  `CREATE TABLE IF NOT EXISTS user (id INTEGER PRIMARY KEY AUTOINCREMENT, login TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'approved', created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS role (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
   CREATE TABLE IF NOT EXISTS user_role (user_id INTEGER NOT NULL, role_id INTEGER NOT NULL, PRIMARY KEY (user_id, role_id));
   CREATE TABLE IF NOT EXISTS user_member (user_id INTEGER NOT NULL, member_id TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY (user_id, member_id));
   CREATE TABLE IF NOT EXISTS room (name TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, owner_id INTEGER, created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS room_member (room TEXT NOT NULL, user_id INTEGER NOT NULL, status TEXT NOT NULL, joined_at INTEGER, left_at INTEGER, PRIMARY KEY (room, user_id));
   INSERT OR IGNORE INTO role (name) VALUES ('system_admin'), ('admin'), ('member');`,
  // 2. 계정 비활성화와 임시 비밀번호, 방 보관, 참가 구간 이력, DB 세션, 관리 이력, 방별 기록 인덱스
  `ALTER TABLE user ADD COLUMN disabled_at INTEGER;
   ALTER TABLE user ADD COLUMN must_change_pass INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE room ADD COLUMN archived_at INTEGER;
   CREATE TABLE membership_log (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, user_id INTEGER NOT NULL, joined_at INTEGER NOT NULL, left_at INTEGER);
   INSERT INTO membership_log (room, user_id, joined_at, left_at) SELECT room, user_id, joined_at, left_at FROM room_member WHERE joined_at IS NOT NULL;
   CREATE INDEX membership_log_user ON membership_log (user_id, room);
   CREATE TABLE session (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, seen_at INTEGER NOT NULL);
   CREATE INDEX session_user ON session (user_id);
   CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor_id INTEGER, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS history_room_ts ON history (room, ts);`,
  // 3. 계정 이름을 전체에서 유일하게. 멤버 목록과 승인 대기 목록은 계정 이름으로 사람을 구분한다
  `CREATE UNIQUE INDEX user_name ON user (name);`,
]

/** 아직 안 돈 버전을 순서대로 적용한다. 서버 시작과 계정 명령이 부른다. 한 버전은 트랜잭션 하나다 */
export function migrate(): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)')
  const done = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null }).v ?? 0
  for (let v = done; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[v]!)
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(v + 1)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
}
