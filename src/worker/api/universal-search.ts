import { Hono } from "hono";
import type {
  SearchContactResult,
  SearchConversationResult,
  SearchNoteResult,
  SearchRuleResult,
  ThreadSummary,
  UniversalSearchResults,
} from "../../shared/types.ts";

type SearchEnv = { Bindings: { DB: D1Database } };

const MAX_QUERY_LENGTH = 200;
const MAX_TERMS = 8;
const CONVERSATION_LIMIT = 10;
const GROUP_LIMIT = 8;
const EXCERPT_LENGTH = 160;

/**
 * The universal search behind the box in the top right. One query finds
 * Conversations (subject, body and addresses), Internal Notes, Mail Rules
 * and Contacts. Every word must match; each
 * word matches the start of a word in message bodies and anywhere else.
 */
export const universalSearchApi = new Hono<SearchEnv>();

universalSearchApi.get("/", async (c) => {
  const terms = searchTerms(c.req.query("q") ?? "");
  const results: UniversalSearchResults = {
    conversations: [],
    notes: [],
    rules: [],
    contacts: [],
  };
  if (terms.length === 0) return c.json(results);
  const db = c.env.DB;
  const [conversations, notes, rules, contacts] = await Promise.all([
    searchConversations(db, terms),
    searchNotes(db, terms),
    searchRules(db, terms),
    searchContacts(db, terms),
  ]);
  results.conversations = conversations;
  results.notes = notes;
  results.rules = rules;
  results.contacts = contacts;
  return c.json(results);
});

/** Splits a query into the words that must all match. */
export function searchTerms(query: string): string[] {
  const words = query.slice(0, MAX_QUERY_LENGTH).trim().split(/\s+/).filter(Boolean);
  return [...new Set(words.map((word) => word.toLowerCase()))].slice(0, MAX_TERMS);
}

/**
 * An FTS5 query requiring every term as a word prefix. Terms are quoted so
 * operators and punctuation typed by people are never parsed as syntax.
 * Returns null when no term has a letter or digit FTS could index.
 */
export function ftsQuery(terms: string[]): string | null {
  const phrases = terms
    .filter((term) => /[\p{L}\p{N}]/u.test(term))
    .map((term) => `"${term.replaceAll('"', "")}"*`);
  return phrases.length ? phrases.join(" ") : null;
}

/** Text around the first term found, collapsed to one line. */
export function excerpt(text: string | null | undefined, terms: string[]): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const lower = flat.toLowerCase();
  const found = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  const first = found.length ? Math.min(...found) : 0;
  let start = first > 40 ? first - 40 : 0;
  // Begin on a whole word.
  if (start > 0) {
    const space = flat.indexOf(" ", start);
    if (space >= 0 && space < first) start = space + 1;
  }
  const end = Math.min(flat.length, start + EXCERPT_LENGTH);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

function containsAny(text: string | null | undefined, terms: string[]): boolean {
  const lower = (text ?? "").toLowerCase();
  return terms.some((term) => lower.includes(term));
}

function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * A WHERE fragment requiring every term to appear in at least one of the
 * given expressions, with its bound values in order. A plain expression is
 * compared with LIKE; one containing {} is used as written, with each {}
 * standing for the term's LIKE pattern.
 */
function everyTermIn(expressions: string[], terms: string[]): { sql: string; values: string[] } {
  const values: string[] = [];
  const clauses = terms.map((term) => {
    const pattern = likePattern(term);
    return `(${expressions
      .map((expression) => {
        const condition = expression.includes("{}")
          ? expression
          : `${expression} LIKE {}`;
        return condition.replaceAll("{}", () => {
          values.push(pattern);
          return "? ESCAPE '\\'";
        });
      })
      .join(" OR ")})`;
  });
  return { sql: clauses.join(" AND "), values };
}

