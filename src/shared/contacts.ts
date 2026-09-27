import { isEmailAddress } from "./recipients.ts";
import type { ContactInput } from "./types.ts";

export const CONTACT_FIELD_LIMITS = {
  name: 120,
  company: 120,
  phone: 40,
  notes: 4000,
} as const;

/** Most Contacts one import request may carry; larger files are sent in several requests. */
export const MAX_CONTACT_IMPORT_BATCH = 500;

/** Largest contacts file the import accepts. */
export const MAX_CONTACT_IMPORT_FILE_BYTES = 5 * 1024 * 1024;

export interface ParsedContactFile {
  contacts: ContactInput[];
  /** Rows or cards without a usable email address. */
  skipped: number;
  /** Rows whose address already appeared earlier in the file. */
  duplicates: number;
}

export class ContactFileError extends Error {}

/**
 * Reads a CSV (Google Contacts, Outlook or any file with an email column) or
 * vCard file into Contacts. Only the first email address of each row or card
 * is used; single-line fields are collapsed and every field is cut to its limit.
 */
export function parseContactFile(fileName: string, text: string): ParsedContactFile {
  const content = text.replace(/^﻿/, "");
  const vcard = /\.vcf$|\.vcard$/i.test(fileName) || /^\s*BEGIN:VCARD/i.test(content);
  const raw = vcard ? readVcards(content) : readCsvContacts(content);

  const seen = new Set<string>();
  const result: ParsedContactFile = { contacts: [], skipped: 0, duplicates: 0 };
  for (const entry of raw) {
    const address = firstAddress(entry.address ?? "");
    if (!address) {
      result.skipped++;
      continue;
    }
    if (seen.has(address)) {
      result.duplicates++;
      continue;
    }
    seen.add(address);
    result.contacts.push({
      address,
      name: oneLine(entry.name, CONTACT_FIELD_LIMITS.name),
      company: oneLine(entry.company, CONTACT_FIELD_LIMITS.company),
      phone: oneLine(entry.phone, CONTACT_FIELD_LIMITS.phone),
      notes: entry.notes?.trim().slice(0, CONTACT_FIELD_LIMITS.notes) || null,
    });
  }
  return result;
}

type RawContact = Partial<Record<"address" | "name" | "company" | "phone" | "notes", string>>;

function firstAddress(value: string): string | null {
  for (const part of value.split(/\s*(?::::|[,;\s])\s*/)) {
    const address = part.replace(/^mailto:/i, "").replace(/^<|>$/g, "").trim().toLowerCase();
    if (isEmailAddress(address)) return address;
  }
  return null;
}

function oneLine(value: string | undefined, limit: number): string | null {
  return value?.replace(/\s+/g, " ").trim().slice(0, limit) || null;
}

/** RFC 4180 CSV: quoted fields may contain commas, quotes ("") and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === "") {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

function readCsvContacts(text: string): RawContact[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new ContactFileError("The file is empty");
  const keys = header.map((cell) => cell.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
  // Type and label columns ("E-mail 1 - Type") describe a value; they never hold one.
  const find = (pattern: RegExp) =>
    keys.findIndex((key) => pattern.test(key) && !/\b(type|label)\b/.test(key));

  const email = find(/\be ?mail\b/);
  if (email === -1) {
    throw new ContactFileError("Couldn’t find an email column. Add a header row with an “Email” column.");
  }
  const name = find(/^(name|full name|display name|contact name)$/);
  const first = find(/^(first name|given name)$/);
  const middle = find(/^(middle name|additional name)$/);
  const last = find(/^(last name|family name|surname)$/);
  const company = find(/^(company|organization|organisation|org|business|organization( \d+)? name|company name)$/);
  const phone = find(/\b(phone|mobile|telephone|tel)\b/);
  const notes = find(/^(notes?|comments?)$/);
  const cell = (row: string[], index: number) => (index === -1 ? undefined : row[index]);

  return rows.map((row) => ({
    address: cell(row, email),
    name:
      cell(row, name)?.trim() ||
      [first, middle, last].map((index) => cell(row, index)?.trim()).filter(Boolean).join(" "),
    company: cell(row, company),
    phone: cell(row, phone),
    notes: cell(row, notes),
  }));
}

function readVcards(text: string): RawContact[] {
  // Unfold continuation lines (a line break followed by a space or tab).
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const cards: RawContact[] = [];
  let card: RawContact | null = null;
  let structuredName = "";
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const property = line.slice(0, colon).split(";")[0].replace(/^[^.]*\./, "").toUpperCase();
    const value = line.slice(colon + 1);
    if (property === "BEGIN" && /^vcard$/i.test(value.trim())) {
      card = {};
      structuredName = "";
    } else if (!card) {
      continue;
    } else if (property === "END") {
      card.name ||= structuredName;
      cards.push(card);
      card = null;
    } else if (property === "EMAIL") {
      card.address ??= unescapeVcard(value);
    } else if (property === "FN") {
      card.name = unescapeVcard(value);
    } else if (property === "N") {
      // N is Family;Given;Additional;Prefix;Suffix.
      const [family, given, additional] = splitVcard(value);
      structuredName = [given, additional, family].filter(Boolean).join(" ");
    } else if (property === "ORG") {
      card.company ??= splitVcard(value)[0];
    } else if (property === "TEL") {
      card.phone ??= unescapeVcard(value);
    } else if (property === "NOTE") {
      card.notes ??= unescapeVcard(value);
    }
  }
  return cards;
}

function splitVcard(value: string): string[] {
  return value.split(/(?<!\\);/).map(unescapeVcard);
}

function unescapeVcard(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_, char: string) => (char.toLowerCase() === "n" ? "\n" : char)).trim();
}
