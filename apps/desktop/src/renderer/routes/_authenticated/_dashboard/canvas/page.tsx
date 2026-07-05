import { WorkspaceClientProvider as WorkspaceTrpcProvider } from "@rox/workspace-client";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { HostStatusInline } from "renderer/components/HostStatusInline";
import { env } from "renderer/env.renderer";
import { getHostServiceHeaders } from "renderer/lib/host-service-auth";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import { CanvasWorkspaceView } from "renderer/screens/canvas/CanvasWorkspaceView";
import { E2E_CANVAS_FIXTURE } from "shared/constants";
import type { AccessibleV2Workspace } from "../v2-workspaces/hooks/useAccessibleV2Workspaces";
import { useAccessibleV2Workspaces } from "../v2-workspaces/hooks/useAccessibleV2Workspaces";
import { selectDefaultCanvasWorkspace } from "./canvasWorkspaceSelection";

export const Route = createFileRoute("/_authenticated/_dashboard/canvas/")({
	component: CanvasPage,
});

const LAST_ACTIVE_CANVAS_WORKSPACE_ID_KEY =
	"rox.canvas.last-active-workspace-id";

function readLastActiveCanvasWorkspaceId(): string | null {
	try {
		return window.localStorage.getItem(LAST_ACTIVE_CANVAS_WORKSPACE_ID_KEY);
	} catch {
		return null;
	}
}

function saveLastActiveCanvasWorkspaceId(workspaceId: string): void {
	try {
		window.localStorage.setItem(
			LAST_ACTIVE_CANVAS_WORKSPACE_ID_KEY,
			workspaceId,
		);
	} catch {
		// Best effort only; route selection still works from accessible workspaces.
	}
}

function getHostServiceStatusLabel(status: string): string {
	switch (status) {
		case "running":
			return "хост готов";
		case "starting":
			return "хост запускается";
		case "stopped":
			return "хост остановлен";
		default:
			return "статус уточняется";
	}
}

function createE2ECanvasWorkspace(
	machineId: string | null,
): AccessibleV2Workspace | null {
	if (!machineId) return null;
	return {
		id: E2E_CANVAS_FIXTURE.workspaceId,
		name: "Проверочное пространство канваса",
		branch: "main",
		type: "main",
		createdAt: new Date("2026-06-17T00:00:00.000Z"),
		createdByUserId: null,
		createdByName: null,
		createdByImage: null,
		isCreatedByCurrentUser: false,
		projectId: E2E_CANVAS_FIXTURE.projectId,
		projectName: "Проверочный проект канваса Rox",
		projectRepoId: null,
		projectGithubOwner: "agisota",
		hostId: machineId,
		hostName: "Это устройство",
		hostIsOnline: true,
		hostType: "local-device",
		isInSidebar: true,
		pr: null,
	};
}

function CanvasPage() {
	const { all, pinned } = useAccessibleV2Workspaces();
	const {
		activeHostUrl,
		activeOrganizationName,
		hostServiceStatus,
		machineId,
	} = useLocalHostService();
	const lastActiveWorkspaceId = useMemo(readLastActiveCanvasWorkspaceId, []);
	const e2eFallbackWorkspace = env.E2E_AUTH_BYPASS
		? createE2ECanvasWorkspace(machineId)
		: null;
	const selectedWorkspace = selectDefaultCanvasWorkspace({
		all,
		pinned,
		lastActiveWorkspaceId,
		isE2EAuthBypass: env.E2E_AUTH_BYPASS,
		e2eFallbackWorkspace,
	});

	useEffect(() => {
		if (!selectedWorkspace) return;
		saveLastActiveCanvasWorkspaceId(selectedWorkspace.id);
	}, [selectedWorkspace]);

	if (!selectedWorkspace) {
		return <CanvasWorkspaceView />;
	}

	if (!activeHostUrl) {
		return (
			<div className="flex h-full w-full items-center justify-center bg-background px-6 text-sm text-foreground">
				<section className="w-full max-w-xl rounded-md border bg-card p-5 shadow-sm">
					<p className="font-medium text-base">Канвас ожидает локальный хост</p>
					<p className="mt-2 text-muted-foreground">
						Чтобы открыть рабочий канвас, Rox должен подключиться к локальному
						хост-сервису для выбранного рабочего пространства.
					</p>
					<div className="mt-4 rounded-md border bg-background/70 p-3">
						<HostStatusInline />
						<p className="mt-2 text-muted-foreground text-xs">
							Статус: {getHostServiceStatusLabel(hostServiceStatus)}.
							Организация: {activeOrganizationName ?? "не выбрана"}.
						</p>
					</div>
					<p className="mt-4 text-muted-foreground text-xs">
						Если подключение не запускается, откройте Настройки -&gt; Хосты и
						проверьте локальный хост этого устройства.
					</p>
				</section>
			</div>
		);
	}

	return (
		<WorkspaceTrpcProvider
			cacheKey={selectedWorkspace.id}
			hostUrl={activeHostUrl}
			headers={() => getHostServiceHeaders(activeHostUrl)}
		>
			<CanvasWorkspaceView workspaceId={selectedWorkspace.id} />
		</WorkspaceTrpcProvider>
	);
}
