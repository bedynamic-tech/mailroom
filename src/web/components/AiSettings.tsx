import { McpSettings } from "./McpSettings";
import { SettingsHeader, SettingsPage } from "./SettingsNavigation";

export function AiSettings(props: {
  onBack: () => void;
  onOpenGeneral: () => void;
  onOpenInboxes: () => void;
  onOpenContacts: () => void;
}) {
  return (
    <div className="flex h-full min-w-0 flex-col bg-canvas">
      <SettingsHeader
        active="ai"
        onBack={props.onBack}
        onOpenGeneral={props.onOpenGeneral}
        onOpenInboxes={props.onOpenInboxes}
        onOpenContacts={props.onOpenContacts}
        onOpenAi={() => undefined}
      />

      <SettingsPage>
        <McpSettings />
      </SettingsPage>
    </div>
  );
}
