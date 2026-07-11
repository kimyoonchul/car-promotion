import { DEALERS } from './dealers.js';
import { fetchHtml, parseArchive, parseDetail, parsePromotionLinks, parseSitemap } from './scrape.js';
import { loadState, saveState } from './state.js';
import { extractFromImages } from './vision.js';
import { appendRows, SHEET_HEADER } from './sheets.js';
import { notifyDiscord } from './discord.js';
import { fileURLToPath } from 'node:url';

try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch {
  /* .env 없으면 환경변수만 사용 */
}

const DRY_RUN = process.argv.includes('--dry-run');
const NO_VISION = process.argv.includes('--no-vision');

const nowKST = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });
const slug = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 60);

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
      return [{ id, url: d.detailLink ?? url, title: d.title, publishedOn: d.publishedOn, images: d.images, needsDetail: false }];
    }
    case 'menu':
      return parsePromotionLinks(html, url).map((l) => ({ id: l.url, url: l.url, title: l.label, needsDetail: true }));
    case 'sitemap':
      return parseSitemap(html).map((u) => ({ id: u, url: u, title: null, needsDetail: true }));
    default:
      return [];
  }
}

async function main() {
  const state = loadState();
  const isInitialRun = Object.keys(state.seen).length === 0;
  const year = new Date().getFullYear();

  console.log(`[${nowKST()}] 수집 시작${DRY_RUN ? ' (dry-run)' : ''}${isInitialRun ? ' — 초기 수집: 디스코드 알림 생략' : ''}`);

  // 1) 딜러별 소스에서 후보 수집
  const candidates = new Map(); // id → candidate
  for (const dealer of DEALERS) {
    for (const source of dealer.sources) {
      try {
        const posts = await collectSource(dealer, source, year);
        for (const p of posts) {
          if (!candidates.has(p.id)) {
            candidates.set(p.id, { ...p, dealer: dealer.name, regions: dealer.regions, category: source.category, validate: dealer.validate });
          }
        }
        console.log(`  ${dealer.name} / ${source.category}: ${posts.length}건`);
      } catch (err) {
        console.error(`  ${dealer.name} / ${source.category}: 수집 실패 — ${err.message}`);
      }
    }
  }

  // 2) 신규 게시물만 추림
  const fresh = [...candidates.values()].filter((c) => !state.seen[c.id]);
  console.log(`후보 ${candidates.size}건 중 신규 ${fresh.length}건`);

  // 3) 신규 건 상세 조회(제목/게시일/이미지) + 이미지에서 기간·혜택 추출
  // 같은 캠페인이 허브·아카이브 양쪽에 다른 URL로 잡히므로 딜러+제목+게시일로 중복 제거.
  // 공지·약관류와 오래된 게시물(사이트맵 백필)은 상태에만 기록하고 처리하지 않는다.
  const NOISE_RE = /개인정보|처리방침|결산\s*공고|채용|약관/;
  const FRESH_DAYS = 180;
  const isStale = (publishedOn) => {
    const m = publishedOn?.match(/^(\d{4})\.(\d{2})\.(\d{2})/);
    if (!m) return false;
    return Date.now() - Date.parse(`${m[1]}-${m[2]}-${m[3]}`) > FRESH_DAYS * 86_400_000;
  };
  const keyOf = (p) => `${p.dealer}|${p.title}|${p.publishedOn ?? ''}`;

  const results = [];
  const skipped = []; // 중복·노이즈·오래된 건 — 상태에만 기록
  const contentKeys = new Set();
  for (const post of fresh) {
    try {
      if (post.title && post.publishedOn && contentKeys.has(keyOf(post))) {
        skipped.push(post);
        continue;
      }
      if (post.needsDetail) {
        const d = parseDetail(await fetchHtml(post.url, { validate: post.validate }), post.url);
        post.title = d.title ?? post.title ?? '(제목 없음)';
        post.publishedOn = d.publishedOn ?? post.publishedOn;
        post.images = d.images;
      }
      const key = keyOf(post);
      if (contentKeys.has(key) || NOISE_RE.test(post.title) || isStale(post.publishedOn)) {
        contentKeys.add(key);
        skipped.push(post);
        continue;
      }
      contentKeys.add(key);
      if (!NO_VISION) {
        post.extract = await extractFromImages({ dealer: post.dealer, title: post.title, images: post.images ?? [] });
      }
      results.push(post);
      const p = post.extract?.period ? ` | 기간 ${post.extract.period}` : '';
      console.log(`  [신규] ${post.dealer} — ${post.title} (게시 ${post.publishedOn ?? '?'})${p}`);
    } catch (err) {
      console.error(`  [신규] ${post.dealer} — ${post.url} 상세 조회 실패: ${err.message} (다음 실행에서 재시도)`);
    }
  }
  if (skipped.length) console.log(`중복/공지/오래된 게시물 ${skipped.length}건은 기록만 하고 건너뜀`);

  if (DRY_RUN) {
    console.log('dry-run: 시트/디스코드/상태 저장을 생략합니다.');
    return;
  }

  // 4) 구글 시트에 축적 (초기 실행이면 헤더부터)
  const rows = results.map((p) => [
    nowKST(),
    p.dealer,
    p.category,
    p.title,
    p.publishedOn ?? '',
    p.extract?.period ?? '',
    (p.extract?.benefits ?? []).join(' / '),
    p.extract ? (p.extract.isServiceCampaign ? 'Y' : 'N') : '',
    p.url,
  ]);
  try {
    const wrote = await appendRows(isInitialRun && rows.length ? [SHEET_HEADER, ...rows] : rows);
    if (wrote) console.log(`구글 시트에 ${rows.length}행 추가`);
  } catch (err) {
    console.error(`구글 시트 기록 실패: ${err.message}`);
  }

  // 5) 디스코드 알림 (초기 백필은 생략)
  if (!isInitialRun) {
    for (const post of results) {
      try {
        await notifyDiscord(post);
      } catch (err) {
        console.error(`디스코드 알림 실패 (${post.title}): ${err.message}`);
      }
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
