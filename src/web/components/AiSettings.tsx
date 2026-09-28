import { McpSettings } from "./McpSettings";
import { SettingsHeader, SettingsPage } from "./SettingsNavigation";

export function AiSettings(props: {
  onBack: () => void;
  onOpenGeneral: () => void;
  onOpenNotifications: () => void;
  onOpenInboxes: () => void;
  onOpenContacts: () => void;
  onOpenRules: () => void;
  onOpenSpam: () => void;
}) {
  return (
    <div className="flex h-full min-w-0 flex-col bg-canvas">
      <SettingsHeader
        active="ai"
        onBack={props.onBack}
        onOpenGeneral={props.onOpenGeneral}
        onOpenNotifications={props.onOpenNotifications}
        onOpenInboxes={props.onOpenInboxes}
        onOpenContacts={props.onOpenContacts}
        onOpenRules={props.onOpenRules}
        onOpenSpam={props.onOpenSpam}
        onOpenAi={() => undefined}
      />

      <SettingsPage>
        <McpSettings />
      </SettingsPage>
    </div>
  );
}
