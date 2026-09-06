// BMW 드라이빙 센터 Owners 프로그램 예약 자리 감시.
// 잔여석이 0 → 1 이상으로 바뀐 회차(취소표·추가 오픈)와 새로 열린 날짜를 디스코드로 알린다.
//
//   node src/watch-driving-center.js            # 1회 실행 (변화 있으면 알림 + 상태 저장)
//   node src/watch-driving-center.js --loop     # LOOP_MINUTES 동안 POLL_MINUTES 간격으로 반복 (GitHub Actions 용)
//   node src/watch-driving-center.js --dry-run  # 조회·비교만, 알림·저장 생략
//   node src/watch-driving-center.js --status   # 현재 예약 현황을 디스코드로 한 번 보내기 (웹훅 확인용)
//
// GitHub Actions 의 짧은 주기 cron(*/10) 은 실제로는 2~4시간씩 밀려서 취소표를 놓친다.
// 그래서 6시간마다 잡을 하나 띄우고, 그 안에서 --loop 로 5분마다 조회한다 (공개 레포는 Actions 시간 무제한).
// 상태 파일은 바뀔 때마다 즉시 커밋(COMMIT_STATE=1)해서 잡이 중간에 죽어도 다음 잡이 같은 자리를 다시 알리지 않는다.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROGRAMS, fetchProgramSnapshot, diffSnapshot, openedEmbed, newDatesEmbed, statusEmbed, fmtDate } from './drivingCenter.js';
import { postToWebhook } from './discord.js';

try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch {
  /* .env 없으면 환경변수만 사용 */
}

const DRY_RUN = process.argv.includes('--dry-run');
const STATUS = process.argv.includes('--status');
const LOOP = process.argv.includes('--loop');
const LOOP_MINUTES = Number(process.env.LOOP_MINUTES ?? 345); // GitHub 잡 한도 6시간 안에서 setup 여유를 둔 값
const POLL_MINUTES = Number(process.env.POLL_MINUTES ?? 5);
const COMMIT_STATE = process.env.COMMIT_STATE === '1'; // 상태 파일이 바뀌면 바로 git commit + push
const STATE_PATH = fileURLToPath(new URL('../data/driving-center.json', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const USERNAME = 'BMW 드라이빙 센터 알림';

const nowKST = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { programs: {} };
  }
}

// 내용이 실제로 달라졌을 때만 쓰고, 달라졌는지 돌려준다
function saveState(state) {
  const next = JSON.stringify(state, null, 2) + '\n';
  let prev = null;
  try {
    prev = readFileSync(STATE_PATH, 'utf8');
  } catch {
    /* 첫 실행 */
  }
  if (prev === next) return false;
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, next, 'utf8');
  return true;
}

// 상태 파일 커밋·푸시. 실패해도 감시는 계속되어야 하므로 로그만 남긴다 (워크플로 마지막 단계가 한 번 더 시도한다)
function commitState() {
  const run = (cmd) => execSync(cmd, { cwd: REPO_ROOT, stdio: 'pipe' }).toString().trim();
  try {
    run('git add data/driving-center.json');
    if (run('git diff --cached --name-only') === '') return;
    run('git commit -q -m "chore: update driving center seat state"');
    run('git pull -q --rebase origin main');
    run('git push -q');
    console.log('  상태 파일 커밋·푸시');
  } catch (err) {
    console.error(`  상태 파일 커밋 실패: ${err.stderr?.toString().trim() || err.message}`);
  }
}

