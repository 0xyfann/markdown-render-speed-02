// parse.js — a fast, dependency-free Markdown-to-HTML renderer whose output
// matches marked 18.1.3 (default options: gfm true, breaks false) byte for
// byte. Written from scratch as a two-phase parser: a container-aware block
// phase followed by a delimiter-stack inline phase, with the GFM extensions
// marked enables (tables, strikethrough, task lists, extended autolinks).
//
// export: parse(markdown: string) -> string (HTML)

// ---------------------------------------------------------------------------
// Character helpers
// ---------------------------------------------------------------------------

function isPunct(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

// Escape a string for HTML text or attribute values the way marked does:
// &, <, >, " and ' all become entities.
function escapeHtml(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === '&') { out += '&amp;'; i++; continue; }
    if (ch === '<') { out += '&lt;'; i++; continue; }
    if (ch === '>') { out += '&gt;'; i++; continue; }
    if (ch === '"') { out += '&quot;'; i++; continue; }
    if (ch === "'") { out += '&#39;'; i++; continue; }
    let j = i + 1;
    while (j < n) {
      const c = s[j];
      if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") break;
      j++;
    }
    out += s.slice(i, j);
    i = j;
  }
  return out;
}

const NAMED_ENTITY_AT = /^&[A-Za-z][A-Za-z0-9]*;/;

// Escape for attribute values (href, title, alt, language class): like
// escapeHtml, but an & that opens a named entity reference passes through,
// as marked leaves named entities in attributes untouched.
function escapeAttr(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === '&') {
      const m = NAMED_ENTITY_AT.exec(s.slice(i, i + 40));
      if (m) { out += m[0]; i += m[0].length; continue; }
      out += '&amp;'; i++; continue;
    }
    if (ch === '<') { out += '&lt;'; i++; continue; }
    if (ch === '>') { out += '&gt;'; i++; continue; }
    if (ch === '"') { out += '&quot;'; i++; continue; }
    if (ch === "'") { out += '&#39;'; i++; continue; }
    let j = i + 1;
    while (j < n) {
      const c = s[j];
      if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") break;
      j++;
    }
    out += s.slice(i, j);
    i = j;
  }
  return out;
}

// Code content inside a container (list item / block quote): a leading
// whitespace run containing a tab is re-rendered as spaces, computed by
// absolute column. Outside containers the text stays verbatim.
function codeContent(str, startCol, inContainer) {
  if (!inContainer || !/\S/.test(str)) return str;
  return expandLeadingTabs(str, startCol);
}

function expandLeadingTabs(str, startCol) {
  let w = 0, hasTab = false;
  while (w < str.length && (str[w] === ' ' || str[w] === '\t')) {
    if (str[w] === '\t') hasTab = true;
    w++;
  }
  if (!hasTab || w === 0) return str;
  let colNow = startCol, width = 0;
  for (let k = 0; k < w; k++) {
    if (str[k] === '\t') { const tw = 4 - (colNow % 4); colNow += tw; width += tw; }
    else { colNow++; width++; }
  }
  return ' '.repeat(width) + str.slice(w);
}

function escapeCode(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

function numericEntity(body) {
  let cp;
  if (body[1] === 'x' || body[1] === 'X') cp = parseInt(body.slice(2), 16);
  else cp = parseInt(body.slice(1), 10);
  if (!cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '�';
  return String.fromCodePoint(cp);
}

const ENTITY_RE = /^&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]*);/;

// Read an entity reference at s[i] === '&'. Named references are returned
// verbatim (marked passes them through); numeric ones decode. Returns
// {text, len} or null for a literal ampersand.
function readEntity(s, i) {
  const m = ENTITY_RE.exec(s.slice(i, i + 40));
  if (!m) return null;
  if (m[1][0] === '#') return { text: numericEntity(m[1]), len: m[0].length };
  return { text: m[0], len: m[0].length };
}

// A small table of named entities that can show up inside link destinations
// and titles; unknown names stay literal there.
const ATTR_NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", copy: '©', nbsp: ' ',
  reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  laquo: '«', raquo: '»', times: '×', divide: '÷', plusmn: '±',
  deg: '°', micro: 'µ', para: '¶', middot: '·', bull: '•',
};

// Decode the entity readEntity found at s[j] for use in a destination/title.
function decodeAttrChar(s, j, e) {
  const raw = s.slice(j, j + e.len);
  if (raw[1] === '#') return e.text;
  const name = raw.slice(1, -1);
  if (Object.prototype.hasOwnProperty.call(ATTR_NAMED, name)) return ATTR_NAMED[name];
  return raw;
}

// marked's URL cleanup: percent-encode like encodeURI, turn backslashes
// into %5C, then fold %25 back to % so pre-encoded URLs survive.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/\\/g, '%5C').replace(/%25/g, '%');
  } catch {
    return href;
  }
}

// ---------------------------------------------------------------------------
// Indentation helpers. Columns are absolute: a tab advances to the next
// multiple of 4 from the column where the scanned text starts (startCol).
// ---------------------------------------------------------------------------

function countIndent(line, startCol) {
  let col = startCol || 0;
  const base = col;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return col - base;
}

// Remove exactly `cols` columns of indentation; a partially consumed tab
// leaves the remaining width as spaces.
// Marked removes a fence's indent from content lines by counting
// whitespace characters (a tab counts once), not columns.
function dropChars(line, n, startCol) {
  let col = startCol || 0;
  let i = 0;
  while (i < line.length && n > 0) {
    const ch = line[i];
    if (ch === ' ') { col++; i++; n--; }
    else if (ch === '\t') { col += 4 - (col % 4); i++; n--; }
    else break;
  }
  return [line.slice(i), col];
}

function dropIndent(line, cols, startCol) {
  let col = startCol || 0;
  const target = col + cols;
  let i = 0;
  while (i < line.length && col < target) {
    const ch = line[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') {
      const w = 4 - (col % 4);
      if (col + w > target) return ' '.repeat(col + w - target) + line.slice(i + 1);
      col += w; i++;
    } else break;
  }
  return line.slice(i);
}

// Like dropIndent but reports failure when a non-space character arrives
// before `cols` columns have been consumed.
function consumeIndent(line, cols, startCol) {
  let col = startCol || 0;
  const target = col + cols;
  let p = 0;
  while (col < target) {
    if (p >= line.length) return { ok: true, rest: '' };
    const ch = line[p];
    if (ch === ' ') { col++; p++; }
    else if (ch === '\t') {
      const w = 4 - (col % 4);
      if (col + w > target) {
        return { ok: true, rest: ' '.repeat(col + w - target) + line.slice(p + 1) };
      }
      col += w; p++;
    } else {
      return { ok: false, rest: line.slice(p) };
    }
  }
  return { ok: true, rest: line.slice(p) };
}

function isBlank(s) {
  return /^[ \t]*$/.test(s);
}

// ---------------------------------------------------------------------------
// Block-level matchers
// ---------------------------------------------------------------------------

const HTML_BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));

function newBlock(t) {
  return { t, children: [], text: '', lines: null, open: true };
}

const ATX_RE = /^(#{1,6})(?:[ \t]+(.*))?$/;
const FENCE_RE = /^(`{3,}|~{3,})(.*)$/;
const HR_RE = /^(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/;
const SETEXT_RE = /^(=+|-+)[ \t]*$/;

function matchATX(rest) {
  const m = ATX_RE.exec(rest.replace(/[ \t]+$/, ''));
  if (!m) return null;
  let text = (m[2] || '').replace(/[ \t]+$/, '');
  text = text.replace(/[ \t]+#+$/, '');
  if (/^#+$/.test(text)) text = '';
  const b = newBlock('heading');
  b.level = m[1].length;
  b.text = text;
  b.open = false;
  return b;
}

function matchFence(rest) {
  const m = FENCE_RE.exec(rest);
  if (!m) return null;
  const fence = m[1];
  const info = m[2].trim();
  if (fence[0] === '`' && info.includes('`')) return null;
  const b = newBlock('code');
  b.fenced = true;
  b.fenceCh = fence[0];
  b.fenceLen = fence.length;
  b.info = info;
  b.lines = [];
  return b;
}

function matchHR(rest) {
  return HR_RE.test(rest.trim()) ? newBlock('hr') : null;
}

// HTML block start conditions (CommonMark types 1-7). Returns the type or 0.
function htmlBlockStart(rest) {
  if (rest[0] !== '<') return 0;
  if (/^<(script|pre|style|textarea)(?=[ \t]|\/>|>|$)/i.test(rest)) return 1;
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (/^<![A-Z]/.test(rest)) return 4;
  if (rest.startsWith('<![CDATA[')) return 5;
  const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[ \t]|\/>|>|$)/.exec(rest);
  if (m && HTML_BLOCK_TAGS.has(m[1].toLowerCase())) return 6;
  // Type 7: a complete open or closing tag, alone on the line.
  const tm = OPEN_TAG_RE.exec(rest) || CLOSE_TAG_RE.exec(rest);
  if (tm && rest.slice(tm[0].length).trim() === '') return 7;
  return 0;
}

function htmlBlockEnd(type, line) {
  switch (type) {
    case 1: return /<\/(script|pre|style|textarea)>/i.test(line);
    case 2: return line.includes('-->');
    case 3: return line.includes('?>');
    case 4: return line.includes('>');
    case 5: return line.includes(']]>');
    default: return false; // types 6 and 7 end at a blank line
  }
}

// List markers. The marker itself is matched without its trailing spaces;
// finishMarker works out where the item's content begins.
const BULLET_RE = /^([-+*])(?=[ \t]|$)/;
const ORDERED_RE = /^(\d{1,9})([.)])(?=[ \t]|$)/;

function matchListMarker(rest) {
  let m = BULLET_RE.exec(rest);
  if (m) return finishMarker(rest, m[0].length, { bullet: m[1] });
  m = ORDERED_RE.exec(rest);
  if (m) return finishMarker(rest, m[0].length, { num: parseInt(m[1], 10), delim: m[2] });
  return null;
}

function finishMarker(rest, markerLen, kind) {
  const after = rest.slice(markerLen);
  const spaces = countIndent(after, 0);
  const blank = after.trim() === '';
  let contentIndent;
  if (blank) contentIndent = markerLen + 1;
  else if (spaces >= 1 && spaces <= 4) contentIndent = markerLen + spaces;
  else contentIndent = markerLen + 1;
  return { ...kind, markerLen, contentIndent, blank };
}

function sameListKind(a, b) {
  if (a.bullet !== undefined || b.bullet !== undefined) return a.bullet === b.bullet;
  return a.delim === b.delim;
}

// ---------------------------------------------------------------------------
// Tables: split a row on unescaped pipes outside code spans.
// ---------------------------------------------------------------------------

function splitCells(line) {
  // Code-span ranges first: a backtick run protects pipes only when a
  // closing run of the same length exists later in the line.
  const codeRanges = [];
  {
    let i = 0;
    while (i < line.length) {
      if (line[i] !== '`') { i++; continue; }
      let run = 0;
      while (line[i + run] === '`') run++;
      let j = i + run, closed = -1;
      while (j < line.length) {
        if (line[j] === '`') {
          let r2 = 0;
          while (line[j + r2] === '`') r2++;
          if (r2 === run) { closed = j + r2; break; }
          j += r2;
        } else j++;
      }
      if (closed === -1) { i++; continue; }
      codeRanges.push([i, closed]);
      i = closed;
    }
  }
  const inCode = (pos) => codeRanges.some(([a, b]) => pos >= a && pos < b);
  const cells = [];
  let cur = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      if (line[i + 1] === '|') { cur += '|'; i += 2; continue; }
      cur += ch + line[i + 1]; i += 2; continue;
    }
    if (ch === '|' && !inCode(i)) {
      cells.push(cur); cur = ''; i++; continue;
    }
    cur += ch; i++;
  }
  cells.push(cur);
  if (cells.length > 1 && cells[0].trim() === '' && line.trimStart().startsWith('|')) cells.shift();
  if (cells.length > 1 && cells[cells.length - 1].trim() === '' && /\\?\|[ \t]*$/.test(line) && !line.trimEnd().endsWith('\\|')) cells.pop();
  return cells.map((c) => c.trim());
}

