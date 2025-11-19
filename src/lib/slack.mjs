// src/lib/slack.mjs

// Node 18+ は fetch がグローバルに入っているので、そのまま使える想定
const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

export async function notifySlack(text) {
  if (!WEBHOOK_URL) {
    console.warn('SLACK_WEBHOOK_URL が設定されていないので Slack 通知をスキップします:', text);
    return;
  }

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('Slack 通知に失敗しました:', res.status, body);
    } else {
      console.log('📣 Slack 通知を送信しました');
    }
  } catch (e) {
    console.warn('Slack 通知中にエラーが発生しました:', e.message);
  }
}
