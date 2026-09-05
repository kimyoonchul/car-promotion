// BMW 드라이빙 센터 Owners 프로그램 예약 자리 감시.
// 10분마다 돌면서 잔여석이 0 → 1 이상으로 바뀐 회차(취소표·추가 오픈)와 새로 열린 날짜를 디스코드로 알린다.
//
//   node src/watch-driving-center.js            # 감시 1회 실행 (변화 있으면 알림 + 상태 저장)
//   node src/watch-driving-center.js --dry-run  # 조회·비교만, 알림·저장 생략
//   node src/watch-driving-center.js --status   # 현재 예약 현황을 디스코드로 한 번 보내기 (웹훅 확인용)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
const STATE_PATH = fileURLToPath(new URL('../data/driving-center.json', import.meta.url));
const USERNAME = 'BMW 드라이빙 센터 알림';

const nowKST = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { programs: {} };
  }
}

function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

async function main() {
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
    console.log(`  ${program.name}: 일정 ${dates.length}일 · 회차 ${allSlots.length}개 · 예약 가능 ${openCount}개`);
    for (const d of dates) {
      const open = snapshot[d].filter((s) => s.remaining > 0).map((s) => `${s.start} ${s.remaining}석`);
      console.log(`    ${fmtDate(d)}: ${open.length ? open.join(', ') : '매진'}`);
    }

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

    if (!DRY_RUN) state.programs[key] = { name: program.name, checkedAt: nowKST(), snapshot };
  }

  if (!DRY_RUN) saveState(state);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
