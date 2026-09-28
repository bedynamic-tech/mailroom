-- Contacts can have more than one email address. Every address a Contact has,
-- its primary one included, is listed here; contacts.address stays the
-- primary address, used when composing to the Contact. Mail from any of a
-- Contact's addresses is matched to that Contact.
CREATE TABLE contact_addresses (
  address TEXT PRIMARY KEY COLLATE NOCASE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE
);

CREATE INDEX idx_contact_addresses_contact ON contact_addresses(contact_id);

-- Existing Contacts keep their current address as their primary one.
INSERT INTO contact_addresses (address, contact_id)
SELECT lower(address), id FROM contacts;

-- A Contact's primary address is always one of its addresses.
CREATE TRIGGER contacts_primary_address_insert AFTER INSERT ON contacts
BEGIN
  INSERT OR IGNORE INTO contact_addresses (address, contact_id) VALUES (lower(NEW.address), NEW.id);
END;

CREATE TRIGGER contacts_primary_address_update AFTER UPDATE OF address ON contacts
BEGIN
  INSERT OR IGNORE INTO contact_addresses (address, contact_id) VALUES (lower(NEW.address), NEW.id);
END;
