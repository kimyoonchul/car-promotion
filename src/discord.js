const BMW_BLUE = 0x1c69d4;

export async function notifyDiscord(post) {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) return false;

  const lines = [];
  if (post.extract?.summary) lines.push(post.extract.summary);
  if (post.extract?.period && post.extract.period !== '미상') lines.push(`**기간** ${post.extract.period}`);
  if (post.extract?.benefits?.length) lines.push(post.extract.benefits.map((b) => `• ${b}`).join('\n'));

  const embed = {
    title: `${post.dealer} — ${post.title}`.slice(0, 256),
    url: post.url,
    color: BMW_BLUE,
    description: lines.join('\n\n').slice(0, 4000) || undefined,
    footer: { text: `${post.category}${post.publishedOn ? ` · 게시 ${post.publishedOn}` : ''} · ${post.regions}` },
  };

  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'BMW 캠페인 알림', embeds: [embed] }),
  });
  if (!res.ok) throw new Error(`Discord webhook HTTP ${res.status}`);
  return true;
}
