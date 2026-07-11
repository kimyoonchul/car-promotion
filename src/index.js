import { DEALERS } from './dealers.js';
import { fetchHtml, parseArchive, parseDetail, parsePromotionLinks, parseSitemap } from './scrape.js';
import { loadState, saveState } from './state.js';
import { extractFromImages } from './vision.js';
import { writeSummary, appendLog } from './sheets.js';
import { notifyDiscord, sendDigest } from './discord.js';
import { fileURLToPath } from 'node:url';

try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch {
  /* .env 없으면 환경변수만 사용 */
}

const DRY_RUN = process.argv.includes('--dry-run');
const NO_VISION = process.argv.includes('--no-vision');
const DIGEST = process.argv.includes('--digest');

const nowKST = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });
const slug = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 60);
const NOISE_RE = /개인정보|처리방침|결산\s*공고|채용|약관/;
const FRESH_DAYS = 180;

const parseDate = (publishedOn) => {
  const m = publishedOn?.match(/^(\d{4})\.(\d{2})\.(\d{2})/);
  return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}`) : -Infinity;
};
const isStale = (publishedOn) => {
  const t = parseDate(publishedOn);
  return t !== -Infinity && Date.now() - t > FRESH_DAYS * 86_400_000;
};
const keyOf = (p) => `${p.dealer}|${p.title}|${p.publishedOn ?? ''}`;

// 소스 1곳에서 캠페인 후보 목록을 수집한다.
// 반환: { id, url, title?, publishedOn?, images?, needsDetail }
async function collectSource(dealer, source, year) {
  const url = source.url(year);
  const html = await fetchHtml(url, { validate: dealer.validate });
  switch (source.kind) {
    case 'archive':
      return parseArchive(html, url).map((p) => ({ id: p.url, ...p, needsDetail: true }));
    case 'hub': {
      const d = parseDetail(html, url);
      if (!d.title) return [];
      // 허브 URL은 고정이고 내용이 갈리므로 상세링크(있으면) 또는 제목+게시일로 신규 여부를 판별
      const id = d.detailLink ?? `${url}#${slug(d.title)}@${d.publishedOn ?? ''}`;
      return [{ id, url: d.detailLink ?? url, title: d.title, publishedOn: d.publishedOn, images: d.images, needsDetail: false, resolved: true }];
    }
    case 'menu':
      return parsePromotionLinks(html, url).map((l) => ({ id: l.url, url: l.url, title: l.label, needsDetail: true }));
    case 'sitemap':
      return parseSitemap(html).map((u) => ({ id: u, url: u, title: null, needsDetail: true }));
    default:
      return [];
  }
}

// 상세(제목/게시일/이미지)가 아직 없으면 상세 페이지를 가져와 채운다. 이미 처리된 post는 재요청하지 않는다.
async function resolveDetail(post) {
  if (post.resolved) return post;
  if (post.needsDetail) {
    const d = parseDetail(await fetchHtml(post.url, { validate: post.validate }), post.url);
    post.title = d.title ?? post.title ?? '(제목 없음)';
    post.publishedOn = d.publishedOn ?? post.publishedOn;
    post.images = d.images;
  }
  post.resolved = true;
  return post;
}

// 배너 이미지에서 기간·혜택을 뽑는다. 성공한 결과만 캐싱한다 —
// 실패(키 미설정 등)를 캐싱하면 나중에 키를 넣어도 예전 캠페인은 영영 재시도되지 않기 때문.
// 구버전 스키마(discounts/freebies 없음)로 캐싱된 항목은 무효로 보고 다시 추출한다.
async function resolveExtract(post, state) {
  if (NO_VISION) return null;
  const cached = state.extracts[post.id];
  if (cached && Array.isArray(cached.discounts) && Array.isArray(cached.freebies)) return cached;
  const extract = await extractFromImages({ dealer: post.dealer, title: post.title, images: post.images ?? [] });
  if (extract) state.extracts[post.id] = extract;
  return extract;
}

