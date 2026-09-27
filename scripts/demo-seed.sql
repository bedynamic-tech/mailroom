-- Demo data: the fictional workspace shown in the README screenshot.
-- Run on a freshly migrated local database: npm run db:seed:demo:local
-- Use this instead of seed.sql, not together with it.
INSERT INTO domains (id, name, status, activated_at) VALUES
  (1, 'lumen.example', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')),
  (2, 'fieldnotes.example', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days'));

INSERT INTO mailboxes (id, address, display_name, domain_id, color, agent_mode, agent_instructions) VALUES
  (1, 'support@lumen.example', 'Lumen Support', 1, '#6366f1', 'draft', 'Lumen is an analytics dashboard for SaaS teams, billed per workspace (Pro plan: $49/month). Be warm, concise, and transparent. Never claim an action was completed unless it has been verified. Sign off as "Lumen Support".'),
  (2, 'sales@lumen.example', 'Lumen Sales', 1, '#f59e0b', 'draft', 'Answer pricing and procurement questions for Lumen. Volume discounts start at 25 seats. Offer a call for anything involving contracts or security reviews. Sign off as "Lumen Sales".'),
  (3, 'hello@fieldnotes.example', 'Field Notes', 2, '#10b981', 'draft', 'Field Notes is a weekly newsletter about product design. Reply to readers personally and briefly. Guest post pitches: thank the writer and ask for an outline and two writing samples. Sign off as "Sam, Field Notes".');

INSERT INTO playbooks (id, mailbox_id, name, when_to_use, instructions, example_reply, enabled) VALUES
  (1, 1, 'Duplicate charges', 'Use when a customer reports being charged more than once for the same purchase.', 'Confirm which charges are duplicates before promising a refund. Explain which charge will remain and give a realistic processing window of 5 to 10 business days.', NULL, 1),
  (2, 1, 'Custom domains', 'Use when a customer cannot connect a custom domain to their dashboard.', 'Ask for the domain and the DNS provider. Remind them the CNAME must point to dashboards.lumen.example and can take a few minutes to propagate.', NULL, 1),
  (3, 3, 'Guest post pitches', 'Use when someone offers to write a guest post for the newsletter.', 'Thank them, say what makes a good fit (practical, first-hand, under 1,500 words), and ask for an outline plus two writing samples.', NULL, 1);

INSERT INTO labels (id, mailbox_id, name, condition) VALUES
  (1, 1, 'billing', 'The sender asks about charges, invoices, refunds, or their plan.'),
  (2, 1, 'feature-request', 'The sender asks for a feature or capability Lumen does not have yet.'),
  (3, 2, 'enterprise', 'The sender represents a company evaluating 25 or more seats, or asks about security, compliance, or procurement.'),
  (4, 3, 'guest-post', 'The sender offers to write an article or guest post for the newsletter.');

INSERT INTO threads (id, mailbox_id, subject, normalized_subject, snippet, is_read, message_count, last_message_at) VALUES
  (1, 1, 'Charged twice for the Pro plan', 'charged twice for the pro plan', 'Hi, I just noticed two $49 charges on my card for this month''s Pro plan, about three minutes apart.', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-4 minutes')),
  (2, 2, 'Volume pricing for 40 seats', 'volume pricing for 40 seats', 'We''re evaluating Lumen for our product org (about 40 people) and would like to understand volume pricing.', 0, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-11 minutes')),
  (3, 3, 'Guest post pitch: design systems at scale', 'guest post pitch: design systems at scale', 'I lead the design system team at a mid-size fintech and would love to write for Field Notes.', 0, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-38 minutes')),
  (4, 1, 'Can''t connect my custom domain', 'can''t connect my custom domain', 'That worked. The CNAME just needed a few minutes to propagate. Thanks!', 1, 3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours')),
  (5, 2, 'Security questionnaire', 'security questionnaire', 'Attached is our vendor security questionnaire. Our review board meets next Thursday.', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 hours')),
  (6, 1, 'Feature request: export dashboards to CSV', 'feature request: export dashboards to csv', 'Our finance team asks for a CSV export of the revenue dashboard every month.', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 hours')),
  (7, 3, 'Loved issue #42', 'loved issue #42', 'The piece on onboarding checklists was exactly what our team needed this week.', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 days'));

INSERT INTO messages (id, thread_id, message_id, direction, sent_by, from_address, from_name, to_addresses, subject, text_body, created_at) VALUES
  (1, 1, '<demo-1@northwind.example>', 'inbound', 'external', 'maya@northwind.example', 'Maya Chen', '["support@lumen.example"]', 'Charged twice for the Pro plan', 'Hi, I just noticed two $49 charges on my card for this month''s Pro plan, about three minutes apart. I only have one workspace. Could you refund the extra one?

Thanks,
Maya', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-4 minutes')),
  (2, 2, '<demo-2@okafor.example>', 'inbound', 'external', 'daniel@okafor.example', 'Daniel Okafor', '["sales@lumen.example"]', 'Volume pricing for 40 seats', 'Hi,

We''re evaluating Lumen for our product org (about 40 people) and would like to understand volume pricing. Do you offer annual billing, and is SSO included at that tier?

Best,
Daniel Okafor
Head of Product Operations', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-11 minutes')),
  (3, 3, '<demo-3@raman.example>', 'inbound', 'external', 'priya@raman.example', 'Priya Raman', '["hello@fieldnotes.example"]', 'Guest post pitch: design systems at scale', 'Hi Sam,

I lead the design system team at a mid-size fintech and would love to write for Field Notes. The working title is "Design systems at scale: what broke at 200 components". Happy to share an outline.

Priya', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-38 minutes')),
  (4, 4, '<demo-4@becker.example>', 'inbound', 'external', 'tom@becker.example', 'Tom Becker', '["support@lumen.example"]', 'Can''t connect my custom domain', 'I added stats.becker.example as a custom domain but the dashboard still says "Domain not verified". What am I missing?', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 hours')),
  (5, 4, '<demo-5@lumen.example>', 'outbound', 'agent', 'support@lumen.example', 'Lumen Support', '["tom@becker.example"]', 'Re: Can''t connect my custom domain', 'Hi Tom,

Could you check that stats.becker.example has a CNAME record pointing to dashboards.lumen.example? New records can take a few minutes to propagate.

Best,
Lumen Support', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-150 minutes')),
  (6, 4, '<demo-6@becker.example>', 'inbound', 'external', 'tom@becker.example', 'Tom Becker', '["support@lumen.example"]', 'Re: Can''t connect my custom domain', 'That worked. The CNAME just needed a few minutes to propagate. Thanks!', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours')),
  (7, 5, '<demo-7@lindqvist.example>', 'inbound', 'external', 'sofia@lindqvist.example', 'Sofia Lindqvist', '["sales@lumen.example"]', 'Security questionnaire', 'Hello,

Attached is our vendor security questionnaire. Our review board meets next Thursday, so answers by Wednesday would be ideal.

Kind regards,
Sofia Lindqvist', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 hours')),
  (8, 6, '<demo-8@rivera.example>', 'inbound', 'external', 'alex@rivera.example', 'Alex Rivera', '["support@lumen.example"]', 'Feature request: export dashboards to CSV', 'Our finance team asks for a CSV export of the revenue dashboard every month. Right now I copy the numbers by hand. Is an export on the roadmap?', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 hours')),
  (9, 7, '<demo-9@park.example>', 'inbound', 'external', 'lena@park.example', 'Lena Park', '["hello@fieldnotes.example"]', 'Loved issue #42', 'The piece on onboarding checklists was exactly what our team needed this week. We''re already rewriting ours. Thank you!', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 days'));

INSERT INTO thread_labels (thread_id, label_id) VALUES
  (1, 1),
  (2, 3),
  (3, 4),
  (5, 3),
  (6, 2);

INSERT INTO drafts (id, thread_id, text_body, created_by, agent_notes, playbook_id, source_inbound_message_id, status) VALUES
  (1, 1, 'Hi Maya,

Thanks for flagging this. I found two identical $49 charges three minutes apart and refunded the second one. It should appear on your statement within 5 to 10 business days.

Best,
Lumen Support', 'agent', 'Two identical $49 Pro plan charges on the same card, three minutes apart, for a single workspace. Matches the Duplicate charges playbook.', 1, 1, 'pending'),
  (2, 3, 'Hi Priya,

Thanks for thinking of Field Notes! Design systems at scale is a great fit for our readers. Could you send a short outline and two writing samples? We look for practical, first-hand pieces under 1,500 words.

Sam, Field Notes', 'agent', 'Guest post pitch from a design system lead. Following the Guest post pitches playbook.', 3, 3, 'pending');

INSERT INTO draft_runs (thread_id, inbound_message_id, status, attempt_count, draft_id, started_at, finished_at) VALUES
  (1, 1, 'ready', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-4 minutes'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 minutes')),
  (2, 2, 'generating', 1, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute'), NULL),
  (3, 3, 'ready', 1, 2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-38 minutes'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-37 minutes'));

INSERT INTO contacts (address, name, company, phone, notes, last_seen_at) VALUES
  ('maya@northwind.example', 'Maya Chen', 'Northwind', NULL, 'Pro plan since March.', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-4 minutes')),
  ('daniel@okafor.example', 'Daniel Okafor', 'Okafor Labs', '+1 555 0142', 'Evaluating 40 seats.', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-11 minutes')),
  ('priya@raman.example', 'Priya Raman', NULL, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-38 minutes')),
  ('tom@becker.example', 'Tom Becker', 'Becker Studio', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours')),
  ('sofia@lindqvist.example', 'Sofia Lindqvist', 'Lindqvist AB', NULL, 'Security review board meets Thursdays.', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 hours')),
  ('alex@rivera.example', 'Alex Rivera', 'Rivera Finance', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 hours')),
  ('lena@park.example', 'Lena Park', NULL, NULL, 'Newsletter reader.', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 days'));

INSERT INTO blocked_senders (mailbox_id, kind, pattern, blocked_count, last_blocked_at) VALUES
  (NULL, 'domain', 'cheap-backlinks.example', 14, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-6 hours')),
  (3, 'address', 'promo@seo-growth.example', 3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'));
