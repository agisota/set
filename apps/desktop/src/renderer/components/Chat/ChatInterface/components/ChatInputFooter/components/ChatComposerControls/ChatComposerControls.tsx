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
import { useHotkey } from "renderer/hotkeys";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { PILL_BUTTON_CLASS } from "../../../../styles";
import type { ModelOption, PermissionMode } from "../../../../types";
import { ModelPicker } from "../../../ModelPicker";
import { PermissionModePicker } from "../../../PermissionModePicker";
import { PlusMenu } from "../../../PlusMenu";
import { getDictationDisabledReason } from "./dictationAffordance";

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
	/** Server-side Whisper availability (voice.isConfigured). Off → mic disabled. */
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
	// Plain dictation can be turned off in Settings → Voice. Cache-first: only
	// treat as off once we've explicitly read `false` (undefined = loading → keep
	// the default-on mic so it doesn't flicker out on mount). The shared MicButton
	// stays IPC-free, so the toggle is read here at the desktop edge and folded
	// into `disabled` (and the hotkey gate) below.
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

	// Desktop keyboard shortcut for dictation. The shared MicButton is hotkey-free;
	// it hands us a stable toggle via onReady and we bind DICTATE (Ctrl+Shift+D) to
	// it here, where the renderer hotkey system lives. Web mounts MicButton with no
	// onReady, so it has no shortcut — by design. Gated off when the user disabled
	// dictation in Settings → Voice.
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
