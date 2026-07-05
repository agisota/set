import {
	PromptInputFooter,
	PromptInputSubmit,
	PromptInputTools,
} from "@rox/ui/ai-elements/prompt-input";
import type { ThinkingLevel } from "@rox/ui/ai-elements/thinking-toggle";
import { ReasoningLevelSlider } from "@rox/ui/motion";
import {
	MicButton,
	type MicButtonControls,
	type Recording,
} from "@rox/ui/voice";
import type { ChatStatus } from "ai";
import { ArrowUpIcon, Loader2Icon, SquareIcon } from "lucide-react";
import type React from "react";
import { useCallback, useRef } from "react";
import { getDictationDisabledReason } from "renderer/components/Chat/ChatInterface/components/ChatInputFooter/components/ChatComposerControls/dictationAffordance";
import { PermissionModePicker } from "renderer/components/Chat/ChatInterface/components/PermissionModePicker";
import { PlusMenu } from "renderer/components/Chat/ChatInterface/components/PlusMenu";
import { PILL_BUTTON_CLASS } from "renderer/components/Chat/ChatInterface/styles";
import type {
	ModelOption,
	PermissionMode,
} from "renderer/components/Chat/ChatInterface/types";
import { useHotkey } from "renderer/hotkeys";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { ModelPicker } from "../../../ModelPicker";

interface ChatComposerControlsProps {
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
	canAbort: boolean;
	submitStatus?: ChatStatus;
	submitDisabled?: boolean;
	onStop: (event: React.MouseEvent) => void;
	onDictationComplete?: (recording: Recording, locked: boolean) => void;
	dictationTranscribing?: boolean;
	dictationConfigured?: boolean;
	usedTokens?: number;
	maxTokens?: number;
}

export function ChatComposerControls({
	availableModels,
	selectedModel,
	setSelectedModel,
	modelSelectorOpen,
	setModelSelectorOpen,
	unresolvedModelId: _unresolvedModelId,
	permissionMode,
	setPermissionMode,
	thinkingLevel,
	setThinkingLevel,
	canAbort,
	submitStatus,
	submitDisabled,
	onStop,
	onDictationComplete,
	dictationTranscribing,
	dictationConfigured,
	usedTokens: _usedTokens,
	maxTokens: _maxTokens,
}: ChatComposerControlsProps) {
	const dictationEnabled =
		electronTrpc.settings.getDictationEnabled.useQuery().data;
	const { data: permissionStatus } =
		electronTrpc.permissions.getStatus.useQuery();
	const micDisabledReason = getDictationDisabledReason({
		dictationEnabled,
		dictationConfigured,
		microphoneGranted: permissionStatus?.microphone,
	});
	const micDisabled = micDisabledReason !== undefined;
	const micControlsRef = useRef<MicButtonControls | null>(null);
	const handleMicReady = useCallback((controls: MicButtonControls | null) => {
		micControlsRef.current = controls;
	}, []);
	useHotkey("DICTATE", () => {
		if (micDisabled) return;
		micControlsRef.current?.toggle();
	});

	return (
		<PromptInputFooter>
			<PromptInputTools className="gap-1.5">
				<PermissionModePicker
					selectedMode={permissionMode}
					onSelectMode={setPermissionMode}
				/>
				<ModelPicker
					models={availableModels}
					selectedModel={selectedModel}
					onSelectModel={setSelectedModel}
					open={modelSelectorOpen}
					onOpenChange={setModelSelectorOpen}
				/>
				<ReasoningLevelSlider
					level={thinkingLevel}
					onLevelChange={setThinkingLevel}
					className={PILL_BUTTON_CLASS}
				/>
			</PromptInputTools>
			<div className="flex items-center gap-2">
				<PlusMenu />
				<MicButton
					onComplete={onDictationComplete}
					transcribing={dictationTranscribing}
					disabled={micDisabled}
					disabledReason={micDisabledReason}
					onReady={handleMicReady}
				/>
				<PromptInputSubmit
					className="size-[23px] rounded-full border border-transparent bg-foreground/10 shadow-none p-[5px] hover:bg-foreground/20"
					status={submitStatus}
					disabled={!canAbort && submitDisabled}
					onClick={canAbort ? onStop : undefined}
				>
					{canAbort ? (
						<SquareIcon className="size-3.5 text-muted-foreground" />
					) : submitStatus === "submitted" || submitDisabled ? (
						<Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />
					) : (
						<ArrowUpIcon className="size-3.5 text-muted-foreground" />
					)}
				</PromptInputSubmit>
			</div>
		</PromptInputFooter>
	);
}
