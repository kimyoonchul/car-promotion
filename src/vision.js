import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';

// 딜러들이 캠페인 상세(기간·할인율·사은품)를 배너 이미지로만 게시하므로 비전 모델로 추출한다.
// structured outputs(json_schema)로 응답 형식을 보장한다.

const SCHEMA = {
  type: 'object',
  properties: {
    period: { type: 'string', description: '캠페인 기간 (예: "2026.06.15 ~ 2026.07.26"). 이미지에서 확인 불가면 "미상"' },
    discounts: {
      type: 'array',
      items: { type: 'string' },
      description: '할인 혜택 목록. 각 항목은 "대상: 할인내용" 형식으로 짧게 (예: "소모품 부품·공임: 20% 할인", "타이어 4본 교체: 20% 할인")',
    },
    freebies: {
      type: 'array',
      items: { type: 'string' },
      description: '무료·증정 혜택 목록 — 무상점검, 사은품, 증정품과 그 조건을 빠짐없이 (예: "무상점검(에어컨·냉각수·타이어 등)", "20만원 이상 결제 시 BMW 레디백 증정", "앱 예약 방문 시 우산 증정")',
    },
    summary: { type: 'string', description: '캠페인 핵심 내용 한 문장 요약' },
    isServiceCampaign: { type: 'boolean', description: '정비/서비스(A/S) 캠페인이면 true, 차량 판매·금융 프로모션이면 false' },
  },
  required: ['period', 'discounts', 'freebies', 'summary', 'isServiceCampaign'],
  additionalProperties: false,
};

// 스키마·처리방식이 바뀌면 올린다 — 캐싱된 추출 결과의 버전이 다르면 다시 추출된다
export const EXTRACT_VERSION = 2;

// 모델이 이미지를 축소 없이 읽는 한 변 최대치(고해상도 비전 2576px)보다 약간 작게.
// 이보다 크면 서버에서 자동 축소돼 작은 한글이 뭉개진다("입고"→"입금" 오독의 원인).
const MAX_EDGE = 2400;
const OVERLAP = 150; // 슬라이스 경계에서 글줄이 잘리지 않도록 겹침
const MAX_SLICES = 6;

const mediaTypeOf = (res, url) => {
  const ct = res.headers.get('content-type')?.split(';')[0];
  if (ct?.startsWith('image/')) return ct;
  if (/\.png(\?|$)/i.test(url)) return 'image/png';
  if (/\.webp(\?|$)/i.test(url)) return 'image/webp';
  if (/\.gif(\?|$)/i.test(url)) return 'image/gif';
  return 'image/jpeg';
};

// 이미지 URL들을 API에 넣을 수 있는 base64 블록으로 변환.
// 딜러 배너는 세로로 매우 긴 경우가 많아, 각 조각이 축소 없이 들어가도록 겹치게 잘라 나눈다.
async function prepareImageBlocks(urls) {
  const blocks = [];
  for (const url of urls.slice(0, 2)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) continue;
      let buf = Buffer.from(await res.arrayBuffer());
      let { width = 0, height = 0 } = await sharp(buf).metadata();
      if (!width || !height) continue;

      // 가로가 한도를 넘으면 먼저 축소(가로형 배너의 글자는 충분히 큼)
      let reencoded = false;
      if (width > MAX_EDGE) {
        buf = await sharp(buf).resize({ width: MAX_EDGE, withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
        ({ width = 0, height = 0 } = await sharp(buf).metadata());
        reencoded = true;
      }
      if (height <= MAX_EDGE) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: reencoded ? 'image/jpeg' : mediaTypeOf(res, url), data: buf.toString('base64') } });
        continue;
      }
      // 세로로 긴 배너는 축소하면 글자가 뭉개지므로 원본 해상도 그대로 슬라이스한다
      const slices = Math.min(Math.ceil(height / MAX_EDGE), MAX_SLICES);
      const sliceH = Math.ceil(height / slices);
      for (let i = 0; i < slices; i++) {
        const top = Math.max(0, i * sliceH - OVERLAP);
        const cut = Math.min(sliceH + OVERLAP * 2, height - top);
        const out = await sharp(buf).extract({ left: 0, top, width, height: cut }).jpeg({ quality: 90 }).toBuffer();
        blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: out.toString('base64') } });
      }
    } catch {
      /* 이미지 하나 실패해도 나머지로 진행 */
    }
  }
  return blocks;
}

let client = null;
let disabled = false;

