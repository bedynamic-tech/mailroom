import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { fetchGeneralSettings, setAutoCreateContacts } from "../api";
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
      </SettingsPage>
    </div>
  );
}
