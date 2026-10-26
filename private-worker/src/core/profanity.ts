const MAP: Record<string, string> = {
  ي: 'ی', ى: 'ی', ك: 'ک', ة: 'ه', ۀ: 'ه', أ: 'ا', إ: 'ا', آ: 'ا', ؤ: 'و', ئ: 'ی',
}

/** Unify Persian/Arabic letter variants, drop diacritics, tatweel, zero-width and bidi marks. */
export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/[يىكةۀأإآؤئ]/g, (ch) => MAP[ch] ?? ch)
    .replace(/[۰-۹٠-٩]/g, (ch) => {
      const c = ch.charCodeAt(0)
      return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660)
    })
}

const collapse = (s: string) => s.replace(/(.)\1+/gu, '$1') // "fuuuck" → "fuck"
const squash = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, '') // "f u c k" → "fuck"
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Words up to 3 letters only match as a whole word (avoids false positives);
 * longer words also match inside text with spaces / symbols / repeated letters removed.
 */
export class ProfanityFilter {
  private short = new Set<string>()
  private long: string[] = []

  constructor(words: string[]) {
    for (const w of words) {
      const n = collapse(squash(normalize(w)))
      if (!n) continue
      if ([...n].length <= 3) this.short.add(n)
      else this.long.push(n)
    }
  }

  test(text: string): boolean {
    if (!this.short.size && !this.long.length) return false
    const norm = normalize(text)
    if (this.short.size) {
      // Short banned terms also allow punctuation, emoji, or spaces between their letters,
      // while Unicode letter/number boundaries prevent matches inside unrelated longer words.
      for (const word of this.short) {
        const pieces = [...word].map((ch) => `${escapeRegex(ch)}+`).join('[^\\p{L}\\p{N}]*')
        const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${pieces}(?![\\p{L}\\p{N}])`, 'u')
        if (pattern.test(norm)) return true
      }
    }
    if (this.long.length) {
      const flat = collapse(squash(norm))
      for (const w of this.long) if (flat.includes(w)) return true
    }
    return false
  }
}