export async function extractFromImages({ dealer, title, images }) {
  if (disabled || images.length === 0) return null;
  try {
    client ??= new Anthropic(); // ANTHROPIC_API_KEY 또는 ant auth 프로필에서 자격증명 해석
  } catch {
    disabled = true;
    console.warn('  [vision] API 자격증명 없음 — 이번 실행에서 이미지 추출 비활성화');
    return null;
  }
  // 배너 속 작은 한글(증정 조건 등)을 정확히 읽어야 해서 고해상도 비전을 지원하는 모델을 쓴다.
  // 캠페인당 한 번만 호출되고 결과는 캐싱되므로 비용은 캠페인당 몇십 원 수준.
  const model = process.env.VISION_MODEL || 'claude-sonnet-5';
  try {
    const imageBlocks = await prepareImageBlocks(images);
    if (imageBlocks.length === 0) return null;
    const response = await client.messages.create({
      model,
      max_tokens: 4000, // 혜택 목록이 긴 배너에서 JSON이 중간에 잘리지 않도록 여유 있게
      thinking: { type: 'disabled' },
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [
        {
          role: 'user',
          content: [
            ...imageBlocks,
            {
              type: 'text',
              text:
                `위 이미지는 BMW 딜러 "${dealer}"의 캠페인 "${title}" 안내문이다 (이미지가 여러 장이면 세로로 긴 배너를 잘라 이어붙인 것일 수 있음). ` +
                `캠페인 기간, 할인 혜택, 그리고 무료·증정 혜택(무상점검, 사은품, 증정 조건)을 빠짐없이 추출하라. ` +
                `글자를 정확히 옮겨 적어라(예: "입고 시"와 "입금 시"는 다른 말이다). 이미지에 없는 내용은 지어내지 마라.`,
            },
          ],
        },
      ],
    });
    if (response.stop_reason === 'refusal') return null;
    const text = response.content.find((b) => b.type === 'text')?.text;
    if (!text) return null;
    return { v: EXTRACT_VERSION, ...JSON.parse(text) };
  } catch (err) {
    // SDK가 API 키 자체를 못 찾으면 HTTP 요청 전에 던지는 클라이언트측 에러라
    // Anthropic.AuthenticationError(서버 응답 401)의 서브클래스가 아니다 — 메시지로 함께 판별한다.
    if (err instanceof Anthropic.AuthenticationError || /authentication method/i.test(err.message)) {
      disabled = true;
      console.warn('  [vision] API 자격증명 없음 — 이번 실행에서 이미지 추출 비활성화');
    } else {
      console.warn(`  [vision] "${title}" 추출 실패: ${err.message}`);
    }
    return null;
  }
}

const RATING_SCHEMA = {
  type: 'object',
  properties: {
    ratings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          dealer: { type: 'string', description: '입력에 있는 딜러사 이름 그대로' },
          rating: { type: 'string', enum: ['강추', '추천', '보통'] },
          reason: { type: 'string', description: '핵심 근거 한 줄 (30자 이내)' },
        },
        required: ['dealer', 'rating', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['ratings'],
  additionalProperties: false,
};

// 현재 진행 중인 캠페인 전체를 놓고 딜러별 추천 등급을 매긴다 (실행당 1회, 텍스트만이라 저렴)
export async function rateCampaigns(posts) {
  if (disabled || posts.length === 0) return null;
  try {
    client ??= new Anthropic();
  } catch {
    disabled = true;
    return null;
  }
  const model = process.env.VISION_MODEL || 'claude-sonnet-5';
  const input = posts.map((p) => ({
    dealer: p.dealer,
    campaign: p.title,
    period: p.extract?.period ?? '미상',
    isServiceCampaign: p.extract ? p.extract.isServiceCampaign : !!p.service,
    discounts: p.extract?.discounts ?? [],
    freebies: p.extract?.freebies ?? [],
  }));
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 1000,
      thinking: { type: 'disabled' },
      output_config: { format: { type: 'json_schema', schema: RATING_SCHEMA } },
      messages: [
        {
          role: 'user',
          content:
            `BMW 차주가 정비받을 딜러 서비스센터를 고르고 있다. 아래는 딜러별 현재 캠페인이다.\n\n${JSON.stringify(input, null, 1)}\n\n` +
            `딜러마다 추천 등급을 매겨라. 기준: (1) 무료 혜택이 많고 받기 쉬운가 — 무상점검, 문턱 낮은 사은품(적은 결제금액·간단한 조건)일수록 좋음 ` +
            `(2) 소모품·타이어·에어컨·공임 등 실제 정비비를 줄여주는 할인폭 (3) 정비 캠페인이 아닌 판매·금융 프로모션은 '보통'. ` +
            `'강추'는 가장 실속 있는 1~2곳에만 부여하라.`,
        },
      ],
    });
    if (response.stop_reason === 'refusal') return null;
    const text = response.content.find((b) => b.type === 'text')?.text;
    return text ? JSON.parse(text).ratings : null;
  } catch (err) {
    console.warn(`  [rating] 추천 등급 산정 실패: ${err.message}`);
    return null;
  }
}
