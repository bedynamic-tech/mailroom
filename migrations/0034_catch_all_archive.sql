-- A Domain's catch-all can file the mail it catches straight into the
-- Archive, read and without notifications, instead of leaving it open.
ALTER TABLE domains ADD COLUMN catch_all_archive INTEGER NOT NULL DEFAULT 0
  CHECK (catch_all_archive IN (0, 1));
