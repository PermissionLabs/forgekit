// Unified/git diff path extraction. Header lines are parsed only outside hunk bodies (hunk line counts are
// honoured), and git C-style quoted paths ("a/\303\251.yml") are decoded before the a/ b/ prefix is stripped.

/** Decode a git-quoted path starting at s[0] === '"'. Returns { value, end } or null when malformed. */
export function unquoteGitPath(s) {
  if (s[0] !== '"') return null;
  const bytes = [];
  const ESC = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7, '"': 34, "\\": 92 };
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === '"') return { value: Buffer.from(bytes).toString("utf8"), end: i + 1 };
    if (c === "\\") {
      const n = s[i + 1];
      if (n === undefined) return null;
      if (/[0-7]/.test(n)) {
        const oct = s.slice(i + 1, i + 4);
        if (!/^[0-7]{3}$/.test(oct)) return null;
        bytes.push(parseInt(oct, 8));
        i += 3;
      } else if (n in ESC) { bytes.push(ESC[n]); i += 1; }
      else return null;
    } else {
      // A raw character (core.quotePath=false) may be a surrogate pair: encode the whole code point, not UTF-16 units.
      const cp = s.codePointAt(i);
      bytes.push(...Buffer.from(String.fromCodePoint(cp), "utf8"));
      if (cp > 0xffff) i++;
    }
  }
  return null;
}

const stripPrefix = (p) => p.replace(/^[ab]\//, "");

/** Path token of a ---/+++ line: quoted, or raw up to a tab (timestamp). null for /dev/null or malformed. */
function headerPath(rest) {
  if (rest.startsWith('"')) { const q = unquoteGitPath(rest); return q ? stripPrefix(q.value) : null; }
  const raw = rest.replace(/\t.*$/, "");
  if (raw === "/dev/null") return null;
  return stripPrefix(raw);
}

/** The two paths of a `diff --git` line (quoted or not). */
function gitPair(rest) {
  if (!rest.includes('"')) {
    const L = (rest.length - 5) / 2;
    if (Number.isInteger(L) && L > 0 && rest.startsWith("a/") && rest.slice(2 + L, 5 + L) === " b/" && rest.slice(5 + L) === rest.slice(2, 2 + L)) return [rest.slice(2, 2 + L), rest.slice(5 + L)];
    const m = rest.match(/^a\/(.+?) b\/(.+)$/);
    return m ? [m[1], m[2]] : [];
  }
  const out = [];
  let s = rest;
  while (s.length && out.length < 2) {
    if (s.startsWith('"')) {
      const q = unquoteGitPath(s);
      if (!q) return out;
      out.push(stripPrefix(q.value));
      s = s.slice(q.end).replace(/^ /, "");
    } else {
      const sp = s.indexOf(' "');
      const tok = sp === -1 ? s : s.slice(0, sp);
      out.push(stripPrefix(tok));
      s = sp === -1 ? "" : s.slice(sp + 1);
    }
  }
  return out;
}

/**
 * parseDiffPaths(text) -> { paths[] (old and new sides), newPaths[] (post-change side) }
 * A `diff --git` block without ---/+++ lines (mode-only change, new empty file, binary change) still contributes
 * its b/ path to newPaths unless the block deletes the file.
 */
export function parseDiffPaths(text) {
  const all = new Set(), post = new Set();
  let oldLeft = 0, newLeft = 0;
  let block = null; // { b, deleted, sawPost }
  const closeBlock = () => { if (block && block.b && !block.deleted && !block.sawPost) post.add(block.b); block = null; };
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (oldLeft > 0 || newLeft > 0) {
      const c = line === "" ? " " : line[0];
      if (c === "\\") continue;
      if (c === " ") { oldLeft--; newLeft--; continue; }
      if (c === "-" && oldLeft > 0) { oldLeft--; continue; }
      if (c === "+" && newLeft > 0) { newLeft--; continue; }
      oldLeft = newLeft = 0; // malformed hunk: fall through to header parsing
    }
    let m;
    if ((m = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/))) {
      oldLeft = m[1] === undefined ? 1 : Number(m[1]);
      newLeft = m[2] === undefined ? 1 : Number(m[2]);
      continue;
    }
    if (line.startsWith("diff --git ")) {
      closeBlock();
      const pair = gitPair(line.slice(11));
      for (const p of pair) all.add(p);
      block = { b: pair[1] ?? null, deleted: false, sawPost: false };
      continue;
    }
    if (block && /^deleted file mode /.test(line)) { block.deleted = true; continue; }
    if ((m = line.match(/^(---|\+\+\+) (.+)$/))) {
      const p = headerPath(m[2]);
      if (m[1] === "+++" && block) block.sawPost = true;
      if (p) { all.add(p); if (m[1] === "+++") post.add(p); }
      continue;
    }
    if ((m = line.match(/^(rename|copy) (from|to) (.+)$/))) {
      const p = m[3].startsWith('"') ? unquoteGitPath(m[3])?.value : m[3];
      if (p) { all.add(p); if (m[2] === "to") { post.add(p); if (block) block.sawPost = true; } }
    }
  }
  closeBlock();
  return { paths: [...all], newPaths: [...post] };
}
