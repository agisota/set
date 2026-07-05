import type { ChatPaneData } from "../../../../types";
import { GovernanceTabContent } from "../../hooks/useGovernanceTab/components/GovernanceTabContent";

interface FusionTabProps {
	workspaceId: string;
	onOpenChat?: (launchConfig?: ChatPaneData["launchConfig"]) => void;
}

export function FusionTab({ workspaceId, onOpenChat }: FusionTabProps) {
	return (
		<GovernanceTabContent
			workspaceId={workspaceId}
			onOpenChat={onOpenChat ?? (() => {})}
		/>
	);
}
