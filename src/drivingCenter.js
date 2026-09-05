// BMW 드라이빙 센터(driving-center.bmw.co.kr) 예약 잔여석 조회.
// 예약 페이지 자체는 BMW ID 로그인 + 가상 대기열 뒤에 있지만, 페이지가 쓰는 일정 API는
// /api/public/ 아래에 있어 로그인 없이 호출된다 (2026-09 확인). 그래서 아이디·비밀번호·쿠키가 필요 없다.
//
//   GET /api/public/schedule?targetMonth=YYYYMM&productMasterCode=&carGroupSequence=&productPriceSequence=&productPatternCode=0001
//       → { targetMonth, turnDateList: [{ turnDate: 'YYYY-MM-DD', orderPossibilityFlag }] }   (회차가 있는 날짜 목록)
//   GET /api/public/schedule/YYYYMMDD?productMasterCode=&carGroupSequence=&productPriceSequence=
//       → [{ turnSequence, turnStartTime, turnEndTime, turnClassificationTotalProductQuantity, turnClassificationRemainingProductQuantity }]
//
// 상품 코드는 /api/public/main/product (POST) 와 /api/public/products/price/packages/{productMasterCode} 에서 확인.
// carGroupSequence 는 차량 선택이 있는 프로그램만 쓰고, 자가 차량 프로그램(Owners)은 0 이다.

const HOST = 'https://driving-center.bmw.co.kr';
export const RESERVE_URL = `${HOST}/orders/programs/products/view`;

// 감시할 프로그램. 추가하려면 price/packages API 에서 productPriceSequence 를 확인해 한 줄 넣으면 된다.
//   Owners Drift Day: { name: 'Owners Drift Day', productMasterCode: 1024, productPriceSequence: 53, carGroupSequence: 0, price: 50000 }
export const PROGRAMS = [
  { name: 'Owners Track Day', productMasterCode: 1023, productPriceSequence: 4303, carGroupSequence: 0, price: 50000 },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

async function getJson(path, params) {
  const url = new URL(path, HOST);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' } });
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  const body = await res.json();
  if (body.resultCode !== '0000') throw new Error(`${path} resultCode ${body.resultCode}: ${body.resultMessage ?? ''}`);
  return body.data;
}

const programParams = (p) => ({
  productMasterCode: p.productMasterCode,
  carGroupSequence: p.carGroupSequence ?? 0,
  productPriceSequence: p.productPriceSequence,
});

// 해당 월에 회차가 있는 날짜 목록 ('YYYY-MM-DD'[])
export async function fetchDates(program, yyyymm) {
  const data = await getJson('/api/public/schedule', { targetMonth: yyyymm, ...programParams(program), productPatternCode: '0001' });
  return (data?.turnDateList ?? []).map((d) => d.turnDate);
}

// 해당 날짜의 회차별 잔여석
export async function fetchSlots(program, date) {
  const data = await getJson(`/api/public/schedule/${date.replaceAll('-', '')}`, programParams(program));
  return (data ?? []).map((t) => ({
    turnSequence: String(t.turnSequence),
    start: t.turnStartTime,
    end: t.turnEndTime,
    total: t.turnClassificationTotalProductQuantity ?? 0,
    remaining: t.turnClassificationRemainingProductQuantity ?? 0,
  }));
}

// 이번 달부터 monthsAhead 개월 뒤까지의 'YYYYMM' 목록 (KST 기준)
export function monthsToScan(monthsAhead, now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 3_600_000);
  const out = [];
  for (let i = 0; i <= monthsAhead; i++) {
    const d = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth() + i, 1));
    out.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

export const todayKST = (now = new Date()) => new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);

// 프로그램 하나의 향후 일정 전체 스냅샷: { 'YYYY-MM-DD': [slot, ...] }
export async function fetchProgramSnapshot(program, { monthsAhead = 3, now = new Date() } = {}) {
  const today = todayKST(now);
  const dates = new Set();
  for (const m of monthsToScan(monthsAhead, now)) {
    for (const d of await fetchDates(program, m)) if (d >= today) dates.add(d);
  }
  const snapshot = {};
  for (const d of [...dates].sort()) snapshot[d] = await fetchSlots(program, d);
  return snapshot;
}

