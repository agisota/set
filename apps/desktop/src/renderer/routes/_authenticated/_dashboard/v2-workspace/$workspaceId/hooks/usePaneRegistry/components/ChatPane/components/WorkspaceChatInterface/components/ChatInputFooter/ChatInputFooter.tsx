import {
	PromptInput,
	PromptInputAttachment,
	PromptInputAttachments,
	type PromptInputMessage,
	usePromptInputController,
} from "@rox/ui/ai-elements/prompt-input";
import type { ThinkingLevel } from "@rox/ui/ai-elements/thinking-toggle";
import { toast } from "@rox/ui/sonner";
import { blobToBase64, type Recording } from "@rox/ui/voice";
import { workspaceTrpc } from "@rox/workspace-client";
import { useQuery } from "@tanstack/react-query";
import type { ChatStatus, FileUIPart } from "ai";
import type React from "react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { QuestionInputOverlay } from "renderer/components/Chat/ChatInterface/components/ChatInputFooter/components/QuestionInputOverlay";
import { TiptapPromptEditor } from "renderer/components/Chat/ChatInterface/components/TiptapPromptEditor";
import { useFocusPromptOnPane } from "renderer/components/Chat/ChatInterface/hooks/useFocusPromptOnPane";
import type { SlashCommand } from "renderer/components/Chat/ChatInterface/hooks/useSlashCommands";
import type {
	ModelOption,
	PermissionMode,
} from "renderer/components/Chat/ChatInterface/types";
import { useHotkeyDisplay } from "renderer/hotkeys";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { apiClient } from "renderer/routes/_authenticated/providers/CollectionsProvider/collections";
import { ChatComposerControls } from "./components/ChatComposerControls";
import { ChatInputDropZone } from "./components/ChatInputDropZone";
import { ChatShortcuts } from "./components/ChatShortcuts";
import { FileDropOverlay } from "./components/FileDropOverlay";
import { LinkedIssues } from "./components/LinkedIssues";
import { SlashCommandPreview } from "./components/SlashCommandPreview";
import type { LinkedIssue } from "./types";
import { getErrorMessage } from "./utils/getErrorMessage";

interface ChatInputFooterProps {
	workspaceId: string;
	cwd: string;
	isFocused: boolean;
	error: unknown;
	canAbort: boolean;
	submitStatus?: ChatStatus;
	availableModels: ModelOption[];
	selectedModel: ModelOption | null;
	setSelectedModel: React.Dispatch<React.SetStateAction<ModelOption | null>>;
	modelSelectorOpen: boolean;
	setModelSelectorOpen: React.Dispatch<React.SetStateAction<boolean>>;
	unresolvedModelId?: string | null;
	permissionMode: PermissionMode;
	setPermissionMode: (mode: PermissionMode) => void;
	thinkingLevel: ThinkingLevel;
	setThinkingLevel: (level: ThinkingLevel) => void;
	slashCommands: SlashCommand[];
	submitDisabled?: boolean;
	renderAttachment?: (file: FileUIPart & { id: string }) => ReactNode;
	onSubmitStart?: () => void;
	onSubmitEnd?: () => void;
	onSend: (message: PromptInputMessage) => Promise<void> | void;
	onStop: (e: React.MouseEvent) => void;
	pendingQuestion?: {
		questionId: string;
		question: string;
		options?: { label: string; description?: string }[];
	} | null;
	isQuestionSubmitting?: boolean;
	onQuestionRespond?: (questionId: string, answer: string) => Promise<void>;
	onQuestionCancel?: () => void;
	usedTokens?: number;
	maxTokens?: number;
}

