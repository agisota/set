import { Badge } from "@rox/ui/badge";
import { Button } from "@rox/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@rox/ui/card";
import {
	Activity,
	ArrowRight,
	BrainCircuit,
	Clock3,
	Database,
	Hash,
	MessageSquarePlus,
	Terminal,
} from "lucide-react";
import Link from "next/link";
import type React from "react";

import type { AgentsDashboardData } from "../../agents/data";
import { FeatureInventoryCard } from "./FeatureInventoryCard";
import { SubscriptionCard } from "./SubscriptionCard";

type AgentsCabinetProps = {
	userName: string;
	data: AgentsDashboardData;
};

export function AgentsCabinet({ userName, data }: AgentsCabinetProps) {
	const topSession = data.sessions[0];

	return (
		<main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 md:px-6">
			<section className="rounded-lg border bg-card p-5">
				<div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
					<div className="min-w-0">
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<BrainCircuit className="size-4" />
							<span className="uppercase tracking-[0.14em]">
								Личный кабинет агентов
							</span>
						</div>
						<h1 className="mt-3 text-2xl font-semibold tracking-tight md:text-3xl">
							{userName}
						</h1>
						<p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
							Сессии, расход токенов и trace-логи показываются только для
							текущего пользователя в активной организации.
						</p>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Button asChild>
							<Link href="/agents/chat">
								<MessageSquarePlus className="size-4" />
								Новый чат
							</Link>
						</Button>
						{topSession && (
							<Button asChild variant="outline">
								<Link href={topSession.href}>
									Открыть последнюю сессию
									<ArrowRight className="size-4" />
								</Link>
							</Button>
						)}
					</div>
				</div>
			</section>

			<section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
				<MetricCard
					icon={<Database className="size-4" />}
					label="Сессии"
					value={formatNumber(data.totals.activeSessions)}
				/>
				<MetricCard
					icon={<Hash className="size-4" />}
					label="Всего токенов"
					value={compactNumber(data.totals.totalTokens)}
				/>
				<MetricCard
					icon={<Activity className="size-4" />}
					label="LLM calls"
					value={formatNumber(data.totals.llmCalls)}
				/>
				<MetricCard
					icon={<Terminal className="size-4" />}
					label="Tool calls"
					value={formatNumber(data.totals.toolCalls)}
				/>
			</section>

			<section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
				<FeatureInventoryCard />
				<SubscriptionCard subscription={data.subscription} />
			</section>

			<section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
				<Card className="rounded-lg">
					<CardHeader className="gap-1">
						<CardTitle>Сессии</CardTitle>
						<p className="text-sm text-muted-foreground">
							Последние 50 agent-сессий с детализацией по usage_requests.trace.
						</p>
					</CardHeader>
					<CardContent>
						{data.sessions.length === 0 ? (
							<div className="rounded-lg border border-dashed p-8 text-center">
								<p className="text-sm font-medium">Сессии пока не записаны</p>
								<p className="mt-2 text-sm text-muted-foreground">
									Когда агент создаст chat_session и usage_requests, здесь
									появится личный журнал.
								</p>
							</div>
						) : (
							<div className="divide-y rounded-lg border">
								{data.sessions.map((session) => (
									<Link
										key={session.id}
										href={session.href}
										className="grid gap-3 p-4 transition-colors hover:bg-muted/50 lg:grid-cols-[minmax(0,1fr)_8rem_7rem_7rem]"
									>
										<div className="min-w-0">
											<div className="flex flex-wrap items-center gap-2">
												<h2 className="truncate text-sm font-semibold">
													{session.title}
												</h2>
												<Badge variant="outline">{session.model}</Badge>
											</div>
											<p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
												{session.lastMessage}
											</p>
											<p className="mt-2 font-mono text-xs text-muted-foreground">
												{session.id}
											</p>
										</div>
										<Mini
											label="токены"
											value={compactNumber(session.totalTokens)}
										/>
										<Mini
											label="llm calls"
											value={formatNumber(session.llmCalls)}
										/>
										<Mini
											label="context"
											value={`${formatNumber(session.contextPercent)}%`}
										/>
									</Link>
								))}
							</div>
						)}
					</CardContent>
				</Card>

				<Card className="rounded-lg">
					<CardHeader className="gap-1">
						<CardTitle>Состояние</CardTitle>
						<p className="text-sm text-muted-foreground">
							Источник: chat_sessions + usage_requests.
						</p>
					</CardHeader>
					<CardContent className="space-y-4">
						<div className="rounded-lg border p-4">
							<div className="flex items-center gap-2 text-sm font-medium">
								<Clock3 className="size-4" />
								Последняя активность
							</div>
							<p className="mt-2 text-sm text-muted-foreground">
								{topSession
									? formatDateTime(topSession.lastActiveAt)
									: "нет данных"}
							</p>
						</div>
						<div className="rounded-lg border p-4">
							<div className="text-sm font-medium">Модель последней сессии</div>
							<p className="mt-2 text-sm text-muted-foreground">
								{topSession?.model ?? "нет данных"}
							</p>
						</div>
					</CardContent>
				</Card>
			</section>
		</main>
	);
}

function MetricCard({
	icon,
	label,
	value,
}: {
	icon: React.ReactNode;
	label: string;
	value: string;
}) {
	return (
		<Card className="rounded-lg">
			<CardContent className="flex items-center justify-between gap-4 pt-0">
				<div>
					<p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
						{label}
					</p>
					<p className="mt-2 text-2xl font-semibold">{value}</p>
				</div>
				<div className="rounded-md border bg-muted p-2 text-muted-foreground">
					{icon}
				</div>
			</CardContent>
		</Card>
	);
}

function Mini({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-md bg-muted/60 px-3 py-2">
			<div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
				{label}
			</div>
			<div className="mt-1 font-mono text-sm">{value}</div>
		</div>
	);
}

function formatNumber(value: number) {
	return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(
		value,
	);
}

function compactNumber(value: number) {
	return new Intl.NumberFormat("ru-RU", {
		notation: "compact",
		maximumFractionDigits: 1,
	}).format(value);
}

function formatDateTime(value: string) {
	return new Intl.DateTimeFormat("ru-RU", {
		day: "2-digit",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(value));
}
