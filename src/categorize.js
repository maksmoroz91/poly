// Priority order from the issue: esports > politics > crypto > other.
// Category is resolved from a combination of Gamma's `category` field and
// keyword matching on the question text, since Polymarket categories are
// often generic ("Sports", "Politics").

// Keyword lists use word-boundary matching (see `matchesWord`) so short
// tokens like "lec" don't falsely hit "election".
const ESPORTS_KEYWORDS = [
  'cs2', 'counter-strike', 'counter strike', 'csgo', 'cs:go',
  'dota', 'dota2',
  'league of legends', 'lol', 'lcs', 'lec', 'lck', 'lpl', 'worlds',
  'valorant', 'vct',
  'esports', 'e-sports',
];

const POLITICS_KEYWORDS = [
  'election', 'elections', 'president', 'presidential', 'senate', 'congress',
  'vote', 'voting', 'parliament', 'primary', 'primaries', 'nominee',
  'nomination', 'referendum', 'government', 'cabinet', 'prime minister',
  'governor', 'impeachment',
];

const CRYPTO_KEYWORDS = [
  'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol',
  'crypto', 'stablecoin', 'usdt', 'usdc', 'altcoin', 'blockchain',
];

export const PRIORITY = {
  esports: 1,
  politics: 2,
  crypto: 3,
  other: 4,
};

export function categorize(market) {
  const hay = [market?.question, market?.category, market?.slug]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (ESPORTS_KEYWORDS.some((k) => matchesWord(hay, k))) return 'esports';
  if (POLITICS_KEYWORDS.some((k) => matchesWord(hay, k))) return 'politics';
  if (CRYPTO_KEYWORDS.some((k) => matchesWord(hay, k))) return 'crypto';
  return 'other';
}

function matchesWord(hay, keyword) {
  // Escape regex metachars, then anchor on non-word boundaries so "lec"
  // does not match inside "election" but still matches "LEC Finals".
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i');
  return re.test(hay);
}

export function priorityOf(category) {
  return PRIORITY[category] ?? PRIORITY.other;
}
