// ============================================================================
// user.ts : 페이지 로그인 계정 관리 명령. 서버와 같은 state.db 를 쓴다 (RELAY_STATE 로 지정)
//   npm run user -- add <이메일> <비밀번호> [이름]    승인된 계정을 만들거나 비밀번호를 바꾸고 system_admin 역할을 준다
// ============================================================================
import './relay.ts' // db 를 연다
import { addUser, migrate } from './web.ts'

const [cmd, login, pass, name] = process.argv.slice(2)
if (cmd !== 'add' || !login || !pass) {
  process.stderr.write('사용법: npm run user -- add <이메일> <비밀번호> [이름]\n')
  process.exit(1)
}
migrate()
addUser(login, pass, name)
process.stdout.write(`계정 ${login} (${name ?? login}) 에 system_admin 역할을 주었습니다\n`)
