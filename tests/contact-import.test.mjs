import assert from "node:assert/strict";
import test from "node:test";
import { ContactFileError, parseContactFile, parseCsv } from "../src/shared/contacts.ts";

test("parseCsv handles quotes, escaped quotes, embedded newlines and CRLF", () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n"multi\nline",\r\n\r\n'), [
    ["a", "b"],
    ["x, y", 'say "hi"'],
    ["multi\nline", ""],
  ]);
});

test("reads a Google Contacts export", () => {
  const csv = [
    "First Name,Middle Name,Last Name,Organization Name,E-mail 1 - Label,E-mail 1 - Value,Phone 1 - Label,Phone 1 - Value,Notes",
    'Ada,,Lovelace,Analytical Engines,* Work,ADA@Example.org ::: ada@home.example,Mobile,+44 20 1234,"Met at\nthe conference"',
    "No,,Email,,,,,,",
  ].join("\n");
  assert.deepEqual(parseContactFile("contacts.csv", `﻿${csv}`), {
    contacts: [{
      address: "ada@example.org",
      name: "Ada Lovelace",
      company: "Analytical Engines",
      phone: "+44 20 1234",
      notes: "Met at\nthe conference",
    }],
    skipped: 1,
    duplicates: 0,
  });
});

test("reads an Outlook export and a simple name/email file", () => {
  const outlook = "First Name,Last Name,E-mail Address,Company,Mobile Phone\nGrace,Hopper,grace@navy.example,US Navy,555\n";
  assert.deepEqual(parseContactFile("outlook.csv", outlook).contacts, [
    { address: "grace@navy.example", name: "Grace Hopper", company: "US Navy", phone: "555", notes: null },
  ]);
  const simple = "Name,Email\nAlan Turing,alan@example.com\nDup,ALAN@example.com\n";
  const parsed = parseContactFile("simple.csv", simple);
  assert.equal(parsed.contacts.length, 1);
  assert.equal(parsed.contacts[0].name, "Alan Turing");
  assert.equal(parsed.duplicates, 1);
});

test("rejects a CSV without an email column", () => {
  assert.throws(() => parseContactFile("x.csv", "Name,Phone\nA,1\n"), ContactFileError);
  assert.throws(() => parseContactFile("x.csv", ""), ContactFileError);
});

test("reads vCards with folded lines, groups, structured names and escapes", () => {
  const vcf = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "N:Lovelace;Ada;;;",
    "item1.EMAIL;type=INTERNET;type=pref:ada@example.org",
    "EMAIL:second@example.org",
    "ORG:Analytical Engines;Research",
    "TEL;TYPE=CELL:+44 20",
    "NOTE:First line\\nsecond\\, with comma and a very long",
    "  folded tail",
    "END:VCARD",
    "BEGIN:VCARD",
    "FN:No Address",
    "END:VCARD",
  ].join("\r\n");
  assert.deepEqual(parseContactFile("contacts.vcf", vcf), {
    contacts: [{
      address: "ada@example.org",
      name: "Ada Lovelace",
      company: "Analytical Engines",
      phone: "+44 20",
      notes: "First line\nsecond, with comma and a very long folded tail",
    }],
    skipped: 1,
    duplicates: 0,
  });
});
