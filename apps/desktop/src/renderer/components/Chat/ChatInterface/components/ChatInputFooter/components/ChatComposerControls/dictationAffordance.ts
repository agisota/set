export function getDictationDisabledReason({
	dictationEnabled,
	dictationConfigured,
	microphoneGranted,
}: {
	dictationEnabled?: boolean;
	dictationConfigured?: boolean;
	microphoneGranted?: boolean;
}): string | undefined {
	if (dictationEnabled === false) {
		return "Голосовой ввод выключен в Настройки → Голос.";
	}
	if (microphoneGranted === false) {
		return "Нет доступа к микрофону. Разрешите микрофон в Настройки → Разрешения.";
	}
	if (dictationConfigured === false) {
		return "Требуется настройка распознавания речи.";
	}
	return undefined;
}
