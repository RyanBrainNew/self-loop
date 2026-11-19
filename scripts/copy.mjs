// Output-language helpers. The loop speaks the project's language for the
// artifacts a person reads; machine values stay in English.

export const SUPPORTED_LANGUAGES = Object.freeze(['zh-CN', 'en']);

export function normalizeLanguage(value, fallback = 'zh-CN') {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const lower = raw.toLowerCase();
  if (lower === 'zh' || lower === 'zh-cn' || lower === 'zh-hans') {
    return 'zh-CN';
  }
  if (lower === 'en' || lower.startsWith('en-')) return 'en';
  throw new Error(`language must be one of ${SUPPORTED_LANGUAGES.join(', ')}: ${raw}`);
}

export function isChinese(language) {
  return normalizeLanguage(language) === 'zh-CN';
}

export function pick(language, english, chinese) {
  return isChinese(language) ? chinese : english;
}
