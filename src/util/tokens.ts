/**
 * Token estimation and text splitting.
 *
 * Exactness is unnecessary: the chunker's ceiling sits below the embedding
 * model's true limit, so the heuristic only has to be conservative rather than
 * correct. chars/4 is the usual approximation for Latin script; CJK glyphs are
 * roughly one token each, which chars/4 underestimates by ~4x, so they are
 * counted separately.
 *
 * Every splitter here keeps one promise: each part it returns fits within
 * `maxTokens` (plus, for code and tables, the fence or header it repeats).
 * Structure decides where a cut goes when it can; `splitHard` is the last
 * resort for a unit with no structure left to cut at, such as a minified line
 * or a base64 blob, which used to become one unbounded chunk.
 */

const CJK_RANGES =
  /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/u;

export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    if (CJK_RANGES.test(ch)) cjk++;
  }
  const rest = text.length - cjk;
  return Math.ceil(rest / 4) + cjk;
}

/**
 * The trailing ~`tokens` worth of text, snapped forward to a sentence or word
 * boundary so the fragment never begins mid-word.
 */
export function takeLastTokens(text: string, tokens: number): string {
  const approxChars = tokens * 4;
  if (text.length <= approxChars) return text;

  let cut = text.length - approxChars;
  const sentence = text.indexOf(". ", cut);
  if (sentence !== -1 && sentence - cut < approxChars / 2) {
    cut = sentence + 2;
  } else {
    const space = text.indexOf(" ", cut);
    if (space !== -1) cut = space + 1;
  }
  return text.slice(cut).trimStart();
}

/** Greedily pack sentences into parts of at most `maxTokens`. */
export function splitProse(text: string, maxTokens: number): string[] {
  if (estimateTokens(text) <= maxTokens) return [text];

  const sentences = text.match(/[^.!?]+(?:[.!?]+["')\]]*\s*|$)/g) ?? [text];
  const parts: string[] = [];
  let current = "";

  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed) parts.push(trimmed);
    current = "";
  };

  for (const sentence of sentences) {
    if (estimateTokens(sentence) > maxTokens) {
      // A single sentence over budget (common in tables-as-prose or in text
      // with no terminal punctuation at all). Fall back to word boundaries.
      pushCurrent();
      for (const wordPart of splitWords(sentence, maxTokens)) parts.push(wordPart);
      continue;
    }
    if (current && estimateTokens(current + sentence) > maxTokens) pushCurrent();
    current += sentence;
  }
  pushCurrent();

  return parts.length > 0 ? parts : [text];
}

function splitWords(text: string, maxTokens: number): string[] {
  const words = text.split(/(\s+)/);
  const parts: string[] = [];
  let current = "";
  for (const word of words) {
    if (estimateTokens(word) > maxTokens) {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = "";
      parts.push(...splitHard(word, maxTokens));
      continue;
    }
    if (current && estimateTokens(current + word) > maxTokens) {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = "";
    }
    current += word;
  }
  const trimmed = current.trim();
  if (trimmed) parts.push(trimmed);
  return parts;
}

/**
 * Cut text into parts of at most `maxTokens` with no regard for structure,
 * preferring whitespace near the end of each window when there is any. Counted
 * the way `estimateTokens` counts, so a CJK run is cut as tightly as Latin.
 */
export function splitHard(text: string, maxTokens: number): string[] {
  const budget = Math.max(1, Math.floor(maxTokens));
  const parts: string[] = [];
  const push = (part: string) => {
    const trimmed = part.trimEnd();
    if (trimmed.trim()) parts.push(trimmed);
  };

  let start = 0;
  let latin = 0;
  let cjk = 0;
  /** Index just past the last whitespace in the current window, or -1. */
  let lastBreak = -1;
  const count = (ch: string) => {
    if (CJK_RANGES.test(ch)) cjk++;
    else latin += ch.length;
  };

  let i = 0;
  while (i < text.length) {
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    const isCjk = CJK_RANGES.test(ch);
    const next = Math.ceil((latin + (isCjk ? 0 : ch.length)) / 4) + cjk + (isCjk ? 1 : 0);
    if (next > budget && i > start) {
      const cut = lastBreak > start + (i - start) * 0.9 ? lastBreak : i;
      push(text.slice(start, cut));
      start = cut;
      latin = 0;
      cjk = 0;
      lastBreak = -1;
      for (const carried of text.slice(start, i)) count(carried);
      continue;
    }
    count(ch);
    i += ch.length;
    if (/\s/u.test(ch)) lastBreak = i;
  }
  push(text.slice(start));

  return parts.length > 0 ? parts : [text];
}

/**
 * Split a list at item boundaries, never mid-item.
 *
 * Continuation lines (wrapped text, nested items) travel with the item they
 * belong to, so a split never strands half of a bullet.
 */
export function splitList(text: string, maxTokens: number): string[] {
  if (estimateTokens(text) <= maxTokens) return [text];

  const isItemStart = (line: string) => /^\s*(?:[-*+]|\d+[.)])\s/.test(line);

  const items: string[] = [];
  let currentItem: string[] = [];
  for (const line of text.split("\n")) {
    if (isItemStart(line) && currentItem.length > 0) {
      items.push(currentItem.join("\n"));
      currentItem = [];
    }
    currentItem.push(line);
  }
  if (currentItem.length > 0) items.push(currentItem.join("\n"));

  const parts: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length > 0) parts.push(buf.join("\n"));
    buf = [];
  };

  for (const item of items) {
    if (estimateTokens(item) > maxTokens) {
      // One bullet longer than a whole chunk. Nothing to do but split its
      // prose; the marker stays on the first fragment.
      flush();
      for (const part of splitProse(item, maxTokens)) parts.push(part);
      continue;
    }
    if (buf.length > 0 && estimateTokens([...buf, item].join("\n")) > maxTokens) flush();
    buf.push(item);
  }
  flush();

  return parts.length > 0 ? parts : [text];
}

