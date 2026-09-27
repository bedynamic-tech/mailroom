import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  disableBrowserNotifications,
  enableBrowserNotifications,
  fetchGeneralSettings,
  sendTestEmailNotification,
  setEmailNotificationsEnabled,
  updateDefaultSignature,
  updateEmailNotifications,
} from "../api";
import type { EmailNotificationTemplate } from "../../shared/types";
import {
  BrowserPushError,
  createBrowserPushSubscription,
  getBrowserPushState,
  unsubscribeCurrentBrowser,
} from "../push-notifications";
import { isIosBrowser, useInstallState } from "../pwa";
import { BellIcon, MailIcon } from "./Icons";
import { EmailTemplateEditor } from "./EmailTemplateEditor";
import { RichTextEditor } from "./RichTextEditor";
import { normalizeSignature } from "../../shared/signature";
import {
  SettingsBlock,
  SettingsHeader,
  SettingsPage,
  SettingsPanel,
} from "./SettingsNavigation";

export function GeneralSettings(props: {
  onBack: () => void;
  onOpenInboxes: () => void;
  onOpenContacts: () => void;
  onOpenRules: () => void;
  onOpenSpam: () => void;
  onOpenAi: () => void;
}) {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ["settings", "general"],
    queryFn: fetchGeneralSettings,
  });
  const browser = useQuery({
    queryKey: ["browser-push-state"],
    queryFn: getBrowserPushState,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  const refreshState = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["settings", "general"] }),
      queryClient.invalidateQueries({ queryKey: ["browser-push-state"] }),
    ]);
  };

  const enable = useMutation({
    mutationFn: async () => {
      const publicKey = settings.data?.vapid_public_key;
      if (!publicKey) throw new Error("Browser notifications are not configured.");
      const subscription = await createBrowserPushSubscription(publicKey);
      await enableBrowserNotifications(subscription);
    },
    onSettled: refreshState,
  });

  const disable = useMutation({
    mutationFn: async () => {
      await disableBrowserNotifications();
      await unsubscribeCurrentBrowser();
    },
    onSettled: refreshState,
  });

  const globalEnabled = Boolean(settings.data?.browser_notifications_enabled);
  const configured = Boolean(settings.data?.browser_notifications_configured);
  const supported = browser.data?.supported ?? true;
  const blocked = browser.data?.permission === "denied";
  const subscribed = Boolean(browser.data?.subscribed);
  const busy = enable.isPending || disable.isPending;
  const switchDisabled =
    settings.isLoading ||
    browser.isLoading ||
    busy ||
    !configured ||
    (!globalEnabled && (!supported || blocked));
  const error = enable.error ?? disable.error;

  return (
    <div className="flex h-full min-w-0 flex-col bg-canvas">
      <SettingsHeader
        active="general"
        onBack={props.onBack}
        onOpenGeneral={() => undefined}
        onOpenInboxes={props.onOpenInboxes}
        onOpenContacts={props.onOpenContacts}
        onOpenRules={props.onOpenRules}
        onOpenSpam={props.onOpenSpam}
        onOpenAi={props.onOpenAi}
      />

      <SettingsPage>
        <SettingsBlock id="notification-settings-heading" title="Notifications">
          <SettingsPanel>
            <div className="flex items-start gap-4 px-4 py-4 sm:px-5">
              <div className="min-w-0 flex-1">
                <label
                  htmlFor="browser-notifications"
                  className="flex items-center gap-2 text-sm font-medium text-foreground"
                >
                  <BellIcon className="h-4 w-4 text-muted-foreground" />
                  Browser notifications
                </label>
                <p className="mt-1 max-w-xl text-sm leading-5 text-muted-foreground">
                  {notificationDescription({
                    configured,
                    supported,
                    blocked,
                    globalEnabled,
                    subscribed,
                  })}
                </p>

                {globalEnabled && !subscribed && supported && !blocked && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => enable.mutate()}
                    disabled={busy || !configured}
                  >
                    {enable.isPending ? "Enabling…" : "Enable on this browser"}
                  </Button>
                )}

                {error && (
                  <p className="mt-2 text-xs leading-5 text-destructive" role="alert">
                    {notificationErrorMessage(error)}
                  </p>
                )}
              </div>
              <Switch
                id="browser-notifications"
                checked={globalEnabled}
                onCheckedChange={(checked) =>
                  checked ? enable.mutate() : disable.mutate()
                }
                disabled={switchDisabled}
                aria-describedby="browser-notifications-description"
                className="mt-0.5"
              />
              <span id="browser-notifications-description" className="sr-only">
                Applies to new email received by every inbox in this workspace.
              </span>
            </div>
            <EmailNotificationSetting
              enabled={Boolean(settings.data?.email_notifications_enabled)}
              savedAddress={settings.data?.email_notification_address ?? null}
              template={settings.data?.email_notification_template ?? null}
              loading={settings.isLoading}
            />
          </SettingsPanel>
        </SettingsBlock>

        <DefaultSignatureSetting
          savedHtml={settings.data?.default_signature_html ?? null}
          loading={settings.isLoading}
          onOpenInboxes={props.onOpenInboxes}
        />

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

