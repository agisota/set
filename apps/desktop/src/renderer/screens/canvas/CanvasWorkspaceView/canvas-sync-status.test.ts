import { describe, expect, it } from "bun:test";
import {
	CANVAS_ACTIVE_REFRESH_INTERVAL_MS,
	getCanvasSyncStatus,
} from "./canvas-sync-status";

describe("canvas sync status", () => {
	it("keeps unauthenticated or unresolved Canvas states explicit", () => {
		expect(
			getCanvasSyncStatus({
				workspaceId: undefined,
				activeCanvasId: "canvas-1",
				isFetching: false,
			}),
		).toBe("Синхронизация неактивна: workspace не открыт");

		expect(
			getCanvasSyncStatus({
				workspaceId: "workspace-1",
				activeCanvasId: null,
				isFetching: false,
			}),
		).toBe("Ожидание синхронизации: нет активного канваса");
	});

	it("reports active canonical refresh state and bounded polling fallback", () => {
		expect(
			getCanvasSyncStatus({
				workspaceId: "workspace-1",
				activeCanvasId: "canvas-1",
				isFetching: true,
			}),
		).toBe("Live sync: обновляем сохраненный документ");

		expect(
			getCanvasSyncStatus({
				workspaceId: "workspace-1",
				activeCanvasId: "canvas-1",
				isFetching: false,
				lastRefreshAt: new Date("2026-06-17T18:37:57.340Z"),
				refreshIntervalMs: CANVAS_ACTIVE_REFRESH_INTERVAL_MS,
			}),
		).toBe("Live sync: опрос каждые 5s · последнее обновление 18:37:57 UTC");
	});

	it("surfaces refresh errors as retrying live sync instead of silent staleness", () => {
		expect(
			getCanvasSyncStatus({
				workspaceId: "workspace-1",
				activeCanvasId: "canvas-1",
				isFetching: false,
				lastRefreshError: "network offline",
			}),
		).toBe("Live sync: повтор после network offline");
	});
});
