import { cn } from "@rox/ui/utils";
import { Loader2Icon, MicIcon } from "lucide-react";
import type React from "react";
import { useEffect, useRef } from "react";
import { canStartDictation } from "../canStartDictation";
import { type Recording, useDictation } from "../useDictation";
import { WaveformOverlay } from "./WaveformOverlay";

/** Upward drag (px) past which a held recording locks into toggle mode. */
const LOCK_DRAG_THRESHOLD = 44;

/**
 * Imperative controls a host (e.g. a desktop hotkey) can drive. `toggle` mirrors
 * the keyboard behavior the desktop used to own internally: start+lock when idle,
 * stop when active — but only if dictation may currently start.
 */
export interface MicButtonControls {
	toggle: () => void;
}

export interface MicButtonProps {
	onComplete?: (recording: Recording, locked: boolean) => void;
	transcribing?: boolean;
	disabled?: boolean;
	disabledReason?: string;
	/**
	 * Receives imperative controls once mounted (and `null` on unmount). The
	 * desktop edge uses this to bind `useHotkey("DICTATE", controls.toggle)`
	 * outside this package so @rox/ui stays free of renderer/hotkeys. Web omits it.
	 */
	onReady?: (controls: MicButtonControls | null) => void;
}

/**
 * Dictation mic button with two gestures:
 *   - **push-to-talk**: press and hold to record, release to stop + send.
 *   - **toggle-lock**: press, drag up past a threshold to lock; release keeps
 *     recording; a later tap stops + sends.
 *
 * Platform-neutral: no hotkey/IPC imports. A keyboard shortcut is wired by the
 * host via `onReady` (see desktop ChatComposerControls).
 */
export function MicButton({
	onComplete,
	transcribing,
	disabled,
	disabledReason,
	onReady,
}: MicButtonProps) {
	const dictation = useDictation({ onComplete });
	const pointerStartY = useRef<number | null>(null);

	// Expose a stable toggle to the host (desktop binds it to the DICTATE hotkey:
	// press to start+lock, press again to stop + insert). Kept in a ref so the
	// identity handed to the host never changes while still seeing live state.
	const dictationRef = useRef(dictation);
	dictationRef.current = dictation;
	const disabledRef = useRef(disabled);
	disabledRef.current = disabled;
	const transcribingRef = useRef(transcribing);
	transcribingRef.current = transcribing;

	const controlsRef = useRef<MicButtonControls>({
		toggle: () => {
			if (!canStartDictation(disabledRef.current, transcribingRef.current)) {
				// Still allow stopping an in-progress (e.g. locked) recording.
				if (dictationRef.current.isActive) dictationRef.current.stop();
				return;
			}
			if (dictationRef.current.isActive) {
				dictationRef.current.stop();
			} else {
				void dictationRef.current
					.start()
					.then(() => dictationRef.current.lock());
			}
		},
	});

	useEffect(() => {
		onReady?.(controlsRef.current);
		return () => onReady?.(null);
	}, [onReady]);

	const handlePointerDown = (e: React.PointerEvent) => {
		if (!canStartDictation(disabled, transcribing)) return;
		e.preventDefault();
		// A tap while locked stops + sends.
		if (dictation.isLocked) {
			dictation.stop();
			return;
		}
		pointerStartY.current = e.clientY;
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		void dictation.start();
	};

	const handlePointerMove = (e: React.PointerEvent) => {
		if (pointerStartY.current == null || dictation.state !== "recording")
			return;
		if (pointerStartY.current - e.clientY > LOCK_DRAG_THRESHOLD) {
			dictation.lock();
		}
	};

	const handlePointerUp = (e: React.PointerEvent) => {
		(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
		pointerStartY.current = null;
		// PTT release stops + sends; a locked recording keeps going until tapped.
		if (dictation.state === "recording") dictation.stop();
	};

	return (
		<>
			{dictation.isActive && (
				<WaveformOverlay
					level={dictation.audioLevel}
					durationMs={dictation.durationMs}
					locked={dictation.isLocked}
					transcribing={transcribing}
					onStop={dictation.stop}
					onCancel={dictation.cancel}
				/>
			)}
			<button
				type="button"
				aria-label={disabledReason ?? "Диктовать"}
				title={disabledReason ?? "Нажмите, чтобы диктовать, или удерживайте"}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
				disabled={disabled}
				className={cn(
					"flex size-[23px] items-center justify-center rounded-full border border-transparent p-[5px] transition-colors",
					dictation.isActive
						? "bg-red-500/15 text-red-500"
						: "bg-foreground/10 text-muted-foreground hover:bg-foreground/20",
					disabled && "opacity-50 hover:bg-foreground/10",
				)}
			>
				{transcribing ? (
					<Loader2Icon className="size-3.5 animate-spin" />
				) : (
					<MicIcon className="size-3.5" />
				)}
			</button>
		</>
	);
}