export function ChatInputFooter({
	workspaceId,
	cwd,
	isFocused,
	error,
	canAbort,
	submitStatus,
	availableModels,
	selectedModel,
	setSelectedModel,
	modelSelectorOpen,
	setModelSelectorOpen,
	unresolvedModelId,
	permissionMode,
	setPermissionMode,
	thinkingLevel,
	setThinkingLevel,
	slashCommands,
	submitDisabled,
	renderAttachment,
	onSubmitStart,
	onSubmitEnd,
	onSend,
	onStop,
	pendingQuestion,
	isQuestionSubmitting,
	onQuestionRespond,
	onQuestionCancel,
	usedTokens,
	maxTokens,
}: ChatInputFooterProps) {
	useFocusPromptOnPane(isFocused);

	// Re-focus the editor when the question overlay dismisses.
	const { textInput } = usePromptInputController();
	const prevPendingQuestionRef = useRef(pendingQuestion);
	useEffect(() => {
		const prev = prevPendingQuestionRef.current;
		prevPendingQuestionRef.current = pendingQuestion;
		if (prev != null && pendingQuestion == null) {
			const id = requestAnimationFrame(() => textInput.focus());
			return () => cancelAnimationFrame(id);
		}
	}, [pendingQuestion, textInput]);

	const [linkedIssues, setLinkedIssues] = useState<LinkedIssue[]>([]);
	const inputRootRef = useRef<HTMLDivElement>(null);
	const errorMessage = getErrorMessage(error);
	const focusShortcutText = useHotkeyDisplay("FOCUS_CHAT_INPUT").text;
	const showFocusHint = focusShortcutText !== "Unassigned";

	const removeLinkedIssue = useCallback((slug: string) => {
		setLinkedIssues((prev) => prev.filter((issue) => issue.slug !== slug));
	}, []);

	const trpcUtils = workspaceTrpc.useUtils();
	const electronUtils = electronTrpc.useUtils();
	const { data: voiceConfig } = useQuery({
		queryKey: ["voice", "isConfigured"],
		queryFn: () => apiClient.voice.isConfigured.query(),
		staleTime: Number.POSITIVE_INFINITY,
	});
	const dictationConfigured = voiceConfig?.configured;
	const searchFiles = useCallback(
		async (query: string) => {
			const { matches } = await trpcUtils.filesystem.searchFiles.fetch({
				workspaceId,
				query,
				includeHidden: false,
				limit: 20,
			});
			return matches.map((m) => ({
				id: m.absolutePath,
				name: m.name,
				relativePath: m.relativePath,
			}));
		},
		[trpcUtils, workspaceId],
	);

	const handleSend = useCallback(
		(message: PromptInputMessage) => {
			if (linkedIssues.length === 0) return onSend(message);

			const prefix = linkedIssues
				.map((issue) => `@task:${issue.slug}`)
				.join(" ");
			const modifiedMessage: PromptInputMessage = {
				...message,
				text: `${prefix} ${message.text}`,
			};
			setLinkedIssues([]);
			return onSend(modifiedMessage);
		},
		[linkedIssues, onSend],
	);

	const [transcribing, setTranscribing] = useState(false);
	const handleDictationComplete = useCallback(
		async (recording: Recording, locked: boolean) => {
			setTranscribing(true);
			try {
				const audioBase64 = await blobToBase64(recording.blob);
				const voiceAgentContext =
					await electronUtils.settings.getVoiceAgentContext
						.fetch()
						.catch(() => "");
				const result = await apiClient.voice.transcribe.mutate({
					audioBase64,
					mimeType: recording.mimeType,
					durationMs: recording.durationMs,
					voiceAgentContext: voiceAgentContext?.trim() || undefined,
				});
				const text = (result.processed?.ru || result.rawText || "").trim();
				if (!text) {
					toast.info("Не удалось распознать речь");
					return;
				}
				if (locked) {
					const prev = textInput.value;
					textInput.setInput(prev ? `${prev} ${text}` : text);
					textInput.focus();
				} else {
					void handleSend({ text, files: [] });
				}
			} catch {
				toast.error("Ошибка расшифровки — запись сохранена для повтора");
			} finally {
				setTranscribing(false);
			}
		},
		[textInput, handleSend, electronUtils],
	);

	return (
		<ChatInputDropZone className="bg-background px-4 py-3">
			{(dragType) => (
				<div className="mx-auto w-full max-w-[680px]">
					{errorMessage && (
						<p
							role="alert"
							className="mb-3 select-text rounded-md border border-destructive/20 bg-destructive/10 px-4 py-2 text-sm text-destructive"
						>
							{errorMessage}
						</p>
					)}
					{pendingQuestion && onQuestionRespond && onQuestionCancel ? (
						<QuestionInputOverlay
							key={pendingQuestion.questionId}
							question={pendingQuestion}
							isSubmitting={isQuestionSubmitting ?? false}
							onRespond={onQuestionRespond}
							onCancel={onQuestionCancel}
						/>
					) : (
						<div
							ref={inputRootRef}
							className={
								dragType === "path"
									? "relative opacity-50 transition-opacity"
									: "relative"
							}
						>
							{showFocusHint && (
								<span className="pointer-events-none absolute top-3 right-3 z-10 text-xs text-muted-foreground/50 [:focus-within>&]:hidden">
									{focusShortcutText} — фокус
								</span>
							)}
							<PromptInput
								className="[&>[data-slot=input-group]]:rounded-[13px] [&>[data-slot=input-group]]:border-[0.5px] [&>[data-slot=input-group]]:shadow-none [&>[data-slot=input-group]]:bg-foreground/[0.02]"
								onSubmitStart={onSubmitStart}
								onSubmitEnd={onSubmitEnd}
								onSubmit={handleSend}
								multiple
								maxFiles={5}
								maxFileSize={10 * 1024 * 1024}
								globalDrop
							>
								<ChatShortcuts isFocused={isFocused} />
								<FileDropOverlay visible={dragType === "files"} />
								<PromptInputAttachments>
									{renderAttachment ??
										((file) => <PromptInputAttachment data={file} />)}
								</PromptInputAttachments>
								<LinkedIssues
									issues={linkedIssues}
									onRemove={removeLinkedIssue}
								/>
								<SlashCommandPreview
									workspaceId={workspaceId}
									slashCommands={slashCommands}
								/>
								<TiptapPromptEditor
									cwd={cwd}
									searchFiles={searchFiles}
									slashCommands={slashCommands}
									availableModels={availableModels}
									placeholder="Попросите внести изменения, @упомяните файлы, /команды"
								/>
								<ChatComposerControls
									availableModels={availableModels}
									selectedModel={selectedModel}
									setSelectedModel={setSelectedModel}
									modelSelectorOpen={modelSelectorOpen}
									setModelSelectorOpen={setModelSelectorOpen}
									unresolvedModelId={unresolvedModelId}
									permissionMode={permissionMode}
									setPermissionMode={setPermissionMode}
									thinkingLevel={thinkingLevel}
									setThinkingLevel={setThinkingLevel}
									canAbort={canAbort}
									submitStatus={submitStatus}
									submitDisabled={submitDisabled}
									onStop={onStop}
									onDictationComplete={handleDictationComplete}
									dictationTranscribing={transcribing}
									dictationConfigured={dictationConfigured}
									usedTokens={usedTokens}
									maxTokens={maxTokens}
								/>
							</PromptInput>
						</div>
					)}
					<div className="py-1.5" />
				</div>
			)}
		</ChatInputDropZone>
	);
}