// 이전 스냅샷과 비교해 알릴 거리를 뽑는다.
//  - opened: 잔여석이 0(또는 미지)→1 이상으로 바뀐 회차  ← 핵심 알림 ("자리 났다")
//  - newDates: 처음 보는 날짜 (새 달 일정 오픈)
// 이미 자리가 있던 회차가 계속 있는 건 다시 알리지 않는다. 다시 0 이 되면 상태만 갱신하고, 그 뒤 또 열리면 다시 알린다.
export function diffSnapshot(prev = {}, next = {}) {
  const opened = [];
  const newDates = [];
  for (const [date, slots] of Object.entries(next)) {
    const prevSlots = prev[date];
    if (!prevSlots) newDates.push(date);
    for (const s of slots) {
      const before = prevSlots?.find((p) => p.turnSequence === s.turnSequence)?.remaining ?? 0;
      if (s.remaining > 0 && before === 0) opened.push({ date, ...s });
    }
  }
  return { opened, newDates };
}

const DAY_KO = ['일', '월', '화', '수', '목', '금', '토'];
export const fmtDate = (d) => `${d.slice(5).replace('-', '/')}(${DAY_KO[new Date(`${d}T00:00:00+09:00`).getDay()]})`;

// 디스코드 embed — 자리가 난 회차 알림
export function openedEmbed(program, opened, snapshot) {
  const byDate = new Map();
  for (const o of opened) {
    if (!byDate.has(o.date)) byDate.set(o.date, []);
    byDate.get(o.date).push(o);
  }
  const fields = [...byDate.entries()].map(([date, slots]) => ({
    name: `📅 ${fmtDate(date)}`,
    value: slots.map((s) => `• ${s.start}~${s.end}  **${s.remaining}석**`).join('\n').slice(0, 1024),
    inline: true,
  }));
  const totalOpen = Object.values(snapshot).flat().filter((s) => s.remaining > 0).length;
  const price = program.price ? ` · ${program.price.toLocaleString()}원` : '';
  return {
    title: `🏁 ${program.name} — 예약 자리 났어요!`,
    url: RESERVE_URL,
    color: 0xe22718,
    description: `${opened.length}개 회차에 자리가 생겼습니다. 로그인 후 대기열을 거쳐 예약하세요.\n예약 가능 회차 전체 ${totalOpen}개${price}`,
    fields: fields.slice(0, 25),
    footer: { text: 'BMW 드라이빙 센터 · 10분 주기 감시' },
  };
}

// 디스코드 embed — 새 일정(날짜) 오픈 알림
export function newDatesEmbed(program, newDates, snapshot) {
  const lines = newDates.map((d) => {
    const slots = snapshot[d] ?? [];
    const open = slots.filter((s) => s.remaining > 0).length;
    return `• ${fmtDate(d)} — 회차 ${slots.length}개${open ? `, **예약 가능 ${open}개**` : ', 전부 매진'}`;
  });
  return {
    title: `🗓️ ${program.name} — 새 일정 ${newDates.length}일 오픈`,
    url: RESERVE_URL,
    color: 0x1c69d4,
    description: lines.join('\n').slice(0, 4000),
    footer: { text: 'BMW 드라이빙 센터' },
  };
}

// 디스코드 embed — 현재 상태 요약 (--status)
export function statusEmbed(program, snapshot) {
  const dates = Object.keys(snapshot).sort();
  const lines = dates.map((d) => {
    const slots = snapshot[d];
    const open = slots.filter((s) => s.remaining > 0);
    const detail = open.length ? open.map((s) => `${s.start} ${s.remaining}석`).join(', ') : '매진';
    return `• ${fmtDate(d)} — ${detail} (회차 ${slots.length}개)`;
  });
  return {
    title: `📋 ${program.name} — 현재 예약 현황`,
    url: RESERVE_URL,
    color: 0x99aab5,
    description: (lines.join('\n') || '예정된 일정이 없습니다.').slice(0, 4000),
    footer: { text: 'BMW 드라이빙 센터' },
  };
}
