import { describe, expect, it } from "bun:test";
import { getDictationDisabledReason } from "./dictationAffordance";

describe("getDictationDisabledReason", () => {
	it("explains when dictation is turned off", () => {
		expect(
			getDictationDisabledReason({
				dictationEnabled: false,
				dictationConfigured: true,
				microphoneGranted: true,
			}),
		).toBe("Голосовой ввод выключен в Настройки → Голос.");
	});

	it("explains microphone denial before recognition configuration", () => {
		expect(
			getDictationDisabledReason({
				dictationEnabled: true,
				dictationConfigured: false,
				microphoneGranted: false,
			}),
		).toBe(
			"Нет доступа к микрофону. Разрешите микрофон в Настройки → Разрешения.",
		);
	});

	it("explains missing speech recognition configuration", () => {
		expect(
			getDictationDisabledReason({
				dictationEnabled: true,
				dictationConfigured: false,
				microphoneGranted: true,
			}),
		).toBe("Требуется настройка распознавания речи.");
	});

	it("does not disable the mic while configuration is still loading", () => {
		expect(
			getDictationDisabledReason({
				dictationEnabled: true,
				dictationConfigured: undefined,
				microphoneGranted: true,
			}),
		).toBeUndefined();
	});
});
