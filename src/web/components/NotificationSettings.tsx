import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  disableBrowserNotifications,
  enableBrowserNotifications,
  fetchGeneralSettings,
  sendTestEmailNotification,
  setEmailNotificationsEnabled,
  syncBrowserNotifications,
  testBrowserNotifications,
  type BrowserPushTestResult,
  updateEmailNotifications,
  updateNotificationTypes,
  type NotificationType,
} from "../api";
import type { EmailNotificationTemplate, GeneralSettings as GeneralSettingsData } from "../../shared/types";
import {
  BrowserPushError,
  createBrowserPushSubscription,
  currentBrowserPushSubscription,
  getBrowserPushState,
  unsubscribeCurrentBrowser,
} from "../push-notifications";
import { isIosBrowser } from "../pwa";
import { BellIcon, MailIcon } from "./Icons";
import { EmailTemplateEditor } from "./EmailTemplateEditor";
import { SettingsBlock, SettingsHeader, SettingsPage, SettingsPanel } from "./SettingsNavigation";

export function NotificationSettings(props: {
  onBack: () => void;
  onOpenGeneral: () => void;
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

  const sendTest = useMutation({
    mutationFn: async () => {
      // Make sure this browser is on the server's list before testing it.
      const subscription = await currentBrowserPushSubscription();
      const registered = subscription
        ? (await syncBrowserNotifications(subscription)).registered
        : false;
      return { ...(await testBrowserNotifications()), thisBrowserRegistered: registered };
    },
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
        active="notifications"
        onBack={props.onBack}
        onOpenGeneral={props.onOpenGeneral}
        onOpenNotifications={() => undefined}
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

                {globalEnabled && settings.data && (
                  <NotificationTypeChecks channel="browser" settings={settings.data} disabled={busy} />
                )}

                {globalEnabled && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="mt-2 -ml-2"
                    onClick={() => sendTest.mutate()}
                    disabled={busy || sendTest.isPending}
                  >
                    {sendTest.isPending ? "Sending…" : "Send test"}
                  </Button>
                )}
                {globalEnabled && sendTest.isSuccess && (
                  <p
                    className={`mt-1 text-xs leading-5 ${
                      sendTest.data.delivered === sendTest.data.subscriptions &&
                      sendTest.data.delivered > 0 &&
                      sendTest.data.thisBrowserRegistered
                        ? "text-muted-foreground"
                        : "text-destructive"
                    }`}
                    role="status"
                  >
                    {browserTestMessage(sendTest.data)}
                  </p>
                )}
                {globalEnabled && sendTest.error && (
                  <p className="mt-1 text-xs leading-5 text-destructive" role="alert">
                    {sendTest.error.message}
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
                Turns this kind of notification on for the whole workspace.
              </span>
            </div>
            <EmailNotificationSetting
              settings={settings.data ?? null}
              enabled={Boolean(settings.data?.email_notifications_enabled)}
              savedAddress={settings.data?.email_notification_address ?? null}
              template={settings.data?.email_notification_template ?? null}
              loading={settings.isLoading}
            />
          </SettingsPanel>
        </SettingsBlock>
      </SettingsPage>
    </div>
  );
}

const NOTIFICATION_TYPES = [
  { key: "new_email", label: "New email", detail: "When an email starts a new conversation in any inbox." },
  { key: "replies", label: "Replies", detail: "When a new message arrives in an existing conversation." },
] as const;

/** Checkboxes under a notification toggle: which notifications that channel sends. */
function NotificationTypeChecks(props: {
  channel: "browser" | "email";
  settings: GeneralSettingsData;
  disabled: boolean;
}) {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (input: { type: NotificationType; checked: boolean }) =>
      updateNotificationTypes({ [input.type]: input.checked }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["settings", "general"] }),
  });
  const labelId = `${props.channel}-notification-types`;
  return (
    <fieldset className="mt-3" aria-labelledby={labelId}>
      <p id={labelId} className="text-xs font-medium text-muted-foreground">
        Send notifications for
      </p>
      <div className="mt-2 space-y-2">
        {NOTIFICATION_TYPES.map((type) => {
          const key = `${props.channel}_${type.key}` as NotificationType;
          const checked =
            save.isPending && save.variables?.type === key ? save.variables.checked : props.settings[key];
          return (
            <label key={key} htmlFor={key} className="flex w-fit items-start gap-2">
              <Checkbox
                id={key}
                checked={checked}
                onCheckedChange={(value) => save.mutate({ type: key, checked: value === true })}
                disabled={props.disabled || save.isPending}
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm text-foreground">{type.label}</span>
                <span className="block text-xs leading-5 text-muted-foreground">{type.detail}</span>
              </span>
            </label>
          );
        })}
      </div>
      {save.error && (
        <p className="mt-1 text-xs leading-5 text-destructive" role="alert">
          {save.error.message || "Couldn’t save. Try again."}
        </p>
      )}
    </fieldset>
  );
}

