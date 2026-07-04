import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OnboardingOverlay } from "./OnboardingOverlay";

describe("OnboardingOverlay", () => {
	test("renders a visible fallback while the target anchor is unavailable", () => {
		const html = renderToStaticMarkup(
			<OnboardingOverlay
				step={{
					id: "workspace-chat",
					anchor: "missing-anchor",
					title: "Задача, чат и изменения вместе",
					body: "Workspace хранит контекст одной задачи.",
					action: "Откройте существующий чат.",
				}}
				stepIndex={1}
				totalSteps={8}
				onPause={() => {}}
				onNext={() => {}}
			/>,
		);

		expect(html).toContain("Готовим этот шаг");
		expect(html).toContain("Шаг 2 из 8");
		expect(html).toContain("Задача, чат и изменения вместе");
		expect(html).toContain("Отложить");
		expect(html).toContain("Дальше");
	});
});
