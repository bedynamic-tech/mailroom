import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  ContactFileError,
  MAX_CONTACT_IMPORT_BATCH,
  MAX_CONTACT_IMPORT_FILE_BYTES,
  parseContactFile,
  type ParsedContactFile,
} from "../../shared/contacts";
import type { ContactImportResult } from "../../shared/types";
import { fetchGeneralSettings, importContacts, setAutoCreateContacts } from "../api";
import { ContactsIcon } from "./Icons";
import {
  SettingsBlock,
  SettingsHeader,
  SettingsPage,
  SettingsPanel,
} from "./SettingsNavigation";

export function ContactSettings(props: {
  onBack: () => void;
  onOpenGeneral: () => void;
  onOpenInboxes: () => void;
  /** Opens the Contacts list itself. */
  onOpenContacts: () => void;
  onOpenAi: () => void;
}) {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ["settings", "general"],
    queryFn: fetchGeneralSettings,
  });
  const toggle = useMutation({
    mutationFn: setAutoCreateContacts,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["settings", "general"] }),
  });
  // Show the pending state while the switch request is in flight.
  const checked = toggle.isPending
    ? Boolean(toggle.variables)
    : Boolean(settings.data?.auto_create_contacts);

  return (
    <div className="flex h-full min-w-0 flex-col bg-canvas">
      <SettingsHeader
        active="contacts"
        onBack={props.onBack}
        onOpenGeneral={props.onOpenGeneral}
        onOpenInboxes={props.onOpenInboxes}
        onOpenContacts={() => undefined}
        onOpenAi={props.onOpenAi}
      />

      <SettingsPage>
        <SettingsBlock
          id="contact-settings-heading"
          title="Contacts"
          description="Details about the people who email your inboxes, shared across the workspace."
          action={
            <Button variant="outline" size="sm" onClick={props.onOpenContacts}>
              <ContactsIcon className="h-3.5 w-3.5" />
              Manage contacts
            </Button>
          }
        >
          <SettingsPanel>
            <div className="flex items-start gap-4 px-4 py-4 sm:px-5">
              <div className="min-w-0 flex-1">
                <label
                  htmlFor="auto-create-contacts"
                  className="text-[13.5px] font-medium text-foreground"
                >
                  Automatically create new contacts
                </label>
                <p
                  id="auto-create-contacts-description"
                  className="mt-1 max-w-xl text-[13px] leading-5 text-muted-foreground"
                >
                  Adds a contact for each new sender whose name appears in their email. Senders
                  without a name, automated mail and your own inboxes are skipped. Existing
                  contacts stay up to date either way.
                </p>
                {toggle.isError && (
                  <p className="mt-2 text-xs leading-5 text-destructive" role="alert">
                    {toggle.error instanceof Error
                      ? toggle.error.message
                      : "Couldn’t update this setting"}
                  </p>
                )}
              </div>
              <Switch
                id="auto-create-contacts"
                checked={checked}
                onCheckedChange={(value) => toggle.mutate(value)}
                disabled={settings.isLoading || settings.isError || toggle.isPending}
                aria-describedby="auto-create-contacts-description"
                className="mt-0.5"
              />
            </div>
          </SettingsPanel>
        </SettingsBlock>

        <ContactImport onOpenContacts={props.onOpenContacts} />
      </SettingsPage>
    </div>
  );
}

const count = (value: number, noun: string, plural = `${noun}s`) =>
  `${value.toLocaleString()} ${value === 1 ? noun : plural}`;

