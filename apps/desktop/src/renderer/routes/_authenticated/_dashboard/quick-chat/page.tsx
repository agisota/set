import { createFileRoute } from "@tanstack/react-router";
import { QuickChatView } from "./components/QuickChatView/QuickChatView";

export const Route = createFileRoute("/_authenticated/_dashboard/quick-chat/")({
	component: QuickChatPage,
});

function QuickChatPage() {
	return <QuickChatView />;
}