// 감시 1회. 조회·알림 실패 건수를 돌려준다.
async function runOnce() {
  const state = loadState();
  console.log(`[${nowKST()}] 드라이빙 센터 잔여석 확인${DRY_RUN ? ' (dry-run)' : ''}`);

  let failed = 0;
  for (const program of PROGRAMS) {
    const key = String(program.productMasterCode);
    let snapshot;
    try {
      snapshot = await fetchProgramSnapshot(program);
    } catch (err) {
      failed++;
      console.error(`  ${program.name}: 조회 실패 — ${err.message} (상태 유지, 다음 실행에서 재시도)`);
      continue;
    }

    const dates = Object.keys(snapshot).sort();
    const allSlots = Object.values(snapshot).flat();
    const openCount = allSlots.filter((s) => s.remaining > 0).length;
    const summary = dates.map((d) => {
      const open = snapshot[d].filter((s) => s.remaining > 0).map((s) => `${s.start} ${s.remaining}석`);
      return `${fmtDate(d)} ${open.length ? open.join('/') : '매진'}`;
    });
    console.log(`  ${program.name}: 일정 ${dates.length}일 · 회차 ${allSlots.length}개 · 예약 가능 ${openCount}개 — ${summary.join(', ')}`);

    const prev = state.programs[key]?.snapshot;
    const { opened, newDates } = diffSnapshot(prev, snapshot);
    if (opened.length) console.log(`  → 자리 난 회차 ${opened.length}개: ${opened.map((o) => `${fmtDate(o.date)} ${o.start} ${o.remaining}석`).join(', ')}`);
    if (newDates.length) console.log(`  → 새 일정 ${newDates.length}일: ${newDates.map(fmtDate).join(', ')}`);

    if (STATUS) {
      const sent = DRY_RUN ? false : await postToWebhook({ username: USERNAME, embeds: [statusEmbed(program, snapshot)] });
      console.log(sent ? '  현황 요약 발송' : '  현황 요약 발송 생략 (웹훅 미설정 또는 dry-run)');
    } else if (!DRY_RUN) {
      const embeds = [];
      if (opened.length) embeds.push(openedEmbed(program, opened, snapshot));
      // 첫 실행(prev 없음)은 전부 "새 날짜"라 새 일정 알림은 건너뛴다. 자리 난 회차 알림은 첫 실행에도 보낸다.
      if (newDates.length && prev) embeds.push(newDatesEmbed(program, newDates, snapshot));
      if (embeds.length) {
        try {
          const sent = await postToWebhook({ username: USERNAME, content: opened.length ? '@here 드라이빙 센터 예약 자리가 났어요' : undefined, embeds });
          console.log(sent ? `  디스코드 알림 발송 (${embeds.length}건)` : '  디스코드 웹훅 미설정 — 알림 생략');
        } catch (err) {
          failed++;
          console.error(`  디스코드 알림 실패: ${err.message} (상태 유지, 다음 실행에서 재시도)`);
          continue; // 알림이 안 갔으면 상태를 갱신하지 않아 다음 실행에서 다시 알린다
        }
      }
    }

    // checkedAt 같은 매번 바뀌는 값은 넣지 않는다 — 상태 파일이 실제 잔여석 변화가 있을 때만 바뀌어야 커밋이 안 쌓인다
    if (!DRY_RUN) state.programs[key] = { name: program.name, snapshot };
  }

  if (!DRY_RUN && saveState(state) && COMMIT_STATE) commitState();
  return failed;
}

async function main() {
  if (!LOOP) {
    if (await runOnce()) process.exitCode = 1;
    return;
  }

  const end = Date.now() + LOOP_MINUTES * 60_000;
  console.log(`반복 감시 시작 — ${POLL_MINUTES}분 간격, ${LOOP_MINUTES}분 동안 (종료 예정 ${new Date(end).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' })} KST)`);
  let runs = 0;
  let failures = 0;
  for (;;) {
    runs++;
    try {
      failures += await runOnce();
    } catch (err) {
      failures++;
      console.error(`  예기치 못한 오류: ${err.message}`);
    }
    if (Date.now() + POLL_MINUTES * 60_000 > end) break;
    await sleep(POLL_MINUTES * 60_000);
  }
  console.log(`반복 감시 종료 — ${runs}회 조회, 실패 ${failures}회`);
  // 일시적 실패는 무시하고, 절반 넘게 실패했을 때만 잡을 실패로 표시한다
  if (failures > runs / 2) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