function ContactImport(props: { onOpenContacts: () => void }) {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; parsed: ParsedContactFile } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [progress, setProgress] = useState(0);

  const run = useMutation({
    mutationFn: async (parsed: ParsedContactFile) => {
      const total: ContactImportResult = { created: 0, updated: 0, skipped: 0, errors: [] };
      setProgress(0);
      // Large files go up in batches; a failed batch stops the import and
      // leaves the earlier batches in place, which a retry simply updates.
      for (let i = 0; i < parsed.contacts.length; i += MAX_CONTACT_IMPORT_BATCH) {
        const batch = parsed.contacts.slice(i, i + MAX_CONTACT_IMPORT_BATCH);
        const result = await importContacts(batch, overwrite);
        total.created += result.created;
        total.updated += result.updated;
        total.skipped += result.skipped;
        total.errors.push(...result.errors.slice(0, 20 - total.errors.length));
        setProgress(i + batch.length);
      }
      return total;
    },
    onSuccess: () => setFile(null),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["contacts"] }),
  });

  const choose = async (selected: File | undefined) => {
    if (fileInput.current) fileInput.current.value = "";
    if (!selected) return;
    run.reset();
    setFile(null);
    setFileError(null);
    if (selected.size > MAX_CONTACT_IMPORT_FILE_BYTES) {
      setFileError("This file is larger than 5 MB. Split it into smaller files and import each one.");
      return;
    }
    try {
      const parsed = parseContactFile(selected.name, await selected.text());
      if (parsed.contacts.length === 0) {
        setFileError("No contacts with an email address were found in this file.");
        return;
      }
      setFile({ name: selected.name, parsed });
    } catch (error) {
      setFileError(
        error instanceof ContactFileError ? error.message : "This file couldn’t be read.",
      );
    }
  };

  const ignored = file ? file.parsed.skipped + file.parsed.duplicates : 0;

  return (
    <SettingsBlock
      id="contact-import-heading"
      title="Import contacts"
      description="Add contacts from a CSV file (Google Contacts, Outlook or any file with an Email column) or a vCard file (.vcf) from Apple Contacts and most address books."
    >
      <SettingsPanel>
        <div className="px-4 py-4 sm:px-5">
          <input
            ref={fileInput}
            type="file"
            accept=".csv,.vcf,.vcard,text/csv,text/vcard,text/x-vcard"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => void choose(event.target.files?.[0])}
          />

          {!file && !run.isSuccess && (
            <Button
              variant="outline"
              size="sm"
              disabled={run.isPending}
              onClick={() => fileInput.current?.click()}
            >
              Choose file
            </Button>
          )}

          {fileError && (
            <p role="alert" className="mt-3 text-[13px] leading-5 text-destructive">
              {fileError}
            </p>
          )}

          {file && (
            <div>
              <p className="text-[13.5px] font-medium text-foreground">
                {count(file.parsed.contacts.length, "contact")} found in {file.name}
              </p>
              {ignored > 0 && (
                <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
                  {[
                    file.parsed.skipped > 0 &&
                      `${count(file.parsed.skipped, "entry", "entries")} without an email address`,
                    file.parsed.duplicates > 0 &&
                      `${count(file.parsed.duplicates, "repeated address", "repeated addresses")}`,
                  ]
                    .filter(Boolean)
                    .join(" and ")}{" "}
                  will be left out.
                </p>
              )}

              <ul className="mt-3 overflow-hidden rounded-lg border text-[13px]">
                {file.parsed.contacts.slice(0, 5).map((contact) => (
                  <li
                    key={contact.address}
                    className="flex min-w-0 gap-3 border-b px-3 py-2 last:border-b-0"
                  >
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {contact.name ?? contact.address}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {[contact.name ? contact.address : null, contact.company]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </li>
                ))}
                {file.parsed.contacts.length > 5 && (
                  <li className="px-3 py-2 text-muted-foreground">
                    and {count(file.parsed.contacts.length - 5, "more contact")}
                  </li>
                )}
              </ul>

              <div className="mt-4 flex items-start gap-2.5">
                <Checkbox
                  id="contact-import-overwrite"
                  checked={overwrite}
                  disabled={run.isPending}
                  onCheckedChange={(checked) => setOverwrite(checked === true)}
                  className="mt-0.5"
                />
                <label htmlFor="contact-import-overwrite" className="text-[13px] leading-5">
                  <span className="font-medium text-foreground">
                    Replace details of existing contacts
                  </span>
                  <span className="block text-muted-foreground">
                    When off, the file only fills in details a contact is missing.
                  </span>
                </label>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button size="sm" disabled={run.isPending} onClick={() => run.mutate(file.parsed)}>
                  {run.isPending
                    ? `Importing ${progress.toLocaleString()} of ${file.parsed.contacts.length.toLocaleString()}…`
                    : `Import ${count(file.parsed.contacts.length, "contact")}`}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={run.isPending}
                  onClick={() => {
                    setFile(null);
                    run.reset();
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {run.isError && (
            <p role="alert" className="mt-3 text-[13px] leading-5 text-destructive">
              {run.error instanceof Error ? run.error.message : "The import failed."}
              {progress > 0 &&
                ` ${count(progress, "contact")} ${progress === 1 ? "was" : "were"} imported before it stopped; importing the file again is safe.`}
            </p>
          )}

          {run.isSuccess && (
            <div role="status" className="mt-3 text-[13px] leading-5">
              <p className="text-foreground">
                Added {count(run.data.created, "new contact")}
                {run.data.updated > 0 &&
                  ` and ${overwrite ? "updated" : "matched"} ${count(run.data.updated, "existing contact")}`}
                .{" "}
                <Button variant="link" className="h-auto p-0 text-[13px]" onClick={props.onOpenContacts}>
                  View contacts
                </Button>
              </p>
              {run.data.skipped > 0 && (
                <>
                  <p className="mt-1 text-muted-foreground">
                    {count(run.data.skipped, "entry", "entries")} skipped:
                  </p>
                  <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                    {run.data.errors.map((error, index) => (
                      <li key={index}>
                        {error.address || "(blank)"}: {error.error}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => {
                  run.reset();
                  fileInput.current?.click();
                }}
              >
                Import another file
              </Button>
            </div>
          )}
        </div>
      </SettingsPanel>
    </SettingsBlock>
  );
}
