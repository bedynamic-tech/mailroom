import { useEffect, useState } from "react";
import { Monitor as MonitorIcon, Moon as MoonIcon, Sun as SunIcon } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { fetchGeneralSettings, updateDefaultSignature, updateReplyGreeting } from "../api";
import { isIosBrowser, useInstallState } from "../pwa";
import { setTheme, useTheme, type ThemeChoice } from "../theme";
import { RichTextEditor } from "./RichTextEditor";
import { normalizeSignature } from "../../shared/signature";
import {
  DEFAULT_REPLY_GREETING_TEMPLATE,
  MAX_REPLY_GREETING_LENGTH,
  normalizeGreetingTemplate,
  replyGreetingLine,
} from "../../shared/reply-greeting";
import {
  SettingsBlock,
  SettingsHeader,
  SettingsPage,
  SettingsPanel,
} from "./SettingsNavigation";

export function GeneralSettings(props: {
  onBack: () => void;
  onOpenNotifications: () => void;
  onOpenInboxes: () => void;
  onOpenContacts: () => void;
  onOpenRules: () => void;
  onOpenSpam: () => void;
  onOpenAi: () => void;
}) {
  const settings = useQuery({
    queryKey: ["settings", "general"],
    queryFn: fetchGeneralSettings,
  });

  return (
    <div className="flex h-full min-w-0 flex-col bg-canvas">
      <SettingsHeader
        active="general"
        onBack={props.onBack}
        onOpenGeneral={() => undefined}
        onOpenNotifications={props.onOpenNotifications}
        onOpenInboxes={props.onOpenInboxes}
        onOpenContacts={props.onOpenContacts}
        onOpenRules={props.onOpenRules}
        onOpenSpam={props.onOpenSpam}
        onOpenAi={props.onOpenAi}
      />

      <SettingsPage>
        <DefaultSignatureSetting
          savedHtml={settings.data?.default_signature_html ?? null}
          loading={settings.isLoading}
          onOpenInboxes={props.onOpenInboxes}
        />

        <ReplyGreetingSetting
          enabled={settings.data?.reply_greeting_enabled ?? false}
          savedTemplate={settings.data?.reply_greeting_template ?? null}
          loading={settings.isLoading || settings.isError}
        />

        <AppearanceSetting />

        <AppSettings />
      </SettingsPage>
    </div>
  );
}

