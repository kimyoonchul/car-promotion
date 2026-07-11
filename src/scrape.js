import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (compatible; bmw-campaign-tracker/0.1; personal-use)';
const PUB_RE = /published on:\s*([\d.]+)/;

export async function fetchHtml(url, { retries = 2, validate } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, 'accept-language': 'ko' },
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      if (validate && !validate(html)) throw new Error('응답 검증 실패 (다른 딜러 콘텐츠 응답 의심)');
      return html;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

const clean = (s) => s.replace(/\s+/g, ' ').trim();

// 연도별 아카이브: a.blog-post-title 앵커(제목+상세링크) + 인접한 "published on:" 텍스트
export function parseArchive(html, baseUrl) {
  const $ = cheerio.load(html);
  const posts = [];
  $('a.blog-post-title').each((_, el) => {
    const $a = $(el);
    const href = $a.attr('href');
    if (!href) return;
    const url = new URL(href, baseUrl).href;
    const block = $a.closest('.blog-post');
    const m = (block.length ? block.text() : '').match(PUB_RE);
    posts.push({ url, title: clean($a.text()), publishedOn: m?.[1] ?? null });
  });
  return posts;
}

// 허브/상세 페이지: h1 제목, published on 날짜, 배너 이미지, (있으면) 상세 링크
export function parseDetail(html, baseUrl) {
  const $ = cheerio.load(html);
  const title = clean($('h1').first().text()) || null;
  const m = $.root().text().match(PUB_RE);
  const images = [];
  $('img').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (src.includes('bmwdealeradmin.co.kr/storage')) {
      try {
        images.push(new URL(src, baseUrl).href);
      } catch {
        /* 잘못된 src는 무시 */
      }
    }
  });
  let detailLink = null;
  $('a[href*="/promotions/previous/"]').each((_, el) => {
    if (!detailLink) detailLink = new URL($(el).attr('href'), baseUrl).href;
  });
  return { title, publishedOn: m?.[1] ?? null, images, detailLink };
}

const PROMO_PATH_RE = /^\/promotions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// 홈페이지(메뉴)에서 같은 호스트의 /promotions/{uuid} 앵커 수집
export function parsePromotionLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const host = new URL(baseUrl).host;
  const seen = new Map();
  $('a[href*="/promotions/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    let url;
    try {
      url = new URL(href, baseUrl);
    } catch {
      return;
    }
    if (url.host !== host || !PROMO_PATH_RE.test(url.pathname)) return;
    if (!seen.has(url.href)) seen.set(url.href, clean($(el).text()) || null);
  });
  return [...seen].map(([url, label]) => ({ url, label }));
}

export function parseSitemap(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)]
    .map((m) => m[1])
    .filter((u) => u.includes('/promotions/') && !u.includes('/previous/'));
}
