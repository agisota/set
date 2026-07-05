import { describe, expect, it } from "bun:test";
import { resolveVoiceDictationState } from "./VoiceSettings";

describe("resolveVoiceDictationState", () => {
	it("shows disabled state when dictation is off", () => {
		expect(
			resolveVoiceDictationState({
				dictationEnabled: false,
				microphoneGranted: true,
				voiceConfigured: true,
			}).label,
		).toBe("Выключено");
	});

	it("prioritizes microphone denial over recognition config", () => {
		const state = resolveVoiceDictationState({
			dictationEnabled: true,
			microphoneGranted: false,
			voiceConfigured: false,
		});

		expect(state.label).toBe("Нет доступа к микрофону");
		expect(state.description).toContain("доступ к микрофону");
	});

	it("shows recognition setup when mic is allowed but recognition is missing", () => {
		const state = resolveVoiceDictationState({
			dictationEnabled: true,
			microphoneGranted: true,
			voiceConfigured: false,
		});

		expect(state.label).toBe("Требуется настройка распознавания");
		expect(state.description).toContain("распознавания речи");
	});

	it("shows ready state only when dictation, mic, and recognition are available", () => {
		expect(
			resolveVoiceDictationState({
				dictationEnabled: true,
				microphoneGranted: true,
				voiceConfigured: true,
			}).label,
		).toBe("Готово");
	});
});
