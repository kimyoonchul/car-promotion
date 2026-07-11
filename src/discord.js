const BMW_BLUE = 0x1c69d4;
const GREY = 0x99aab5;

const bullets = (arr, max) => arr.slice(0, max).map((x) => `• ${x}`).join('\n').slice(0, 1024);

// 캠페인 1건을 디스코드 embed 카드로 변환 (신규 알림·요약 다이제스트 공용)
function postEmbed(post, { isNew = false } = {}) {
  const ex = post.extract;
  const isService = ex ? ex.isServiceCampaign : !!post.service;
  const icon = isNew ? '🆕' : isService ? '🔧' : '🚗';

  const desc = [];
  if (ex?.period && ex.period !== '미상') {
    desc.push(`🗓️ **${ex.period}**${post.dday ? `  ·  ${post.dday}` : ''}`);
  }
  desc.push(`📍 ${post.regions}`);
  if (!ex) desc.push('상세 내용은 링크에서 확인하세요.');

  const fields = [];
  if (ex?.discounts?.length) fields.push({ name: '💸 할인', value: bullets(ex.discounts, 6) });
  if (ex?.freebies?.length) fields.push({ name: '🎁 무료·사은품', value: bullets(ex.freebies, 6) });

  return {
    title: `${icon} ${post.dealer} — ${post.title}`.slice(0, 256),
    url: post.url,
    color: isService ? BMW_BLUE : GREY,
    description: desc.join('\n'),
    fields,
    footer: { text: `${post.category ?? ''}${post.publishedOn ? ` · 게시 ${post.publishedOn}` : ''}` },
  };
}

async function postToWebhook(payload) {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) return false;
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'BMW 캠페인 알림', ...payload }),
  });
  if (!res.ok) throw new Error(`Discord webhook HTTP ${res.status}`);
  return true;
}

// 신규 캠페인 1건 알림
export async function notifyDiscord(post) {
  return postToWebhook({ embeds: [postEmbed(post, { isNew: true })] });
}

// "지금 진행중" 전체 요약 다이제스트 (디스코드는 메시지당 embed 최대 10개)
export async function sendDigest(posts, dateStr) {
  if (posts.length === 0) return false;
  return postToWebhook({
    content: `## 📋 지금 진행 중인 BMW 딜러 캠페인\n${dateStr} 기준 · 딜러 ${posts.length}곳 · 🔧 정비 캠페인 / 🚗 판매·기타`,
    embeds: posts.slice(0, 10).map((p) => postEmbed(p)),
  });
}
