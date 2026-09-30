import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Reply } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  addThreadNote,
  archiveThread,
  blockThreadSender,
  createDraft,
  deleteThread,
  deleteThreadNote,
  discardDraft,
  fetchGeneralSettings,
  fetchMailboxes,
  fetchThread,
  markRead,
  retryDraftRun,
  saveReplyRecipients,
  sendReply,
  unarchiveThread,
} from "../api";
import type { Draft, Message, ThreadDetail, ThreadNote } from "../../shared/types";
import { MAX_RECIPIENTS_PER_MESSAGE } from "../../shared/email-limits";
import { replyAllRecipients } from "../../shared/recipients";
import {
  deriveAgentDraftStatus,
  type AgentDraftStatus,
} from "../../shared/agent-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatTime, splitQuotedTail } from "../lib";
import { EmailAvatar } from "./EmailAvatar";
import { EmailHtmlBody } from "./EmailHtmlBody";
import { defaultDarkAppearance, type EmailAppearance } from "../email-html";
import { inlineAttachmentIds } from "../inline-images";
import { useResolvedTheme } from "../theme";
import { useStickToBottom } from "../use-stick-to-bottom";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  ChevronUpIcon,
  ContrastIcon,
  InboxIcon,
  MoreIcon,
  NoteIcon,
  PaperclipIcon,
  SendIcon,
  PlusIcon,
  ShieldBanIcon,
  SparklesIcon,
  TagIcon,
  TrashIcon,
  XIcon,
} from "./Icons";
import { DeleteConversationsDialog } from "./DeleteConversationsDialog";
import { BlockSenderDialog } from "./BlockSenderDialog";
import { CatchAllBadge } from "./CatchAllBadge";
import { DeliveryStatus } from "./DeliveryStatus";
import { BlockAddressDialog, CreateInboxFromAddressDialog } from "./CatchAllDialogs";
import { LinkifiedText } from "./LinkifiedText";
import { RecipientInput, type RecipientInputHandle } from "./RecipientInput";
import {
  parseReplyRecipients,
  serializeReplyRecipients,
} from "../../shared/reply-recipients";
import { RichTextEditor, RichTextPreview } from "./RichTextEditor";
import { firstNameFrom, replyGreetingHtml, replyGreetingLine } from "../../shared/reply-greeting";
import {
  isBlankRichText,
  plainTextToHtml,
  richTextToPlainText,
  sanitizeRichText,
} from "../../shared/rich-text";

