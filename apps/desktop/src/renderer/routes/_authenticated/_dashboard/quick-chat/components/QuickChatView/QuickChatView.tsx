import {
	AVAILABLE_CHAT_MODELS,
	isRoxHouseModel,
	ROX_CHAT_MODEL,
	ROX_CHAT_MODEL_NAME,
} from "@rox/shared/chat-models";
import { Button } from "@rox/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@rox/ui/dropdown-menu";
import { Textarea } from "@rox/ui/textarea";
import { cn } from "@rox/ui/utils";
import {
	blobToBase64,
	MicButton,
	type MicButtonControls,
	type Recording,
} from "@rox/ui/voice";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	LuArrowUp,
	LuChevronDown,
	LuLoaderCircle,
	LuSettings,
	LuSparkles,
} from "react-icons/lu";
import { getDictationDisabledReason } from "renderer/components/Chat/ChatInterface/components/ChatInputFooter/components/ChatComposerControls/dictationAffordance";
import { useHotkey } from "renderer/hotkeys";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { logger } from "renderer/lib/logger";
import { apiClient } from "renderer/routes/_authenticated/providers/CollectionsProvider/collections";
import { useQuickChatDraftStore } from "renderer/stores/quick-chat-draft";
import { DEFAULT_SAVED_PROMPTS } from "../../../saved-prompts/components/SavedPromptsView/default-prompts";
import {
	DEFAULT_REASONING_LEVEL,
	REASONING_LEVELS,
	type ReasoningLevel,
	STARTER_PROMPT_IDS,
} from "./constants";
import { resolveQuickChatOutcome, shouldBlockSend } from "./quick-chat-state";

interface QuickChatMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
}

/** RU notice shown when a non-Rox model is picked but no user key is configured. */
const NEEDS_USER_KEY_NOTICE = `Для этой модели нужен ваш ключ провайдера. Откройте «Настройки → Модели», чтобы добавить ключ, либо выберите ${ROX_CHAT_MODEL_NAME} — она работает без настройки.`;
/**
 * RU banner shown when the Rox house model itself is not configured server-side.
 * Rendered as an inline actionable affordance (with a CTA to «Настройки →
 * Модели») rather than a dead assistant bubble, and send is disabled while it is
 * active so the user can't keep hitting the same dead end.
 */
const NOT_CONFIGURED_BANNER =
	`${ROX_CHAT_MODEL_NAME} сейчас недоступна — серверный ключ не настроен. ` +
	"Добавьте ключ модели в настройках или выберите другую модель со своим ключом.";
/** CTA label on the not-configured banner. */
const NOT_CONFIGURED_CTA = "Открыть «Настройки → Модели»";
const GENERIC_ERROR_NOTICE =
	"Не удалось получить ответ. Проверьте соединение и попробуйте снова.";

/**
 * Starter chips for the empty state — a curated subset of the shared
 * `DEFAULT_SAVED_PROMPTS`, kept in the saved-prompts list so both surfaces share
 * one source. Order follows `STARTER_PROMPT_IDS`; unknown ids are dropped.
 */
const STARTER_PROMPTS = STARTER_PROMPT_IDS.flatMap((id) => {
	const prompt = DEFAULT_SAVED_PROMPTS.find((entry) => entry.id === id);
	return prompt ? [prompt] : [];
});