function AppSettings() {
  const install = useInstallState();
  const ios = isIosBrowser();

  return (
    <SettingsBlock
      id="app-settings-heading"
      title="App"
      description="Install Mailroom to open it in its own window, show unread counts on its icon, and get notifications from your operating system."
    >
      <SettingsPanel>
        <div className="flex items-center gap-4 px-4 py-4 sm:px-5">
          <img
            src="/icons/icon-192.png"
            alt=""
            width={40}
            height={40}
            className="h-10 w-10 shrink-0 rounded-[10px] border"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">Mailroom app</p>
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

function EmailNotificationSetting(props: {
  enabled: boolean;
  savedAddress: string | null;
  template: EmailNotificationTemplate | null;
  loading: boolean;
}) {
  const queryClient = useQueryClient();
  const [editorOpen, setEditorOpen] = useState(false);
  const [address, setAddress] = useState(props.savedAddress ?? "");
  useEffect(() => setAddress(props.savedAddress ?? ""), [props.savedAddress]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["settings", "general"] });
  const save = useMutation({
    mutationFn: (value: string) => updateEmailNotifications(value),
    onSettled: refresh,
  });
  const toggle = useMutation({
    mutationFn: setEmailNotificationsEnabled,
    onSettled: refresh,
  });
  const sendTest = useMutation({ mutationFn: sendTestEmailNotification });

  const busy = save.isPending || toggle.isPending;
  const trimmed = address.trim();
  const unchanged = trimmed.toLowerCase() === (props.savedAddress ?? "");
  const error = save.error ?? toggle.error;
  // Show the pending state while the switch request is in flight.
  const checked = toggle.isPending ? Boolean(toggle.variables) : props.enabled;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (trimmed && !unchanged) save.mutate(trimmed);
  };

  return (
    <>
      <form onSubmit={onSubmit} className="border-t px-4 py-4 sm:px-5">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <label
              htmlFor="email-notifications"
              className="flex items-center gap-2 text-sm font-medium text-foreground"
            >
              <MailIcon className="h-4 w-4 text-muted-foreground" />
              Email notifications
            </label>
            <p className="mt-1 max-w-xl text-sm leading-5 text-muted-foreground">
              {!props.savedAddress
                ? "Add an email address to get a notice when any inbox receives a new email."
                : props.enabled
                  ? `A notice is sent to ${props.savedAddress} when any inbox receives a new email.`
                  : `Notices to ${props.savedAddress} are paused.`}
            </p>
          </div>
          <Switch
            id="email-notifications"
            checked={checked}
            onCheckedChange={(value) => toggle.mutate(value)}
            disabled={props.loading || busy || !props.savedAddress}
            aria-describedby="email-notifications-description"
            className="mt-0.5"
          />
          <span id="email-notifications-description" className="sr-only">
            Applies to new email received by every inbox in this workspace.
          </span>
        </div>

        <div className="mt-3 flex max-w-xl flex-wrap items-center gap-2">
          <Input
            id="email-notification-address"
            type="email"
            autoComplete="email"
            aria-label="Notification email address"
            placeholder="you@example.com"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            disabled={props.loading || busy}
            className="min-w-[14rem] flex-1"
          />
          <Button
            type="submit"
            size="sm"
            variant={props.savedAddress ? "outline" : "default"}
            disabled={props.loading || busy || !trimmed || unchanged}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>

        {props.savedAddress && (
          <div className="mt-2 flex flex-wrap items-center gap-1 -ml-2.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEditorOpen(true)}
              disabled={!props.template}
            >
              Customize email
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => sendTest.mutate()}
              disabled={busy || sendTest.isPending}
            >
              {sendTest.isPending ? "Sending…" : "Send test"}
            </Button>
          </div>
        )}

        {sendTest.isSuccess && (
          <p className="mt-2 text-xs leading-5 text-muted-foreground" role="status">
            Test sent from {sendTest.data.from} to {sendTest.data.to}. If it doesn’t arrive, check
            spam and your Cloudflare Email Sending setup.
          </p>
        )}
        {sendTest.error && (
          <p className="mt-2 text-xs leading-5 text-destructive" role="alert">
            {sendTest.error.message}
          </p>
        )}
        {error && (
          <p className="mt-2 text-xs leading-5 text-destructive" role="alert">
            {error.message || "Couldn’t update email notifications. Try again."}
          </p>
        )}
      </form>
      {/* Outside the form: React events bubble through portals, so a nested
          submit would also save the address. */}
      {props.template && (
        <EmailTemplateEditor
          open={editorOpen}
          onOpenChange={setEditorOpen}
          template={props.template}
          recipient={props.savedAddress}
        />
      )}
    </>
  );
}

function notificationDescription(state: {
  configured: boolean;
  supported: boolean;
  blocked: boolean;
  globalEnabled: boolean;
  subscribed: boolean;
}): string {
  if (!state.configured) return "Push delivery has not been configured on this server.";
  if (!state.supported && isIosBrowser()) {
    return "On iPhone and iPad, add Mailroom to your Home Screen, then open it from there to turn on notifications.";
  }
  if (!state.supported) return "This browser does not support push notifications.";
  if (state.blocked) return "Notifications are blocked in this browser's site settings.";
  if (state.globalEnabled && state.subscribed) {
    return "This browser will notify you when any inbox receives a new email.";
  }
  if (state.globalEnabled) return "Notifications are on, but this browser is not subscribed yet.";
  return "Get notified when any inbox receives a new email.";
}

function notificationErrorMessage(error: Error): string {
  if (error instanceof BrowserPushError && error.code === "permission-denied") {
    return "Notifications were not allowed. Change this site's notification permission in your browser to try again.";
  }
  return error.message || "Couldn’t update browser notifications. Try again.";
}
