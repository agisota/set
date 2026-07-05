type QuickChatStatus = "ok" | "needs-user-key" | "not-configured";

export type QuickChatOutcome = "reply" | "notice" | "not-configured";

export function resolveQuickChatOutcome(
	status: QuickChatStatus,
): QuickChatOutcome {
	if (status === "ok") return "reply";
	if (status === "needs-user-key") return "notice";
	return "not-configured";
}

export function shouldBlockSend({
	trimmedInputLength,
	isSending,
	notConfigured,
}: {
	trimmedInputLength: number;
	isSending: boolean;
	notConfigured: boolean;
}): boolean {
	return trimmedInputLength === 0 || isSending || notConfigured;
}
