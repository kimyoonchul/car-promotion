import { DEALERS } from './dealers.js';
import { fetchHtml, parseArchive, parseDetail, parsePromotionLinks, parseSitemap } from './scrape.js';
import { loadState, saveState } from './state.js';
import { extractFromImages, rateCampaigns, EXTRACT_VERSION } from './vision.js';
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
      // 허브 URL은 고정이고 내용만 갈리므로 제목+게시일로 신규 여부를 판별한다.
      // (예전엔 페이지 안의 "이전 프로모션" 아카이브 링크를 id로 썼는데, 그 링크는 내용이 바뀌어도 고정이라
      //  새 캠페인이 신규로 잡히지 않고 지난 캠페인의 추출 캐시(기간·혜택)를 그대로 쓰는 버그가 있었다.
      //  legacyId는 그 구버전 id — 이미 본 글을 다시 알리지 않기 위한 1회성 대조용)
      const id = `${url}#${slug(d.title)}@${d.publishedOn ?? ''}`;
      return [{ id, url, title: d.title, publishedOn: d.publishedOn, images: d.images, needsDetail: false, resolved: true, legacyId: d.detailLink }];
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
// 스키마·처리방식(EXTRACT_VERSION)이 바뀌면 구버전 캐시는 무효로 보고 다시 추출한다.
async function resolveExtract(post, state) {
  if (NO_VISION) return null;
  const cached = state.extracts[post.id];
  if (cached?.v === EXTRACT_VERSION) return cached;
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

// 이미지 파일명에서 쪽번호를 뗀 줄기: ".../BMW 9월 프로모션_홈페이지-02.jpg" → "BMW 9월 프로모션_홈페이지"
const imageStem = (u) =>
  decodeURIComponent(new URL(u).pathname.split('/').pop()).replace(/\.\w+$/, '').replace(/[-_]\d{1,2}$/, '');

// 같은 딜러가 같은 날 한 포스터를 여러 장(01/02…)으로 쪼개 따로 게시한 글들을 첫 글에 합친다.
// 코오롱이 매달 "N월 프로모션"(01) + "N월 금융 프로모션"(02)을 이렇게 올려 알림이 두 번 가던 문제.
// 반환: 합쳐져서 사라진 글 목록 — 다음 실행에서 또 신규로 잡히지 않도록 state에는 기록해야 한다.
function mergeSplitBanners(posts) {
  const groups = new Map();
  for (const p of posts) {
    if (!p.images?.length || !p.publishedOn) continue;
    const stems = [...new Set(p.images.map(imageStem))].sort().join('|');
    const key = `${p.dealer}|${p.publishedOn}|${stems}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const merged = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.images[0].localeCompare(b.images[0])); // 01 → 02 순으로 이어 붙인다
    const [primary, ...rest] = group;
    for (const r of rest) {
      for (const img of r.images) if (!primary.images.includes(img)) primary.images.push(img);
      r.mergedInto = primary;
      merged.push(r);
    }
    console.log(`  [병합] ${primary.dealer} — "${rest.map((r) => r.title).join('", "')}" → "${primary.title}" (같은 포스터 분할 게시)`);
  }
  return merged;
}

// 기간이 이미 지난 캠페인 — 디스코드에선 빼고, 시트에선 아래로 내려 음영처리한다
const isEnded = (post) => (post.dday ?? dday(post.extract?.period)) === '종료됨';

const badgeOf = (post) =>
  post.rating === '강추' ? '⭐⭐ 강추' : post.rating === '추천' ? '⭐ 추천' : '';

// "2026.06.15 ~ 2026.07.26" → "6/15~7/26 · D-14" 처럼 훑기 좋게 압축
function compactPeriod(post) {
  const dates = [...(post.extract?.period ?? '').matchAll(/\d{4}\.\s?(\d{1,2})\.\s?(\d{1,2})/g)];
  if (dates.length === 0) return post.dday || '미상';
  const fmt = (m) => `${Number(m[1])}/${Number(m[2])}`;
  const range = dates.length >= 2 ? `${fmt(dates[0])}~${fmt(dates[dates.length - 1])}` : `${fmt(dates[0])}~`;
  return post.dday ? `${range} · ${post.dday}` : range;
}

// 추천 평가가 핵심 혜택을 못 뽑았을 때(비전 실패 등)의 대체 요약
function fallbackHighlights(post) {
  const ex = post.extract;
  if (!ex) return [];
  return [...(ex.discounts ?? []).slice(0, 2), ...(ex.freebies ?? []).slice(0, 1)].map((x) =>
    x.length > 26 ? `${x.slice(0, 25)}…` : x,
  );
}

// 요약 탭 — 핵심만
function summaryRow(post) {
  const isService = post.extract ? post.extract.isServiceCampaign : post.service;
  const highlights = post.highlights?.length ? post.highlights : fallbackHighlights(post);
  return [
    badgeOf(post),
    post.dealer,
    post.regions,
    isService ? post.title : `${post.title} (판매·기타)`,
    compactPeriod(post),
    asBullets(highlights),
    `=HYPERLINK("${post.url}","보기")`,
  ];
}

// 상세 탭 — 전체 혜택 목록
function detailRow(post) {
  const ex = post.extract;
  return [
    post.dealer,
    post.title,
    ex?.period ?? '미상',
    asBullets(ex?.discounts),
    asBullets(ex?.freebies),
    post.reason ? `${badgeOf(post)} ${post.reason}` : '',
    `=HYPERLINK("${post.url}","보기")`,
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
  const fresh = [];
  const skipped = []; // 중복·노이즈·오래된 건 — 상태에만 기록
  for (const c of candidates.values()) {
    if (state.seen[c.id]) continue;
    // 구버전 id(아카이브 링크)로 이미 본 허브 글 — 제목이 같으면 신규가 아니므로 새 id로 기록만 한다
    if (c.legacyId && state.seen[c.legacyId]?.title === c.title) skipped.push(c);
    else fresh.push(c);
  }
  console.log(`후보 ${candidates.size}건 중 신규 ${fresh.length}건`);

  // 2-1) 상세 조회 + 중복·노이즈·오래된 글 걸러내기
  const resolved = [];
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
      resolved.push(post);
    } catch (err) {
      console.error(`  [신규] ${post.dealer} — ${post.url} 상세 조회 실패: ${err.message} (다음 실행에서 재시도)`);
    }
  }

  // 2-2) 한 포스터를 여러 글로 쪼개 올린 건 한 건으로 합친다
  const merged = mergeSplitBanners(resolved);
  skipped.push(...merged);

  // 2-3) 배너에서 기간·혜택 추출
  const results = []; // 로그에 쌓을 신규 건
  for (const post of resolved) {
    if (post.mergedInto) continue;
    try {
      post.extract = await resolveExtract(post, state);
      results.push(post);
      const p = post.extract?.period ? ` | 기간 ${post.extract.period}` : '';
      console.log(`  [신규] ${post.dealer} — ${post.title} (게시 ${post.publishedOn ?? '?'})${p}`);
    } catch (err) {
      console.error(`  [신규] ${post.dealer} — ${post.title} 혜택 추출 실패: ${err.message} (다음 실행에서 재시도)`);
    }
  }
  if (skipped.length) console.log(`중복/공지/오래된/병합된 게시물 ${skipped.length}건은 기록만 하고 건너뜀`);

  // 3) "지금 진행중" 요약 — 딜러별로 정비(A/S) 캠페인 소스 중 가장 최근 것을 우선 선정.
  // 정비 캠페인 소스가 하나도 없으면(코오롱 등) 전체 중 최근 게시물로 대체한다.
  const summaryPosts = [];
  for (const dealer of DEALERS) {
    const all = (byDealer.get(dealer.name) ?? []).filter((p) => !p.mergedInto && !NOISE_RE.test(p.title ?? ''));
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

  // 3-1) 추천 등급 — 전체 캠페인을 놓고 무료 혜택·실질 할인 기준으로 강추/추천/보통 판정, 강추가 위로
  if (!NO_VISION && summaryPosts.length) {
    const ratings = await rateCampaigns(summaryPosts);
    for (const r of ratings ?? []) {
      const p = summaryPosts.find((x) => x.dealer === r.dealer);
      if (p) {
        p.rating = r.rating;
        p.reason = r.reason;
        p.highlights = r.highlights;
      }
    }
    const rank = { 강추: 0, 추천: 1, 보통: 2 };
    summaryPosts.sort((a, b) => (rank[a.rating] ?? 3) - (rank[b.rating] ?? 3));
  }
  // 종료된 캠페인은 등급과 무관하게 항상 맨 아래로
  summaryPosts.sort((a, b) => Number(isEnded(a)) - Number(isEnded(b)));

  if (DRY_RUN) {
    console.log('dry-run: 시트/디스코드/상태 저장을 생략합니다.');
    console.log('--- 지금 진행중 요약 미리보기 ---');
    for (const p of summaryPosts) {
      const badge = badgeOf(p);
      const tag = isEnded(p) ? '[종료] ' : badge ? `[${badge}] ` : '';
      console.log(`  ${tag}${p.dealer}: ${p.title} (게시 ${p.publishedOn ?? '?'})${p.reason ? ` — ${p.reason}` : ''}`);
    }
    return;
  }

  // 4) 구글 시트 반영 — "지금 진행중"(요약)·"상세 혜택"은 통째로 덮어쓰고, "전체 로그"엔 신규 건만 추가
  try {
    const dimRows = summaryPosts.flatMap((p, i) => (isEnded(p) ? [i] : []));
    const wrote = await writeSummary(summaryPosts.map(summaryRow), summaryPosts.map(detailRow), dimRows);
    if (wrote) {
      const ended = dimRows.length ? ` · 종료 ${dimRows.length}건 음영처리` : '';
      console.log(`"지금 진행중"·"상세 혜택" 탭 갱신 (${summaryPosts.length}개 딜러${ended})`);
    }
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
        // 이미 끝난 캠페인은 알릴 가치가 없다 (오래된 글이 뒤늦게 잡히는 경우)
        if (isEnded(post)) {
          console.log(`  [알림 생략] ${post.dealer} — ${post.title} (기간 종료)`);
          continue;
        }
        await notifyDiscord(post);
      } catch (err) {
        console.error(`디스코드 알림 실패 (${post.title}): ${err.message}`);
      }
    }
  }

  // 5-1) 요약 다이제스트 — --digest 플래그 또는 매주 월요일(KST) 자동 발송. 종료된 캠페인은 제외.
  const isMondayKST = new Date(Date.now() + 9 * 3_600_000).getUTCDay() === 1;
  if (DIGEST || isMondayKST) {
    try {
      const active = summaryPosts.filter((p) => !isEnded(p));
      const sent = await sendDigest(active, nowKST().slice(0, 10));
      if (sent) console.log(`디스코드 다이제스트 발송 (${active.length}개 딜러 · 종료 ${summaryPosts.length - active.length}건 제외)`);
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