function EmailNotificationSetting(props: {
  settings: GeneralSettingsData | null;
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
                ? "Add an email address to get notifications by email."
                : props.enabled
                  ? `Notifications are sent to ${props.savedAddress}.`
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
            Turns this kind of notification on for the whole workspace.
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

        {props.enabled && props.savedAddress && props.settings && (
          <NotificationTypeChecks channel="email" settings={props.settings} disabled={busy} />
        )}

        {props.savedAddress && (
          <div className="mt-2 flex flex-wrap items-center gap-1 -ml-2.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEditorOpen(true)}
              disabled={!props.template}
            >
              Customize new email notice
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
    return "On iPhone and iPad, add Mailroom + to your Home Screen, then open it from there to turn on notifications.";
  }
  if (!state.supported) return "This browser does not support push notifications.";
  if (state.blocked) return "Notifications are blocked in this browser's site settings.";
  if (state.globalEnabled && state.subscribed) {
    return "This browser shows the notifications checked below.";
  }
  if (state.globalEnabled) return "Notifications are on, but this browser is not subscribed yet.";
  return "Get notifications in this browser.";
}

function browserTestMessage(
  result: BrowserPushTestResult & { thisBrowserRegistered: boolean },
): string {
  const notHere = result.thisBrowserRegistered
    ? ""
    : " This browser is not registered, so it will not get notifications. Press Enable on this browser.";
  if (result.subscriptions === 0) {
    return `No browsers are registered for notifications.${notHere}`;
  }
  const browsers = (count: number) => `${count} ${count === 1 ? "browser" : "browsers"}`;
  const names = result.deliveredTo.length > 0 ? ` (${result.deliveredTo.join(", ")})` : "";
  if (result.failures.length === 0 && result.removed === 0) {
    return `Sent to ${browsers(result.delivered)}${names}. It should appear in a few seconds.${notHere}`;
  }
  const parts = [`Delivered to ${result.delivered} of ${browsers(result.subscriptions)}${names}.`];
  if (result.removed > 0) {
    parts.push(`${browsers(result.removed)} had expired and must be turned on again.`);
  }
  for (const failure of result.failures) {
    const service = failure.service.replace(/^https:\/\//, "");
    const detail = failure.reason ? `: ${failure.reason}` : "";
    parts.push(
      failure.status
        ? `${failure.browser}: ${service} refused it (${failure.status}${detail}).`
        : `${failure.browser}: ${service} could not be reached${failure.reason ? ` (${failure.reason})` : ""}.`,
    );
  }
  return parts.join(" ") + notHere;
}

function notificationErrorMessage(error: Error): string {
  if (error instanceof BrowserPushError && error.code === "permission-denied") {
    return "Notifications were not allowed. Change this site's notification permission in your browser to try again.";
  }
  return error.message || "Couldn’t update browser notifications. Try again.";
}