export function ThreadView(props: {
  threadId: number;
  deferMarkRead?: boolean;
  onBack: () => void;
  onMoved: () => void;
}) {
  const queryClient = useQueryClient();
  const [replyText, setReplyText] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  // null until the To field is edited, so it keeps following the latest inbound reply target.
  const [replyToEdit, setReplyToEdit] = useState<string[] | null>(null);
  const [replyCc, setReplyCc] = useState<string[]>([]);
  const [replyBcc, setReplyBcc] = useState<string[]>([]);
  // The recipients last saved on the Conversation; undefined until they are loaded.
  const savedRecipients = useRef<string | null | undefined>(undefined);
  const pendingRecipientSaves = useRef(0);
  // Cc/Bcc rows stay collapsed unless they hold an address or are being filled in.
  const [addingCc, setAddingCc] = useState(false);
  const [addingBcc, setAddingBcc] = useState(false);
  const [sendNotice, setSendNotice] = useState<string | null>(null);
  const [failedAttemptKey, setFailedAttemptKey] = useState<string | null>(null);
  const [usedDraftId, setUsedDraftId] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [blocking, setBlocking] = useState<{ sender: string; options: BlockCandidate[] } | null>(null);
  const [creatingInbox, setCreatingInbox] = useState(false);
  const [blockingAddress, setBlockingAddress] = useState(false);
  const navigate = useNavigate();
  const seenDraftIds = useRef(new Set<number>());
  const blockArchivesThis = useRef(false);
  const markedRead = useRef<number | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const replyFormRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ccInputRef = useRef<HTMLInputElement>(null);
  const bccInputRef = useRef<HTMLInputElement>(null);
  const toField = useRef<RecipientInputHandle>(null);
  const ccField = useRef<RecipientInputHandle>(null);
  const bccField = useRef<RecipientInputHandle>(null);
  const attemptIds = useRef(new Map<string, { text: string; id: string }>());
  // The Reply greeting line in the reply box: undefined until one is added (or
  // the user starts writing first), null once the user takes over the text.
  const insertedGreeting = useRef<string | null | undefined>(undefined);

  // Own Inbox addresses are never copied on Reply all.
  const mailboxes = useQuery({ queryKey: ["mailboxes"], queryFn: fetchMailboxes });

  const generalSettings = useQuery({
    queryKey: ["settings", "general"],
    queryFn: fetchGeneralSettings,
  });

  const detail = useQuery({
    queryKey: ["thread", props.threadId],
    queryFn: () => fetchThread(props.threadId),
    refetchInterval: (query) => {
      const status = query.state.data?.draft_run?.status;
      return status === "queued" || status === "generating" ? 3_000 : 30_000;
    },
  });

  const markThreadRead = useCallback(() => {
    if (markedRead.current === props.threadId) return;
    markedRead.current = props.threadId;
    markRead(props.threadId).then(() => {
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
    });
  }, [props.threadId, queryClient]);

  useEffect(() => {
    if (!props.deferMarkRead) markThreadRead();
  }, [props.deferMarkRead, markThreadRead]);

  useEffect(() => {
    setReplyText("");
    setPendingFiles([]);
    setReplyToEdit(null);
    setReplyCc([]);
    setReplyBcc([]);
    savedRecipients.current = undefined;
    setAddingCc(false);
    setAddingBcc(false);
    setSendNotice(null);
    setFailedAttemptKey(null);
    setUsedDraftId(null);
    addNote.reset();
    removeNote.reset();
    seenDraftIds.current.clear();
    attemptIds.current.clear();
    insertedGreeting.current = undefined;
  }, [props.threadId]);

  // Edited recipients are saved on the Conversation, so they follow the user
  // across devices, reloads and sends. Declared before the load below, so the
  // render that loads them never saves the empty defaults over them.
  useEffect(() => {
    if (savedRecipients.current === undefined) return;
    const recipients = { to: replyToEdit, cc: replyCc, bcc: replyBcc };
    const serialized = serializeReplyRecipients(recipients);
    if (serialized === savedRecipients.current) return;
    const previous = savedRecipients.current;
    savedRecipients.current = serialized;
    // Keep the cached Conversation current, so reopening it shows these right away.
    queryClient.setQueryData<ThreadDetail>(["thread", props.threadId], (current) =>
      current ? { ...current, thread: { ...current.thread, reply_recipients: serialized } } : current,
    );
    pendingRecipientSaves.current += 1;
    saveReplyRecipients(props.threadId, recipients)
      .catch(() => {
        // Retry with the next edit.
        if (savedRecipients.current === serialized) savedRecipients.current = previous;
      })
      .finally(() => {
        pendingRecipientSaves.current -= 1;
        queryClient.invalidateQueries({ queryKey: ["thread", props.threadId] });
      });
  }, [props.threadId, queryClient, replyToEdit, replyCc, replyBcc]);

  // Picks up recipients saved on another device, unless a save from here is still in flight.
  const storedRecipients = detail.data?.thread.reply_recipients;
  useEffect(() => {
    if (storedRecipients === undefined || pendingRecipientSaves.current > 0) return;
    const saved = parseReplyRecipients(storedRecipients);
    const serialized = serializeReplyRecipients(saved);
    if (serialized === savedRecipients.current) return;
    savedRecipients.current = serialized;
    setReplyToEdit(saved.to);
    setReplyCc(saved.cc);
    setReplyBcc(saved.bcc);
  }, [storedRecipients]);

  const replyCollapsed = useCollapseReplyOnScroll(
    conversationRef,
    replyFormRef,
    props.threadId,
    Boolean(detail.data),
  );

  useStickToBottom(
    conversationRef,
    props.threadId,
    Boolean(detail.data),
    (detail.data?.messages.length ?? 0) + (detail.data?.notes.length ?? 0),
  );

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["thread", props.threadId] });
    queryClient.invalidateQueries({ queryKey: ["threads"] });
    queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
  };

  const reply = useMutation({
    mutationFn: (args: {
      text: string;
      html: string;
      attemptId: string;
      attemptKey: string;
      draftId?: number;
      files?: File[];
      to: string[];
      cc: string[];
      bcc: string[];
    }) =>
      sendReply(
        props.threadId,
        args.text,
        args.attemptId,
        args.draftId,
        args.files ?? [],
        { to: args.to, cc: args.cc, bcc: args.bcc },
        args.html,
      ),
    onSuccess: (result, args) => {
      // Recipients stay as sent, so the next reply goes to the same people.
      if (result.status === "sent") {
        setReplyText("");
        insertedGreeting.current = undefined;
        setPendingFiles([]);
        setAddingCc(false);
        setAddingBcc(false);
        setUsedDraftId(null);
      }
      setFailedAttemptKey(null);
      setSendNotice(
        result.status === "sending"
          ? "The provider accepted this send request, but confirmation is still pending. It will not be sent again automatically."
          : null,
      );
      invalidateAll();
    },
    onError: (_error, args) => setFailedAttemptKey(args.attemptKey),
  });

  // Internal Notes stay in the workspace: they are saved apart from the reply
  // and never sent, so the composer's recipients and attachments stay put.
  const addNote = useMutation({
    mutationFn: (args: { text: string; html: string }) =>
      addThreadNote(props.threadId, args.text, args.html),
    onSuccess: (_note, args) => {
      setReplyText((current) => {
        if (sanitizeRichText(current) !== args.html) return current;
        insertedGreeting.current = undefined;
        return "";
      });
      setUsedDraftId(null);
      queryClient.invalidateQueries({ queryKey: ["thread", props.threadId] });
    },
  });

  const removeNote = useMutation({
    mutationFn: (noteId: number) => deleteThreadNote(props.threadId, noteId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["thread", props.threadId] }),
  });

  const discard = useMutation({
    mutationFn: (draftId: number) => discardDraft(draftId),
    onSuccess: (_result, draftId) => {
      seenDraftIds.current.add(draftId);
      setReplyText("");
      insertedGreeting.current = undefined;
      setUsedDraftId(null);
      invalidateAll();
    },
  });

  const moveThread = useMutation({
    mutationFn: (action: "archive" | "unarchive") =>
      action === "archive" ? archiveThread(props.threadId) : unarchiveThread(props.threadId),
    onSuccess: () => {
      invalidateAll();
      props.onMoved();
    },
  });

  const removeThread = useMutation({
    mutationFn: () => deleteThread(props.threadId),
    onSuccess: () => {
      setConfirmDelete(false);
      queryClient.removeQueries({ queryKey: ["thread", props.threadId] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
      props.onMoved();
    },
  });

  const retryDraft = useMutation({
    mutationFn: (runId: number) => retryDraftRun(runId),
    onSuccess: invalidateAll,
  });

  const startDraft = useMutation({
    mutationFn: () => createDraft(props.threadId),
    onSuccess: invalidateAll,
  });

  const draft = detail.data?.drafts.at(-1) ?? null;

  // undefined while the settings or Conversation are loading; null for no greeting.
  const greeting =
    generalSettings.data && detail.data
      ? generalSettings.data.reply_greeting_enabled
        ? replyGreetingLine(
            generalSettings.data.reply_greeting_template,
            recipientFirstName(detail.data, replyToEdit ?? defaultReplyTargets(detail.data.messages)),
          )
        : null
      : undefined;
  const replyPlainText = richTextToPlainText(replyText);
  // True while the reply box holds nothing the user wrote: empty, or only the greeting.
  const replyUntouched =
    replyPlainText === "" ||
    (typeof insertedGreeting.current === "string" && replyPlainText === insertedGreeting.current);
  const replyEmpty = isBlankRichText(replyText) || (Boolean(greeting) && replyPlainText === greeting);

  // Starts the reply box with the Reply greeting, and keeps it matching the To
  // recipient until the user edits it. Text the user wrote is never replaced.
  useEffect(() => {
    if (greeting === undefined || reply.isPending) return;
    const inserted = insertedGreeting.current;
    const current = richTextToPlainText(replyText);
    if (inserted === null) return;
    if (inserted === undefined) {
      if (!greeting || current !== "") return;
    } else if (current !== inserted || greeting === inserted) {
      if (current !== inserted) insertedGreeting.current = null;
      return;
    }
    insertedGreeting.current = greeting ?? undefined;
    setReplyText(greeting ? replyGreetingHtml(greeting) : "");
  }, [greeting, replyText, reply.isPending]);

  useEffect(() => {
    if (!draft || seenDraftIds.current.has(draft.id)) return;
    // Consider each draft once: polling must not restore text the user cleared
    // or replace a reply they were already writing when the draft arrived. A
    // reply holding only the greeting is replaced, as the draft has its own.
    seenDraftIds.current.add(draft.id);
    if (!replyUntouched || reply.isPending || discard.isPending) return;
    insertedGreeting.current = null;
    setReplyText(plainTextToHtml(draft.text_body));
    setUsedDraftId(draft.id);
  }, [draft, replyUntouched, reply.isPending, discard.isPending]);

  if (detail.isLoading) return <ThreadViewSkeleton onBack={props.onBack} />;

  if (detail.isError || !detail.data) {
    return (
      <div className="flex h-full flex-col bg-canvas">
        <div className="flex h-16 items-center border-b bg-background px-4 md:hidden">
          <Button
            variant="ghost"
            size="icon"
            onClick={props.onBack}
            className="-ml-1"
            aria-label="Back to conversations"
          >
            <ArrowLeftIcon className="h-5 w-5" />
          </Button>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center px-6 pb-16 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <InboxIcon className="h-[18px] w-[18px]" />
          </span>
          <p className="mt-3 text-sm font-medium text-foreground">Couldn’t open this conversation</p>
          <p className="mt-1 text-xs text-muted-foreground">
            It may have been archived or deleted, or the connection dropped.
          </p>
          <Button variant="outline" onClick={() => detail.refetch()} className="mt-4">
            Try again
          </Button>
        </div>
      </div>
    );
  }

  const { thread, messages, drafts, notes } = detail.data;
  const timeline = conversationTimeline(messages, notes);
  const ownAddresses = new Set(
    [
      thread.mailbox_address,
      thread.catch_all_recipient,
      ...(mailboxes.data ?? []).map((mailbox) => mailbox.address),
    ]
      .filter((address): address is string => Boolean(address))
      .map((address) => address.toLowerCase()),
  );
  const openBlockSender = (message: Message) => {
    const options = blockCandidatesFor(message, ownAddresses);
    if (options.length > 0) setBlocking({ sender: options[0].address, options });
  };
  const wroteConversation = (sender: string, kind: "address" | "domain") =>
    messages.some((message) => {
      if (message.direction !== "inbound") return false;
      const from = message.from_address.toLowerCase();
      if (kind === "address") return from === sender;
      const domain = sender.slice(sender.lastIndexOf("@") + 1);
      const fromDomain = from.slice(from.lastIndexOf("@") + 1);
      return fromDomain === domain || fromDomain.endsWith(`.${domain}`);
    });

  const agentStatus = deriveAgentDraftStatus({
    pendingDraftCount: drafts.length,
    runStatus: detail.data.draft_run?.status ?? null,
    agentMode: thread.mailbox_agent_mode,
    latestInboundIsAutomated: Boolean(thread.latest_inbound_is_auto_submitted),
    lastMessageDirection: thread.last_message_direction,
  });
  const draftError =
    startDraft.isError && startDraft.error instanceof Error
      ? startDraft.error.message
      : detail.data.draft_run?.error ?? null;

  // To starts as defaultReplyTargets and can be edited.
  const latestInbound = messages.filter((message) => message.direction === "inbound").at(-1);
  const inboundReplyTarget = defaultReplyTargets(messages);
  const replyTargets = replyToEdit ?? inboundReplyTarget;
  const copyCapacity =
    MAX_RECIPIENTS_PER_MESSAGE - replyTargets.length - replyCc.length - replyBcc.length;
  const lowered = (values: string[]) => values.map((value) => value.toLowerCase());
  const alreadyCopied = new Set(lowered([...replyCc, ...replyBcc]));
  const replyAllMissing = latestInbound
    ? replyAllRecipients({
        to: parseAddressList(latestInbound.to_addresses),
        cc: parseAddressList(latestInbound.cc_addresses),
        replyTargets,
        ownAddresses: [
          thread.mailbox_address,
          ...(thread.catch_all_recipient ? [thread.catch_all_recipient] : []),
          ...(mailboxes.data ?? []).map((mailbox) => mailbox.address),
        ],
      }).filter((address) => !alreadyCopied.has(address.toLowerCase()))
    : [];

  const replyMailbox = mailboxes.data?.find((mailbox) => mailbox.id === thread.mailbox_id);
  const replySignature = replyMailbox?.effective_signature_html
    ? replyMailbox.signature_mode === "custom"
      ? "Mailbox"
      : "Default"
    : null;

  const showCc = addingCc || replyCc.length > 0;
  const showBcc = addingBcc || replyBcc.length > 0;
  const openCopyRow = (row: "cc" | "bcc") => {
    (row === "cc" ? setAddingCc : setAddingBcc)(true);
    requestAnimationFrame(() => (row === "cc" ? ccInputRef : bccInputRef).current?.focus());
  };

  const replyAll = () => {
    setReplyCc((current) => [...current, ...replyAllMissing.slice(0, Math.max(0, copyCapacity))]);
  };

  const attemptFor = (key: string, text: string) => {
    const existing = attemptIds.current.get(key);
    if (existing?.text === text) return existing.id;
    const id = crypto.randomUUID();
    attemptIds.current.set(key, { text, id });
    return id;
  };

  const submitReply = () => {
    const html = isBlankRichText(replyText) ? "" : sanitizeRichText(replyText);
    const text = html ? richTextToPlainText(html) : "";
    if ((!replyEmpty || pendingFiles.length > 0) && !reply.isPending && !discard.isPending) {
      // Add any address still being typed; stop if one of them is invalid.
      const to = toField.current ? toField.current.commit() : replyTargets;
      const cc = ccField.current ? ccField.current.commit() : replyCc;
      const bcc = bccField.current ? bccField.current.commit() : replyBcc;
      if (!to || !cc || !bcc) return;
      if (to.length === 0) {
        setSendNotice("Add at least one To recipient.");
        return;
      }
      const fingerprint = `${html} ${pendingFiles.map((file) => `${file.name}:${file.size}`).join(",")} to:${to.join(",")} cc:${cc.join(",")} bcc:${bcc.join(",")}`;
      const attemptKey = usedDraftId === null ? "manual" : `draft-${usedDraftId}`;
      reply.mutate({
        text,
        html,
        files: pendingFiles,
        to,
        cc,
        bcc,
        draftId: usedDraftId ?? undefined,
        attemptId: attemptFor(attemptKey, fingerprint),
        attemptKey,
      });
    }
  };

  const submitNote = () => {
    if (replyEmpty || addNote.isPending || reply.isPending) return;
    const html = sanitizeRichText(replyText);
    addNote.mutate({ text: richTextToPlainText(html), html });
  };

  const applyDraft = (next: Draft) => {
    seenDraftIds.current.add(next.id);
    insertedGreeting.current = null;
    setReplyText(plainTextToHtml(next.text_body));
    setUsedDraftId(next.id);
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    setPendingFiles((current) => [...current, ...list].slice(0, 10));
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div
      className="relative flex h-full min-w-0 flex-col bg-canvas"
      onPointerDown={markThreadRead}
      onKeyDown={markThreadRead}
      onWheel={markThreadRead}
    >
      <header className="flex min-h-16 shrink-0 items-center gap-3 border-b bg-background px-4 py-2.5 md:px-6">
        <Button
          variant="ghost"
          size="icon"
          onClick={props.onBack}
          className="-ml-1 md:hidden"
          aria-label="Back to conversations"
        >
          <ArrowLeftIcon className="h-5 w-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <h1
            className="truncate text-base font-semibold tracking-[-0.015em] text-foreground"
            title={thread.subject || undefined}
          >
            {thread.subject || "(no subject)"}
          </h1>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">
              {thread.catch_all_recipient
                ? `${thread.catch_all_recipient} via ${thread.mailbox_address}`
                : thread.mailbox_address}
            </span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0 tabular-nums">
              {thread.message_count} {thread.message_count === 1 ? "message" : "messages"}
            </span>
            {thread.labels.length > 0 && (
              <span className="ml-1 hidden min-w-0 items-center gap-1 overflow-hidden sm:flex">
                {thread.labels.map((label) => (
                  <Badge
                    key={label.id}
                    variant="outline"
                    className="h-5 shrink-0 gap-1 rounded-md px-1.5 text-xs font-normal text-foreground/75"
                  >
                    <TagIcon className="h-3 w-3 text-muted-foreground" />
                    {label.name}
                  </Badge>
                ))}
              </span>
            )}
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              disabled={moveThread.isPending || removeThread.isPending}
              aria-label="Conversation options"
              title="More"
              className="shrink-0"
            >
              <MoreIcon className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            {thread.status === "archived" ? (
              <DropdownMenuItem onSelect={() => moveThread.mutate("unarchive")}>
                <InboxIcon />
                Move to inbox
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => moveThread.mutate("archive")}>
                <ArchiveIcon />
                Archive
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                removeThread.reset();
                setConfirmDelete(true);
              }}
            >
              <TrashIcon />
              Permanently delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DeleteConversationsDialog
          open={confirmDelete}
          title="Permanently delete this conversation?"
          description="This permanently deletes its messages, attachments, drafts, and notes. This can’t be undone."
          confirmLabel="Delete permanently"
          pending={removeThread.isPending}
          error={removeThread.error}
          onConfirm={() => removeThread.mutate()}
          onOpenChange={setConfirmDelete}
        />
      </header>

      {thread.catch_all_recipient && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground md:px-6">
          <p className="min-w-0 flex-1 basis-56">
            Sent to <span className="font-medium break-all text-foreground">{thread.catch_all_recipient}</span>,
            which has no inbox of its own.
          </p>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" className="h-7" onClick={() => setCreatingInbox(true)}>
              <PlusIcon className="h-3.5 w-3.5" />
              Create inbox
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-muted-foreground"
              onClick={() => setBlockingAddress(true)}
            >
              <ShieldBanIcon className="h-3.5 w-3.5" />
              Block address
            </Button>
          </div>
          <CreateInboxFromAddressDialog
            open={creatingInbox}
            address={thread.catch_all_recipient}
            onOpenChange={setCreatingInbox}
          />
          <BlockAddressDialog
            open={blockingAddress}
            address={thread.catch_all_recipient}
            onOpenChange={setBlockingAddress}
            onBlocked={props.onMoved}
          />
        </div>
      )}

      <div ref={conversationRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mr-auto w-full max-w-[1100px] px-4 py-5 sm:px-6 md:py-6">
          {timeline.map((entry, index) => (
            <Fragment key={`${entry.kind}-${entry.item.id}`}>
              {index > 0 && <MessageConnector />}
              {entry.kind === "note" ? (
                <NoteCard
                  note={entry.item}
                  deleting={removeNote.isPending && removeNote.variables === entry.item.id}
                  onDelete={() => removeNote.mutate(entry.item.id)}
                />
              ) : (
                <MessageCard
                  message={entry.item}
                  contactNames={detail.data.contact_names}
                  catchAllRecipient={thread.catch_all_recipient}
                  onBlockSender={
                    blockCandidatesFor(entry.item, ownAddresses).length > 0
                      ? () => openBlockSender(entry.item)
                      : undefined
                  }
                />
              )}
            </Fragment>
          ))}
        </div>
      </div>

      {blocking && (
        <BlockSenderDialog
          open
          sender={blocking.sender}
          senderOptions={blocking.options}
          scopes={[
            {
              value: "inbox",
              label: thread.mailbox_address,
              hint: "Only this inbox",
              target: thread.mailbox_address,
            },
            {
              value: "all",
              label: "All inboxes",
              hint: "Every inbox in this workspace",
              target: "any of your inboxes",
            },
          ]}
          archives
          wroteConversation={wroteConversation}
          onBlock={(kind, scope, sender) => {
            blockArchivesThis.current = wroteConversation(sender, kind);
            return blockThreadSender(props.threadId, kind, scope === "all" ? "all" : "inbox", sender);
          }}
          onOpenChange={(open) => !open && setBlocking(null)}
          onBlocked={() => {
            invalidateAll();
            if (blockArchivesThis.current) props.onMoved();
          }}
        />
      )}

      {replyCollapsed.collapsed && (
        <Button
          onClick={replyCollapsed.expand}
          aria-label="Reply"
          title="Reply"
          size="icon"
          className="absolute right-4 bottom-4 z-10 size-14 touch:size-14 rounded-full shadow-lg shadow-black/15 [&_svg:not([class*='size-'])]:size-5"
        >
          <Reply />
        </Button>
      )}
      <footer
        className={cn("shrink-0 bg-canvas pt-1 pb-3 sm:pb-5", replyCollapsed.collapsed && "hidden")}
      >
        <div ref={replyFormRef} className="mr-auto w-full max-w-[1100px] px-4 sm:px-6">
          <Card className="gap-0 py-0 shadow-[0_1px_2px_oklch(0.2_0.012_265/0.04),0_4px_16px_-6px_oklch(0.2_0.012_265/0.08)] transition-shadow focus-within:ring-foreground/25">
            <div className="border-b border-border/70 text-xs">
                <CopyRecipientsRow
                  label="To"
                  htmlFor="reply-to"
                  actions={
                    <>
                      {!showCc && (
                        <Button
                          variant="ghost"
                          size="xs"
                          className="text-muted-foreground"
                          aria-label="Add Cc recipients"
                          disabled={reply.isPending}
                          onClick={() => openCopyRow("cc")}
                        >
                          Cc
                        </Button>
                      )}
                      {!showBcc && (
                        <Button
                          variant="ghost"
                          size="xs"
                          className="text-muted-foreground"
                          aria-label="Add Bcc recipients"
                          disabled={reply.isPending}
                          onClick={() => openCopyRow("bcc")}
                        >
                          Bcc
                        </Button>
                      )}
                      {replyAllMissing.length > 0 && (
                        <Button
                          variant="ghost"
                          size="xs"
                          className="text-muted-foreground"
                          title={`Copy everyone on the last email: ${replyAllMissing.join(", ")}`}
                          disabled={reply.isPending || copyCapacity <= 0}
                          onClick={replyAll}
                        >
                          Reply all
                        </Button>
                      )}
                    </>
                  }
                >
                  <RecipientInput
                    ref={toField}
                    id="reply-to"
                    label="To"
                    values={replyTargets}
                    onChange={(values) => {
                      setReplyToEdit(values);
                      setSendNotice(null);
                    }}
                    capacity={copyCapacity}
                    taken={new Set(lowered([...replyCc, ...replyBcc]))}
                    disabled={reply.isPending}
                    placeholder="Add To recipients"
                    onSubmitShortcut={submitReply}
                  />
                </CopyRecipientsRow>
                {showCc && (
                  <CopyRecipientsRow label="Cc" htmlFor="reply-cc">
                    <RecipientInput
                      ref={ccField}
                      inputRef={ccInputRef}
                      id="reply-cc"
                      label="Cc"
                      values={replyCc}
                      onChange={setReplyCc}
                      capacity={copyCapacity}
                      taken={new Set(lowered([...replyTargets, ...replyBcc]))}
                      disabled={reply.isPending}
                      placeholder="Add Cc recipients"
                      onDismiss={() => setAddingCc(false)}
                      onSubmitShortcut={submitReply}
                    />
                  </CopyRecipientsRow>
                )}
                {showBcc && (
                  <CopyRecipientsRow label="Bcc" htmlFor="reply-bcc">
                    <RecipientInput
                      ref={bccField}
                      inputRef={bccInputRef}
                      id="reply-bcc"
                      label="Bcc"
                      values={replyBcc}
                      onChange={setReplyBcc}
                      capacity={copyCapacity}
                      taken={new Set(lowered([...replyTargets, ...replyCc]))}
                      disabled={reply.isPending}
                      placeholder="Add Bcc recipients"
                      onDismiss={() => setAddingBcc(false)}
                      onSubmitShortcut={submitReply}
                    />
                  </CopyRecipientsRow>
                )}
                {copyCapacity <= 0 && (
                  <p role="status" className="px-3.5 pb-2 text-muted-foreground">
                    This reply has reached the limit of {MAX_RECIPIENTS_PER_MESSAGE} recipients.
                  </p>
                )}
            </div>
            <RichTextEditor
              id={`reply-${props.threadId}`}
              value={replyText}
              disabled={reply.isPending || discard.isPending || addNote.isPending}
              onChange={(html) => {
                setReplyText(html);
                // Writing before the greeting was added keeps it out.
                if (insertedGreeting.current === undefined) insertedGreeting.current = null;
                if (isBlankRichText(html)) setUsedDraftId(null);
              }}
              caretToEndOnFocus={Boolean(greeting) && replyPlainText === greeting}
              onSubmitShortcut={submitReply}
              placeholder="Write a reply…"
              ariaLabel="Reply"
              variant="bare"
              contentClassName="max-h-[min(40dvh,320px)] min-h-[132px] px-3.5"
              toolbarEnd={
                <DraftAssistButton
                  status={agentStatus}
                  hasDraft={draft !== null}
                  busy={retryDraft.isPending || startDraft.isPending || discard.isPending}
                  disabled={reply.isPending}
                  error={draftError}
                  onStart={() => startDraft.mutate()}
                />
              }
              belowToolbar={
                <DraftAssist
                  status={agentStatus}
                  draft={draft}
                  usingDraft={draft !== null && usedDraftId === draft.id}
                  error={draftError}
                  busy={retryDraft.isPending || startDraft.isPending || discard.isPending}
                  disabled={reply.isPending}
                  onUse={() => draft && applyDraft(draft)}
                  onDiscard={() => draft && discard.mutate(draft.id)}
                  onRetry={() => {
                    if (detail.data.draft_run) retryDraft.mutate(detail.data.draft_run.id);
                  }}
                />
              }
            />
            {pendingFiles.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-3.5 pb-1" aria-label="Attachments to send">
                {pendingFiles.map((file, index) => (
                  <span
                    key={`${file.name}-${index}`}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-muted/40 py-1 pr-1 pl-2 text-xs text-foreground"
                  >
                    <PaperclipIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">{file.name}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {formatFileSize(file.size)}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      onClick={() =>
                        setPendingFiles((current) =>
                          current.filter((_, i) => i !== index),
                        )
                      }
                    >
                      <XIcon className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between gap-2 px-3 pb-3">
              <div className="flex min-w-0 items-center gap-3 pl-0.5 text-xs text-muted-foreground">
                {replySignature && (
                  <span className="min-w-0 truncate" title={`Signature: ${replySignature}`}>
                    <span className="text-foreground/70">Signature:</span> {replySignature}
                  </span>
                )}
                <span className="hidden shrink-0 items-center gap-1 sm:inline-flex">
                  <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
                  <Kbd>Enter</Kbd>
                  <span className="ml-0.5">to send</span>
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => addFiles(event.target.files)}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground"
                  aria-label="Attach files"
                  title="Attach files"
                  disabled={reply.isPending}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <PaperclipIcon className="h-4 w-4" />
                </Button>
                <div className="flex items-center">
                  <Button
                    onClick={submitReply}
                    disabled={
                      (replyEmpty && pendingFiles.length === 0) ||
                      reply.isPending ||
                      discard.isPending ||
                      addNote.isPending
                    }
                    className="rounded-r-none"
                  >
                    <SendIcon className="h-3.5 w-3.5" />
                    {reply.isPending ? "Sending…" : addNote.isPending ? "Adding note…" : "Send reply"}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon"
                        className="w-7 rounded-l-none border-l border-l-primary-foreground/20 touch:w-9"
                        aria-label="More send options"
                        title="More send options"
                        disabled={
                          replyEmpty ||
                          reply.isPending ||
                          discard.isPending ||
                          addNote.isPending
                        }
                      >
                        <ChevronUpIcon className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="top" align="end" className="min-w-56">
                      <DropdownMenuItem
                        disabled={replyEmpty}
                        onSelect={submitNote}
                        className="items-start"
                      >
                        <NoteIcon className="mt-0.5 text-amber-600 dark:text-amber-400" />
                        <span className="flex flex-col">
                          <span>Add internal note</span>
                          <span className="text-xs text-muted-foreground">
                            Only your team sees it. Nothing is sent.
                          </span>
                        </span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </div>
          </Card>
          {addNote.isError && (
            <p role="alert" className="mt-2 text-xs leading-5 text-destructive">
              {addNote.error instanceof Error ? addNote.error.message : "Couldn’t add the note."}
              {" "}Your text is still here. Try again.
            </p>
          )}
          {removeNote.isError && (
            <p role="alert" className="mt-2 text-xs leading-5 text-destructive">
              Couldn’t delete the note. Try again.
            </p>
          )}
          {discard.isError && (
            <p role="alert" className="mt-2 text-xs leading-5 text-destructive">
              Couldn’t discard the AI draft. Your text is still here. Try again.
            </p>
          )}
          {reply.isError && (
            <div
              role="alert"
              className="mt-2 flex items-center gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive"
            >
              <p className="min-w-0 flex-1">
                {reply.error instanceof Error ? reply.error.message : "The reply could not be sent."}
                {" "}Your text is still here. Check Email Logs before creating a new send attempt.
              </p>
              {failedAttemptKey && (
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 text-foreground"
                  onClick={() => {
                    attemptIds.current.delete(failedAttemptKey);
                    setFailedAttemptKey(null);
                    reply.reset();
                  }}
                >
                  New attempt
                </Button>
              )}
            </div>
          )}
          {sendNotice && (
            <div
              role="status"
              className="mt-2 rounded-lg border bg-background px-3 py-2 text-xs leading-5 text-muted-foreground"
            >
              {sendNotice}
            </div>
          )}
        </div>
      </footer>
    </div>
  );
}

/** Single-pane widths, where the conversation fills the screen. */
const SINGLE_PANE_QUERY = "(max-width: 767px)";
// Scrolls smaller than this are jitter, not the person reading back.
const SCROLL_UP_PX = 8;
const AT_BOTTOM_PX = 48;

/**
 * On phones, scrolling back through a conversation folds the reply form into a
 * round Reply button so the messages get the whole screen. The form stays
 * mounted, so a half-written reply is kept. It opens again from the button, or
 * when the person scrolls back down to the latest message. Scrolling up folds
 * it even while it has focus, since focus stays in the editor after the
 * keyboard is put away.
 */
function useCollapseReplyOnScroll(
  containerRef: React.RefObject<HTMLElement | null>,
  formRef: React.RefObject<HTMLElement | null>,
  resetKey: unknown,
  ready: boolean,
) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => setCollapsed(false), [resetKey]);

  useEffect(() => {
    const container = containerRef.current;
    if (!ready || !container) return;
    const query = window.matchMedia(SINGLE_PANE_QUERY);
    // iOS rubber-bands past either end, reporting a scrollTop outside the
    // scrollable range until the bounce settles. Clamping keeps the spring back
    // from a bottom overscroll from reading as the person scrolling up.
    const clampedTop = () =>
      Math.min(Math.max(container.scrollTop, 0), container.scrollHeight - container.clientHeight);
    let lastTop = clampedTop();
    let lastHeight = container.clientHeight;
    const onScroll = () => {
      const top = clampedTop();
      const delta = top - lastTop;
      lastTop = top;
      // A scroll caused by the view resizing (the keyboard opening, the form
      // folding or opening) is layout, not the person reading back.
      const resized = container.clientHeight !== lastHeight;
      lastHeight = container.clientHeight;
      if (!query.matches || resized) return;
      if (delta < -SCROLL_UP_PX) {
        const active = document.activeElement;
        if (active instanceof HTMLElement && formRef.current?.contains(active)) active.blur();
        setCollapsed(true);
      } else if (
        delta > 0 &&
        container.scrollHeight - container.clientHeight - top <= AT_BOTTOM_PX
      ) {
        setCollapsed(false);
      }
    };
    const onWidthChange = () => {
      if (!query.matches) setCollapsed(false);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    query.addEventListener("change", onWidthChange);
    return () => {
      container.removeEventListener("scroll", onScroll);
      query.removeEventListener("change", onWidthChange);
    };
  }, [containerRef, formRef, ready, resetKey]);

  const expand = () => {
    setCollapsed(false);
    requestAnimationFrame(() =>
      formRef.current?.querySelector<HTMLElement>("[contenteditable=true]")?.focus(),
    );
  };

  return { collapsed, expand };
}

function CopyRecipientsRow(props: {
  label: string;
  htmlFor: string;
  children: ReactNode;
  /** Controls at the right end of the row. */
  actions?: ReactNode;
}) {
  return (
    <div className={cn("flex items-start gap-2 pl-3.5", props.actions ? "pr-2" : "pr-3.5")}>
      {/* Label and actions share the height of the field's first line, so all three center on it. */}
      <label htmlFor={props.htmlFor} className="flex h-10 w-8 shrink-0 items-center text-muted-foreground md:h-[38px]">
        {props.label}
      </label>
      {props.children}
      {props.actions && <span className="flex h-10 shrink-0 items-center md:h-[38px]">{props.actions}</span>}
    </div>
  );
}

type BlockCandidate = { address: string; hint: string };

/** The external addresses on a Message that could be blocked, sender first. */
function blockCandidatesFor(message: Message, ownAddresses: Set<string>): BlockCandidate[] {
  const seen = new Set<string>();
  const candidates: BlockCandidate[] = [];
  const add = (address: string, hint: string) => {
    const normalized = address.trim().toLowerCase();
    if (!normalized.includes("@") || ownAddresses.has(normalized) || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push({ address: normalized, hint });
  };
  if (message.direction === "inbound") add(message.from_address, "Sender");
  for (const address of parseAddressList(message.to_addresses)) add(address, "To");
  for (const address of parseAddressList(message.cc_addresses)) add(address, "Cc");
  return candidates;
}

/**
 * Where a reply goes unless To is edited: the latest inbound Message's reply
 * target (see sendReplyAttempt). A Conversation started from Mailroom has no
 * inbound Message yet, so it follows up with the latest sent Message's To.
 */
function defaultReplyTargets(messages: Message[]): string[] {
  const latestInbound = messages.filter((message) => message.direction === "inbound").at(-1);
  if (latestInbound) {
    const replyTo = parseAddressList(latestInbound.reply_to_addresses);
    return replyTo.length ? replyTo : [latestInbound.from_address];
  }
  const latestOutbound = messages.filter((message) => message.direction === "outbound").at(-1);
  return latestOutbound ? parseAddressList(latestOutbound.to_addresses) : [];
}

/**
 * First name of the first To recipient for the Reply greeting: from their
 * Contact, else from the display name on their latest email here.
 */
function recipientFirstName(detail: ThreadDetail, to: string[]): string | null {
  const address = to[0]?.toLowerCase();
  if (!address) return null;
  const contactName = firstNameFrom(detail.contact_names?.[address]);
  if (contactName) return contactName;
  const sent = detail.messages
    .filter((message) => message.from_address.toLowerCase() === address && message.from_name)
    .at(-1);
  return firstNameFrom(sent?.from_name);
}

function parseAddressList(raw: string | null | undefined): string[] {
  try {
    const values = JSON.parse(raw || "[]") as unknown;
    return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

type TimelineEntry = { kind: "message"; item: Message } | { kind: "note"; item: ThreadNote };

/** Messages and Internal Notes in the order they were written. */
function conversationTimeline(messages: Message[], notes: ThreadNote[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...messages.map((item) => ({ kind: "message" as const, item })),
    ...notes.map((item) => ({ kind: "note" as const, item })),
  ];
  // Stable sort keeps each list's own order for equal timestamps.
  return entries.sort((a, b) => Date.parse(a.item.created_at) - Date.parse(b.item.created_at));
}

// Thin line in the gap between cards, centered under the sender avatar (card padding + half the h-9 avatar).
function MessageConnector() {
  return (
    <div aria-hidden="true" className="h-4 pl-[33.5px] sm:pl-[37.5px]">
      <div className="h-full w-px bg-border" />
    </div>
  );
}

function MessageCard({
  message,
  contactNames,
  catchAllRecipient,
  onBlockSender,
}: {
  message: Message;
  contactNames?: Record<string, string>;
  catchAllRecipient: string | null;
  onBlockSender?: () => void;
}) {
  const [showQuoted, setShowQuoted] = useState(false);
  const dark = useResolvedTheme() === "dark";
  const [chosenAppearance, setChosenAppearance] = useState<EmailAppearance | null>(null);
  const defaultAppearance = useMemo(
    () => (dark && message.html_body ? defaultDarkAppearance(message.html_body) : "original"),
    [dark, message.html_body],
  );
  const appearance: EmailAppearance = dark ? (chosenAppearance ?? defaultAppearance) : "original";
  const attachments = useMemo(() => {
    if (!message.html_body) return message.attachments;
    const inline = inlineAttachmentIds(message.html_body, message.attachments);
    return message.attachments.filter((attachment) => !inline.has(attachment.id));
  }, [message.attachments, message.html_body]);
  const isOutbound = message.direction === "outbound";
  // The Contact name is ours, so it wins over the name on the mail.
  const senderName =
    contactNames?.[message.from_address.toLowerCase()]?.trim() || message.from_name?.trim() || "";
  const displayName = senderName || message.from_address;
  const { main, quoted } = splitQuotedTail(message.text_body ?? "");
  const to = parseAddressList(message.to_addresses);
  const cc = parseAddressList(message.cc_addresses);
  const bcc = isOutbound ? parseAddressList(message.bcc_addresses) : [];
  const hasMenu = Boolean((dark && message.html_body) || onBlockSender);

  return (
    <Card className="gap-0 p-4 sm:p-5">
      <div className="mb-3 flex items-start gap-3">
        <EmailAvatar
          email={message.from_address}
          label={displayName}
          fallback={message.sent_by === "agent" ? <SparklesIcon className="h-4 w-4" /> : undefined}
          className={`h-9 w-9 text-sm ${isOutbound ? "bg-muted text-foreground/70" : ""}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-foreground">{displayName}</span>
            {message.sent_by === "agent" && <AuthorBadge tone="agent">Agent</AuthorBadge>}
            {isOutbound && message.sent_by === "human" && <AuthorBadge tone="human">You</AuthorBadge>}
            {!isOutbound && catchAllRecipient && <CatchAllBadge address={catchAllRecipient} />}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {isOutbound ? `to ${to.join(", ")}` : message.from_address}
          </div>
          {!isOutbound && to.length > 1 && (
            <div className="truncate text-xs text-muted-foreground" title={to.join(", ")}>
              to {to.join(", ")}
            </div>
          )}
          {cc.length > 0 && (
            <div className="truncate text-xs text-muted-foreground" title={cc.join(", ")}>
              cc {cc.join(", ")}
            </div>
          )}
          {bcc.length > 0 && (
            <div className="truncate text-xs text-muted-foreground" title={bcc.join(", ")}>
              bcc {bcc.join(", ")}
            </div>
          )}
        </div>
        <time
          dateTime={message.created_at}
          className="mt-0.5 shrink-0 text-[11px] tabular-nums sm:text-xs text-muted-foreground"
          title={new Date(message.created_at).toLocaleString()}
        >
          {formatTime(message.created_at)}
        </time>
        {hasMenu && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="-mt-0.5 -mr-1.5 text-muted-foreground"
                aria-label="Message options"
                title="More"
              >
                <MoreIcon className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {dark && message.html_body && (
                <>
                  <DropdownMenuItem
                    onSelect={() => setChosenAppearance(appearance === "dark" ? "original" : "dark")}
                  >
                    <ContrastIcon />
                    {appearance === "dark" ? "Show original colors" : "Show in dark colors"}
                  </DropdownMenuItem>
                  {onBlockSender && <DropdownMenuSeparator />}
                </>
              )}
              {onBlockSender && (
                <DropdownMenuItem variant="destructive" onSelect={onBlockSender}>
                  <ShieldBanIcon />
                  Block sender…
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {message.html_body ? (
        <EmailHtmlBody
          html={message.html_body}
          attachments={message.attachments}
          sender={displayName}
          appearance={appearance}
        />
      ) : (
        <div className="max-w-[72ch] break-words text-sm leading-6 whitespace-pre-wrap text-foreground touch:text-base">
          <LinkifiedText text={main} />
        </div>
      )}
      {attachments.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2" aria-label="Attachments">
          {attachments.map((attachment) => (
            <a
              key={attachment.id}
              href={`/api/attachments/${attachment.id}`}
              download={attachment.filename || undefined}
              className="inline-flex max-w-full items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <PaperclipIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">{attachment.filename || "Attachment"}</span>
              <span className="shrink-0 text-muted-foreground">{formatFileSize(attachment.size)}</span>
            </a>
          ))}
        </div>
      )}
      {!message.html_body && quoted && (
        <div className="mt-3">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setShowQuoted((visible) => !visible)}
            aria-expanded={showQuoted}
            className="-ml-2 text-muted-foreground"
          >
            {showQuoted ? "Hide quoted text" : "Show quoted text"}
          </Button>
          {showQuoted && (
            <div className="mt-2 break-words border-l border-border pl-3 text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">
              <LinkifiedText text={quoted} />
            </div>
          )}
        </div>
      )}
      {isOutbound && (
        <div className="-mr-1.5 -mb-1 mt-3 flex justify-end">
          <DeliveryStatus bounces={message.bounces ?? []} />
        </div>
      )}
    </Card>
  );
}

/** An Internal Note, tinted yellow so it never reads as an email. */
function NoteCard(props: { note: ThreadNote; deleting: boolean; onDelete: () => void }) {
  const { note } = props;
  return (
    <Card
      aria-label="Internal note"
      className="gap-0 bg-amber-50 p-4 ring-amber-300/70 sm:p-5 dark:bg-amber-400/10 dark:ring-amber-400/30"
    >
      <div className="mb-2 flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-200/70 text-amber-800 dark:bg-amber-400/20 dark:text-amber-300">
          <NoteIcon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <span className="text-sm font-semibold text-amber-900 dark:text-amber-200">Internal note</span>
          <div className="mt-0.5 truncate text-xs text-amber-800/80 dark:text-amber-300/80">
            {note.mail_rule_id !== null
              ? `Added by rule ${note.mail_rule_name ? `“${note.mail_rule_name}”` : "(deleted)"}`
              : "Only visible to your team"}
          </div>
        </div>
        <time
          dateTime={note.created_at}
          className="mt-0.5 shrink-0 self-start text-[11px] tabular-nums sm:text-xs text-amber-800/80 dark:text-amber-300/80"
          title={new Date(note.created_at).toLocaleString()}
        >
          {formatTime(note.created_at)}
        </time>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="-mt-0.5 -mr-1.5 self-start text-amber-800/80 hover:bg-amber-200/60 dark:text-amber-300/80 dark:hover:bg-amber-400/20"
              aria-label="Note options"
              title="More"
              disabled={props.deleting}
            >
              <MoreIcon className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem variant="destructive" onSelect={props.onDelete}>
              <TrashIcon />
              Delete note
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {note.html_body ? (
        <RichTextPreview
          html={note.html_body}
          openLinks
          className="max-w-[72ch] text-foreground touch:text-base"
        />
      ) : (
        <div className="max-w-[72ch] break-words text-sm leading-6 whitespace-pre-wrap text-foreground touch:text-base">
          <LinkifiedText text={note.text_body} />
        </div>
      )}
    </Card>
  );
}

/** The AI draft button at the right end of the reply toolbar. */
function DraftAssistButton(props: {
  status: AgentDraftStatus;
  hasDraft: boolean;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  onStart: () => void;
}) {
  if (props.hasDraft) return null;
  if (props.status === "processing") {
    return (
      <span role="status" title="Drafting with AI" className="flex size-7 items-center justify-center text-muted-foreground touch:size-8">
        <SparklesIcon className="h-4 w-4 animate-pulse" />
        <span className="sr-only">Drafting with AI</span>
      </span>
    );
  }
  if (props.status !== "not_processed") return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="shrink-0 text-muted-foreground hover:text-foreground touch:size-8"
      onClick={props.onStart}
      disabled={props.busy || props.disabled}
      title={props.error ?? "Draft with AI"}
      aria-label="Draft with AI"
    >
      <SparklesIcon className={cn("h-4 w-4", props.busy && "animate-pulse")} />
    </Button>
  );
}

/** A line under the reply toolbar while an AI draft is ready or has failed. */
function DraftAssist(props: {
  status: AgentDraftStatus;
  draft: Draft | null;
  usingDraft: boolean;
  error: string | null;
  busy: boolean;
  disabled: boolean;
  onUse: () => void;
  onDiscard: () => void;
  onRetry: () => void;
}) {
  const action = (label: string, onClick: () => void, title?: string) => (
    <Button
      variant="ghost"
      size="xs"
      className="text-muted-foreground hover:text-foreground"
      onClick={onClick}
      disabled={props.busy || props.disabled}
      title={title}
    >
      {label}
    </Button>
  );
  const row = "flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 border-b border-border/60 py-0.5 pr-2 pl-3.5 text-xs text-muted-foreground";

  if (props.draft) {
    const context = [
      props.draft.playbook_name ? `Playbook: ${props.draft.playbook_name}` : null,
      props.draft.agent_notes,
    ]
      .filter(Boolean)
      .join("\n\n");
    return (
      <div className={row} title={context || undefined}>
        <span role="status" className="flex shrink-0 items-center gap-1 font-medium text-foreground/80">
          <SparklesIcon className="h-3 w-3" />
          {props.usingDraft ? "AI draft" : "New AI draft"}
        </span>
        {props.usingDraft && props.draft.playbook_name && (
          <>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 truncate" title={`Playbook: ${props.draft.playbook_name}`}>
              Playbook: {props.draft.playbook_name}
            </span>
          </>
        )}
        <span aria-hidden="true">·</span>
        {!props.usingDraft && action("Replace", props.onUse, "Replace reply with AI draft")}
        {action(props.busy ? "Discarding…" : "Discard", props.onDiscard, "Discard AI draft and clear reply")}
      </div>
    );
  }

  if (props.status === "failed") {
    return (
      <div className={row}>
        <span className="flex items-center gap-1" title={props.error ?? undefined}>
          <SparklesIcon className="h-3 w-3" />
          AI draft unavailable
        </span>
        {action(props.busy ? "Retrying…" : "Retry", props.onRetry)}
      </div>
    );
  }

  return null;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(0.1, bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

function Kbd(props: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted/50 px-1 font-sans text-xs font-medium text-muted-foreground">
      {props.children}
    </kbd>
  );
}

function AuthorBadge(props: { tone: "agent" | "human"; children: React.ReactNode }) {
  return (
    <Badge
      variant={props.tone === "agent" ? "outline" : "secondary"}
      className="h-5 rounded-md px-1.5 text-xs font-medium"
    >
      {props.children}
    </Badge>
  );
}

function ThreadViewSkeleton({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex h-full flex-col bg-canvas" aria-busy="true" aria-label="Loading conversation">
      <div className="flex h-16 items-center gap-3 border-b bg-background px-4 md:px-6">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          className="-ml-1 md:hidden"
          aria-label="Back to conversations"
        >
          <ArrowLeftIcon className="h-5 w-5" />
        </Button>
        <div className="space-y-2">
          <div className="h-3.5 w-56 animate-pulse rounded bg-muted" />
          <div className="h-2.5 w-32 animate-pulse rounded bg-muted/70" />
        </div>
      </div>
      <div className="mr-auto w-full max-w-[1100px] space-y-3 px-4 py-5 sm:px-6 md:py-6">
        {[0, 1].map((item) => (
          <Card key={item} className="animate-pulse p-5">
            <div className="flex items-center gap-3">
              <span className="h-9 w-9 rounded-full bg-muted" />
              <span className="h-3 w-36 rounded bg-muted" />
            </div>
            <div className="mt-5 space-y-2">
              <span className="block h-3 w-full rounded bg-muted" />
              <span className="block h-3 w-4/5 rounded bg-muted" />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
