import { describe, expect, it } from "bun:test";
import {
	toAgentStartupFailureMessage,
	toSendFailureMessage,
} from "./sendMessage";

describe("toSendFailureMessage", () => {
	it("maps auth failures when status is 401/403", () => {
		expect(toSendFailureMessage({ status: 401 })).toBe(
			"Не удалось авторизоваться у модели. Переподключите OAuth или укажите API-ключ в выборе модели, затем повторите запрос.",
		);
		expect(toSendFailureMessage({ response: { status: 403 } })).toBe(
			"Не удалось авторизоваться у модели. Переподключите OAuth или укажите API-ключ в выборе модели, затем повторите запрос.",
		);
	});

	it("keeps backend message when status is not auth-related", () => {
		expect(
			toSendFailureMessage(
				new Error("Unauthorized model provider token, please reconnect OAuth"),
			),
		).toBe("Unauthorized model provider token, please reconnect OAuth");
	});

	it("maps terminal agent startup exit errors into actionable Russian diagnostics", () => {
		const message = toAgentStartupFailureMessage(
			"omp exited (code=1, signal=null)",
		);

		expect(message).toContain(
			'Не удалось запустить "omp": процесс завершился с кодом 1.',
		);
		expect(message).toContain("Настройки → Агенты");
		expect(message).toContain("Настройки → Терминал");
		expect(message).toContain("~/Library/Logs/Rox/main.log");
		expect(message).toContain("Повторить");
		expect(message).toContain("Технические детали: code=1, signal=null.");
		expect(message).not.toBeNull();
		if (message) {
			expect(toSendFailureMessage("omp exited (code=1, signal=null)")).toBe(
				message,
			);
		}
	});

	it("maps missing terminal agent config errors", () => {
		const message = toAgentStartupFailureMessage(
			'No host agent config matching "omp"',
		);

		expect(message).toContain('Конфигурация агента "omp" не найдена.');
		expect(message).toContain("Настройки → Агенты");
		expect(message).toContain("~/Library/Logs/Rox/main.log");
		expect(message).toContain("Повторить");
	});

	it("maps host command preflight failures into retryable startup diagnostics", () => {
		const message = toAgentStartupFailureMessage(
			'Команда агента "omp" для "OMP" не найдена или недоступна в PATH. Лог запуска: ~/Library/Logs/Rox/main.log.',
		);

		expect(message).toContain('Команда агента "omp"');
		expect(message).toContain("PATH");
		expect(message).toContain("~/Library/Logs/Rox/main.log");
		expect(message).toContain("Повторить");
	});

	it("maps generic OMP failures into one recovery message", () => {
		const message = toAgentStartupFailureMessage("OMP failed during startup");

		expect(message).toContain('Не удалось запустить "omp".');
		expect(message).toContain("Настройки → Агенты");
		expect(message).toContain("Настройки → Терминал");
		expect(message).toContain("~/Library/Logs/Rox/main.log");
		expect(message).toContain("Повторить");
		expect(message).toContain("Технические детали: OMP failed during startup.");
	});
});
