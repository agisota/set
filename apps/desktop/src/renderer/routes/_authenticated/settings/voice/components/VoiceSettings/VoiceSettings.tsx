import { Badge } from "@rox/ui/badge";
import { Button } from "@rox/ui/button";
import { Label } from "@rox/ui/label";
import { toast } from "@rox/ui/sonner";
import { Switch } from "@rox/ui/switch";
import { Textarea } from "@rox/ui/textarea";
import { ShieldCheckIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { apiClient } from "renderer/routes/_authenticated/providers/CollectionsProvider/collections";
import {
	type AmbientCloudState,
	resolveAmbientContext,
	resolveAmbientEnabled,
	toCloudPersona,
} from "./ambientCloudSync";

/**
 * Settings → Voice: opt-out + customization + consent (Phase 4a/4b).
 *
 * - "Голосовой ввод" (dictation) — on by default; off keeps the mic visible but
 *   disabled, and disables the dictate hotkey.
 * - "Фоновый агент (always-on)" — opt-in (off by default) per the locked privacy
 *   decision; shows a recording indicator when it eventually runs.
 * - "Контекст для агента" — free-text the user supplies in advance, threaded into
 *   the dictation post-process so the model has their context.
 *
 * Persistence is dual (phase 4b "Act"):
 *   - LOCAL (electronTrpc.settings.* → local SQLite, optimistic) drives the
 *     snappy UI and the on-device runtime / dictation post-process.
 *   - CLOUD (apiClient.ambient.* → `user_ambient_settings`) is the org+user row
 *     the server `*\/5` nudge job gates on; the desktop may be closed, so the
 *     job can only see the cloud row. The ambient toggle + persona therefore
 *     ALSO write the cloud row, and initial state is seeded from the cloud
 *     `ambient.get` (cloud = source of truth for the server job; local mirrors
 *     it for the UI). A cloud-write failure surfaces a toast but never breaks
 *     the local toggle. Org/user scoping is server-derived in the router.
 */

type DictationStateTone = "default" | "secondary" | "destructive" | "outline";

export type VoiceDictationState = {
	label: string;
	tone: DictationStateTone;
	description: string;
};

export function resolveVoiceDictationState({
	dictationEnabled,
	microphoneGranted,
	voiceConfigured,
}: {
	dictationEnabled?: boolean;
	microphoneGranted?: boolean;
	voiceConfigured: boolean | null;
}): VoiceDictationState {
	if (dictationEnabled === false) {
		return {
			label: "Выключено",
			tone: "secondary",
			description:
				"Кнопка микрофона в prompt input остаётся видимой, но неактивной.",
		};
	}
	if (microphoneGranted === false) {
		return {
			label: "Нет доступа к микрофону",
			tone: "destructive",
			description:
				"macOS не выдала Rox доступ к микрофону. Диктовка не начнётся, пока доступ не разрешён.",
		};
	}
	if (voiceConfigured === false) {
		return {
			label: "Требуется настройка распознавания",
			tone: "outline",
			description:
				"Backend распознавания речи сейчас не сконфигурирован. Кнопка микрофона будет disabled и покажет эту причину.",
		};
	}
	if (voiceConfigured === null) {
		return {
			label: "Проверяем настройку",
			tone: "outline",
			description:
				"Rox проверяет runtime распознавания речи. Кнопка микрофона останется disabled, пока проверка не завершится.",
		};
	}
	return {
		label: "Готово",
		tone: "default",
		description:
			"Голосовой ввод включён; кнопка микрофона доступна в prompt input и горячей клавише.",
	};
}

export function VoiceSettings() {
	const utils = electronTrpc.useUtils();
	const { data: permissionStatus } =
		electronTrpc.permissions.getStatus.useQuery();
	const requestMicrophone =
		electronTrpc.permissions.requestMicrophone.useMutation({
			onSuccess: () => {
				void utils.permissions.getStatus.invalidate();
			},
		});
	const [voiceConfigured, setVoiceConfigured] = useState<boolean | null>(null);
	useEffect(() => {
		let active = true;
		apiClient.voice.isConfigured
			.query()
			.then((result) => {
				if (active) setVoiceConfigured(result.configured);
			})
			.catch(() => {
				if (active) setVoiceConfigured(false);
			});
		return () => {
			active = false;
		};
	}, []);

	// --- Dictation toggle ---------------------------------------------------
	const { data: dictationEnabled, isLoading: isDictationLoading } =
		electronTrpc.settings.getDictationEnabled.useQuery();
	const setDictationEnabled =
		electronTrpc.settings.setDictationEnabled.useMutation({
			onMutate: async ({ enabled }) => {
				await utils.settings.getDictationEnabled.cancel();
				const previous = utils.settings.getDictationEnabled.getData();
				utils.settings.getDictationEnabled.setData(undefined, enabled);
				return { previous };
			},
			onError: (_err, _vars, context) => {
				if (context?.previous !== undefined) {
					utils.settings.getDictationEnabled.setData(
						undefined,
						context.previous,
					);
				}
			},
			onSettled: () => {
				utils.settings.getDictationEnabled.invalidate();
			},
		});

	// --- Cloud ambient settings (source of truth for the server nudge job) ---
	// Seeded once from `apiClient.ambient.get`; a failed read leaves it
	// undefined and the UI falls back to the local flags until it loads.
	const [cloudAmbient, setCloudAmbient] = useState<
		AmbientCloudState | undefined
	>(undefined);
	useEffect(() => {
		let active = true;
		apiClient.ambient.get
			.query()
			.then((row) => {
				if (active) setCloudAmbient(row);
			})
			.catch(() => {
				// Non-fatal: keep showing the local-mirror values; the toggle still
				// works locally and the next successful write reconciles the cloud.
			});
		return () => {
			active = false;
		};
	}, []);

	// --- Ambient capture toggle (opt-in) ------------------------------------
	const { data: ambientCaptureEnabled, isLoading: isAmbientLoading } =
		electronTrpc.settings.getAmbientCaptureEnabled.useQuery();
	const setAmbientCaptureEnabled =
		electronTrpc.settings.setAmbientCaptureEnabled.useMutation({
			onMutate: async ({ enabled }) => {
				await utils.settings.getAmbientCaptureEnabled.cancel();
				const previous = utils.settings.getAmbientCaptureEnabled.getData();
				utils.settings.getAmbientCaptureEnabled.setData(undefined, enabled);
				return { previous };
			},
			onError: (_err, _vars, context) => {
				if (context?.previous !== undefined) {
					utils.settings.getAmbientCaptureEnabled.setData(
						undefined,
						context.previous,
					);
				}
			},
			onSettled: () => {
				utils.settings.getAmbientCaptureEnabled.invalidate();
			},
		});

	// The actual toggle handler: keep the snappy LOCAL write AND push the cloud
	// row the server nudge job reads. Cloud failure → toast, but the local
	// toggle stays applied (optimistic local update is not reverted).
	const handleAmbientToggle = (enabled: boolean) => {
		setAmbientCaptureEnabled.mutate({ enabled });
		setCloudAmbient((prev) => ({
			ambientEnabled: enabled,
			voiceAgentContext: prev?.voiceAgentContext ?? null,
		}));
		apiClient.ambient.setEnabled.mutate({ enabled }).catch(() => {
			toast.error(
				"Не удалось синхронизировать фоновый агент с сервером — попробуйте ещё раз",
			);
		});
	};

	// --- Agent context (free text) ------------------------------------------
	const { data: voiceAgentContext } =
		electronTrpc.settings.getVoiceAgentContext.useQuery();
	const setVoiceAgentContext =
		electronTrpc.settings.setVoiceAgentContext.useMutation({
			onSettled: () => {
				utils.settings.getVoiceAgentContext.invalidate();
			},
		});

	// Local draft so typing is smooth; persisted on blur. Seeded cache-first
	// (only before the user starts editing) from the cloud persona when it has
	// loaded, otherwise the local-mirror value.
	const seededContext = resolveAmbientContext(cloudAmbient, voiceAgentContext);
	const [contextDraft, setContextDraft] = useState("");
	const [contextDirty, setContextDirty] = useState(false);
	useEffect(() => {
		if (
			!contextDirty &&
			(cloudAmbient !== undefined || voiceAgentContext !== undefined)
		) {
			setContextDraft(seededContext);
		}
	}, [seededContext, cloudAmbient, voiceAgentContext, contextDirty]);

	const persistContext = () => {
		const next = contextDraft;
		setContextDirty(false);
		if (next === seededContext) return;
		// LOCAL mirror for the on-device runtime / dictation post-process.
		setVoiceAgentContext.mutate({ context: next });
		// CLOUD persona the server nudge job uses; empty → null clears it.
		const persona = toCloudPersona(next);
		setCloudAmbient((prev) => ({
			ambientEnabled: prev?.ambientEnabled ?? false,
			voiceAgentContext: persona,
		}));
		apiClient.ambient.setPersona.mutate({ persona }).catch(() => {
			toast.error(
				"Не удалось сохранить контекст на сервере — попробуйте ещё раз",
			);
		});
	};

	const dictationState = resolveVoiceDictationState({
		dictationEnabled,
		microphoneGranted: permissionStatus?.microphone,
		voiceConfigured,
	});

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<div className="space-y-0.5 pr-6">
					<Label htmlFor="dictation-enabled" className="font-medium text-sm">
						Голосовой ввод
					</Label>
					<p className="text-muted-foreground text-xs">
						Кнопка микрофона в поле ввода и горячая клавиша для диктовки
						промптов. Когда выключено — микрофон виден, но неактивен.
					</p>
				</div>
				<Switch
					id="dictation-enabled"
					checked={dictationEnabled ?? true}
					onCheckedChange={(enabled) => setDictationEnabled.mutate({ enabled })}
					disabled={isDictationLoading || setDictationEnabled.isPending}
				/>
			</div>

			<div className="flex items-start justify-between gap-4 rounded-md border border-border bg-muted/35 p-3">
				<div className="space-y-1">
					<div className="flex items-center gap-2">
						<Label className="font-medium text-sm">Состояние диктовки</Label>
						<Badge variant={dictationState.tone}>{dictationState.label}</Badge>
					</div>
					<p className="select-text cursor-text text-muted-foreground text-xs leading-snug">
						{dictationState.description}
					</p>
				</div>
				{permissionStatus?.microphone === false && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={requestMicrophone.isPending}
						onClick={() => requestMicrophone.mutate()}
					>
						Разрешить микрофон
					</Button>
				)}
			</div>

			<div className="flex items-center justify-between">
				<div className="space-y-0.5 pr-6">
					<Label htmlFor="ambient-capture" className="font-medium text-sm">
						Фоновый агент (always-on)
					</Label>
					<p className="text-muted-foreground text-xs">
						Постоянное прослушивание для проактивной помощи. По умолчанию{" "}
						<span className="font-medium text-foreground">выключено</span> и
						включается только вами. Когда активно — показывается индикатор
						записи. Ничего не записывается, пока вы это не включите.
					</p>
				</div>
				<Switch
					id="ambient-capture"
					checked={resolveAmbientEnabled(cloudAmbient, ambientCaptureEnabled)}
					onCheckedChange={handleAmbientToggle}
					disabled={isAmbientLoading || setAmbientCaptureEnabled.isPending}
				/>
			</div>

			<div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3">
				<ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
				<p className="select-text text-muted-foreground text-xs leading-snug">
					Приватность: фоновый захват по умолчанию отключён (opt-in). При
					включении появляется видимый индикатор записи. Аудио обрабатывается на
					нашем API только для распознавания.
				</p>
			</div>

			<div className="space-y-1.5">
				<Label htmlFor="voice-agent-context" className="font-medium text-sm">
					Контекст для агента
				</Label>
				<p className="text-muted-foreground text-xs">
					Задайте контекст заранее — термины, имена, проекты, предпочтения. Он
					помогает точнее распознавать и оформлять надиктованное (и будет
					использоваться фоновым агентом).
				</p>
				<Textarea
					id="voice-agent-context"
					value={contextDraft}
					onChange={(e) => {
						setContextDirty(true);
						setContextDraft(e.target.value);
					}}
					onBlur={persistContext}
					placeholder="Напр.: Я соло-фаундер. Проект Set — десктоп-приложение на Electron. Отвечай по-русски, BLUF."
					className="min-h-28 select-text"
					maxLength={10_000}
				/>
			</div>
		</div>
	);
}