function DefaultSignatureSetting(props: {
  savedHtml: string | null;
  loading: boolean;
  onOpenInboxes: () => void;
}) {
  const queryClient = useQueryClient();
  const [html, setHtml] = useState(props.savedHtml ?? "");
  useEffect(() => setHtml(props.savedHtml ?? ""), [props.savedHtml]);

  const save = useMutation({
    mutationFn: () => updateDefaultSignature(normalizeSignature(html)),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings", "general"] }),
        queryClient.invalidateQueries({ queryKey: ["mailboxes"] }),
      ]);
    },
  });

  const dirty = normalizeSignature(html) !== (props.savedHtml ?? null);

  return (
    <SettingsBlock
      id="default-signature-heading"
      title="Default signature"
      description={
        <>
          Added to replies and new email from every inbox that uses the default. An inbox can
          use its own signature or none in{" "}
          <button
            type="button"
            onClick={props.onOpenInboxes}
            className="rounded-sm text-foreground underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Inbox settings
          </button>
          .
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (dirty) save.mutate();
        }}
      >
        <RichTextEditor
          id="default-signature"
          value={html}
          onChange={(value) => {
            setHtml(value);
            save.reset();
          }}
          disabled={props.loading || save.isPending}
          placeholder="Jane Doe, Support Lead at Acme"
          ariaLabelledBy="default-signature-heading"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="min-w-0 text-xs text-muted-foreground" aria-live="polite">
            {save.isError ? (
              <span className="text-destructive">
                {save.error instanceof Error ? save.error.message : "Couldn’t save the signature."}
              </span>
            ) : dirty ? (
              "Unsaved changes"
            ) : save.isSuccess ? (
              "Signature saved"
            ) : null}
          </p>
          <Button type="submit" size="sm" disabled={props.loading || save.isPending || !dirty}>
            {save.isPending ? "Saving…" : "Save signature"}
          </Button>
        </div>
      </form>
    </SettingsBlock>
  );
}
function ReplyGreetingSetting(props: {
  enabled: boolean;
  savedTemplate: string | null;
  loading: boolean;
}) {
  const queryClient = useQueryClient();
  const saved = props.savedTemplate ?? DEFAULT_REPLY_GREETING_TEMPLATE;
  const [template, setTemplate] = useState(saved);
  useEffect(() => setTemplate(saved), [saved]);

  const save = useMutation({
    mutationFn: (input: { enabled: boolean; template: string | null }) =>
      updateReplyGreeting(input.enabled, input.template),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["settings", "general"] }),
  });

  const enabled = save.isPending ? save.variables.enabled : props.enabled;
  const normalized = normalizeGreetingTemplate(template);
  const dirty = normalized !== (props.savedTemplate ?? null);
  const preview = replyGreetingLine(normalized, "Jane");

  return (
    <SettingsBlock
      id="reply-greeting-heading"
      title="Reply greeting"
      description="Start each reply with a greeting and a blank line, as if you had typed it and pressed Enter twice."
    >
      <SettingsPanel>
        <div className="flex items-start gap-4 px-4 py-4 sm:px-5">
          <div className="min-w-0 flex-1">
            <label htmlFor="reply-greeting-enabled" className="text-sm font-medium text-foreground">
              Add a greeting to replies
            </label>
            <p
              id="reply-greeting-enabled-description"
              className="mt-1 max-w-xl text-sm leading-5 text-muted-foreground"
            >
              Uses the contact&rsquo;s name, or the sender&rsquo;s name from their email. When no
              name is known, the reply starts empty.
            </p>
          </div>
          <Switch
            id="reply-greeting-enabled"
            checked={enabled}
            onCheckedChange={(value) => save.mutate({ enabled: value, template: props.savedTemplate })}
            disabled={props.loading || save.isPending}
            aria-describedby="reply-greeting-enabled-description"
            className="mt-0.5"
          />
        </div>
        {enabled && (
          <form
            className="border-t px-4 py-4 sm:px-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (dirty) save.mutate({ enabled: true, template: normalized });
            }}
          >
            <label htmlFor="reply-greeting-template" className="text-sm font-medium text-foreground">
              Greeting
            </label>
            <p
              id="reply-greeting-template-description"
              className="mt-1 text-sm leading-5 text-muted-foreground"
            >
              {"{first_name}"} is replaced with the recipient&rsquo;s first name.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Input
                id="reply-greeting-template"
                value={template}
                maxLength={MAX_REPLY_GREETING_LENGTH}
                onChange={(event) => {
                  setTemplate(event.target.value);
                  save.reset();
                }}
                disabled={props.loading || save.isPending}
                placeholder={DEFAULT_REPLY_GREETING_TEMPLATE}
                aria-describedby="reply-greeting-template-description"
                className="max-w-xs min-w-0 flex-1"
              />
              <Button type="submit" size="sm" disabled={props.loading || save.isPending || !dirty}>
                {save.isPending ? "Saving…" : "Save greeting"}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
              {save.isError ? (
                <span className="text-destructive">
                  {save.error instanceof Error ? save.error.message : "Couldn’t save the greeting."}
                </span>
              ) : (
                <>Example: {preview ?? "(no greeting)"}</>
              )}
            </p>
          </form>
        )}
        {!enabled && save.isError && (
          <p className="border-t px-4 py-3 text-xs text-destructive sm:px-5" role="alert">
            {save.error instanceof Error ? save.error.message : "Couldn’t update this setting"}
          </p>
        )}
      </SettingsPanel>
    </SettingsBlock>
  );
}

const THEME_OPTIONS: { value: ThemeChoice; label: string; icon: typeof SunIcon }[] = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "System", icon: MonitorIcon },
];

function AppearanceSetting() {
  const theme = useTheme();

  return (
    <SettingsBlock
      id="appearance-settings-heading"
      title="Appearance"
      description="Saved on this device. System follows your device's light or dark setting."
    >
      <SettingsPanel>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5">
          <p id="theme-label" className="text-sm font-medium text-foreground">
            Theme
          </p>
          <div
            role="radiogroup"
            aria-labelledby="theme-label"
            className="inline-flex rounded-lg bg-muted p-[3px]"
          >
            {THEME_OPTIONS.map((option) => {
              const selected = theme === option.value;
              const Icon = option.icon;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setTheme(option.value)}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none touch:h-9",
                    selected
                      ? "bg-background text-foreground shadow-sm dark:bg-accent"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden />
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      </SettingsPanel>
    </SettingsBlock>
  );
}

function AppSettings() {
  const install = useInstallState();
  const ios = isIosBrowser();

  return (
    <SettingsBlock
      id="app-settings-heading"
      title="App"
      description="Install Mailroom + to open it in its own window, show unread counts on its icon, and get notifications from your operating system."
    >
      <SettingsPanel>
        <div className="flex items-center gap-4 px-4 py-4 sm:px-5">
          <img
            src="/icons/icon-192.png"
            alt=""
            width={40}
            height={40}
            className="h-10 w-10 shrink-0"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">Mailroom + app</p>
            <p className="mt-0.5 text-sm leading-5 text-muted-foreground">
              {install.installed
                ? "Installed on this device."
                : install.canPrompt
                  ? "Available to install on this device."
                  : ios
                    ? "In Safari, tap Share, then Add to Home Screen."
                    : "Use your browser's Install app option in the address bar or menu."}
            </p>
          </div>
          {install.canPrompt && !install.installed && (
            <Button size="sm" onClick={() => void install.prompt()} className="shrink-0">
              Install
            </Button>
          )}
        </div>
      </SettingsPanel>
    </SettingsBlock>
  );
}
