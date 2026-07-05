export const CANVAS_ACTIVE_REFRESH_INTERVAL_MS = 5_000;

interface CanvasSyncStatusInput {
	activeCanvasId?: string | null;
	isFetching: boolean;
	lastRefreshAt?: Date | null;
	lastRefreshError?: string | null;
	refreshIntervalMs?: number;
	workspaceId?: string | null;
}

function formatRefreshTime(date: Date): string {
	return date.toISOString().slice(11, 19);
}

export function getCanvasSyncStatus({
	activeCanvasId,
	isFetching,
	lastRefreshAt,
	lastRefreshError,
	refreshIntervalMs = CANVAS_ACTIVE_REFRESH_INTERVAL_MS,
	workspaceId,
}: CanvasSyncStatusInput): string {
	if (!workspaceId) return "Синхронизация неактивна: workspace не открыт";
	if (!activeCanvasId) return "Ожидание синхронизации: нет активного канваса";
	if (lastRefreshError) return `Live sync: повтор после ${lastRefreshError}`;
	if (isFetching) return "Live sync: обновляем сохраненный документ";

	const refreshSeconds = Math.max(1, Math.round(refreshIntervalMs / 1000));
	const lastRefresh = lastRefreshAt
		? ` · последнее обновление ${formatRefreshTime(lastRefreshAt)} UTC`
		: "";

	return `Live sync: опрос каждые ${refreshSeconds}s${lastRefresh}`;
}
