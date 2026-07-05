import type { ThinkingLevel } from "@rox/ui/ai-elements/thinking-toggle";

export type ChatSendMessageInput = {
	payload: {
		content: string;
		files?: Array<{
			data: string;
			mediaType: string;
			filename?: string;
		}>;
	};
	metadata: {
		model?: string;
		thinkingLevel?: ThinkingLevel;
	};
};

function toBaseErrorMessage(error: unknown): string {
	if (typeof error === "string" && error.trim().length > 0) return error;
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}
	return "Не удалось отправить сообщение";
}

function toNumericStatus(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? null : parsed;
}

function getErrorStatusCode(error: unknown): number | null {
	if (!error || typeof error !== "object") return null;
	const candidate = error as {
		status?: unknown;
		statusCode?: unknown;
		code?: unknown;
		data?: { status?: unknown; statusCode?: unknown };
		response?: {
			status?: unknown;
			data?: { status?: unknown; statusCode?: unknown };
		};
	};
	const statusCandidates = [
		candidate.status,
		candidate.statusCode,
		candidate.response?.status,
		candidate.data?.status,
		candidate.data?.statusCode,
		candidate.response?.data?.status,
		candidate.response?.data?.statusCode,
		candidate.code,
	];
	for (const statusCandidate of statusCandidates) {
		const parsed = toNumericStatus(statusCandidate);
		if (parsed !== null) return parsed;
	}
	return null;
}

function formatAgentName(agent: string | undefined): string {
	const normalized = agent?.trim();
	return normalized ? `"${normalized}"` : "терминальный агент";
}

const AGENT_STARTUP_LOG_REFERENCE = "~/Library/Logs/Rox/main.log";
const AGENT_STARTUP_RETRY_HINT =
	"После исправления нажмите «Повторить» в уведомлении или запустите чат заново.";

export function toAgentStartupFailureMessage(error: unknown): string | null {
	const baseMessage = toBaseErrorMessage(error);
	const exitMatch = baseMessage.match(
		/\b(?<agent>[a-z0-9._-]+)\s+exited\s+\(code=(?<code>[^,\s)]+),\s*signal=(?<signal>[^)]+)\)/i,
	);
	if (exitMatch?.groups) {
		const agentName = formatAgentName(exitMatch.groups.agent);
		const code = exitMatch.groups.code;
		const signal = exitMatch.groups.signal;
		return [
			`Не удалось запустить ${agentName}: процесс завершился с кодом ${code}.`,
			"Проверьте в Настройки → Агенты и Настройки → Терминал, что команда доступна в PATH и у неё есть нужная host-конфигурация.",
			`Лог запуска: ${AGENT_STARTUP_LOG_REFERENCE}.`,
			AGENT_STARTUP_RETRY_HINT,
			`Технические детали: code=${code}, signal=${signal}.`,
		].join(" ");
	}

	const missingConfigMatch = baseMessage.match(
		/No host agent config matching ["']?(?<agent>[^"']+)["']?/i,
	);
	if (missingConfigMatch?.groups) {
		return `Конфигурация агента ${formatAgentName(
			missingConfigMatch.groups.agent,
		)} не найдена. Откройте Настройки → Агенты и проверьте id, команду запуска и рабочую директорию. Лог запуска: ${AGENT_STARTUP_LOG_REFERENCE}. ${AGENT_STARTUP_RETRY_HINT}`;
	}

	if (/Команда агента\s+"[^"]+".*PATH/i.test(baseMessage)) {
		return baseMessage.includes("Повторить")
			? baseMessage
			: `${baseMessage} ${AGENT_STARTUP_RETRY_HINT}`;
	}

	if (
		/\bomp\b/i.test(baseMessage) &&
		/\bfailed|failure|ошиб|не удалось/i.test(baseMessage)
	) {
		return [
			'Не удалось запустить "omp".',
			"Проверьте в Настройки → Агенты и Настройки → Терминал, что OMP установлен, команда доступна в PATH и выбранная host-конфигурация указывает на неё.",
			`Лог запуска: ${AGENT_STARTUP_LOG_REFERENCE}.`,
			AGENT_STARTUP_RETRY_HINT,
			`Технические детали: ${baseMessage}.`,
		].join(" ");
	}

	return null;
}

export function toSendFailureMessage(error: unknown): string {
	const baseMessage = toBaseErrorMessage(error);
	const startupFailureMessage = toAgentStartupFailureMessage(error);
	if (startupFailureMessage) return startupFailureMessage;

	const statusCode = getErrorStatusCode(error);
	if (statusCode !== 401 && statusCode !== 403) return baseMessage;
	return "Не удалось авторизоваться у модели. Переподключите OAuth или укажите API-ключ в выборе модели, затем повторите запрос.";
}
