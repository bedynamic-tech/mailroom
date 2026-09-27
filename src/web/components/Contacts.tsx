import { useDeferredValue, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SquarePen } from "lucide-react";
import type { Contact, ContactDetail } from "../../shared/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  ApiError,
  CONTACT_PAGE_SIZE,
  createContact,
  deleteContact,
  fetchContact,
  fetchContacts,
  updateContact,
  type ContactCursor,
} from "../api";
import { formatTime } from "../lib";
import { EmailAvatar } from "./EmailAvatar";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  ContactsIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
  XIcon,
} from "./Icons";

interface ContactForm {
  name: string;
  company: string;
  phone: string;
  notes: string;
}

const EMPTY_FORM: ContactForm = { name: "", company: "", phone: "", notes: "" };

function formOf(contact: Contact): ContactForm {
  return {
    name: contact.name ?? "",
    company: contact.company ?? "",
    phone: contact.phone ?? "",
    notes: contact.notes ?? "",
  };
}

export function Contacts(props: {
  contactId: number | null;
  creating: boolean;
  onSelect: (id: number, options?: { replace?: boolean }) => void;
  onNew: () => void;
  onCloseDetail: () => void;
  onBack: () => void;
  onCompose: (address: string) => void;
  onOpenConversation: (id: number, archived: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const contacts = useInfiniteQuery({
    queryKey: ["contacts", "list", deferredSearch],
    queryFn: ({ pageParam }) => fetchContacts(deferredSearch, pageParam),
    initialPageParam: null as ContactCursor | null,
    getNextPageParam: (lastPage) => {
      const last = lastPage.at(-1);
      return !last || lastPage.length < CONTACT_PAGE_SIZE
        ? undefined
        : { at: last.last_seen_at ?? last.created_at, id: last.id };
    },
  });
  const rows = contacts.data?.pages.flat() ?? [];
  const detailOpen = props.creating || props.contactId !== null;

  return (
    <div className="flex h-full min-w-0">
      <section
        aria-label="Contacts"
        className={`w-full shrink-0 flex-col border-r bg-background md:w-[368px] xl:w-[400px] ${
          detailOpen ? "hidden md:flex" : "flex"
        }`}
      >
        <header className="border-b px-4 pt-3.5 pb-3">
          <div className="mb-3 flex h-8 items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={props.onBack}
              className="-ml-1.5 lg:hidden"
              aria-label="Back to inbox"
            >
              <ArrowLeftIcon className="h-5 w-5" />
            </Button>
            <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.015em] text-foreground">
              Contacts
            </h1>
            <Button variant="outline" size="sm" onClick={props.onNew}>
              <PlusIcon className="h-3.5 w-3.5" />
              New contact
            </Button>
          </div>
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setSearch("");
                  event.currentTarget.blur();
                }
              }}
              placeholder="Search by name, email or company"
              aria-label="Search contacts"
              className="h-10 w-full bg-muted/50 pr-9 pl-8.5 text-base focus-visible:bg-background md:h-9 md:text-[13px]"
            />
            {search && (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setSearch("")}
                className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground"
                aria-label="Clear search"
              >
                <XIcon className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {contacts.isLoading && <ContactListSkeleton />}
          {contacts.isError && (
            <ListState title="Couldn’t load contacts" detail="Check your connection and try again." />
          )}
          {!contacts.isLoading && !contacts.isError && rows.length === 0 && (
            <ListState
              title={deferredSearch ? "No matching contacts" : "No contacts yet"}
              detail={
                deferredSearch
                  ? "Try a name, email address or company."
                  : "Named senders who email your inboxes are added automatically. Change this in Settings."
              }
            />
          )}
          {rows.map((contact) => (
            <ContactRow
              key={contact.id}
              contact={contact}
              selected={props.contactId === contact.id}
              onClick={() => props.onSelect(contact.id)}
            />
          ))}
          {contacts.hasNextPage && (
            <div className="flex justify-center px-4 py-4">
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => contacts.fetchNextPage()}
                disabled={contacts.isFetchingNextPage}
              >
                {contacts.isFetchingNextPage ? "Loading…" : "Load more contacts"}
              </Button>
            </div>
          )}
        </div>
      </section>

      <div className={`min-w-0 flex-1 overflow-hidden ${detailOpen ? "block" : "hidden md:block"}`}>
        {props.creating ? (
          <NewContact
            onCancel={props.onCloseDetail}
            onCreated={(id) => props.onSelect(id, { replace: true })}
          />
        ) : props.contactId !== null ? (
          <ContactDetails
            key={props.contactId}
            contactId={props.contactId}
            onBack={props.onCloseDetail}
            onDeleted={props.onCloseDetail}
            onCompose={props.onCompose}
            onOpenConversation={props.onOpenConversation}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center bg-canvas px-6 pb-16 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-full border bg-background text-muted-foreground">
              <ContactsIcon className="h-5 w-5" />
            </span>
            <p className="mt-3 text-[13px] font-medium text-foreground">No contact selected</p>
            <p className="mt-1 max-w-64 text-[12.5px] leading-5 text-muted-foreground">
              Choose one from the list to see their details and conversations.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function ContactRow(props: { contact: Contact; selected: boolean; onClick: () => void }) {
  const { contact } = props;
  const title = contact.name ?? contact.address;
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-current={props.selected ? "true" : undefined}
      className={`flex w-full min-w-0 items-center gap-3 border-b border-border/70 px-4 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset ${
        props.selected ? "bg-accent" : "bg-background hover:bg-muted/60"
      }`}
    >
      <EmailAvatar email={contact.address} label={title} className="h-8 w-8 text-xs" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
            {title}
          </span>
          {contact.last_seen_at && (
            <time
              dateTime={contact.last_seen_at}
              title="Last email received"
              className="shrink-0 text-xs tabular-nums text-muted-foreground"
            >
              {formatTime(contact.last_seen_at)}
            </time>
          )}
        </span>
        <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">
          {[contact.name ? contact.address : null, contact.company].filter(Boolean).join(" · ") ||
            "No details yet"}
        </span>
      </span>
    </button>
  );
}

function NewContact(props: { onCancel: () => void; onCreated: (id: number) => void }) {
  const queryClient = useQueryClient();
  const [address, setAddress] = useState("");
  const [form, setForm] = useState<ContactForm>(EMPTY_FORM);
  const create = useMutation({
    mutationFn: () => createContact({ address, ...form }),
    onSuccess: (contact) => {
      queryClient.invalidateQueries({ queryKey: ["contacts"] });
      props.onCreated(contact.id);
    },
  });
  const existingId = (() => {
    const error = create.error;
    return error instanceof ApiError && error.status === 409 ? error.existingId : undefined;
  })();

  return (
    <DetailShell title="New contact" onBack={props.onCancel}>
      <form
        className="space-y-4"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <Field label="Email address">
          <Input
            type="email"
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              if (create.isError) create.reset();
            }}
            placeholder="person@example.com"
            autoComplete="off"
            autoFocus
            required
            aria-invalid={create.isError}
          />
        </Field>
        <ContactFields form={form} onChange={setForm} />
        {create.isError && (
          <p role="alert" className="text-sm text-destructive">
            {create.error instanceof Error ? create.error.message : "Couldn’t add this contact"}
            {existingId !== undefined && (
              <>
                {" "}
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-sm"
                  onClick={() => props.onCreated(existingId)}
                >
                  Open it
                </Button>
              </>
            )}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={create.isPending || !address.trim()}>
            {create.isPending ? "Adding…" : "Add contact"}
          </Button>
          <Button type="button" variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </DetailShell>
  );
}

function ContactDetails(props: {
  contactId: number;
  onBack: () => void;
  onDeleted: () => void;
  onCompose: (address: string) => void;
  onOpenConversation: (id: number, archived: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ["contacts", "detail", props.contactId],
    queryFn: () => fetchContact(props.contactId),
  });
  const contact = detail.data?.contact;
  const [form, setForm] = useState<ContactForm>(EMPTY_FORM);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (contact) setForm(formOf(contact));
  }, [contact]);

  const save = useMutation({
    mutationFn: () => updateContact(props.contactId, form),
    onSuccess: (updated) => {
      queryClient.setQueryData<ContactDetail>(
        ["contacts", "detail", props.contactId],
        (current) => (current ? { ...current, contact: updated } : current),
      );
      queryClient.invalidateQueries({ queryKey: ["contacts", "list"] });
      queryClient.invalidateQueries({ queryKey: ["contacts", "suggest"] });
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteContact(props.contactId),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["contacts", "detail", props.contactId] });
      queryClient.invalidateQueries({ queryKey: ["contacts"] });
      props.onDeleted();
    },
  });

  if (detail.isLoading) {
    return (
      <DetailShell title="Contact" onBack={props.onBack}>
        <p role="status" className="text-sm text-muted-foreground">Loading contact…</p>
      </DetailShell>
    );
  }
  if (!detail.data || !contact) {
    return (
      <DetailShell title="Contact" onBack={props.onBack}>
        <p role="alert" className="text-sm text-muted-foreground">
          {detail.error instanceof ApiError && detail.error.status === 404
            ? "This contact no longer exists."
            : "Couldn’t load this contact."}
        </p>
      </DetailShell>
    );
  }

  const dirty = JSON.stringify(form) !== JSON.stringify(formOf(contact));
  const title = contact.name ?? contact.address;

  return (
    <DetailShell
      title={title}
      onBack={props.onBack}
      actions={
        <Button variant="outline" size="sm" onClick={() => props.onCompose(contact.address)}>
          <SquarePen className="h-3.5 w-3.5" />
          Email
        </Button>
      }
    >
      <div className="flex items-center gap-3">
        <EmailAvatar email={contact.address} label={title} className="h-11 w-11 text-base" />
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold text-foreground">{title}</p>
          <p className="truncate text-[13px] text-muted-foreground">{contact.address}</p>
        </div>
      </div>

      <form
        className="mt-6 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <ContactFields form={form} onChange={(next) => { setForm(next); if (save.isSuccess) save.reset(); }} />
        {save.isError && (
          <p role="alert" className="text-sm text-destructive">
            {save.error instanceof Error ? save.error.message : "Couldn’t save this contact"}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={!dirty || save.isPending}>
            {save.isPending ? "Saving…" : "Save changes"}
          </Button>
          {dirty && (
            <Button type="button" variant="ghost" onClick={() => setForm(formOf(contact))}>
              Discard
            </Button>
          )}
          {!dirty && save.isSuccess && (
            <span role="status" className="text-[13px] text-muted-foreground">Saved</span>
          )}
        </div>
      </form>

      <section aria-labelledby="contact-conversations" className="mt-10">
        <h2 id="contact-conversations" className="text-sm font-semibold text-foreground">
          Conversations
          {detail.data.conversation_count > 0 && (
            <span className="ml-2 font-normal tabular-nums text-muted-foreground">
              {detail.data.conversation_count}
            </span>
          )}
        </h2>
        {detail.data.conversations.length === 0 ? (
          <p className="mt-2 text-[13px] text-muted-foreground">
            No email from this address yet.
          </p>
        ) : (
          <ul className="mt-3 overflow-hidden rounded-xl border bg-background">
            {detail.data.conversations.map((conversation) => (
              <li key={conversation.id} className="border-b last:border-b-0">
                <button
                  type="button"
                  onClick={() =>
                    props.onOpenConversation(conversation.id, conversation.status === "archived")
                  }
                  className="flex w-full min-w-0 items-center gap-3 px-4 py-2.5 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-foreground">
                      {conversation.subject || "(no subject)"}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {conversation.mailbox_address}
                    </span>
                  </span>
                  {conversation.status === "archived" && (
                    <Badge
                      variant="outline"
                      className="h-5 shrink-0 gap-1 rounded-md px-1.5 text-[11px] font-normal text-muted-foreground"
                    >
                      <ArchiveIcon className="h-3 w-3" />
                      Archived
                    </Badge>
                  )}
                  <time
                    dateTime={conversation.last_message_at}
                    className="shrink-0 text-xs tabular-nums text-muted-foreground"
                  >
                    {formatTime(conversation.last_message_at)}
                  </time>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="contact-delete" className="mt-10 border-t pt-6">
        <h2 id="contact-delete" className="sr-only">Delete contact</h2>
        {confirmDelete ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[13px] text-foreground">
              Delete this contact? Their conversations stay; if they email again, they’re added back.
            </p>
            <Button
              variant="destructive"
              size="sm"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? "Deleting…" : "Delete"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => setConfirmDelete(true)}
          >
            <TrashIcon className="h-3.5 w-3.5" />
            Delete contact
          </Button>
        )}
        {remove.isError && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {remove.error instanceof Error ? remove.error.message : "Couldn’t delete this contact"}
          </p>
        )}
      </section>
    </DetailShell>
  );
}

function ContactFields(props: { form: ContactForm; onChange: (form: ContactForm) => void }) {
  const set = (field: keyof ContactForm) => (value: string) =>
    props.onChange({ ...props.form, [field]: value });
  return (
    <>
      <Field label="Name">
        <Input value={props.form.name} maxLength={120} onChange={(e) => set("name")(e.target.value)} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Company">
          <Input
            value={props.form.company}
            maxLength={120}
            onChange={(e) => set("company")(e.target.value)}
          />
        </Field>
        <Field label="Phone">
          <Input
            type="tel"
            value={props.form.phone}
            maxLength={40}
            onChange={(e) => set("phone")(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Notes">
        <Textarea
          value={props.form.notes}
          maxLength={4000}
          rows={4}
          placeholder="Anything your team should know about this person"
          onChange={(e) => set("notes")(e.target.value)}
        />
      </Field>
    </>
  );
}

function DetailShell(props: {
  title: string;
  onBack: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-w-0 flex-col bg-canvas">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4 md:px-8">
        <Button
          variant="ghost"
          size="icon"
          onClick={props.onBack}
          className="-ml-1.5 md:hidden"
          aria-label="Back to contacts"
        >
          <ArrowLeftIcon className="h-5 w-5" />
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.015em] text-foreground">
          {props.title}
        </h2>
        {props.actions}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="w-full max-w-[640px] px-4 py-6 md:px-8 md:py-8">{props.children}</div>
      </div>
    </div>
  );
}

function Field(props: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-[13px] font-medium text-foreground">{props.label}</span>
      <span className="mt-1.5 block">{props.children}</span>
    </label>
  );
}

function ListState(props: { title: string; detail?: string }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <ContactsIcon className="h-[18px] w-[18px]" />
      </span>
      <p className="mt-3 text-[13px] font-medium text-foreground">{props.title}</p>
      {props.detail && (
        <p className="mt-1 max-w-60 text-[12.5px] leading-5 text-muted-foreground">{props.detail}</p>
      )}
    </div>
  );
}

function ContactListSkeleton() {
  return (
    <div aria-label="Loading contacts" aria-busy="true">
      {[0, 1, 2, 3, 4].map((item) => (
        <div key={item} className="flex animate-pulse items-center gap-3 border-b border-border/70 px-4 py-3.5">
          <span className="h-8 w-8 shrink-0 rounded-full bg-muted" />
          <span className="min-w-0 flex-1 space-y-2">
            <span className="block h-3 w-2/5 rounded bg-muted" />
            <span className="block h-2.5 w-3/5 rounded bg-muted/70" />
          </span>
        </div>
      ))}
    </div>
  );
}