// "2026.06.15 ~ 2026.07.26" 같은 기간 문자열의 마지막 날짜를 종료일로 보고 D-day를 계산
function dday(period) {
  const dates = [...(period ?? '').matchAll(/(\d{4})\.\s?(\d{1,2})\.\s?(\d{1,2})/g)];
  if (dates.length === 0) return '';
  const [, y, m, d] = dates[dates.length - 1];
  const end = Date.parse(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T23:59:59+09:00`);
  const days = Math.floor((end - Date.now()) / 86_400_000);
  if (days < 0) return '종료됨';
  if (days === 0) return '오늘 마감';
  return `D-${days}`;
}

const asBullets = (arr) => (arr?.length ? arr.map((x) => `• ${x}`).join('\n') : '-');

function summaryRow(post) {
  const ex = post.extract;
  const isService = ex ? ex.isServiceCampaign : post.service;
  return [
    post.dealer,
    post.regions,
    isService ? '정비' : '기타',
    post.title,
    ex?.period ?? '미상',
    post.dday || '',
    asBullets(ex?.discounts),
    asBullets(ex?.freebies),
    `=HYPERLINK("${post.url}","바로가기")`,
  ];
}

async function main() {
  const state = loadState();
  const isInitialRun = Object.keys(state.seen).length === 0;
  const year = new Date().getFullYear();

  console.log(`[${nowKST()}] 수집 시작${DRY_RUN ? ' (dry-run)' : ''}${isInitialRun ? ' — 초기 수집: 디스코드 알림 생략' : ''}`);

  // 1) 딜러별 소스에서 후보 수집
  const candidates = new Map(); // id → candidate
  const byDealer = new Map(); // dealer.name → candidate[]
  for (const dealer of DEALERS) {
    const list = [];
    byDealer.set(dealer.name, list);
    for (const source of dealer.sources) {
      try {
        const posts = await collectSource(dealer, source, year);
        for (const p of posts) {
          if (!candidates.has(p.id)) {
            const full = { ...p, dealer: dealer.name, regions: dealer.regions, category: source.category, service: !!source.service, validate: dealer.validate };
            candidates.set(p.id, full);
            list.push(full);
          }
        }
        console.log(`  ${dealer.name} / ${source.category}: ${posts.length}건`);
      } catch (err) {
        console.error(`  ${dealer.name} / ${source.category}: 수집 실패 — ${err.message}`);
      }
    }
  }

  // 2) 신규 게시물만 추림 — "전체 로그" + 디스코드 알림 대상
  const fresh = [...candidates.values()].filter((c) => !state.seen[c.id]);
  console.log(`후보 ${candidates.size}건 중 신규 ${fresh.length}건`);

  const results = []; // 로그에 쌓을 신규 건
  const skipped = []; // 중복·노이즈·오래된 건 — 상태에만 기록
  const contentKeys = new Set();
  for (const post of fresh) {
    try {
      if (post.title && post.publishedOn && contentKeys.has(keyOf(post))) {
        skipped.push(post);
        continue;
      }
      await resolveDetail(post);
      const key = keyOf(post);
      if (contentKeys.has(key) || NOISE_RE.test(post.title) || isStale(post.publishedOn)) {
        contentKeys.add(key);
        skipped.push(post);
        continue;
      }
      contentKeys.add(key);
      post.extract = await resolveExtract(post, state);
      results.push(post);
      const p = post.extract?.period ? ` | 기간 ${post.extract.period}` : '';
      console.log(`  [신규] ${post.dealer} — ${post.title} (게시 ${post.publishedOn ?? '?'})${p}`);
    } catch (err) {
      console.error(`  [신규] ${post.dealer} — ${post.url} 상세 조회 실패: ${err.message} (다음 실행에서 재시도)`);
    }
  }
  if (skipped.length) console.log(`중복/공지/오래된 게시물 ${skipped.length}건은 기록만 하고 건너뜀`);

  // 3) "지금 진행중" 요약 — 딜러별로 정비(A/S) 캠페인 소스 중 가장 최근 것을 우선 선정.
  // 정비 캠페인 소스가 하나도 없으면(코오롱 등) 전체 중 최근 게시물로 대체한다.
  const summaryPosts = [];
  for (const dealer of DEALERS) {
    const all = (byDealer.get(dealer.name) ?? []).filter((p) => !NOISE_RE.test(p.title ?? ''));
    if (all.length === 0) continue;
    const serviceOnly = all.filter((p) => p.service);
    const list = serviceOnly.length ? serviceOnly : all;
    list.sort((a, b) => parseDate(b.publishedOn) - parseDate(a.publishedOn));
    const top = list[0];
    try {
      await resolveDetail(top);
      top.extract ??= await resolveExtract(top, state);
      top.dday = dday(top.extract?.period);
      summaryPosts.push(top);
    } catch (err) {
      console.error(`  [요약] ${dealer.name} 최신 캠페인 조회 실패: ${err.message}`);
    }
  }

  if (DRY_RUN) {
    console.log('dry-run: 시트/디스코드/상태 저장을 생략합니다.');
    console.log('--- 지금 진행중 요약 미리보기 ---');
    for (const p of summaryPosts) console.log(`  ${p.dealer}: ${p.title} (게시 ${p.publishedOn ?? '?'})`);
    return;
  }

  // 4) 구글 시트 반영 — "지금 진행중"은 통째로 덮어쓰고, "전체 로그"엔 신규 건만 추가
  try {
    const wrote = await writeSummary(summaryPosts.map(summaryRow));
    if (wrote) console.log(`"지금 진행중" 탭 갱신 (${summaryPosts.length}개 딜러)`);
  } catch (err) {
    console.error(`요약 탭 기록 실패: ${err.message}`);
  }
  try {
    const logRows = results.map((p) => [
      nowKST(),
      p.dealer,
      p.category,
      p.title,
      p.publishedOn ?? '',
      p.extract?.period ?? '',
      asBullets(p.extract?.discounts),
      asBullets(p.extract?.freebies),
      p.extract ? (p.extract.isServiceCampaign ? 'Y' : 'N') : '',
      `=HYPERLINK("${p.url}","바로가기")`,
    ]);
    const wrote = await appendLog(logRows);
    if (wrote) console.log(`"전체 로그" 탭에 ${logRows.length}행 추가`);
  } catch (err) {
    console.error(`로그 기록 실패: ${err.message}`);
  }

  // 5) 디스코드 알림 (초기 백필은 생략)
  if (!isInitialRun) {
    for (const post of results) {
      try {
        post.dday ??= dday(post.extract?.period);
        await notifyDiscord(post);
      } catch (err) {
        console.error(`디스코드 알림 실패 (${post.title}): ${err.message}`);
      }
    }
  }

  // 5-1) 요약 다이제스트 — --digest 플래그 또는 매주 월요일(KST) 자동 발송
  const isMondayKST = new Date(Date.now() + 9 * 3_600_000).getUTCDay() === 1;
  if (DIGEST || isMondayKST) {
    try {
      const sent = await sendDigest(summaryPosts, nowKST().slice(0, 10));
      if (sent) console.log(`디스코드 다이제스트 발송 (${summaryPosts.length}개 딜러)`);
    } catch (err) {
      console.error(`디스코드 다이제스트 실패: ${err.message}`);
    }
  }

  // 6) 상태 저장 — 상세 조회에 실패한 건은 기록하지 않아 다음 실행에서 재시도된다
  for (const post of [...results, ...skipped]) {
    state.seen[post.id] = { firstSeen: nowKST(), dealer: post.dealer, title: post.title ?? null };
  }
  saveState(state);
  console.log(`완료 — 신규 ${results.length}건 처리`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
