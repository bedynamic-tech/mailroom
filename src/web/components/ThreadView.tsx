import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import {
  archiveThread,
  blockThreadSender,
  createDraft,
  deleteThread,
  discardDraft,
  fetchMailboxes,
  fetchThread,
  linkBoardCard,
  markRead,
  retryDraftRun,
  sendReply,
  unarchiveThread,
} from "../api";
import type { Draft, Message } from "../../shared/types";
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
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BoardIcon,
  InboxIcon,
  MoreIcon,
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
import { AddToBoardCardDialog, BoardCardDialog, type CardDialogTarget } from "./BoardDialogs";
import { cardTitleFromSubject } from "../../shared/board";
import { CatchAllBadge } from "./CatchAllBadge";
import { BlockAddressDialog, CreateInboxFromAddressDialog } from "./CatchAllDialogs";
import { LinkifiedText } from "./LinkifiedText";
import { RecipientInput, type RecipientInputHandle } from "./RecipientInput";
import { RichTextEditor, richTextSummary } from "./RichTextEditor";
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
  const [replyCc, setReplyCc] = useState<string[]>([]);
  const [replyBcc, setReplyBcc] = useState<string[]>([]);
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
  const [boardTarget, setBoardTarget] = useState<CardDialogTarget | null>(null);
  const [addingToCard, setAddingToCard] = useState(false);
  const navigate = useNavigate();
  const seenDraftIds = useRef(new Set<number>());
  const blockArchivesThis = useRef(false);
  const markedRead = useRef<number | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ccInputRef = useRef<HTMLInputElement>(null);
  const bccInputRef = useRef<HTMLInputElement>(null);
  const ccField = useRef<RecipientInputHandle>(null);
  const bccField = useRef<RecipientInputHandle>(null);
  const attemptIds = useRef(new Map<string, { text: string; id: string }>());

  // Own Inbox addresses are never copied on Reply all.
  const mailboxes = useQuery({ queryKey: ["mailboxes"], queryFn: fetchMailboxes });

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
    setReplyCc([]);
    setReplyBcc([]);
    setAddingCc(false);
    setAddingBcc(false);
    setSendNotice(null);
    setFailedAttemptKey(null);
    setUsedDraftId(null);
    seenDraftIds.current.clear();
    attemptIds.current.clear();
  }, [props.threadId]);

  useEffect(() => {
    if (!detail.data) return;
    requestAnimationFrame(() => {
      const container = conversationRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    });
  }, [detail.data, props.threadId]);

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
      cc: string[];
      bcc: string[];
    }) =>
      sendReply(
        props.threadId,
        args.text,
        args.attemptId,
        args.draftId,
        args.files ?? [],
        { cc: args.cc, bcc: args.bcc },
        args.html,
      ),
    onSuccess: (result, args) => {
      if (result.status === "sent") {
        setReplyText("");
        setPendingFiles([]);
        setReplyCc([]);
        setReplyBcc([]);
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

  const discard = useMutation({
    mutationFn: (draftId: number) => discardDraft(draftId),
    onSuccess: (_result, draftId) => {
      seenDraftIds.current.add(draftId);
      setReplyText("");
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

  const linkSuggested = useMutation({
    mutationFn: (cardId: number) => linkBoardCard(cardId, props.threadId),
    onSuccess: () => {
      invalidateAll();
      queryClient.invalidateQueries({ queryKey: ["board"] });
    },
  });

  const startDraft = useMutation({
    mutationFn: () => createDraft(props.threadId),
    onSuccess: invalidateAll,
  });

  const draft = detail.data?.drafts.at(-1) ?? null;

  useEffect(() => {
    if (!draft || seenDraftIds.current.has(draft.id)) return;
    // Consider each draft once: polling must not restore text the user cleared
    // or replace a reply they were already writing when the draft arrived.
    seenDraftIds.current.add(draft.id);
    if (!isBlankRichText(replyText) || reply.isPending || discard.isPending) return;
    setReplyText(plainTextToHtml(draft.text_body));
    setUsedDraftId(draft.id);
  }, [draft, replyText, reply.isPending, discard.isPending]);

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

  const { thread, messages, drafts } = detail.data;
  const boardConversation = {
    id: thread.id,
    subject: thread.subject,
    status: thread.status,
    mailbox_address: thread.mailbox_address,
  };
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

  const createBoardItem = () =>
    setBoardTarget({
      kind: "create",
      title: cardTitleFromSubject(thread.subject) || "Follow up",
      conversation: boardConversation,
    });
  const agentStatus = deriveAgentDraftStatus({
    pendingDraftCount: drafts.length,
    runStatus: detail.data.draft_run?.status ?? null,
    agentMode: thread.mailbox_agent_mode,
    latestInboundIsAutomated: Boolean(thread.latest_inbound_is_auto_submitted),
    lastMessageDirection: thread.last_message_direction,
  });

  // Replies always go to the latest inbound Message's reply target (see sendReplyAttempt).
  const latestInbound = messages.filter((message) => message.direction === "inbound").at(-1);
  const replyTargets = latestInbound
    ? (() => {
        const replyTo = parseAddressList(latestInbound.reply_to_addresses);
        return replyTo.length ? replyTo : [latestInbound.from_address];
      })()
    : [];
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
    ? richTextSummary(replyMailbox.effective_signature_html)
    : "";

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
    if ((text || pendingFiles.length > 0) && !reply.isPending && !discard.isPending) {
      // Add any address still being typed; stop if one of them is invalid.
      const cc = ccField.current ? ccField.current.commit() : replyCc;
      const bcc = bccField.current ? bccField.current.commit() : replyBcc;
      if (!cc || !bcc) return;
      const fingerprint = `${html} ${pendingFiles.map((file) => `${file.name}:${file.size}`).join(",")} cc:${cc.join(",")} bcc:${bcc.join(",")}`;
      const attemptKey = usedDraftId === null ? "manual" : `draft-${usedDraftId}`;
      reply.mutate({
        text,
        html,
        files: pendingFiles,
        cc,
        bcc,
        draftId: usedDraftId ?? undefined,
        attemptId: attemptFor(attemptKey, fingerprint),
        attemptKey,
      });
    }
  };

  const applyDraft = (next: Draft) => {
    seenDraftIds.current.add(next.id);
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
      className="flex h-full min-w-0 flex-col bg-canvas"
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
        {thread.status === "archived" ? (
          <>
            <Button
              variant="outline"
              onClick={() => moveThread.mutate("unarchive")}
              disabled={moveThread.isPending || removeThread.isPending}
              aria-label="Move conversation to inbox"
              className="shrink-0"
            >
              <InboxIcon className="h-4 w-4" />
              <span className="hidden sm:inline">
                {moveThread.isPending ? "Moving…" : "Move to inbox"}
              </span>
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                removeThread.reset();
                setConfirmDelete(true);
              }}
              disabled={moveThread.isPending || removeThread.isPending}
              aria-label="Delete conversation permanently"
              className="shrink-0 text-destructive hover:text-destructive"
            >
              <TrashIcon className="h-4 w-4" />
              <span className="hidden sm:inline">Delete</span>
            </Button>
            <DeleteConversationsDialog
              open={confirmDelete}
              title="Delete this conversation?"
              description="This permanently deletes its messages, attachments, and drafts. This can’t be undone."
              confirmLabel="Delete conversation"
              pending={removeThread.isPending}
              error={removeThread.error}
              onConfirm={() => removeThread.mutate()}
              onOpenChange={setConfirmDelete}
            />
          </>
        ) : (
          <Button
            variant="outline"
            onClick={() => moveThread.mutate("archive")}
            disabled={moveThread.isPending}
            aria-label="Archive conversation"
            className="shrink-0"
          >
            <ArchiveIcon className="h-4 w-4" />
            <span className="hidden sm:inline">
              {moveThread.isPending ? "Archiving…" : "Archive"}
            </span>
          </Button>
        )}
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

      {detail.data.suggested_board_cards.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground md:px-6">
          <span className="shrink-0">
            {detail.data.suggested_board_cards.length === 1
              ? "Board item from this sender:"
              : "Board items from this sender:"}
          </span>
          {detail.data.suggested_board_cards.map((card) => (
            <span
              key={card.id}
              className="inline-flex h-6 max-w-72 shrink-0 items-center gap-1 rounded-md border bg-background pl-2 text-xs text-foreground touch:h-8"
            >
              <button
                type="button"
                onClick={() => navigate(`/board/cards/${card.id}`)}
                className="min-w-0 truncate font-medium outline-none hover:underline focus-visible:underline"
                title={`${card.title} (${card.column_name})`}
              >
                {card.title}
              </button>
              <button
                type="button"
                disabled={linkSuggested.isPending}
                onClick={() => linkSuggested.mutate(card.id)}
                className="flex h-full shrink-0 items-center gap-1 rounded-r-md border-l px-2 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                aria-label={`Link this conversation to ${card.title}`}
              >
                <PlusIcon className="h-3 w-3" />
                Link
              </button>
            </span>
          ))}
        </div>
      )}

      {detail.data.board_cards.length > 0 && (
        <nav
          aria-label="Board items"
          className="flex shrink-0 items-center gap-2 overflow-x-auto border-b bg-background px-4 py-2 text-xs text-muted-foreground md:px-6"
        >
          <span className="flex shrink-0 items-center gap-1.5">
            <BoardIcon className="h-3.5 w-3.5" />
            On the board
          </span>
          {detail.data.board_cards.map((card) => (
            <button
              key={card.id}
              type="button"
              onClick={() => navigate(`/board/cards/${card.id}`)}
              title={`${card.title} (${card.column_name})`}
              className="inline-flex h-6 max-w-64 shrink-0 items-center gap-1.5 rounded-md border bg-background px-2 text-xs text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 touch:h-8"
            >
              <span className="min-w-0 truncate font-medium">{card.title}</span>
              <span className="shrink-0 text-muted-foreground">{card.column_name}</span>
            </button>
          ))}
        </nav>
      )}

      <div ref={conversationRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mr-auto w-full max-w-[800px] px-4 py-5 sm:px-6 md:py-6">
          {messages.map((message, index) => (
            <Fragment key={message.id}>
              {index > 0 && <MessageConnector />}
              <MessageCard
                message={message}
                catchAllRecipient={thread.catch_all_recipient}
                onCreateBoardItem={createBoardItem}
                onAddToBoardItem={() => setAddingToCard(true)}
                onBlockSender={
                  blockCandidatesFor(message, ownAddresses).length > 0
                    ? () => openBlockSender(message)
                    : undefined
                }
              />
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
      <BoardCardDialog
        target={boardTarget}
        onOpenChange={(open) => !open && setBoardTarget(null)}
      />
      <AddToBoardCardDialog
        open={addingToCard}
        conversation={boardConversation}
        onOpenChange={setAddingToCard}
        onCreateNew={() => {
          setAddingToCard(false);
          createBoardItem();
        }}
      />

      <footer className="shrink-0 bg-canvas pt-1 pb-3 sm:pb-5">
        <div className="mr-auto w-full max-w-[800px] px-4 sm:px-6">
          <Card className="gap-0 py-0 shadow-[0_1px_2px_oklch(0.2_0.012_265/0.04),0_4px_16px_-6px_oklch(0.2_0.012_265/0.08)] transition-shadow focus-within:ring-foreground/25">
            <div className="flex min-h-9 min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/70 py-1 pr-2 pl-3.5 text-xs text-muted-foreground">
              <span className="flex min-w-0 flex-1 basis-48 items-center gap-1.5 py-1">
                <span className="shrink-0">Replying from</span>
                <span
                  className="truncate font-medium text-foreground/80"
                  title={thread.catch_all_recipient ?? thread.mailbox_address}
                >
                  {thread.catch_all_recipient ?? thread.mailbox_address}
                </span>
                <span className="ml-1 flex shrink-0 items-center">
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
                </span>
              </span>
              <DraftAssist
                status={agentStatus}
                draft={draft}
                usingDraft={draft !== null && usedDraftId === draft.id}
                error={
                  startDraft.isError && startDraft.error instanceof Error
                    ? startDraft.error.message
                    : detail.data.draft_run?.error ?? null
                }
                busy={retryDraft.isPending || startDraft.isPending || discard.isPending}
                disabled={reply.isPending}
                onUse={() => draft && applyDraft(draft)}
                onDiscard={() => draft && discard.mutate(draft.id)}
                onRetry={() => {
                  if (detail.data.draft_run) retryDraft.mutate(detail.data.draft_run.id);
                }}
                onStart={() => startDraft.mutate()}
              />
            </div>
            {(showCc || showBcc) && (
              <div className="border-b border-border/70 text-xs">
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
            )}
            <RichTextEditor
              id={`reply-${props.threadId}`}
              value={replyText}
              disabled={reply.isPending || discard.isPending}
              onChange={(html) => {
                setReplyText(html);
                if (isBlankRichText(html)) setUsedDraftId(null);
              }}
              onSubmitShortcut={submitReply}
              placeholder="Write a reply…"
              ariaLabel="Reply"
              variant="bare"
              contentClassName="max-h-[min(30dvh,200px)] min-h-[84px] px-3.5"
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
            {replySignature && (
              <p
                className="truncate px-3.5 pb-2 text-xs text-muted-foreground"
                title={replySignature}
              >
                <span className="text-foreground/70">Signature:</span> {replySignature}
              </p>
            )}
            <div className="flex items-center justify-end px-3 pb-3 sm:justify-between">
              <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
                <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
                <Kbd>Enter</Kbd>
                <span className="ml-0.5">to send</span>
              </span>
              <div className="flex items-center gap-1.5">
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
                <Button
                  onClick={submitReply}
                  disabled={
                    (isBlankRichText(replyText) && pendingFiles.length === 0) || reply.isPending || discard.isPending
                  }
                >
                  <SendIcon className="h-3.5 w-3.5" />
                  {reply.isPending ? "Sending…" : "Send reply"}
                </Button>
              </div>
            </div>
          </Card>
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

function CopyRecipientsRow(props: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 px-3.5">
      <label htmlFor={props.htmlFor} className="w-8 shrink-0 py-2.5 text-muted-foreground">
        {props.label}
      </label>
      {props.children}
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

function parseAddressList(raw: string | null | undefined): string[] {
  try {
    const values = JSON.parse(raw || "[]") as unknown;
    return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
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
  catchAllRecipient,
  onCreateBoardItem,
  onAddToBoardItem,
  onBlockSender,
}: {
  message: Message;
  catchAllRecipient: string | null;
  onCreateBoardItem: () => void;
  onAddToBoardItem: () => void;
  onBlockSender?: () => void;
}) {
  const [showQuoted, setShowQuoted] = useState(false);
  const isOutbound = message.direction === "outbound";
  const displayName = isOutbound
    ? message.from_name || message.from_address
    : message.from_name || message.from_address;
  const { main, quoted } = splitQuotedTail(message.text_body ?? "");
  const to = parseAddressList(message.to_addresses);
  const cc = parseAddressList(message.cc_addresses);
  const bcc = isOutbound ? parseAddressList(message.bcc_addresses) : [];

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
          className="mt-0.5 shrink-0 text-xs tabular-nums text-muted-foreground"
          title={new Date(message.created_at).toLocaleString()}
        >
          {formatTime(message.created_at)}
        </time>
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
            <DropdownMenuItem onSelect={onCreateBoardItem}>
              <PlusIcon />
              Create board item
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onAddToBoardItem}>
              <BoardIcon />
              Add to board item
            </DropdownMenuItem>
            {onBlockSender && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={onBlockSender}>
                  <ShieldBanIcon />
                  Block sender…
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {message.html_body ? (
        <EmailHtmlBody
          html={message.html_body}
          attachments={message.attachments}
          sender={displayName}
        />
      ) : (
        <div className="max-w-[72ch] break-words text-sm leading-6 whitespace-pre-wrap text-foreground touch:text-base">
          <LinkifiedText text={main} />
        </div>
      )}
      {message.attachments.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2" aria-label="Attachments">
          {message.attachments.map((attachment) => (
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
    </Card>
  );
}

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
  onStart: () => void;
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

  if (props.draft) {
    const context = [
      props.draft.playbook_name ? `Playbook: ${props.draft.playbook_name}` : null,
      props.draft.agent_notes,
    ]
      .filter(Boolean)
      .join("\n\n");
    return (
      <span className="flex min-w-0 max-w-full flex-wrap items-center gap-x-1 gap-y-0.5" title={context || undefined}>
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
      </span>
    );
  }

  if (props.status === "processing") {
    return (
      <span className="flex shrink-0 items-center gap-1 px-1.5">
        <SparklesIcon className="h-3 w-3 animate-pulse" />
        Drafting…
      </span>
    );
  }

  if (props.status === "failed") {
    return (
      <span className="flex shrink-0 items-center gap-0.5">
        <span className="px-1.5" title={props.error ?? undefined}>
          AI draft unavailable
        </span>
        {action(props.busy ? "Retrying…" : "Retry", props.onRetry)}
      </span>
    );
  }

  if (props.status === "not_processed") {
    return (
      <Button
        variant="ghost"
        size="xs"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={props.onStart}
        disabled={props.busy || props.disabled}
        title={props.error ?? undefined}
      >
        <SparklesIcon className="h-3 w-3" />
        {props.busy ? "Drafting…" : "Draft with AI"}
      </Button>
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
      <div className="mr-auto w-full max-w-[800px] space-y-3 px-4 py-5 sm:px-6 md:py-6">
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
