import "server-only";

import { api } from "@/trpc/server";

import {
	type AgentsHostTarget,
	resolveAgentsHostListing,
} from "./resolveAgentsHostListing";
import {
	buildSessionDashboardDetail,
	buildSessionDashboardSummary,
	type SessionDashboardDetail,
	type SessionDashboardSummary,
	type SessionDashboardUsageRow,
} from "./session-dashboard";

export type AgentsSubscriptionSummary = {
	planName: string;
	status: "active" | "unavailable";
	balanceRox: string | null;
	updatedAt: Date | null;
};

type AgentsBalanceSummary = {
	balanceRox: string;
	updatedAt: Date;
};

export type AgentsDashboardData = {
	sessions: SessionDashboardSummary[];
	totals: {
		totalTokens: number;
		llmCalls: number;
		toolCalls: number;
		activeSessions: number;
	};
	subscription: AgentsSubscriptionSummary;
};

type UsageRowWithSession = SessionDashboardUsageRow & {
	chatSessionId: string | null;
};

type AgentsSessionsPayload = {
	sessions: Parameters<typeof buildSessionDashboardSummary>[0][];
	usageRequests: UsageRowWithSession[];
};

const emptySessionsPayload: AgentsSessionsPayload = {
	sessions: [],
	usageRequests: [],
};

export function buildSubscriptionSummary(
	balance: AgentsBalanceSummary | null,
): AgentsSubscriptionSummary {
	return {
		planName: "Rox Balance",
		status: balance ? "active" : "unavailable",
		balanceRox: balance?.balanceRox ?? null,
		updatedAt: balance?.updatedAt ?? null,
	};
}

async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		console.error("[loadAgentsDashboardData] retrying failed query", error);
		return operation();
	}
}

export async function loadAgentsDashboardData(): Promise<AgentsDashboardData> {
	const trpc = await api();
	const [payload, balance] = await Promise.all([
		trpc.chat.listSessions.query().catch((error) => {
			console.error("[loadAgentsDashboardData] failed to load sessions", error);
			return emptySessionsPayload;
		}),
		withRetry(() => trpc.economy.balance.query()).catch((error) => {
			console.error(
				"[loadAgentsDashboardData] failed to load Rox balance",
				error,
			);
			return null;
		}),
	]);
	const usageBySession = groupUsageBySession(payload.usageRequests);
	const sessions = payload.sessions.map((session) =>
		buildSessionDashboardSummary(session, usageBySession.get(session.id) ?? []),
	);

	return {
		sessions,
		totals: {
			totalTokens: sessions.reduce(
				(total, session) => total + session.totalTokens,
				0,
			),
			llmCalls: sessions.reduce(
				(total, session) => total + session.llmCalls,
				0,
			),
			toolCalls: sessions.reduce(
				(total, session) => total + session.toolCalls,
				0,
			),
			activeSessions: sessions.length,
		},
		subscription: buildSubscriptionSummary(balance),
	};
}

export type AgentsHostListing = {
	targets: AgentsHostTarget[];
	useMock: boolean;
};

/**
 * Real host/workspace listing for the cabinet (WS-B T3). Reads `host.list` for
 * the active org and maps it through {@link resolveAgentsHostListing}, so the
 * cabinet can bind to a real attached host (D6 read plane A) instead of mock
 * data. Falls back to the mock prototype ONLY when the org has no hosts at all
 * (the mock module is kept, never deleted). Returns the mock fallback if there
 * is no active organization.
 */
export async function loadAgentsHostTargets(): Promise<AgentsHostListing> {
	const trpc = await api();
	const organization = await trpc.organization.getActive.query();
	if (!organization) {
		return { targets: [], useMock: true };
	}
	const hosts = await trpc.host.list.query({
		organizationId: organization.id,
	});
	return resolveAgentsHostListing(
		organization.id,
		hosts.map((host) => ({
			id: host.id,
			name: host.name,
			online: host.online,
			kind: host.kind,
		})),
	);
}

export async function loadAgentsSessionDetail({
	sessionId,
}: {
	sessionId: string;
}): Promise<SessionDashboardDetail | null> {
	const trpc = await api();
	const payload = await trpc.chat.getSessionDetail.query({ sessionId });

	if (!payload) {
		return null;
	}

	return buildSessionDashboardDetail(payload.session, payload.usageRequests);
}

function groupUsageBySession(rows: UsageRowWithSession[]) {
	const usageBySession = new Map<string, SessionDashboardUsageRow[]>();

	for (const row of rows) {
		if (!row.chatSessionId) {
			continue;
		}

		const existing = usageBySession.get(row.chatSessionId) ?? [];
		existing.push(row);
		usageBySession.set(row.chatSessionId, existing);
	}

	return usageBySession;
}
