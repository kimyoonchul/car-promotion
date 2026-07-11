import Anthropic from '@anthropic-ai/sdk';

// 딜러들이 캠페인 상세(기간·할인율)를 배너 이미지로만 게시하므로 비전 모델로 추출한다.
// structured outputs(json_schema)로 응답 형식을 보장한다.

const SCHEMA = {
  type: 'object',
  properties: {
    period: { type: 'string', description: '캠페인 기간 (예: "2026.06.15 ~ 2026.08.31"). 이미지에서 확인 불가면 "미상"' },
    benefits: { type: 'array', items: { type: 'string' }, description: '혜택 목록. 각 항목은 "대상: 할인내용" 형식 (예: "엔진오일: 부품 20% 할인")' },
    summary: { type: 'string', description: '캠페인 핵심 내용 한 문장 요약' },
    isServiceCampaign: { type: 'boolean', description: '정비/서비스(A/S) 캠페인이면 true, 차량 판매·금융 프로모션이면 false' },
  },
  required: ['period', 'benefits', 'summary', 'isServiceCampaign'],
  additionalProperties: false,
};

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
  const model = process.env.VISION_MODEL || 'claude-opus-4-8';
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [
        {
          role: 'user',
          content: [
            ...images.slice(0, 2).map((url) => ({ type: 'image', source: { type: 'url', url } })),
            {
              type: 'text',
              text: `위 이미지는 BMW 딜러 "${dealer}"의 캠페인 "${title}" 안내문이다. 캠페인 기간과 혜택(할인 항목·할인율·조건)을 추출하라.`,
            },
          ],
        },
      ],
    });
    if (response.stop_reason === 'refusal') return null;
    const text = response.content.find((b) => b.type === 'text')?.text;
    return text ? JSON.parse(text) : null;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      disabled = true;
      console.warn('  [vision] API 자격증명 없음 — 이번 실행에서 이미지 추출 비활성화');
    } else {
      console.warn(`  [vision] "${title}" 추출 실패: ${err.message}`);
    }
    return null;
  }
}
