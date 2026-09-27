/**
 * Split a plain-text email body into the newly written part and the quoted
 * tail (the "On ... wrote:" block most clients append). Used by the UI for
 * collapsed display and by the inbound pipeline for clean snippets — the
 * stored body is never modified.
 */
export function splitQuotedTail(body: string): { main: string; quoted: string | null } {
  const lines = body.split("\n");
  const attributionRe =
    /^(On .{4,80}(wrote|writes):\s*$|-{3,}\s*Original Message\s*-{3,}|________________________________)/i;

  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (attributionRe.test(line)) {
      cut = i;
      break;
    }
    // A run of quoted lines with nothing but quotes after it
    if (line.startsWith(">")) {
      const rest = lines.slice(i);
      if (rest.every((l) => l.trim() === "" || l.trim().startsWith(">"))) {
        cut = i;
        break;
      }
    }
  }
  if (cut <= 0) return { main: body, quoted: null };
  const main = lines.slice(0, cut).join("\n").trimEnd();
  const quoted = lines.slice(cut).join("\n").trim();
  if (!main) return { main: body, quoted: null };
  return { main, quoted };
}