export function QuickChatView() {
	const consumePrompt = useQuickChatDraftStore((state) => state.consumePrompt);
	const navigate = useNavigate();

	const [model, setModel] = useState(ROX_CHAT_MODEL);
	const [reasoning, setReasoning] = useState<ReasoningLevel>(
		DEFAULT_REASONING_LEVEL,
	);
	const [input, setInput] = useState("");
	const [messages, setMessages] = useState<QuickChatMessage[]>([]);
	const [isSending, setIsSending] = useState(false);
	const [isTranscribing, setIsTranscribing] = useState(false);
	// Set when the house model reports `not-configured`: instead of a dead
	// assistant bubble we surface an inline actionable banner and disable send so
	// the user can fix it (add a key / switch model) rather than dead-end.
	const [notConfigured, setNotConfigured] = useState(false);
	// One persisted chat_sessions row per QuickChat conversation. Generated lazily
	// on first send and reused for the rest of the conversation so the whole thread
	// lands in a single session the Журнал can summarize.
	const sessionIdRef = useRef<string | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const micControlsRef = useRef<MicButtonControls | null>(null);

	const { data: voiceConfig } = useQuery({
		queryKey: ["voice", "isConfigured"],
		queryFn: () => apiClient.voice.isConfigured.query(),
		staleTime: Number.POSITIVE_INFINITY,
	});
	const dictationEnabled =
		electronTrpc.settings.getDictationEnabled.useQuery().data;
	const { data: permissionStatus } =
		electronTrpc.permissions.getStatus.useQuery();
	const electronUtils = electronTrpc.useUtils();
	const micDisabledReason = getDictationDisabledReason({
		dictationEnabled,
		dictationConfigured: voiceConfig?.configured,
		microphoneGranted: permissionStatus?.microphone,
	});
	const micDisabled = micDisabledReason !== undefined;

	// Fill the composer from a starter chip and focus it so the user can edit or
	// send. Reuses the same `setInput` path as the saved-prompts draft handoff.
	const applyStarterPrompt = useCallback((body: string) => {
		setInput(body);
		const textarea = textareaRef.current;
		if (textarea) {
			textarea.focus();
			const caret = body.length;
			textarea.setSelectionRange(caret, caret);
		}
	}, []);

	const appendDictatedText = useCallback((text: string) => {
		setInput((prev) => (prev.trim().length > 0 ? `${prev} ${text}` : text));
		setNotConfigured(false);
		requestAnimationFrame(() => {
			const textarea = textareaRef.current;
			if (!textarea) return;
			textarea.focus();
			const caret = textarea.value.length;
			textarea.setSelectionRange(caret, caret);
		});
	}, []);

	const handleDictationComplete = useCallback(
		async (recording: Recording) => {
			setIsTranscribing(true);
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
				if (!text) return;
				appendDictatedText(text);
			} catch (error) {
				logger.error("[quick-chat] dictation failed", error);
			} finally {
				setIsTranscribing(false);
			}
		},
		[appendDictatedText, electronUtils],
	);

	const handleMicReady = useCallback((controls: MicButtonControls | null) => {
		micControlsRef.current = controls;
	}, []);

	useHotkey("DICTATE", () => {
		if (micDisabled) return;
		micControlsRef.current?.toggle();
	});

	// Pick up a prompt staged from the "Сохранённые промпты" view, if any.
	useEffect(() => {
		const staged = consumePrompt();
		if (staged) setInput(staged);
	}, [consumePrompt]);

	useEffect(() => {
		scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
	}, []);

	const scrollToBottom = useCallback(() => {
		requestAnimationFrame(() => {
			scrollRef.current?.scrollTo({
				top: scrollRef.current.scrollHeight,
				behavior: "smooth",
			});
		});
	}, []);

	const send = useCallback(async () => {
		const text = input.trim();
		if (
			shouldBlockSend({
				trimmedInputLength: text.length,
				isSending,
				notConfigured,
			})
		) {
			return;
		}

		if (!sessionIdRef.current) {
			sessionIdRef.current = crypto.randomUUID();
		}
		const sessionId = sessionIdRef.current;

		const now = Date.now();
		const userMessage: QuickChatMessage = {
			id: `u-${now}`,
			role: "user",
			text,
		};
		// History sent to the model: prior turns + this one (excludes placeholders).
		const history = [...messages, userMessage].map((message) => ({
			role: message.role,
			content: message.text,
		}));

		setMessages((prev) => [...prev, userMessage]);
		setInput("");
		setIsSending(true);
		scrollToBottom();

		const appendAssistant = (assistantText: string) => {
			setMessages((prev) => [
				...prev,
				{ id: `a-${now}`, role: "assistant", text: assistantText },
			]);
			scrollToBottom();
		};

		try {
			const result = await apiClient.chat.complete.mutate({
				sessionId,
				messages: history,
				modelId: model.id,
				reasoning,
			});

			const outcome = resolveQuickChatOutcome(result.status);
			if (outcome === "reply" && result.status === "ok") {
				appendAssistant(result.reply);
			} else if (outcome === "notice") {
				appendAssistant(NEEDS_USER_KEY_NOTICE);
			} else {
				// House model has no server key: don't append a dead assistant
				// bubble. Surface the inline actionable banner instead and keep the
				// user's text in the composer so they can retry after fixing it.
				setNotConfigured(true);
				setInput(text);
				setMessages((prev) =>
					prev.filter((message) => message.id !== userMessage.id),
				);
			}
		} catch (error) {
			logger.error("[quick-chat] completion failed", error);
			appendAssistant(GENERIC_ERROR_NOTICE);
		} finally {
			setIsSending(false);
		}
	}, [
		input,
		isSending,
		notConfigured,
		messages,
		model.id,
		reasoning,
		scrollToBottom,
	]);

	const openModelSettings = useCallback(() => {
		void navigate({ to: "/settings/models" });
	}, [navigate]);

	const isEmpty = messages.length === 0;
	const isHouseModel = isRoxHouseModel(model.id);

	return (
		<div className="flex h-full w-full flex-1 flex-col overflow-hidden">
			<header className="flex items-center gap-2 border-b border-border px-6 py-4">
				<LuSparkles className="size-5 text-muted-foreground" />
				<div className="min-w-0">
					<h1 className="text-lg font-semibold text-foreground">Быстрый чат</h1>
					<p className="text-sm text-muted-foreground">
						Начните разговор сразу — без проекта и репозитория.
					</p>
				</div>
			</header>

			<div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6">
				<div className="mx-auto flex max-w-2xl flex-col gap-4">
					{isEmpty ? (
						<div className="mt-12 flex flex-col items-center gap-2 text-center">
							<LuSparkles className="size-8 text-muted-foreground/60" />
							<p className="text-base font-medium text-foreground">
								Чем помочь?
							</p>
							<p className="max-w-md text-sm text-muted-foreground">
								Задайте вопрос модели {ROX_CHAT_MODEL.name}. Это обычный чат —
								проект создавать не нужно.
							</p>
							{input.trim().length === 0 ? (
								<div className="mt-4 flex flex-wrap justify-center gap-2">
									{STARTER_PROMPTS.map((prompt) => (
										<Button
											key={prompt.id}
											type="button"
											variant="outline"
											size="sm"
											className="h-7 rounded-full px-3 text-xs font-normal text-muted-foreground hover:text-foreground"
											onClick={() => applyStarterPrompt(prompt.body)}
										>
											{prompt.title}
										</Button>
									))}
								</div>
							) : null}
						</div>
					) : (
						messages.map((message) => (
							<div
								key={message.id}
								className={cn(
									"flex",
									message.role === "user" ? "justify-end" : "justify-start",
								)}
							>
								<div
									className={cn(
										"max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm select-text",
										message.role === "user"
											? "bg-primary text-primary-foreground"
											: "bg-muted text-foreground",
									)}
								>
									{message.text}
								</div>
							</div>
						))
					)}
					{isSending ? (
						<div className="flex justify-start">
							<div className="flex items-center gap-2 rounded-2xl bg-muted px-4 py-2.5 text-sm text-muted-foreground">
								<LuLoaderCircle className="size-4 animate-spin" />
								{model.name} печатает…
							</div>
						</div>
					) : null}
				</div>
			</div>

			<div className="border-t border-border px-6 py-4">
				{notConfigured ? (
					<div
						role="alert"
						className="mx-auto mb-2 flex max-w-2xl flex-col gap-2 rounded-xl border border-border bg-muted/40 p-3 sm:flex-row sm:items-center sm:justify-between"
					>
						<p className="text-xs text-muted-foreground">
							{NOT_CONFIGURED_BANNER}
						</p>
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="h-7 shrink-0 gap-1.5 rounded-full px-3 text-xs"
							onClick={openModelSettings}
						>
							<LuSettings className="size-3.5" />
							{NOT_CONFIGURED_CTA}
						</Button>
					</div>
				) : null}
				<div className="mx-auto flex max-w-2xl flex-col gap-2 rounded-xl border border-border bg-card p-2">
					<Textarea
						ref={textareaRef}
						value={input}
						onChange={(event) => {
							setInput(event.target.value);
							if (notConfigured) setNotConfigured(false);
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								void send();
							}
						}}
						placeholder="Напишите сообщение…"
						className="min-h-16 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
					/>
					<div className="flex items-center gap-2">
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									variant="outline"
									size="sm"
									className="h-7 gap-1 rounded-full px-2.5 text-xs"
								>
									{model.name}
									<LuChevronDown className="size-3" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent
								align="start"
								className="max-h-72 overflow-y-auto"
							>
								{AVAILABLE_CHAT_MODELS.map((option) => (
									<DropdownMenuItem
										key={option.id}
										onSelect={() => {
											setModel(option);
											setNotConfigured(false);
										}}
										className={cn(option.id === model.id && "font-medium")}
									>
										{option.name}
									</DropdownMenuItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>

						<div className="flex items-center gap-0.5 rounded-full border border-border p-0.5">
							{REASONING_LEVELS.map((level) => (
								<button
									key={level}
									type="button"
									onClick={() => setReasoning(level)}
									className={cn(
										"rounded-full px-2 py-0.5 text-[11px] transition-colors",
										level === reasoning
											? "bg-accent text-foreground"
											: "text-muted-foreground hover:text-foreground",
									)}
								>
									{level}
								</button>
							))}
						</div>

						<div className="ml-auto flex size-8 items-center justify-center">
							<MicButton
								onComplete={handleDictationComplete}
								transcribing={isTranscribing}
								disabled={micDisabled}
								disabledReason={micDisabledReason}
								onReady={handleMicReady}
							/>
						</div>

						<Button
							size="icon"
							className="size-8 rounded-full"
							disabled={input.trim().length === 0 || isSending || notConfigured}
							onClick={() => void send()}
							aria-label="Отправить"
						>
							{isSending ? (
								<LuLoaderCircle className="size-4 animate-spin" />
							) : (
								<LuArrowUp className="size-4" />
							)}
						</Button>
					</div>
					{!isHouseModel ? (
						<p className="px-1 text-[11px] text-muted-foreground">
							{ROX_CHAT_MODEL_NAME} работает без настройки. Для {model.name}{" "}
							нужен ваш ключ провайдера.
						</p>
					) : null}
				</div>
			</div>
		</div>
	);
}