async function searchConversations(
  db: D1Database,
  terms: string[],
): Promise<SearchConversationResult[]> {
  // Message text through the full-text index, newest first.
  const bodyByThread = new Map<number, string>();
  const match = ftsQuery(terms);
  if (match) {
    try {
      const { results } = await db
        .prepare(
          `SELECT msg.thread_id, substr(COALESCE(msg.text_body, ''), 1, 20000) AS body
           FROM messages_fts f JOIN messages msg ON msg.id = f.rowid
           WHERE messages_fts MATCH ?
           ORDER BY msg.created_at DESC, msg.id DESC LIMIT 200`,
        )
        .bind(match)
        .all<{ thread_id: number; body: string }>();
      for (const row of results) {
        if (!bodyByThread.has(row.thread_id)) bodyByThread.set(row.thread_id, row.body);
      }
    } catch {
      // A query FTS still cannot parse finds nothing in message text.
    }
  }

  // Subjects, senders and recipients, which the full-text index leaves out.
  const addresses = everyTermIn(
    [
      "t.subject",
      "COALESCE(t.catch_all_recipient, '')",
      `EXISTS (SELECT 1 FROM messages mm WHERE mm.thread_id = t.id AND (
         mm.from_address LIKE {} OR COALESCE(mm.from_name, '') LIKE {}
         OR mm.to_addresses LIKE {} OR mm.cc_addresses LIKE {}))`,
    ],
    terms,
  );
  const { results: headerMatches } = await db
    .prepare(`SELECT t.id FROM threads t WHERE ${addresses.sql} ORDER BY t.last_message_at DESC LIMIT 50`)
    .bind(...addresses.values)
    .all<{ id: number }>();

  const ids = [...new Set([...bodyByThread.keys(), ...headerMatches.map((row) => row.id)])];
  if (ids.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT t.id, t.subject, t.status, t.snippet, t.last_message_at, m.address AS mailbox_address,
         (SELECT COALESCE(
                  (SELECT c.name FROM contact_addresses ca JOIN contacts c ON c.id = ca.contact_id
                   WHERE ca.address = li.from_address AND trim(COALESCE(c.name, '')) <> ''),
                  NULLIF(trim(li.from_name), ''), li.from_address) FROM messages li
          WHERE li.thread_id = t.id AND li.direction = 'inbound'
          ORDER BY li.created_at DESC, li.id DESC LIMIT 1) AS sender
       FROM threads t JOIN mailboxes m ON m.id = t.mailbox_id
       WHERE t.id IN (SELECT value FROM json_each(?))
       ORDER BY t.last_message_at DESC, t.id DESC LIMIT ?`,
    )
    .bind(JSON.stringify(ids), CONVERSATION_LIMIT)
    .all<{
      id: number;
      subject: string;
      status: ThreadSummary["status"];
      snippet: string;
      last_message_at: string;
      mailbox_address: string;
      sender: string | null;
    }>();
  return results.map((row) => {
    const body = bodyByThread.get(row.id);
    return {
      id: row.id,
      subject: row.subject,
      status: row.status,
      mailbox_address: row.mailbox_address,
      from: row.sender,
      excerpt: body && containsAny(body, terms) ? excerpt(body, terms) : excerpt(row.snippet, terms),
      last_message_at: row.last_message_at,
    };
  });
}

async function searchNotes(db: D1Database, terms: string[]): Promise<SearchNoteResult[]> {
  const where = everyTermIn(["n.text_body"], terms);
  const { results } = await db
    .prepare(
      `SELECT n.id, n.thread_id, n.text_body, n.created_at, t.subject AS thread_subject,
         t.status AS thread_status, r.name AS mail_rule_name
       FROM thread_notes n
       JOIN threads t ON t.id = n.thread_id
       LEFT JOIN mail_rules r ON r.id = n.mail_rule_id
       WHERE ${where.sql}
       ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
    )
    .bind(...where.values, GROUP_LIMIT)
    .all<{
      id: number;
      thread_id: number;
      text_body: string;
      created_at: string;
      thread_subject: string;
      thread_status: ThreadSummary["status"];
      mail_rule_name: string | null;
    }>();
  return results.map((row) => ({
    id: row.id,
    thread_id: row.thread_id,
    thread_subject: row.thread_subject,
    thread_status: row.thread_status,
    mail_rule_name: row.mail_rule_name,
    excerpt: excerpt(row.text_body, terms),
    created_at: row.created_at,
  }));
}

async function searchRules(db: D1Database, terms: string[]): Promise<SearchRuleResult[]> {
  const where = everyTermIn(
    [
      "r.name",
      "COALESCE(r.note, '')",
      "r.conditions",
      "r.forward_to",
      "r.forward_cc",
      "r.forward_bcc",
    ],
    terms,
  );
  const { results } = await db
    .prepare(
      `SELECT r.id, r.name, r.enabled, r.note, r.conditions, r.forward_to, r.forward_cc,
         r.forward_bcc, m.address AS mailbox_address
       FROM mail_rules r LEFT JOIN mailboxes m ON m.id = r.mailbox_id
       WHERE ${where.sql}
       ORDER BY r.name COLLATE NOCASE, r.id LIMIT ?`,
    )
    .bind(...where.values, GROUP_LIMIT)
    .all<{
      id: number;
      name: string;
      enabled: number;
      note: string | null;
      conditions: string;
      forward_to: string;
      forward_cc: string;
      forward_bcc: string;
      mailbox_address: string | null;
    }>();
  return results.map((row) => ({
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    mailbox_address: row.mailbox_address,
    excerpt: ruleExcerpt(row, terms),
  }));
}

/** Where a rule matched, when it was not its name: its note, a condition or a forward address. */
function ruleExcerpt(
  row: { name: string; note: string | null; conditions: string; forward_to: string; forward_cc: string; forward_bcc: string },
  terms: string[],
): string {
  if (terms.every((term) => row.name.toLowerCase().includes(term))) return "";
  if (containsAny(row.note, terms)) return excerpt(row.note, terms);
  const values: string[] = [];
  const collect = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const item = node as { value?: unknown; items?: unknown };
    if (typeof item.value === "string" && item.value) values.push(item.value);
    if (Array.isArray(item.items)) item.items.forEach(collect);
  };
  try {
    collect(JSON.parse(row.conditions));
  } catch {
    // A malformed condition tree has no values to show.
  }
  const condition = values.find((value) => containsAny(value, terms));
  if (condition) return `Condition: ${condition}`;
  const forwards = [row.forward_to, row.forward_cc, row.forward_bcc].flatMap((list) => {
    try {
      const parsed = JSON.parse(list);
      return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : [];
    } catch {
      return [];
    }
  });
  const forward = forwards.find((value) => containsAny(value, terms));
  return forward ? `Forwards to ${forward}` : "";
}

async function searchContacts(db: D1Database, terms: string[]): Promise<SearchContactResult[]> {
  const where = everyTermIn(
    [
      "address",
      "COALESCE(name, '')",
      "COALESCE(company, '')",
      "COALESCE(phone, '')",
      "COALESCE(notes, '')",
      "id IN (SELECT contact_id FROM contact_addresses WHERE address LIKE {})",
    ],
    terms,
  );
  const { results } = await db
    .prepare(
      `SELECT id, address, name, company FROM contacts WHERE ${where.sql}
       ORDER BY COALESCE(last_seen_at, created_at) DESC, id DESC LIMIT ?`,
    )
    .bind(...where.values, GROUP_LIMIT)
    .all<SearchContactResult>();
  return results;
}
