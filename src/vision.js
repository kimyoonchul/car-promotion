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

// Claude API 이미지 한 변 최대 8000px — 여유를 두고 이보다 크면 잘라서 보낸다
const MAX_DIM = 7500;
const OVERLAP = 150; // 슬라이스 경계에서 글줄이 잘리지 않도록 겹침

const mediaTypeOf = (res, url) => {
  const ct = res.headers.get('content-type')?.split(';')[0];
  if (ct?.startsWith('image/')) return ct;
  if (/\.png(\?|$)/i.test(url)) return 'image/png';
  if (/\.webp(\?|$)/i.test(url)) return 'image/webp';
  if (/\.gif(\?|$)/i.test(url)) return 'image/gif';
  return 'image/jpeg';
};

// 이미지 URL들을 API에 넣을 수 있는 base64 블록으로 변환.
// 세로로 매우 긴 배너(딜러 공지에 흔함)는 겹치게 잘라 여러 장으로 나눈다.
async function prepareImageBlocks(urls) {
  const blocks = [];
  for (const url of urls.slice(0, 2)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const { width = 0, height = 0 } = await sharp(buf).metadata();
      if (!width || !height) continue;

      if (width <= MAX_DIM && height <= MAX_DIM) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaTypeOf(res, url), data: buf.toString('base64') } });
        continue;
      }
      // 가로가 한도를 넘으면 축소(가로형 배너는 축소해도 글자가 읽힘)
      let base = buf;
      let w = width;
      let h = height;
      if (width > MAX_DIM) {
        base = await sharp(buf).resize({ width: MAX_DIM, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
        ({ width: w = 0, height: h = 0 } = await sharp(base).metadata());
      }
      if (h <= MAX_DIM) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base.toString('base64') } });
        continue;
      }
      // 세로로 긴 배너는 축소하면 글자가 뭉개지므로 슬라이스로 나눈다 (최대 3장)
      const slices = Math.min(Math.ceil(h / MAX_DIM), 3);
      const sliceH = Math.ceil(h / slices);
      for (let i = 0; i < slices; i++) {
        const top = Math.max(0, i * sliceH - OVERLAP);
        const cut = Math.min(sliceH + OVERLAP * 2, h - top);
        const out = await sharp(base).extract({ left: 0, top, width: w, height: cut }).jpeg({ quality: 85 }).toBuffer();
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
  // 배너 이미지에서 기간·혜택만 뽑는 단순 구조화 추출이라 저렴한 모델로 충분하다.
  // 캠페인당 한 번만 호출되고 결과는 캐싱되므로 비용은 매우 작다.
  const model = process.env.VISION_MODEL || 'claude-haiku-4-5';
  try {
    const imageBlocks = await prepareImageBlocks(images);
    if (imageBlocks.length === 0) return null;
    const response = await client.messages.create({
      model,
      max_tokens: 1500,
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
                `캠페인 기간, 할인 혜택, 그리고 무료·증정 혜택(무상점검, 사은품, 증정 조건)을 빠짐없이 추출하라. 이미지에 없는 내용은 지어내지 마라.`,
            },
          ],
        },
      ],
    });
    if (response.stop_reason === 'refusal') return null;
    const text = response.content.find((b) => b.type === 'text')?.text;
    return text ? JSON.parse(text) : null;
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
