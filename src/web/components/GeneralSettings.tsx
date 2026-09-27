import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  disableBrowserNotifications,
  disableEmailNotifications,
  enableBrowserNotifications,
  fetchGeneralSettings,
  updateEmailNotifications,
} from "../api";
import type { EmailNotificationTemplate } from "../../shared/types";
import {
  BrowserPushError,
  createBrowserPushSubscription,
  getBrowserPushState,
  unsubscribeCurrentBrowser,
} from "../push-notifications";
import { BellIcon, MailIcon } from "./Icons";
import { EmailTemplateEditor } from "./EmailTemplateEditor";
import { McpSettings } from "./McpSettings";
import {
  SettingsBlock,
  SettingsHeader,
  SettingsPage,
  SettingsPanel,
} from "./SettingsNavigation";

export function GeneralSettings(props: {
  onBack: () => void;
  onOpenInboxes: () => void;
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
      />

      <SettingsPage>
        <SettingsBlock id="notification-settings-heading" title="Notifications">
          <SettingsPanel>
            <div className="flex items-start gap-4 px-4 py-4 sm:px-5">
              <div className="min-w-0 flex-1">
                <label
                  htmlFor="browser-notifications"
                  className="flex items-center gap-2 text-[13.5px] font-medium text-foreground"
                >
                  <BellIcon className="h-4 w-4 text-muted-foreground" />
                  New email notifications
                </label>
                <p className="mt-1 max-w-xl text-[13px] leading-5 text-muted-foreground">
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
              savedAddress={settings.data?.email_notification_address ?? null}
              template={settings.data?.email_notification_template ?? null}
              loading={settings.isLoading}
            />
          </SettingsPanel>
        </SettingsBlock>

        <McpSettings />
      </SettingsPage>
    </div>
  );
}

function EmailNotificationSetting(props: {
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
  const turnOff = useMutation({
    mutationFn: disableEmailNotifications,
    onSuccess: () => setAddress(""),
    onSettled: refresh,
  });

  const busy = save.isPending || turnOff.isPending;
  const trimmed = address.trim();
  const unchanged = trimmed.toLowerCase() === (props.savedAddress ?? "");
  const error = save.error ?? turnOff.error;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (trimmed) save.mutate(trimmed);
  };

  return (
    <>
      <form onSubmit={onSubmit} className="border-t px-4 py-4 sm:px-5">
        <label
          htmlFor="email-notification-address"
          className="flex items-center gap-2 text-[13.5px] font-medium text-foreground"
        >
          <MailIcon className="h-4 w-4 text-muted-foreground" />
          Email notifications
        </label>
        <p className="mt-1 max-w-xl text-[13px] leading-5 text-muted-foreground">
          {props.savedAddress
            ? `A notice is sent to ${props.savedAddress} when any inbox receives a new email.`
            : "Send a notice to an email address when any inbox receives a new email."}
        </p>
        <div className="mt-3 flex max-w-xl flex-wrap items-center gap-2">
          <Input
            id="email-notification-address"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            disabled={props.loading || busy}
            className="min-w-[14rem] flex-1"
          />
          <Button
            type="submit"
            size="sm"
            disabled={props.loading || busy || !trimmed || unchanged}
          >
            {save.isPending ? "Saving…" : props.savedAddress ? "Update" : "Turn on"}
          </Button>
          {props.savedAddress && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => turnOff.mutate()}
              disabled={busy}
            >
              {turnOff.isPending ? "Turning off…" : "Turn off"}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setEditorOpen(true)}
            disabled={!props.template}
          >
            Customize email
          </Button>
        </div>
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
