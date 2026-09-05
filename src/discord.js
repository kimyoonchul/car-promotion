const BMW_BLUE = 0x1c69d4;
const GREY = 0x99aab5;

const trim = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const bullets = (arr, max) => arr.slice(0, max).map((x) => `• ${trim(x, 100)}`).join('\n').slice(0, 1024);

// 캠페인 1건을 디스코드 embed 카드로 변환 (신규 알림·요약 다이제스트 공용)
function postEmbed(post, { isNew = false } = {}) {
  const ex = post.extract;
  const isService = ex ? ex.isServiceCampaign : !!post.service;
  const badge = post.rating === '강추' ? '⭐⭐ ' : post.rating === '추천' ? '⭐ ' : '';
  const icon = isNew ? '🆕' : isService ? '🔧' : '🚗';

  const desc = [];
  if (post.rating && post.rating !== '보통') {
    desc.push(`🏆 **${post.rating}**${post.reason ? ` — ${post.reason}` : ''}`);
  }
  if (ex?.period && ex.period !== '미상') {
    desc.push(`🗓️ **${ex.period}**${post.dday ? `  ·  ${post.dday}` : ''}`);
  }
  desc.push(`📍 ${post.regions}`);
  if (!ex) desc.push('상세 내용은 링크에서 확인하세요.');

  // 핵심 혜택(초압축)이 있으면 그것만 — 전체 목록은 시트 "상세 혜택" 탭에서 본다
  const fields = [];
  if (post.highlights?.length) {
    fields.push({ name: '✨ 핵심 혜택', value: bullets(post.highlights, 4) });
  } else {
    if (ex?.discounts?.length) fields.push({ name: '💸 할인', value: bullets(ex.discounts, 4) });
    if (ex?.freebies?.length) fields.push({ name: '🎁 무료·사은품', value: bullets(ex.freebies, 3) });
  }

  return {
    title: `${badge}${icon} ${post.dealer} — ${post.title}`.slice(0, 256),
    url: post.url,
    color: isService ? BMW_BLUE : GREY,
    description: desc.join('\n'),
    fields,
    footer: { text: `${post.category ?? ''}${post.publishedOn ? ` · 게시 ${post.publishedOn}` : ''}` },
  };
}

export async function postToWebhook(payload) {
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

// embed의 대략적 글자수 (디스코드는 메시지당 embed 합계 6000자·10개 제한)
const embedSize = (e) =>
  (e.title?.length ?? 0) +
  (e.description?.length ?? 0) +
  (e.footer?.text.length ?? 0) +
  (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);

// "지금 진행중" 전체 요약 다이제스트 — 한도를 넘으면 여러 메시지로 나눠 보낸다
export async function sendDigest(posts, dateStr) {
  if (posts.length === 0) return false;
  const embeds = posts.map((p) => postEmbed(p));

  const chunks = [];
  let cur = [];
  let size = 0;
  for (const e of embeds) {
    if (cur.length && (cur.length >= 10 || size + embedSize(e) > 5000)) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(e);
    size += embedSize(e);
  }
  if (cur.length) chunks.push(cur);

  let sent = false;
  for (let i = 0; i < chunks.length; i++) {
    const ok = await postToWebhook({
      content: i === 0 ? `## 📋 지금 진행 중인 BMW 딜러 캠페인\n${dateStr} 기준 · 딜러 ${posts.length}곳 · ⭐ 추천 / 🔧 정비 / 🚗 판매·기타` : undefined,
      embeds: chunks[i],
    });
    sent ||= ok;
  }
  return sent;
}