/** Split a fenced code block at line boundaries, repeating fence + language. */
export function splitCode(text: string, maxTokens: number): string[] {
  if (estimateTokens(text) <= maxTokens) return [text];

  const lines = text.split("\n");
  const fenceOpen = lines[0]?.startsWith("```") ? lines[0] : "```";
  const hasFence = lines[0]?.startsWith("```") ?? false;
  const body = hasFence ? lines.slice(1, lines.at(-1) === "```" ? -1 : undefined) : lines;

  const parts: string[] = [];
  let current: string[] = [];
  const overhead = estimateTokens(`${fenceOpen}\n\n\`\`\``);

  for (const line of body) {
    if (estimateTokens(line) + overhead > maxTokens) {
      // One line longer than a whole chunk: minified code, an inlined blob.
      if (current.length > 0) parts.push(`${fenceOpen}\n${current.join("\n")}\n\`\`\``);
      current = [];
      for (const piece of splitHard(line, maxTokens - overhead)) {
        parts.push(`${fenceOpen}\n${piece}\n\`\`\``);
      }
      continue;
    }
    const projected = [...current, line].join("\n");
    if (current.length > 0 && estimateTokens(projected) + overhead > maxTokens) {
      parts.push(`${fenceOpen}\n${current.join("\n")}\n\`\`\``);
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) parts.push(`${fenceOpen}\n${current.join("\n")}\n\`\`\``);

  return parts.length > 0 ? parts : [text];
}

/**
 * Split a GFM pipe table by row groups, repeating the header and its alignment
 * row in every part so each fragment is a valid, readable table on its own.
 */
export function splitTable(text: string, maxTokens: number): string[] {
  if (estimateTokens(text) <= maxTokens) return [text];

  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const header = lines[0];
  const align = lines[1];
  // Not a pipe table with a header we can repeat — fall back to line packing.
  if (!header || !align || !/^\s*\|?[\s:|-]+\|?\s*$/.test(align)) {
    return splitProse(text, maxTokens);
  }

  const headerBlock = `${header}\n${align}`;
  const headerTokens = estimateTokens(headerBlock);
  const parts: string[] = [];
  let current: string[] = [];

  for (const row of lines.slice(2)) {
    // The newline joining header and row counts too.
    const rowBudget = maxTokens - headerTokens - 1;
    if (estimateTokens(row) > rowBudget) {
      // One row longer than a whole chunk. Its pieces are not valid rows, but
      // each still sits under the header it belongs to.
      if (current.length > 0) parts.push(`${headerBlock}\n${current.join("\n")}`);
      current = [];
      for (const piece of splitHard(row, rowBudget)) parts.push(`${headerBlock}\n${piece}`);
      continue;
    }
    const projected = estimateTokens([...current, row].join("\n")) + headerTokens;
    if (current.length > 0 && projected > maxTokens) {
      parts.push(`${headerBlock}\n${current.join("\n")}`);
      current = [];
    }
    current.push(row);
  }
  if (current.length > 0) parts.push(`${headerBlock}\n${current.join("\n")}`);

  return parts.length > 0 ? parts : [text];
}