const DELIM_CELL_RE = /^:?-+:?$/;

function tableAligns(headerLine, delimLine) {
  if (!headerLine.includes('|') && !delimLine.includes('|')) return null;
  const heads = splitCells(headerLine);
  const delims = splitCells(delimLine);
  if (heads.length !== delims.length || heads.length === 0) return null;
  const aligns = [];
  for (const d of delims) {
    if (!DELIM_CELL_RE.test(d)) return null;
    if (d.startsWith(':') && d.endsWith(':')) aligns.push('center');
    else if (d.endsWith(':')) aligns.push('right');
    else if (d.startsWith(':')) aligns.push('left');
    else aligns.push(null);
  }
  return { heads, aligns };
}

// ---------------------------------------------------------------------------
// The block parser: walks lines, maintaining the stack of open blocks.
// Container prefixes (quote markers, list item indentation) are consumed
// from each line; `col` tracks the absolute column of the remainder's
// first character so tab widths resolve correctly.
// ---------------------------------------------------------------------------

function parseBlocks(src, refs) {
  const endsWithNL = src.endsWith('\n');
  const lines = src.split('\n');
  if (endsWithNL) lines.pop();

  const root = newBlock('doc');
  const stack = [root];
  const htmlBlocks = [];
  let curLi = 0;
  const tip = () => stack[stack.length - 1];

  function stackBelowTipInContainer() {
    for (let d = stack.length - 2; d >= 1; d--) {
      if (stack[d].t === 'item' || stack[d].t === 'quote') return true;
    }
    return false;
  }

  function finalizeTop(endLine) {
    const b = stack.pop();
    b.open = false;
    if (b.t === 'para') {
      b.renderText = extractDefs(b.text, refs);
      b.defsOnly = b.renderText.trim() === '';
    }
    if (b.t === 'html') b.endLine = endLine !== undefined ? endLine : curLi;
    if (b.t === 'code') {
      let ls = b.lines || [];
      if (!b.fenced) {
        while (ls.length && ls[ls.length - 1].trim() === '') ls.pop();
        b.text = ls.length ? ls.join('\n') + '\n' : '';
      } else {
        b.text = ls.length ? ls.join('\n') + (ls[ls.length - 1] !== '' ? '\n' : '') : '';
      }
    }
    if (b.t === 'html') {
      b.text = (b.lines || []).join('\n');
    }
    if (b.t === 'list') finishList(b);
    return b;
  }

  function closeDownTo(depth, endLine) {
    while (stack.length - 1 >= depth) finalizeTop(endLine);
  }

  function addChild(parent, b) {
    if (parent.t === 'item') {
      // Content added inside an item absorbs any blank that was pending
      // on the lists that contain the item.
      const idx = stack.lastIndexOf(parent);
      for (let d = 1; d < idx; d++) {
        if (stack[d].t === 'list') stack[d].blankSepPending = false;
      }
    }
    if (parent.t === 'item' && parent.children.length > 0 && parent.pendingBlank) {
      b.sepBlank = true;
    }
    parent.children.push(b);
    if (parent.t === 'item') parent.pendingBlank = false;
    stack.push(b);
    return b;
  }

  // A raw blank line inside lists: every open item remembers the blank
  // (a following direct child is blank-separated), the innermost item's
  // list remembers that its current item saw a blank after content (a
  // following sibling makes the list loose), and a still-empty innermost
  // item is sealed (marked ends an empty item at a blank line).
  function noteBlankLine(minDepth) {
    let innermost = null;
    for (let d = stack.length - 1; d > minDepth; d--) {
      const b = stack[d];
      if (b.t === 'item') {
        b.pendingBlank = true;
        if (!innermost) innermost = { item: b, depth: d };
      }
    }
    for (let d = minDepth + 1; d < stack.length; d++) {
      if (stack[d].t === 'list') stack[d].blankSepPending = true;
    }
    if (innermost) {
      const it = innermost.item;
      if (it.children.length === 0 && (tip().t === 'item' || tip().t === 'list')) {
        it.sealed = true;
      }
    }
  }

  // Blank-line semantics for a line whose remainder (after container
  // matching) is empty or all spaces. Code blocks and type 1-5 HTML blocks
  // absorb the line; paragraphs/tables/html(6,7) end; a raw blank line
  // (nothing consumed it) also ends every open blockquote, as marked's
  // blockquote chunks stop at blank lines.
  function blankLine(rem, col, matchedAll, rawBlank, quoteMatched, scopeDepth, matchedDepth) {
    if (!matchedAll) {
      // The line never reached the deeper containers (e.g. a ">"-only
      // line with two quotes open): everything below the match closes,
      // including a fence that would otherwise absorb the blank.
      closeDownTo(matchedDepth, curLi - 1);
    }
    const t = tip();
    if (matchedAll && t.t === 'code') {
      t.lines.push(t.fenced ? dropChars(rem, t.fenceIndent || 0, col)[0] : dropIndent(rem, 4, col));
      if (t.fenced) t.absorbArmed = false;
      return;
    }
    if (matchedAll && t.t === 'html' && t.htmlType <= 5) {
      t.lines.push(rem);
      return;
    }
    // A spaces-only remainder inside a blockquote continues an open
    // paragraph there (marked keeps the line in the quote's text).
    if (!rawBlank && quoteMatched && rem !== '' && t.t === 'para') {
      t.text += '\n' + rem;
      return;
    }
    if (t.t === 'para' || t.t === 'table' || t.t === 'html') {
      finalizeTop(curLi - 1).endsBlank = true;
    }
    if (rawBlank) {
      for (let d = 1; d < stack.length; d++) {
        if (stack[d].t === 'quote') { closeDownTo(d, curLi - 1); break; }
      }
      noteBlankLine(0);
    } else if (scopeDepth > 0) {
      // A blank line inside a blockquote is a real blank line for the
      // lists and items inside that quote (looseness, sealing).
      noteBlankLine(scopeDepth);
    }
  }

  let curQuoteCols = 0, curLastQuoteW = 0, curLastStripW = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    curLi = li;
    const rawBlank = isBlank(line);

    // -- Phase 1: match open containers.
    let rem = line;
    let col = 0;
    curQuoteCols = 0; curLastQuoteW = 0; curLastStripW = 0;
    let depth = 1;
    let matchedAll = true;
    const remSnap = [line], colSnap = [0];
    for (; depth < stack.length; depth++) {
      remSnap[depth] = rem; colSnap[depth] = col;
      const b = stack[depth];
      if (b.t === 'quote') {
        let p = 0;
        let c = col;
        while (p < rem.length && c - col < 3) {
          if (rem[p] === ' ') { p++; c++; }
          else if (rem[p] === '\t') { p++; c += 4 - (c % 4); }
          else break;
        }
        if (c - col <= 3 && rem[p] === '>') {
          p++; c++;
          let expandBase = 0;
          if (rem[p] === ' ') { p++; c++; expandBase = c - col; }
          else if (rem[p] === '\t') {
            // The tab fills the one optional space slot of the quote
            // prefix; the rest of its width becomes leading spaces of
            // the content, which then starts at its true column.
            const w = 4 - (c % 4);
            rem = ' '.repeat(w - 1) + rem.slice(p + 1);
            expandBase = c + 1 - col;
            c += w;
            curQuoteCols += c - col;
            curLastQuoteW = c - col;
            curLastStripW = c - col;
            col = c;
            rem = expandLeadingTabs(rem, expandBase);
            continue;
          }
          curQuoteCols += c - col;
          curLastQuoteW = c - col;
          curLastStripW = c - col;
          rem = rem.slice(p);
          col = c;
          // The quote's text is a fresh string: its lines' leading
          // tabs are expanded by their column in the parent text
          // (the width of this quote's strip).
          rem = expandLeadingTabs(rem, expandBase);
        } else { matchedAll = false; break; }
      } else if (b.t === 'item') {
        if (b.sealed) { matchedAll = false; break; }
        const r = consumeIndent(rem, b.indent, col);
        if (!r.ok) { matchedAll = false; break; }
        rem = r.rest;
        col += b.indent;
        curLastStripW = b.indent;
      } else if (b.t === 'list') {
        // Lists impose no prefix of their own.
      } else {
        break; // leaf reached
      }
    }
    let matchedDepth = depth;

    // Detachment: a list whose item fence absorbed a line through a
    // failed blockquote ends at the next line that matches the
    // containers above the list again; that line is reprocessed at the
    // list's parent depth (marked captures the item text only up to
    // the absorbed lines).
    for (let d = stack.length - 1; d >= 1; d--) {
      if (stack[d].t === 'list' && stack[d].detached && matchedDepth > d) {
        closeDownTo(d, curLi - 1);
        rem = remSnap[d]; col = colSnap[d];
        matchedDepth = d; matchedAll = false;
        break;
      }
      if (stack[d].t === 'list') break;
    }

    if (rem.trim() === '' && matchedAll && tip().t === 'table' && line.includes('\t')) {
      // A whitespace-only line containing a tab is a table row in
      // marked (an empty one), not the end of the table.
      tip().rows.push(splitCells(rem));
      continue;
    }

    if (rem.trim() === '') {
      let quoteMatched = false;
      for (let d = 1; d < matchedDepth && d < stack.length; d++) {
        if (stack[d].t === 'quote') quoteMatched = true;
      }
      let scopeDepth = 0;
      for (let d = matchedDepth - 1; d >= 1; d--) {
        if (stack[d].t === 'quote') { scopeDepth = d; break; }
      }
      blankLine(rem, col, matchedAll, rawBlank, quoteMatched, scopeDepth, matchedDepth);
      continue;
    }

    if (!matchedAll && tip().t === 'code' && tip().fenced &&
        stack[matchedDepth] && stack[matchedDepth].t === 'quote' &&
        stack.some((b, d) => b.t === 'item' && d > matchedDepth)) {
      // The line failed a blockquote in front of an item's fence.
      // Re-try the item indents on the unstripped remainder: a line
      // that fits them is fence content (and detaches the list); a
      // plain line that does not fit ends the list inside the quote
      // and is reprocessed at the quote's level.
      let simRem = rem, simCol = col, simOk = true;
      for (let d = matchedDepth; d < stack.length - 1; d++) {
        const bt = stack[d].t;
        if (bt === 'item') {
          const r = consumeIndent(simRem, stack[d].indent, simCol);
          if (!r.ok) { simOk = false; break; }
          simRem = r.rest; simCol += stack[d].indent;
        } else if (bt !== 'list' && bt !== 'quote') { simOk = false; break; }
      }
      const t = tip();
      if (simOk) {
        for (let d = stack.length - 2; d >= 1; d--) {
          if (stack[d].t === 'list') { stack[d].detached = true; break; }
        }
        const simDrop = dropChars(simRem, t.fenceIndent || 0, simCol);
        t.lines.push(codeContent(simDrop[0], simDrop[1], stackBelowTipInContainer()));
        t.absorbArmed = true;
        continue;
      }
      if (!t.absorbArmed) {
        const trimmedSim = simRem.replace(/^[ \t]+/, '');
        const mkSim = matchListMarker(trimmedSim);
        if (countIndent(rem, col) <= 3 && !interruptsParagraph(trimmedSim) && !(mkSim && !mkSim.blank)) {
          closeDownTo(matchedDepth + 1, curLi - 1);
          rem = remSnap[matchedDepth]; col = colSnap[matchedDepth];
          matchedAll = false;
          matchedDepth = stack.length;
          // fall through to phase 2 with the quote-level remainder
        }
      }
    }

    if (!matchedAll && tip().t === 'code' && tip().fenced && tip().absorbArmed) {
      // A fenced code block inside a list item, once it has received a
      // content line through the item's indentation, absorbs following
      // non-blank lines even when they no longer match the item (marked
      // captures the item text with the fence still open). The failed
      // containers may include blockquotes; absorbing through a failed
      // quote detaches the list, which then ends at the next line that
      // matches the quote again. A sibling item marker or a thematic
      // break still ends the item instead (item-only failures).
      let ok = false;
      let quoteFailed = false;
      let itemDrop = 0;
      let fenceItemDepth = -1;
      for (let d = stack.length - 2; d >= 1; d--) if (stack[d].t === 'item') { fenceItemDepth = d; break; }
      if (fenceItemDepth >= 0) {
        ok = true;
        for (let d = matchedDepth; d < stack.length - 1; d++) {
          const bt = stack[d].t;
          if (bt === 'quote') {
            // A quote outside the fence's item detaches it; a quote
            // inside the item just ends (no absorption through it).
            if (d < fenceItemDepth) quoteFailed = true;
            else { ok = false; break; }
          }
          else if (bt === 'item') itemDrop += stack[d].indent;
          else if (bt !== 'list') { ok = false; break; }
        }
      }
      const trimmedRem = rem.replace(/^[ \t]+/, '');
      if (ok && countIndent(rem, col) <= 3) {
        // Lines that would start a block at the parent level are not
        // absorbed: paragraph interrupters (heading, fence, quote, HR,
        // HTML block) or any non-empty list marker.
        const mk = matchListMarker(trimmedRem);
        if (interruptsParagraph(trimmedRem) || (mk && !mk.blank)) ok = false;
      }
      if (ok) {
        const t = tip();
        if (quoteFailed) {
          for (let d = stack.length - 2; d >= 1; d--) {
            if (stack[d].t === 'list') { stack[d].detached = true; break; }
          }
        }
        if (SETEXT_RE.test(trimmedRem)) {
          // A setext-looking absorbed line is shielded with 4 spaces at
          // the item-text level (before the fence's own indent drop).
          t.lines.push(dropChars('    ' + trimmedRem, t.fenceIndent || 0, 0)[0]);
        } else {
          const afterItems = dropIndent(rem, itemDrop, col);
          const afterFence = dropChars(afterItems, t.fenceIndent || 0, col + itemDrop);
          t.lines.push(codeContent(afterFence[0],
            afterFence[1] - Math.max(0, curQuoteCols - curLastQuoteW), stackBelowTipInContainer()));
        }
        continue;
      }
    }

    if (!matchedAll) {
      // Lazy paragraph continuation: the deepest open block is a paragraph
      // and this line does not start a block that would interrupt it.
      // A line indented 4+ columns never interrupts; when taken lazily it
      // sheds those 4 columns. A setext-looking lazy line that follows an
      // earlier lazy line is shielded with 4 spaces (marked re-lexes quote
      // text in a way that keeps it from forming a heading).
      const leadW = countIndent(rem, col);
      const trimmedRest = rem.replace(/^[ \t]+/, '');
      if (tip().t === 'para' && (leadW > 3 || !interruptsParagraph(trimmedRest)) &&
          !(leadW <= 3 && matchListMarker(trimmedRest) && stack.some((b) => b.t === 'item')) &&
          !(leadW <= 3 && /^(`{3,}|~{3,})/.test(trimmedRest) && stack.some((b) => b.t === 'item'))) {
        let content = leadW >= 4 ? dropIndent(rem, 4, col) : rem;
        const para = tip();
        if (leadW < 4) content = expandLeadingTabs(content, curLastStripW);
        if (para.hasLazy && SETEXT_RE.test(content.trim())) content = '    ' + content;
        para.hasLazy = true;
        para.text += '\n' + content;
        continue;
      }
      closeDownTo(matchedDepth, curLi - 1);
    }

    // -- Phase 2: new container starts (blockquote / list), in a loop.
    let rest = rem;
    let guard = 0;
    while (guard++ < 100) {
      const t = tip();
      if (t.t !== 'doc' && t.t !== 'quote' && t.t !== 'item' && t.t !== 'list') break;
      const leadW = countIndent(rest, col);
      const indented = leadW >= 4;
      const base = indented ? rest : dropIndent(rest, leadW, col);
      const baseCol = indented ? col : col + leadW;

      if (t.t === 'list') {
        const mk = indented ? null : matchListMarker(base);
        if (mk && sameListKind(t.listKind, mk) && !HR_RE.test(base.trim())) {
          if (t.blankSepPending) t.loose = true;
          const item = newBlock('item');
          item.indent = leadW + mk.contentIndent;
          addChild(t, item);
          rest = dropIndent(base.slice(mk.markerLen), mk.contentIndent - mk.markerLen, baseCol + mk.markerLen);
          col = baseCol + mk.contentIndent;
          continue;
        }
        finalizeTop(); // close the list, retry at the parent
        continue;
      }

      if (!indented && base[0] === '>') {
        const q = newBlock('quote');
        addChild(t, q);
        rest = base.slice(1);
        col = baseCol + 1;
        let expandBase = leadW + 1;
        if (rest[0] === ' ') { rest = rest.slice(1); col++; expandBase = leadW + 2; }
        else if (rest[0] === '\t') {
          const w = 4 - (col % 4);
          rest = ' '.repeat(w - 1) + rest.slice(1);
          expandBase = leadW + 2;
          col += w;
        }
        curQuoteCols += col - baseCol;
        curLastQuoteW = col - baseCol;
        curLastStripW = leadW + (col - baseCol);
        rest = expandLeadingTabs(rest, expandBase);
        continue;
      }

      if (!indented) {
        const mk = matchListMarker(base);
        if (mk && !HR_RE.test(base.trim())) {
          const list = newBlock('list');
          list.listKind = mk.bullet !== undefined ? { bullet: mk.bullet } : { delim: mk.delim };
          list.start = mk.num !== undefined ? mk.num : null;
          addChild(t, list);
          const item = newBlock('item');
          item.indent = leadW + mk.contentIndent;
          addChild(list, item);
          rest = dropIndent(base.slice(mk.markerLen), mk.contentIndent - mk.markerLen, baseCol + mk.markerLen);
          col = baseCol + mk.contentIndent;
          continue;
        }
      }
      break;
    }

    if (rest.trim() === '') {
      let scopeDepth2 = 0;
      for (let d = stack.length - 1; d >= 1; d--) {
        if (stack[d].t === 'quote') { scopeDepth2 = d; break; }
      }
      blankLine(rest, col, true, false, stack.some((b) => b.t === 'quote'), scopeDepth2);
      continue;
    }

    // -- Phase 3: leaf handling.
    let t = tip();
    if (t.t === 'code' && t.fenced) {
      const leadW = countIndent(rest, col);
      const after = leadW <= 3 ? dropIndent(rest, leadW, col) : rest;
      const m = /^(`{3,}|~{3,})[ \t]*$/.exec(after);
      if (leadW <= 3 && m && m[1][0] === t.fenceCh && m[1].length >= t.fenceLen) {
        finalizeTop();
        continue;
      }
      const fenceDrop = dropChars(rest, t.fenceIndent || 0, col);
      t.lines.push(codeContent(fenceDrop[0],
        fenceDrop[1] - Math.max(0, curQuoteCols - curLastQuoteW), stackBelowTipInContainer()));
      t.absorbArmed = true;
      continue;
    }
    if (t.t === 'code' && !t.fenced) {
      if (countIndent(rest, col) >= 4) {
        t.lines.push(codeContent(dropIndent(rest, 4, col), col + 4 - Math.max(0, curQuoteCols - curLastQuoteW), stackBelowTipInContainer()));
        continue;
      }
      finalizeTop(curLi - 1);
      li--;
      continue;
    }
    if (t.t === 'html') {
      t.lines.push(rest);
      if (t.htmlType <= 5 && htmlBlockEnd(t.htmlType, rest)) finalizeTop();
      continue;
    }
    if (t.t === 'table') {
      const trimmedR = rest.replace(/^[ \t]+/, '');
      if (countIndent(rest, col) <= 3 &&
          (trimmedR[0] === '>' || matchFence(trimmedR) || matchATX(trimmedR) ||
           matchHR(trimmedR) || matchListMarker(trimmedR) || htmlBlockStart(trimmedR) > 0)) {
        finalizeTop(curLi - 1);
        li--;
        continue;
      }
      t.rows.push(splitCells(rest));
      continue;
    }
    if (t.t === 'para') {
      const trimmed = rest.replace(/^[ \t]+/, '');
      const leadW = countIndent(rest, col);
      if (leadW <= 3) {
        const sm = SETEXT_RE.exec(trimmed);
        if (sm) {
          const restText = extractDefs(t.text, refs);
          if (restText.trim() !== '') {
            t.t = 'heading';
            t.level = sm[1][0] === '=' ? 1 : 2;
            t.text = restText;
            finalizeTop();
          } else {
            finalizeTop();
            li--; // defs-only paragraph: the underline starts fresh content
          }
          continue;
        }
        if (!t.text.includes('\n')) {
          const ta = tableAligns(t.text, trimmed);
          if (ta) {
            t.t = 'table';
            t.heads = ta.heads;
            t.aligns = ta.aligns;
            t.rows = [];
            t.text = '';
            continue;
          }
        }
      }
      let interrupt = leadW <= 3 && interruptsParagraph(trimmed);
      if (!interrupt && leadW <= 3) {
        const mk = matchListMarker(trimmed);
        if (mk && !mk.blank && mk.num !== undefined) {
          for (let d = stack.length - 2; d >= 1; d--) {
            if (stack[d].t === 'item') { interrupt = true; break; }
            if (stack[d].t === 'quote') break;
          }
        }
      }
      if (interrupt) {
        finalizeTop();
        li--; // reprocess this line from scratch against the new stack
        continue;
      }
      // A paragraph line inside a container has its leading tabs
      // expanded as if the line started at the last container's strip
      // width (marked re-lexes container text level by level). Inside
      // a list item, a continuation line whose remaining indent is 4+
      // columns sheds exactly 4 of them.
      let contText = rest;
      if (stack.length > 2) {
        if (stack.slice(0, -1).some((b) => b.t === 'item') && countIndent(rest, col) >= 4) {
          contText = dropIndent(rest, 4, col);
        }
        contText = expandLeadingTabs(contText, curLastStripW);
      }
      t.text += '\n' + contText;
      continue;
    }

    // Tip is a container: start a leaf.
    startLeaf(rest, col, stack, addChild, curLi, htmlBlocks,
      Math.max(0, curQuoteCols - curLastQuoteW), curLastStripW);
  }

  closeDownTo(1);
  // HTML block trailing newline: for types 1-5 it is present when the line
  // after the block is not empty (a whitespace-only line still counts as
  // a line), or at EOF when the input ends with a newline; for types 6/7
  // only in that EOF position.
  for (const b of htmlBlocks) {
    const el = b.endLine !== undefined ? b.endLine : lines.length - 1;
    if (b.htmlType <= 5) {
      const lastReal = endsWithNL ? lines.length - 2 : lines.length - 1;
      b.trailingNL = el < lastReal ? lines[el + 1].length > 0 : endsWithNL;
    } else {
      b.trailingNL = el === lines.length - 1 && endsWithNL;
    }
  }
  return root;
}

// Blocks that may interrupt a paragraph (CommonMark set, with marked's
// list rule: any bullet, or an ordered marker only when it starts at 1,
// and never an empty item).
function interruptsParagraph(rest) {
  if (rest[0] === '>') return true;
  if (matchFence(rest)) return true;
  if (matchATX(rest)) return true;
  if (matchHR(rest)) return true;
  const ht = htmlBlockStart(rest);
  if (ht >= 1 && ht <= 6) return true;
  const mk = matchListMarker(rest);
  if (mk) {
    if (mk.blank) return false;
    if (mk.bullet !== undefined) return true;
    if (mk.num === 1) return true;
  }
  return false;
}

function startLeaf(rest, col, stack, addChild, curLi, htmlBlocks, tabShift, stripW) {
  const parent = stack[stack.length - 1];
  const leadW = countIndent(rest, col);
  // Indented-code status is judged in the innermost container's own
  // text coordinates: a tab's width counts from the last strip width,
  // not from the document column.
  const leadWText = stripW !== undefined ? countIndent(rest, stripW) : leadW;

  if (leadWText >= 4) {
    const b = newBlock('code');
    b.fenced = false;
    b.lines = [codeContent(dropIndent(rest, 4, col), col + 4 - (tabShift || 0),
      stack.some((x) => x.t === 'item' || x.t === 'quote'))];
    addChild(parent, b);
    return;
  }
  const after = dropIndent(rest, leadW, col);
  const fence = matchFence(after);
  if (fence) {
    // Marked strips the opening fence's indent from backtick-fence
    // content lines, but tilde-fence content is kept verbatim.
    fence.fenceIndent = fence.fenceCh === '~' ? 0 : leadW;
    addChild(parent, fence);
    return;
  }
  const atx = matchATX(after);
  if (atx) { parent.children.push(atx); if (parent.t === 'item') parent.pendingBlank = false; return; }
  const ht = htmlBlockStart(after);
  if (ht) {
    const b = newBlock('html');
    b.htmlType = ht;
    b.lines = [rest];
    htmlBlocks.push(b);
    if (ht <= 5 && htmlBlockEnd(ht, after)) {
      b.text = rest;
      b.endLine = curLi;
      b.open = false;
      if (parent.t === 'item' && parent.children.length > 0 && parent.pendingBlank) b.sepBlank = true;
      parent.children.push(b);
      if (parent.t === 'item') parent.pendingBlank = false;
      return;
    }
    addChild(parent, b);
    return;
  }
  if (matchHR(after)) {
    const b = newBlock('hr');
    parent.children.push(b);
    if (parent.t === 'item') parent.pendingBlank = false;
    return;
  }
  const para = newBlock('para');
  para.text = (parent.t === 'quote' || parent.t === 'item') && stripW !== undefined
    ? expandLeadingTabs(rest, stripW) : rest;
  addChild(parent, para);
}

function finishList(list) {
  let loose = !!list.loose;
  const items = list.children;
  // The last item's text ends at the list's raw end, which marked
  // trims: a trailing paragraph there loses its trailing spaces/tabs.
  const lastItem = items[items.length - 1];
  if (lastItem && lastItem.children.length) {
    const lastBlock = lastItem.children[lastItem.children.length - 1];
    if (lastBlock.t === 'para') {
      lastBlock.text = lastBlock.text.replace(/[ \t]+$/, '');
      if (lastBlock.renderText !== undefined) lastBlock.renderText = lastBlock.renderText.replace(/[ \t]+$/, '');
    }
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    for (let j = 1; j < item.children.length; j++) {
      if (item.children[j].sepBlank) loose = true;
    }
    for (let j = 0; j + 1 < item.children.length; j++) {
      if (item.children[j].endsBlank) loose = true;
    }
  }
  list.loose = loose;
}

// ---------------------------------------------------------------------------
// Link reference definitions
// ---------------------------------------------------------------------------

const FOLD_MAP = { 'ß': 'ss', 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬆ': 'st', 'ς': 'σ', 'ſ': 's' };

function normalizeLabel(s) {
  return s.replace(/[ \t\n]+/g, ' ').trim().toLowerCase()
    .replace(/[ßﬀﬁﬂﬃﬄﬆςſ]/g, (c) => FOLD_MAP[c]);
}

// Parse one link destination at s[i]. Returns {href, next} or null. The
// returned href has backslash escapes and entities resolved.
function scanDest(s, i) {
  if (s[i] === '<') {
    let j = i + 1;
    let out = '';
    while (j < s.length) {
      const ch = s[j];
      if (ch === '>') return { href: out, next: j + 1, angle: true };
      if (ch === '\n' || ch === '<') return null;
      if (ch === '\\' && j + 1 < s.length && isPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
      if (ch === '&') {
        const e = readEntity(s, j);
        if (e) { out += decodeAttrChar(s, j, e); j += e.len; continue; }
      }
      out += ch; j++;
    }
    return null;
  }
  let j = i;
  let depth = 0;
  let out = '';
  while (j < s.length) {
    const ch = s[j];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch.charCodeAt(0) < 0x20) break;
    if (ch === '\\' && j + 1 < s.length && isPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
    if (ch === '(') { depth++; out += ch; j++; continue; }
    if (ch === ')') {
      if (depth === 0) break;
      depth--; out += ch; j++; continue;
    }
    if (ch === '&') {
      const e = readEntity(s, j);
      if (e) { out += decodeAttrChar(s, j, e); j += e.len; continue; }
    }
    out += ch; j++;
  }
  if (depth !== 0) return null;
  if (out === '') return null;
  return { href: out, next: j, angle: false };
}

// Parse a title at s[i] (one of " ' (). Returns {title, next} or null.
function scanTitle(s, i) {
  const open = s[i];
  if (open !== '"' && open !== "'" && open !== '(') return null;
  const close = open === '(' ? ')' : open;
  let j = i + 1;
  let out = '';
  while (j < s.length) {
    const ch = s[j];
    if (ch === close) return { title: out, next: j + 1 };
    if (open === '(' && ch === '(') return null;
    if (ch === '\\' && j + 1 < s.length && isPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
    if (ch === '&') {
      const e = readEntity(s, j);
      if (e) { out += decodeAttrChar(s, j, e); j += e.len; continue; }
    }
    out += ch; j++;
  }
  return null;
}

function skipInlineWs(s, i) {
  let n = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) { i++; n++; }
  return { next: i, count: n };
}

// Try to parse a link reference definition at s[pos].
function scanDef(s, pos) {
  let i = pos;
  if (s[i] !== '[') return null;
  let j = i + 1;
  let label = '';
  while (j < s.length && s[j] !== ']') {
    if (s[j] === '[') return null;
    if (s[j] === '\\' && j + 1 < s.length && isPunct(s[j + 1])) { label += s[j] + s[j + 1]; j += 2; continue; }
    label += s[j]; j++;
  }
  if (j >= s.length || label.trim() === '') return null;
  i = j + 1;
  if (s[i] !== ':') return null;
  i++;
  let nl = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) {
    if (s[i] === '\n') { nl++; if (nl > 1) return null; }
    i++;
  }
  const d = scanDest(s, i);
  if (!d) return null;
  i = d.next;
  // After the destination: optional spaces/tabs, then either the line
  // ends, or a title follows on this line, or a title follows on the next.
  let p = i;
  while (s[p] === ' ' || s[p] === '\t') p++;
  const atLineEnd = p >= s.length || s[p] === '\n';
  if (!atLineEnd) {
    // Same-line title (or junk, which invalidates the definition). A
    // title glued directly to an angle-bracket destination is invalid.
    if (p === i && d.angle) return null;
    if (s[p] !== '"' && s[p] !== "'" && s[p] !== '(') return null;
    const t = scanTitle(s, p);
    if (!t) return null;
    let q = t.next;
    while (s[q] === ' ' || s[q] === '\t') q++;
    if (q < s.length && s[q] !== '\n') return null;
    if (q < s.length) q++;
    return { label: normalizeLabel(label), href: d.href, title: t.title, next: q };
  }
  // The destination line ends here: a title may sit on the next line.
  const destLineNext = p < s.length ? p + 1 : p;
  if (p < s.length && s[p] === '\n') {
    let q = p + 1;
    while (s[q] === ' ' || s[q] === '\t') q++;
    if (s[q] === '"' || s[q] === "'" || s[q] === '(') {
      const t = scanTitle(s, q);
      if (t) {
        let r = t.next;
        while (s[r] === ' ' || s[r] === '\t') r++;
        if (r >= s.length || s[r] === '\n') {
          if (r < s.length) r++;
          return { label: normalizeLabel(label), href: d.href, title: t.title, next: r };
        }
      }
    }
  }
  return { label: normalizeLabel(label), href: d.href, title: null, next: destLineNext };
}

// Extract leading definitions from a paragraph's text; returns the rest.
function extractDefs(text, refs) {
  let pos = 0;
  let first = true;
  for (;;) {
    // Each definition line may carry up to three leading spaces.
    let p = pos, sk = 0;
    while (sk < 3 && (text[p] === ' ' || text[p] === '\t')) { p++; sk++; }
    if (text[p] !== '[') break;
    const d = scanDef(text, p);
    if (!d) break;
    if (!refs.has(d.label)) refs.set(d.label, { href: d.href, title: d.title });
    pos = d.next;
    first = false;
  }
  return first ? text : text.slice(pos);
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

function isWsCh(ch) {
  return ch === undefined || /\s/.test(ch);
}

function isPunctCh(ch) {
  if (ch === undefined) return false;
  if (isPunct(ch)) return true;
  return /[\p{P}\p{S}]/u.test(ch);
}

const TAG_NAME = '[A-Za-z][A-Za-z0-9-]*';
const ATTR = "(?:\\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\\s*=\\s*(?:[^ \\t\\n\"'=<>`]+|'[^']*'|\"[^\"]*\"))?)";
const OPEN_TAG_RE = new RegExp('^<' + TAG_NAME + ATTR + '*\\s*\\/?>');
const CLOSE_TAG_RE = new RegExp('^<\\/' + TAG_NAME + '\\s*>');
const AUTOLINK_URI_RE = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/;
const AUTOLINK_EMAIL_RE = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/;
const EXT_URL_RE = /^(?:[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\/|www\.)[^\s<]+/;
const EMAIL_CORE = "[A-Za-z0-9.!#$%&'*+\\/=?^_`{|}~-]+@(?:[A-Za-z0-9_-]+\\.)+[A-Za-z0-9_-]*[A-Za-z0-9]";
const EXT_EMAIL_RE = new RegExp('^' + EMAIL_CORE);
const SCHEME_EMAIL_RE = new RegExp('^(mailto|xmpp):(' + EMAIL_CORE + ')');
const EMAIL_PREV_BAD = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~@-]/;

function plainTextOf(list) {
  let out = '';
  for (const nd of list) {
    if (nd.k === 't' || nd.k === 'code' || nd.k === 'html') out += nd.s;
    else if (nd.k === 'br') out += '\n';
    else if (nd.k === 'delim') out += nd.ch.repeat(nd.len);
    else if (nd.children) out += plainTextOf(nd.children);
  }
  return out;
}

// Whether a token tree contains a bracket-formed link (angle autolinks
// and the contents of images do not count).
function containsBracketLink(list) {
  for (const nd of list) {
    if (nd.k === 'link' && !nd.ang) return true;
    if (nd.k !== 'img' && nd.children && containsBracketLink(nd.children)) return true;
  }
  return false;
}

// Node kinds: t (text), code, html, br, link, img, em, strong, del, delim.
function parseInline(s, refs, state, extOff) {
  const nodes = [];
  const delims = [];   // {node, ch, canOpen, canClose}; node.len is live
  const allDelims = []; // every delim entry ever created here (stable spans)
  // Marked quirk: once a link whose label used an unequal-run loose
  // backtick span has appeared, a later emphasis span is refused when
  // a code span starts anywhere after its opener.
  let looseLinkPos = -1;
  const codeSpanStarts = [];
  // Positions of '[' / '![' whose link/image attempt was not accepted.
  const failedBrackets = [];
  let buf = '';
  let i = 0;
  const n = s.length;

  function flushText() {
    if (buf !== '') {
      nodes.push({ k: 't', s: buf });
      buf = '';
    }
  }

  // Marked's em/strong matcher rejects a span whose content holds a
  // delimiter pair (single runs for a strong span, double runs for an
  // em span) that starts after whitespace and whose closer is glued to
  // a following letter — unless a later run that could itself close a
  // span rescues it (strong spans only). Only real delimiter runs
  // count; delimiter chars inside code spans, links and other tokens
  // are invisible to the matcher. `rs` is the list of the span's
  // content runs (entries from allDelims), `extra` is a count of
  // delimiter chars borrowed from the closer run at the span's end.
  function cursedRuns(rs, ch, plen, rescue, extra, cEnd) {
    const prs = rs.filter((r) => plen === 1 ? r.origLen === 1 : r.origLen >= 2);
    if (prs.length < 2) return false;
    let p = -1, q = -1;
    for (let i = 0; i < prs.length; i++) {
      const r = prs[i];
      const next = s[r.srcEnd];
      const prev = r.srcStart > 0 ? s[r.srcStart - 1] : undefined;
      if (p < 0 && !isWsCh(next)) { p = i; continue; }
      if (p >= 0 && !isWsCh(prev)) { q = i; break; }
    }
    if (p < 0 || q < 0) return false;
    const pPrev = prs[p].srcStart > 0 ? s[prs[p].srcStart - 1] : undefined;
    const qNext = s[prs[q].srcEnd];
    if (!(pPrev === undefined || isWsCh(pPrev))) return false;
    if (!(qNext !== undefined && !isWsCh(qNext) && qNext !== '*' && qNext !== '_' && qNext !== '~')) return false;
    if (rescue) {
      for (const r of rs) {
        if (r.srcStart <= prs[q].srcStart) continue;
        const prev = s[r.srcStart - 1];
        const next = s[r.srcEnd];
        if (prev !== undefined && !isWsCh(prev) && prev !== '*' && prev !== '_' && prev !== '~' &&
            (next === undefined || isWsCh(next))) return false;
      }
      // Borrowed closer stars form one more run at the very end:
      // preceded by the content's last char, followed by nothing.
      if (extra > 0) {
        const prev = cEnd > 0 ? s[cEnd - 1] : undefined;
        if (prev !== undefined && !isWsCh(prev) && prev !== ch) return false;
      }
    }
    return true;
  }

  // Whether marked's matcher refuses this opener/closer pairing.
  function emphasisBlocked(op, closer, use) {
    const ch = closer.ch;
    const cEnd = closer.srcStart + (closer.origLen - closer.node.len);
    const rs = allDelims.filter((d) => d.ch === ch && d.srcStart >= op.srcEnd && d.srcEnd <= cEnd);
    if (use === 2) {
      const extra = Math.max(0, closer.node.len - 2);
      return cursedRuns(rs, ch, 1, true, extra, cEnd);
    }
    if (op.origLen >= 2) {
      // A single-star match against a multi-star opener is refused
      // when a both-flanking run of the same char sits between them.
      for (const r of rs) {
        const prev = s[r.srcStart - 1];
        const next = s[r.srcEnd];
        if (!isWsCh(prev) && !isWsCh(next) && prev !== ch && next !== ch) return true;
      }
    }
    return cursedRuns(rs, ch, 2, false, 0, cEnd);
  }

  // Tolerant label scan used only to locate the region of a failed
  // link: like scanLabel, but an unclosed backtick run is plain text.
  function scanLabelLooseRegion(from) {
    let depth = 0;
    let j = from;
    while (j < n) {
      const c = s[j];
      if (c === '\\' && j + 1 < n && isPunct(s[j + 1])) { j += 2; continue; }
      if (c === '`') {
        let run = 0;
        while (s[j + run] === '`') run++;
        let k = j + run;
        while (k < n && s[k] !== '`') k++;
        if (k < n) { while (s[k] === '`') k++; j = k; continue; }
        j += run; continue;
      }
      if (c === '[') { depth++; j++; continue; }
      if (c === ']') {
        if (depth === 0) return j;
        depth--; j++; continue;
      }
      j++;
    }
    return -1;
  }

  // Marked quirk: an emphasis span inside a failed [...](...) label
  // does not form when its content holds a code span whose raw text
  // itself contains a backtick.
  function tickEmBlocked(op, closer) {
    if (failedBrackets.length === 0) return false;
    const oPos = nodes.indexOf(op.node);
    const cPos = nodes.indexOf(closer.node);
    if (oPos === -1 || cPos === -1) return false;
    let hasTick = false;
    for (let k = oPos + 1; k < cPos; k++) {
      if (nodes[k].k === 'code' && nodes[k].tick) { hasTick = true; break; }
    }
    if (!hasTick) return false;
    for (const fb of failedBrackets) {
      const labelStart = fb.pos + (fb.image ? 2 : 1);
      if (labelStart > op.srcStart) continue;
      const labelEnd = scanLabelLooseRegion(labelStart);
      if (labelEnd === -1) continue;
      if (closer.srcEnd <= labelEnd && s[labelEnd + 1] === '(') return true;
    }
    return false;
  }

  // Delimiter processing over delims[bottom..], the standard algorithm.
  function processEmphasis(bottom) {
    let closerIdx = bottom;
    while (closerIdx < delims.length) {
      const closer = delims[closerIdx];
      if (!closer.canClose || closer.node.len === 0 ||
          nodes.indexOf(closer.node) === -1) { closerIdx++; continue; }
      let openerIdx = -1;
      for (let j = closerIdx - 1; j >= bottom; j--) {
        const op = delims[j];
        if (op.ch !== closer.ch || !op.canOpen || op.node.len === 0 ||
            nodes.indexOf(op.node) === -1) continue;
        if (op.ch === '~' && op.node.len !== closer.node.len) continue;
        if (op.ch === '*' || op.ch === '_') {
          const odd = (op.canClose || closer.canOpen) &&
            (op.node.len + closer.node.len) % 3 === 0 &&
            !(op.node.len % 3 === 0 && closer.node.len % 3 === 0);
          if (odd) continue;
          const use = op.node.len >= 2 && closer.node.len >= 2 ? 2 : 1;
          if (emphasisBlocked(op, closer, use)) continue;
          if (looseLinkPos !== -1 && looseLinkPos < op.srcStart &&
              codeSpanStarts.some((cs) => cs > op.srcStart)) continue;
          if (tickEmBlocked(op, closer)) continue;
        }
        openerIdx = j;
        break;
      }
      if (openerIdx === -1) {
        if (!closer.canOpen) delims.splice(closerIdx, 1);
        else closerIdx++;
        continue;
      }
      const opener = delims[openerIdx];
      const use = opener.node.len >= 2 && closer.node.len >= 2 ? 2 : 1;
      const oPos = nodes.indexOf(opener.node);
      const cPos = nodes.indexOf(closer.node);
      const inner = nodes.splice(oPos + 1, cPos - oPos - 1);
      const kind = closer.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
      // A strong match against a closing run of 3+ spends one extra
      // star inside the span when the content ends with a delimiter
      // pair glued to the final word.
      let bonus = 0;
      if (use === 2 && closer.node.len > 2 && closer.ch !== '~') {
        let earlierOpener = false;
        for (let j = bottom; j < openerIdx; j++) {
          if (delims[j].ch === closer.ch && delims[j].canOpen && delims[j].node.len > 0) { earlierOpener = true; break; }
        }
        let q = null;
        for (const d of allDelims) {
          if (d.ch === closer.ch && d.srcStart >= opener.srcEnd && d.srcEnd <= closer.srcStart) q = d;
        }
        if (!earlierOpener && q) {
          const tail = s.slice(q.srcEnd, closer.srcStart);
          if (tail !== '' && !/\s/.test(tail) && !tail.includes(closer.ch)) bonus = 1;
        }
      }
      if (bonus) inner.push({ k: 't', s: closer.ch });
      nodes.splice(oPos + 1, 0, { k: kind, children: inner });
      opener.node.len -= use;
      closer.node.len -= use + bonus;
      for (let j = closerIdx - 1; j > openerIdx; j--) delims.splice(j, 1);
      closerIdx = openerIdx + 1;
      if (opener.node.len === 0) {
        delims.splice(openerIdx, 1);
        closerIdx--;
      }
      if (closer.node.len === 0) delims.splice(closerIdx, 1);
    }
  }

  // Side channel: set by scanLabel when the label it scanned used a
  // loose code span whose closing backtick run differs in length from
  // its opener.
  let scanLoose = false;

  // Scan a link label starting just after the opening bracket, using
  // marked's label grammar: plain characters, backslash escapes, nested
  // bracket groups, and loose code spans (a backtick run, non-backtick
  // content, a backtick run of any length). Returns the index of the
  // closing ']' or -1.
  function scanLabel(from) {
    let depth = 0;
    let j = from;
    while (j < n) {
      const c = s[j];
      if (c === '\\' && j + 1 < n && isPunct(s[j + 1])) { j += 2; continue; }
      if (c === '`') {
        // Loose code span: a backtick run, non-backtick content, and a
        // closing run of any length. An unclosed run fails the label,
        // except a run of 2+ sitting immediately before the closing
        // bracket, which counts as plain text — that reading wins over
        // the span reading even when a backtick exists further away.
        let run = 0;
        while (s[j + run] === '`') run++;
        if (run >= 2 && depth === 0 && s[j + run] === ']') { j += run; continue; }
        let k = j + run;
        while (k < n && s[k] !== '`') k++;
        if (k < n) {
          let closeRun = 0;
          while (s[k + closeRun] === '`') closeRun++;
          if (closeRun !== run) scanLoose = true;
          j = k + closeRun; continue;
        }
        return -1;
      }
      if (c === '<') {
        // HTML tags, comments, and <...> autolinks inside a label are
        // skipped as units: a ']' inside them does not close the label.
        const rest = s.slice(j);
        const au = AUTOLINK_URI_RE.exec(rest) || AUTOLINK_EMAIL_RE.exec(rest);
        if (au) { j += au[0].length; continue; }
        const tg = OPEN_TAG_RE.exec(rest) || CLOSE_TAG_RE.exec(rest);
        if (tg) { j += tg[0].length; continue; }
        if (rest.startsWith('<!--')) {
          const e = rest.indexOf('-->');
          if (e === -1) return -1;
          j += e + 3; continue;
        }
        j++; continue;
      }
      if (c === '[') { depth++; j++; continue; }
      if (c === ']') {
        if (depth === 0) return j;
        depth--; j++; continue;
      }
      j++;
    }
    return -1;
  }

  // Attempt a link or image at a '[' (or '![') at source index pos,
  // marked-style: the label is matched on the raw source first, and only
  // tokenized once the whole construct resolves.
  function matchLinkAt(pos, isImage) {
    const labelStart = pos + (isImage ? 2 : 1);
    scanLoose = false;
    const labelEnd = scanLabel(labelStart);
    if (labelEnd === -1) return null;
    const loose = scanLoose;
    const labelText = s.slice(labelStart, labelEnd);
    const after = labelEnd + 1;
    if (s[after] === '(') {
      const r = scanInlineLink(s, after);
      if (r) return { href: r.href, title: r.title, end: r.end, labelText, loose };
      // An invalid (...) part falls back to the shortcut reference.
      const d = refs.get(normalizeLabel(labelText));
      if (d) return { href: d.href, title: d.title, end: after, labelText, loose };
      return null;
    }
    if (s[after] === '[') {
      scanLoose = false;
      const refEnd = scanLabel(after + 1);
      if (refEnd !== -1) {
        const refText = s.slice(after + 1, refEnd);
        const d = refs.get(normalizeLabel(refText === '' ? labelText : refText));
        if (d) return { href: d.href, title: d.title, end: refEnd + 1, labelText, loose: loose || scanLoose };
        return null; // a bracketed label that does not resolve binds
      }
    }
    const d = refs.get(normalizeLabel(labelText));
    if (d) return { href: d.href, title: d.title, end: after, labelText, loose };
    return null;
  }

  while (i < n) {
    const ch = s[i];

    if (ch === '\\') {
      const nx = s[i + 1];
      if (nx === '\n') {
        flushText();
        nodes.push({ k: 'br' });
        i += 2;
        while (s[i] === ' ' || s[i] === '\t') i++;
        continue;
      }
      if (nx !== undefined && isPunct(nx)) { buf += nx; i += 2; continue; }
      buf += '\\'; i++; continue;
    }

    if (ch === '`') {
      let run = 0;
      while (s[i + run] === '`') run++;
      let j = i + run;
      let found = -1;
      while (j < n) {
        if (s[j] === '`') {
          let r2 = 0;
          while (s[j + r2] === '`') r2++;
          if (r2 === run) { found = j; break; }
          j += r2;
        } else j++;
      }
      if (found === -1) { buf += '`'.repeat(run); i += run; continue; }
      let content = s.slice(i + run, found).replace(/\n/g, ' ');
      if (content.length > 1 && content[0] === ' ' && content[content.length - 1] === ' ' &&
          content.trim() !== '') {
        content = content.slice(1, -1);
      }
      flushText();
      nodes.push({ k: 'code', s: content, tick: run >= 2 && s.slice(i + run, found).includes('`') });
      codeSpanStarts.push(i);
      i = found + run;
      continue;
    }

    if (ch === '&') {
      const e = readEntity(s, i);
      if (e) {
        if (s[i + 1] === '#') { buf += e.text; i += e.len; continue; }
        flushText();
        nodes.push({ k: 'html', s: e.text });
        i += e.len; continue;
      }
      buf += '&'; i++; continue;
    }

    if (ch === '<') {
      const rest = s.slice(i);
      let m = AUTOLINK_URI_RE.exec(rest);
      if (m) {
        flushText();
        nodes.push({ k: 'link', href: m[1], title: null, ang: true, children: [{ k: 't', s: m[1] }] });
        i += m[0].length; continue;
      }
      m = AUTOLINK_EMAIL_RE.exec(rest);
      if (m) {
        flushText();
        nodes.push({ k: 'link', href: 'mailto:' + m[1], title: null, ang: true, children: [{ k: 't', s: m[1] }] });
        i += m[0].length; continue;
      }
      const html = scanInlineHtml(rest);
      if (html) {
        flushText();
        nodes.push({ k: 'html', s: html });
        if (state) {
          if (/^<a(?=[\s/>])/i.test(html)) state.inLink = true;
          else if (/^<\/a\s*>/i.test(html)) state.inLink = false;
        }
        i += html.length; continue;
      }
      buf += '<'; i++; continue;
    }

    if (ch === '!' && s[i + 1] === '[') {
      const m = matchLinkAt(i, true);
      if (m) {
        flushText();
        const inner = parseInline(m.labelText, refs, state, extOff);
        nodes.push({ k: 'img', href: m.href, title: m.title, children: inner });
        if (m.loose && looseLinkPos === -1) looseLinkPos = i;
        i = m.end; continue;
      }
      failedBrackets.push({ pos: i, image: true });
      buf += '!'; i++; continue;
    }

    if (ch === '[') {
      const m = matchLinkAt(i, false);
      if (m) {
        // The label is tokenized with bracket links enabled: if one
        // forms inside, the outer link is rejected (marked's rule).
        const inner = parseInline(m.labelText, refs, state, true);
        if (!containsBracketLink(inner)) {
          flushText();
          nodes.push({ k: 'link', href: m.href, title: m.title, children: inner });
          if (m.loose && looseLinkPos === -1) looseLinkPos = i;
          i = m.end; continue;
        }
      }
      failedBrackets.push({ pos: i, image: false });
      buf += '['; i++; continue;
    }

    if (ch === ']') { buf += ']'; i++; continue; }

    if (ch === '*' || ch === '_' || ch === '~') {
      let run = 0;
      while (s[i + run] === ch) run++;
      if (ch === '~' && run > 2) { buf += '~'.repeat(run); i += run; continue; }
      const prev = i === 0 ? undefined : s[i - 1];
      const next = i + run >= n ? undefined : s[i + run];
      const leftFlank = !isWsCh(next) && (!isPunctCh(next) || isWsCh(prev) || isPunctCh(prev));
      const rightFlank = !isWsCh(prev) && (!isPunctCh(prev) || isWsCh(next) || isPunctCh(next));
      let canOpen, canClose;
      if (ch === '*') { canOpen = leftFlank; canClose = rightFlank; }
      else if (ch === '_') {
        canOpen = leftFlank && (!rightFlank || isPunctCh(prev));
        canClose = rightFlank && (!leftFlank || isPunctCh(next));
      } else {
        canOpen = !isWsCh(next);
        canClose = !isWsCh(prev);
      }
      flushText();
      const node = { k: 'delim', ch, len: run };
      nodes.push(node);
      const dEntry = { node, ch, canOpen, canClose, srcStart: i, srcEnd: i + run, origLen: run };
      delims.push(dEntry);
      allDelims.push(dEntry);
      i += run;
      continue;
    }

    if (ch === '\n') {
      const trail = / {2,}$/.exec(buf);
      if (trail) {
        buf = buf.slice(0, buf.length - trail[0].length);
        flushText();
        nodes.push({ k: 'br' });
        i++;
        while (s[i] === ' ' || s[i] === '\t') i++;
        continue;
      }
      buf += '\n';
      i++; continue;
    }

    // Extended autolinks (GFM): www., scheme://, bare emails, and
    // mailto:/xmpp: scheme emails in text.
    if (!(state && state.inLink) && !extOff &&
        (ch === 'w' || ch === 'h' || ch === 'f' || ch === 'm' || ch === 'x' || /[A-Za-z0-9]/.test(ch)) &&
        (i === 0 || isWsCh(s[i - 1]) || isPunctCh(s[i - 1]))) {
      const rest = s.slice(i);
      const um = EXT_URL_RE.exec(rest);
      if (um && (!um[0].startsWith('www.') || /www\.[^\s<]*\./.test(um[0]))) {
        const url = trimAutolink(um[0]);
        if (url.length >= 4) {
          flushText();
          const href = url.startsWith('www.') ? 'http://' + url : url;
          nodes.push({ k: 'link', href, title: null, ext: true, children: [{ k: 't', s: url }] });
          i += url.length;
          continue;
        }
      }
      // Emails: the match must not be preceded by a character that could
      // belong to a longer address, and must not be followed by one that
      // would extend the domain. A blocker that is only '_' or '-' may be
      // an emphasis delimiter: defer those matches as candidates and let
      // the post-emphasis pass decide with the tree as context (marked
      // re-lexes emphasis content as its own string, so a paired
      // delimiter is a string edge there, not a blocking character).
      const prevCh = i === 0 ? null : s[i - 1];
      const prevHardBad = prevCh !== null && EMAIL_PREV_BAD.test(prevCh) &&
        prevCh !== '_' && prevCh !== '-';
      if (!prevHardBad) {
        let text = null, href = null;
        const sm = SCHEME_EMAIL_RE.exec(rest);
        if (sm) {
          text = sm[0];
          if (sm[1] === 'xmpp' && s[i + text.length] === '/') {
            const rm = /^\/[A-Za-z0-9@._~-]+/.exec(rest.slice(text.length));
            if (rm) text += rm[0];
          }
          href = text;
        } else {
          const em = EXT_EMAIL_RE.exec(rest);
          if (em) { text = em[0]; href = 'mailto:' + text; }
        }
        if (text !== null) {
          const nx = i + text.length >= n ? null : s[i + text.length];
          const nextBad = nx !== null && /[A-Za-z0-9_-]/.test(nx);
          const softBlocked = prevCh === '_' || prevCh === '-' ||
            (nextBad && (nx === '_' || nx === '-'));
          if (!nextBad && prevCh !== '_' && prevCh !== '-') {
            flushText();
            nodes.push({ k: 'link', href, title: null, ext: true, children: [{ k: 't', s: text }] });
            i += text.length;
            continue;
          }
          if (softBlocked) {
            flushText();
            nodes.push({ k: 'emcand', text, href });
            i += text.length;
            continue;
          }
        }
      }
    }

    buf += ch;
    i++;
  }
  flushText();
  processEmphasis(0);
  resolveEmailCandidates(nodes);
  return nodes;
}

// Decide deferred email candidates (see the email branch in parseInline):
// a candidate links unless a real blocking character is adjacent in the
// final tree. Element neighbours (code, html, em, ...) count as neutral
// boundaries; a leftover literal delimiter counts by its character.
function resolveEmailCandidates(list) {
  const rawLast = (nd) => {
    if (nd.k === 't') return nd.s.length ? nd.s[nd.s.length - 1] : undefined;
    if (nd.k === 'delim') return nd.len > 0 ? nd.ch : undefined;
    if (nd.k === 'emcand') return nd.text[nd.text.length - 1];
    return null; // neutral element boundary
  };
  const rawFirst = (nd) => {
    if (nd.k === 't') return nd.s.length ? nd.s[0] : undefined;
    if (nd.k === 'delim') return nd.len > 0 ? nd.ch : undefined;
    if (nd.k === 'emcand') return nd.text[0];
    return null;
  };
  for (let idx = 0; idx < list.length; idx++) {
    const nd = list[idx];
    if (nd.children && nd.k !== 'link' && nd.k !== 'img') resolveEmailCandidates(nd.children);
    if (nd.k !== 'emcand') continue;
    let pv, nx;
    for (let j = idx - 1; j >= 0; j--) { pv = rawLast(list[j]); if (pv !== undefined) break; }
    for (let j = idx + 1; j < list.length; j++) { nx = rawFirst(list[j]); if (nx !== undefined) break; }
    const prev = pv === undefined ? null : pv;
    const next = nx === undefined ? null : nx;
    const prevBad = prev !== null && EMAIL_PREV_BAD.test(prev);
    const nextBad = next !== null && /[A-Za-z0-9_-]/.test(next);
    list[idx] = (!prevBad && !nextBad)
      ? { k: 'link', href: nd.href, title: null, ext: true, children: [{ k: 't', s: nd.text }] }
      : { k: 't', s: nd.text };
  }
}

// Parse "(dest title)" starting at s[pos] === '('. Returns {href,title,end}.
function scanInlineLink(s, pos) {
  let i = pos + 1;
  let w = skipInlineWs(s, i);
  i = w.next;
  let href = '';
  if (i < s.length && s[i] !== ')') {
    const d = scanDest(s, i);
    if (!d) return null;
    href = d.href;
    i = d.next;
  }
  w = skipInlineWs(s, i);
  const hadWs = w.count > 0;
  i = w.next;
  let title = null;
  if (s[i] !== ')') {
    if (!hadWs) return null;
    const t = scanTitle(s, i);
    if (!t) return null;
    title = t.title;
    i = t.next;
    w = skipInlineWs(s, i);
    i = w.next;
  }
  if (s[i] !== ')') return null;
  return { href, title, end: i + 1 };
}

// Inline HTML: comment, processing instruction, declaration, CDATA, or a
// syntactically valid open/close tag. Returns the raw string or null.
function scanInlineHtml(rest) {
  if (rest.startsWith('<!--')) {
    if (rest.startsWith('<!-->')) return '<!-->';
    if (rest.startsWith('<!--->')) return '<!--->';
    const end = rest.indexOf('-->', 4);
    if (end === -1) return null;
    const body = rest.slice(4, end);
    if (body.endsWith('-')) return null;
    return rest.slice(0, end + 3);
  }
  if (rest.startsWith('<?')) {
    const end = rest.indexOf('?>', 2);
    return end === -1 ? null : rest.slice(0, end + 2);
  }
  if (rest.startsWith('<![CDATA[')) {
    const end = rest.indexOf(']]>', 9);
    return end === -1 ? null : rest.slice(0, end + 3);
  }
  if (/^<![A-Za-z]/.test(rest)) {
    const end = rest.indexOf('>', 2);
    return end === -1 ? null : rest.slice(0, end + 1);
  }
  const m = OPEN_TAG_RE.exec(rest) || CLOSE_TAG_RE.exec(rest);
  return m ? m[0] : null;
}

// Trim an extended autolink per GFM rules.
function trimAutolink(url) {
  let u = url;
  // An '(' with no ')' anywhere after it (within the match) ends the
  // URL just before it.
  for (let i = 0; i < u.length; i++) {
    if (u[i] === '(' && u.indexOf(')', i) === -1) { u = u.slice(0, i); break; }
  }
  for (;;) {
    const before = u;
    const last = u[u.length - 1];
    const ent = /&[A-Za-z][A-Za-z0-9]*;$/.exec(u);
    if (ent) u = u.slice(0, u.length - ent[0].length);
    else if (last !== undefined && '?!.,:*_~'.includes(last)) u = u.slice(0, -1);
    else if (last === ';') u = u.slice(0, -1);
    else if (last === ')') {
      // The final ')' is dropped when it matches nothing, or when the
      // group it closes itself contains a '('; a simple group stays.
      const stack = [];
      let match = -1;
      for (let i = 0; i < u.length; i++) {
        if (u[i] === '(') stack.push(i);
        else if (u[i] === ')') match = stack.length ? stack.pop() : -1;
      }
      if (match === -1 || u.slice(match + 1, -1).includes('(')) u = u.slice(0, -1);
    }
    if (u === before) break;
  }
  return u;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderNodes(nodes) {
  let out = '';
  for (const nd of nodes) out += renderNode(nd);
  return out;
}

function renderNode(nd) {
  switch (nd.k) {
    case 't': return escapeHtml(nd.s);
    case 'delim': return escapeHtml(nd.ch.repeat(nd.len));
    case 'code': return '<code>' + escapeCode(nd.s) + '</code>';
    case 'html': return nd.s;
    case 'br': return '<br>';
    case 'em': return '<em>' + renderNodes(nd.children) + '</em>';
    case 'strong': return '<strong>' + renderNodes(nd.children) + '</strong>';
    case 'del': return '<del>' + renderNodes(nd.children) + '</del>';
    case 'link': {
      let out = '<a href="' + escapeAttr(cleanUrl(nd.href)) + '"';
      if (nd.title !== null && nd.title !== undefined) {
        out += ' title="' + escapeAttr(nd.title) + '"';
      }
      return out + '>' + renderNodes(nd.children) + '</a>';
    }
    case 'img': {
      let out = '<img src="' + escapeAttr(cleanUrl(nd.href)) + '" alt="' +
        escapeAttr(plainTextOf(nd.children)) + '"';
      if (nd.title !== null && nd.title !== undefined) {
        out += ' title="' + escapeAttr(nd.title) + '"';
      }
      return out + '>';
    }
    default: return '';
  }
}

function renderInline(text, refs, state) {
  return renderNodes(parseInline(text, refs, state));
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

const TASK_RE = /^\[([ xX])\](?:[ \t]+|$)/;

function renderBlocks(blocks, refs, tight, state) {
  let out = '';
  for (const b of blocks) out += renderBlock(b, refs, tight, state);
  return out;
}

function renderBlock(b, refs, tight, state) {
  switch (b.t) {
    case 'doc':
      return renderBlocks(b.children, refs, false, state);
    case 'quote':
      return '<blockquote>\n' + renderBlocks(b.children, refs, false, state) + '</blockquote>\n';
    case 'heading':
      return '<h' + b.level + '>' + renderInline(b.text.trim(), refs, state) + '</h' + b.level + '>\n';
    case 'para': {
      const rawText = b.renderText !== undefined ? b.renderText : b.text;
      const html = renderInline(rawText, refs, state);
      if (html === '' && b.defsOnly) return '';
      if (tight) return html;
      return '<p>' + html + '</p>\n';
    }
    case 'code': {
      let cls = '';
      if (b.fenced && b.info) {
        const lang = b.info.split(/[ \t]+/)[0]
          .replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
        if (lang) cls = ' class="language-' + escapeAttr(lang) + '"';
      }
      return '<pre><code' + cls + '>' + escapeCode(b.text) + '</code></pre>\n';
    }
    case 'html':
      return b.text + (b.trailingNL ? '\n' : '');
    case 'hr':
      return '<hr>\n';
    case 'list': {
      const tag = b.start !== null && b.start !== undefined ? 'ol' : 'ul';
      let out = '<' + tag;
      if (tag === 'ol' && b.start !== 1) out += ' start="' + b.start + '"';
      out += '>\n';
      for (const item of b.children) out += renderItem(item, b, refs, state);
      return out + '</' + tag + '>\n';
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let c = 0; c < b.heads.length; c++) {
        const al = b.aligns[c];
        out += '<th' + (al ? ' align="' + al + '"' : '') + '>' +
          renderInline(b.heads[c], refs, state) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (b.rows.length > 0) {
        out += '<tbody>';
        for (const row of b.rows) {
          out += '<tr>\n';
          for (let c = 0; c < b.heads.length; c++) {
            const al = b.aligns[c];
            const cell = c < row.length ? row[c] : '';
            out += '<td' + (al ? ' align="' + al + '"' : '') + '>' +
              renderInline(cell, refs, state) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
    default:
      return '';
  }
}

function renderItem(item, list, refs, state) {
  let out = '<li>';
  const tight = !list.loose;
  let first = true;
  for (const child of item.children) {
    if (first && child.t === 'para' && item.task !== undefined) {
      const box = item.task
        ? '<input checked="" disabled="" type="checkbox"> '
        : '<input disabled="" type="checkbox"> ';
      const text = child.renderText !== undefined ? child.renderText : child.text;
      const html = renderInline(text.replace(TASK_RE, ''), refs, state);
      out += tight ? box + html : '<p>' + box + html + '</p>\n';
    } else {
      out += renderBlock(child, refs, tight, state);
    }
    first = false;
  }
  return out + '</li>\n';
}

// ---------------------------------------------------------------------------
// parse(): block phase, definition collection, inline phase.
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const refs = new Map();
  const root = parseBlocks(src, refs);
  // First pass: pull link reference definitions out of every paragraph and
  // flag task list items, so references resolve regardless of position.
  (function collect(blocks) {
    for (const b of blocks) {
      if (b.children) collect(b.children);
      if (b.t === 'item' && b.children.length > 0 && b.children[0].t === 'para') {
        const p = b.children[0];
        const text = p.renderText !== undefined ? p.renderText : p.text;
        const m = TASK_RE.exec(text);
        if (m) b.task = m[1] !== ' ';
      }
    }
  })(root.children);
  return renderBlocks(root.children, refs, false, { inLink: false });
}
