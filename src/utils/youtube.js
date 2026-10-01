const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
]);

/**
 * Accepts an 11-character video id or any common YouTube link
 * (watch, youtu.be, embed, shorts, live) and returns the video id, or null.
 * Only the validated id is ever stored or sent to other users, never the raw text.
 */
export function extractVideoId(input) {
  const text = String(input).trim();
  if (VIDEO_ID.test(text)) return text;

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;

  let candidate;
  if (host === 'youtu.be') {
    candidate = url.pathname.split('/')[1];
  } else if (url.pathname === '/watch') {
    candidate = url.searchParams.get('v');
  } else {
    candidate = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/)?.[1];
  }

  return candidate && VIDEO_ID.test(candidate) ? candidate : null;
}
