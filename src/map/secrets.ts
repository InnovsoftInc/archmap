// Patterns for secrets that must never be written into a map file.

const PATTERNS: [string, RegExp][] = [
  ["aws key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["stripe key", /\b[sr]k_live_[0-9a-zA-Z]{16,}/],
  ["github token", /\bgh[pousr]_[0-9a-zA-Z]{36,}/],
  ["slack token", /\bxox[abprs]-[0-9a-zA-Z-]{10,}/],
  [
    "assigned secret",
    /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["'][^"'\s]{8,}["']/i,
  ],
  ["url with credentials", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
  ["azure account key", /AccountKey=[A-Za-z0-9+/=]{40,}/],
  ["jwt", /\beyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/],
];

/** Names of the patterns that match `text`. */
export const findSecrets = (text: string): string[] =>
  PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
