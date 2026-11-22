import { describe, expect, it } from 'vitest';

/**
 * Harbor City is an original IP. This scan fails if franchise names, signature terms of other
 * games, or real-world brands appear anywhere in shipped source. Matching is case-insensitive
 * on word boundaries unless the entry is marked case-sensitive.
 */
const DENY: readonly { pattern: string; caseSensitive?: boolean; reason: string }[] = [
  { pattern: 'grand\\s*theft', reason: 'franchise name' },
  { pattern: 'gta', reason: 'franchise abbreviation' },
  { pattern: 'rockstar', reason: 'publisher name' },
  { pattern: 'liberty\\s*city', reason: 'franchise location' },
  { pattern: 'vice\\s*city', reason: 'franchise location' },
  { pattern: 'san\\s*andreas', reason: 'franchise location' },
  { pattern: 'los\\s*santos', reason: 'franchise location' },
  { pattern: 'san\\s*fierro', reason: 'franchise location' },
  { pattern: 'las\\s*venturas', reason: 'franchise location' },
  { pattern: 'staunton', reason: 'franchise location' },
  { pattern: 'shoreside', reason: 'franchise location' },
  { pattern: 'portland', reason: 'franchise district name' },
  { pattern: "pay\\s*['’]?\\s*n\\s*['’]?\\s*spray", reason: 'franchise shop name' },
  { pattern: 'ammu\\s*-?\\s*nation', reason: 'franchise shop name' },
  { pattern: 'vercetti', reason: 'franchise character' },
  { pattern: 'bellic', reason: 'franchise character' },
  { pattern: 'WASTED', caseSensitive: true, reason: 'franchise death screen (use FLATLINED)' },
  { pattern: 'BUSTED', caseSensitive: true, reason: 'franchise arrest screen (use CUFFED)' },
  { pattern: 'hidden\\s+packages?', reason: 'franchise collectible name (use Stashes)' },
  {
    pattern: 'ferrari|lamborghini|porsche|chevrolet|camaro|corvette|toyota|honda|nissan|cadillac',
    reason: 'car brand',
  },
  { pattern: 'bmw|mercedes|audi|volkswagen|ford\\s+mustang', reason: 'car brand' },
  { pattern: 'mcdonald|starbucks|coca[-\\s]?cola|pepsi|walmart', reason: 'consumer brand' },
];

const SOURCES = import.meta.glob<string>('/src/**/*.{ts,css,html,json}', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const INDEX_HTML = import.meta.glob<string>('/index.html', { query: '?raw', import: 'default', eager: true });

const SELF = '/src/content/ip-denylist.test.ts';

describe('IP deny-list', () => {
  const files = Object.entries({ ...SOURCES, ...INDEX_HTML }).filter(([path]) => path !== SELF);

  it('scans a meaningful number of files', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const entry of DENY) {
    it(`no "${entry.pattern}" (${entry.reason})`, () => {
      const regex = new RegExp(`\\b(?:${entry.pattern})\\b`, entry.caseSensitive ? 'g' : 'gi');
      const hits: string[] = [];
      for (const [path, text] of files) {
        const lines = text.split('\n');
        lines.forEach((line, i) => {
          if (regex.test(line)) hits.push(`${path}:${i + 1}: ${line.trim()}`);
          regex.lastIndex = 0;
        });
      }
      expect(hits).toEqual([]);
    });
  }
});
