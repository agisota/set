import type { RouterOutputs } from "@rox/trpc";
import { Badge } from "@rox/ui/badge";
import { Input } from "@rox/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@rox/ui/select";
import { Skeleton } from "@rox/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@rox/ui/table";
import { useEffect, useMemo, useState } from "react";
import { apiTrpcClient } from "renderer/lib/api-trpc-client";

type AccountOverview = RouterOutputs["user"]["accountOverview"];
type ChatList = RouterOutputs["chat"]["listSessions"];
type UsageRequest = AccountOverview["usageRequests"][number];
type ChatSession = ChatList["sessions"][number];

type PeriodFilter = "all" | "7d" | "30d" | "90d";
type SessionSort = "last" | "rox" | "usd" | "tokens" | "requests" | "title";

interface SessionUsageRow {
	id: string;
	title: string;
	models: string[];
	firstSeenAt: Date | null;
	lastSeenAt: Date | null;
	requests: number;
	tokensIn: number;
	tokensOut: number;
	roxCost: number;
	usdCost: number;
}

function toNumber(value: string | number | null | undefined) {
	if (typeof value === "number") return value;
	if (!value) return 0;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function toDate(value: Date | string | null | undefined) {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value: Date | string | null | undefined) {
	const date = toDate(value);
	if (!date) return "—";
	return new Intl.DateTimeFormat("ru-RU", {
		day: "2-digit",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
	}).format(date);
}

function formatNumber(value: number) {
	return new Intl.NumberFormat("ru-RU").format(Math.round(value));
}

function formatFixed(value: number, digits = 2) {
	return new Intl.NumberFormat("ru-RU", {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
	}).format(value);
}

function formatMoney(value: string | number | null | undefined) {
	return formatFixed(toNumber(value));
}

function isWithinPeriod(date: Date | null, period: PeriodFilter) {
	if (period === "all" || !date) return true;
	const days = period === "7d" ? 7 : period === "30d" ? 30 : 90;
	const threshold = Date.now() - days * 24 * 60 * 60 * 1000;
	return date.getTime() >= threshold;
}

function buildSessionRows(
	usageRequests: UsageRequest[],
	sessions: ChatSession[],
) {
	const sessionsById = new Map(
		sessions.map((session) => [session.id, session]),
	);
	const rowsById = new Map<string, SessionUsageRow>();

	for (const request of usageRequests) {
		const id = request.chatSessionId ?? "without-session";
		const session = request.chatSessionId
			? sessionsById.get(request.chatSessionId)
			: undefined;
		const createdAt = toDate(request.createdAt);
		const row = rowsById.get(id) ?? {
			id,
			title:
				session?.title ??
				(request.chatSessionId
					? `Сессия ${request.chatSessionId.slice(0, 8)}`
					: "Без привязки к сессии"),
			models: [],
			firstSeenAt: createdAt,
			lastSeenAt: createdAt,
			requests: 0,
			tokensIn: 0,
			tokensOut: 0,
			roxCost: 0,
			usdCost: 0,
		};

		row.requests += 1;
		row.tokensIn += request.tokensIn;
		row.tokensOut += request.tokensOut;
		row.roxCost += toNumber(request.roxCost);
		row.usdCost += toNumber(request.usdCost);
		if (!row.models.includes(request.modelId)) {
			row.models.push(request.modelId);
		}
		if (createdAt && (!row.firstSeenAt || createdAt < row.firstSeenAt)) {
			row.firstSeenAt = createdAt;
		}
		if (createdAt && (!row.lastSeenAt || createdAt > row.lastSeenAt)) {
			row.lastSeenAt = createdAt;
		}

		rowsById.set(id, row);
	}

	return [...rowsById.values()];
}

export function AccountUsagePanel() {
	const [overview, setOverview] = useState<AccountOverview | null>(null);
	const [chatList, setChatList] = useState<ChatList | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [query, setQuery] = useState("");
	const [period, setPeriod] = useState<PeriodFilter>("30d");
	const [modelId, setModelId] = useState("all");
	const [sort, setSort] = useState<SessionSort>("last");

	useEffect(() => {
		let cancelled = false;

		async function loadUsage() {
			setIsLoading(true);
			try {
				const [overviewResult, sessionsResult] = await Promise.all([
					apiTrpcClient.user.accountOverview.query(),
					apiTrpcClient.chat.listSessions.query().catch(() => null),
				]);

				if (!cancelled) {
					setOverview(overviewResult);
					setChatList(sessionsResult);
				}
			} finally {
				if (!cancelled) setIsLoading(false);
			}
		}

		void loadUsage();

		return () => {
			cancelled = true;
		};
	}, []);

	const usageRequests = overview?.usageRequests ?? [];
	const sessions = chatList?.sessions ?? [];
	const sessionRows = useMemo(
		() => buildSessionRows(usageRequests, sessions),
		[usageRequests, sessions],
	);
	const modelRows = useMemo(() => {
		const rows = new Map<
			string,
			{ modelId: string; requests: number; tokens: number; roxCost: number }
		>();
		for (const request of usageRequests) {
			const row = rows.get(request.modelId) ?? {
				modelId: request.modelId,
				requests: 0,
				tokens: 0,
				roxCost: 0,
			};
			row.requests += 1;
			row.tokens += request.tokensIn + request.tokensOut;
			row.roxCost += toNumber(request.roxCost);
			rows.set(request.modelId, row);
		}
		return [...rows.values()].sort((a, b) => b.roxCost - a.roxCost);
	}, [usageRequests]);

	const filteredSessions = useMemo(() => {
		const normalizedQuery = query.trim().toLowerCase();
		const rows = sessionRows.filter((row) => {
			if (!isWithinPeriod(row.lastSeenAt, period)) return false;
			if (modelId !== "all" && !row.models.includes(modelId)) return false;
			if (!normalizedQuery) return true;
			return (
				row.title.toLowerCase().includes(normalizedQuery) ||
				row.id.toLowerCase().includes(normalizedQuery) ||
				row.models.some((model) =>
					model.toLowerCase().includes(normalizedQuery),
				)
			);
		});

		rows.sort((a, b) => {
			switch (sort) {
				case "rox":
					return b.roxCost - a.roxCost;
				case "usd":
					return b.usdCost - a.usdCost;
				case "tokens":
					return b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut);
				case "requests":
					return b.requests - a.requests;
				case "title":
					return a.title.localeCompare(b.title);
				case "last":
					return (
						(b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0)
					);
			}
			return 0;
		});

		return rows;
	}, [modelId, period, query, sessionRows, sort]);

	const totals = useMemo(() => {
		return usageRequests.reduce(
			(acc, request) => ({
				requests: acc.requests + 1,
				tokensIn: acc.tokensIn + request.tokensIn,
				tokensOut: acc.tokensOut + request.tokensOut,
				roxCost: acc.roxCost + toNumber(request.roxCost),
				usdCost: acc.usdCost + toNumber(request.usdCost),
			}),
			{ requests: 0, tokensIn: 0, tokensOut: 0, roxCost: 0, usdCost: 0 },
		);
	}, [usageRequests]);

	if (isLoading) {
		return (
			<div className="space-y-3 rounded-lg border p-4">
				<Skeleton className="h-5 w-40" />
				<div className="grid gap-3 sm:grid-cols-4">
					<Skeleton className="h-20" />
					<Skeleton className="h-20" />
					<Skeleton className="h-20" />
					<Skeleton className="h-20" />
				</div>
			</div>
		);
	}

	return (
		<section className="space-y-4 rounded-lg border p-4">
			<div>
				<h3 className="text-sm font-semibold">Баланс и сессии</h3>
				<p className="text-xs text-muted-foreground">
					Детализация расходов по Rox, USD, токенам, моделям и чат-сессиям.
				</p>
			</div>

			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
				<Metric
					label="Баланс Rox"
					value={formatMoney(overview?.balance.balanceRox ?? "500")}
				/>
				<Metric label="Потрачено Rox" value={formatFixed(totals.roxCost)} />
				<Metric label="Расходы USD" value={`$${formatFixed(totals.usdCost)}`} />
				<Metric
					label="Токены"
					value={formatNumber(totals.tokensIn + totals.tokensOut)}
				/>
				<Metric label="Запросы" value={formatNumber(totals.requests)} />
			</div>

			<div className="grid gap-3 xl:grid-cols-[minmax(220px,1fr)_150px_190px_180px]">
				<Input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Фильтр по сессии, модели или ID"
				/>
				<Select
					value={period}
					onValueChange={(value) => setPeriod(value as PeriodFilter)}
				>
					<SelectTrigger>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="7d">7 дней</SelectItem>
						<SelectItem value="30d">30 дней</SelectItem>
						<SelectItem value="90d">90 дней</SelectItem>
						<SelectItem value="all">Всё время</SelectItem>
					</SelectContent>
				</Select>
				<Select value={modelId} onValueChange={setModelId}>
					<SelectTrigger>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">Все модели</SelectItem>
						{modelRows.map((row) => (
							<SelectItem key={row.modelId} value={row.modelId}>
								{row.modelId}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Select
					value={sort}
					onValueChange={(value) => setSort(value as SessionSort)}
				>
					<SelectTrigger>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="last">Сначала активные</SelectItem>
						<SelectItem value="rox">Расходы Rox</SelectItem>
						<SelectItem value="usd">Расходы USD</SelectItem>
						<SelectItem value="tokens">Токены</SelectItem>
						<SelectItem value="requests">Запросы</SelectItem>
						<SelectItem value="title">Название</SelectItem>
					</SelectContent>
				</Select>
			</div>

			<div className="grid gap-4 xl:grid-cols-[1fr_320px]">
				<div className="space-y-2">
					<SectionTitle title="Сессии" count={filteredSessions.length} />
					<div className="max-h-80 overflow-auto rounded-md border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Сессия</TableHead>
									<TableHead>Модели</TableHead>
									<TableHead className="text-right">Запросы</TableHead>
									<TableHead className="text-right">Токены</TableHead>
									<TableHead className="text-right">Rox</TableHead>
									<TableHead>Последняя</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{filteredSessions.length === 0 ? (
									<TableRow>
										<TableCell
											colSpan={6}
											className="py-6 text-center text-muted-foreground"
										>
											Нет данных под выбранные фильтры
										</TableCell>
									</TableRow>
								) : (
									filteredSessions.map((row) => (
										<TableRow key={row.id}>
											<TableCell>
												<div className="max-w-56 truncate font-medium">
													{row.title}
												</div>
												<div className="text-xs text-muted-foreground">
													{row.id.slice(0, 8)}
												</div>
											</TableCell>
											<TableCell>
												<div className="flex max-w-52 flex-wrap gap-1">
													{row.models.map((model) => (
														<Badge key={model} variant="outline">
															{model}
														</Badge>
													))}
												</div>
											</TableCell>
											<TableCell className="text-right">
												{formatNumber(row.requests)}
											</TableCell>
											<TableCell className="text-right">
												{formatNumber(row.tokensIn + row.tokensOut)}
											</TableCell>
											<TableCell className="text-right">
												{formatFixed(row.roxCost)}
											</TableCell>
											<TableCell>{formatDate(row.lastSeenAt)}</TableCell>
										</TableRow>
									))
								)}
							</TableBody>
						</Table>
					</div>
				</div>

				<div className="space-y-4">
					<div className="space-y-2">
						<SectionTitle title="Модели" count={modelRows.length} />
						<div className="space-y-2">
							{modelRows.slice(0, 8).map((row) => (
								<div
									key={row.modelId}
									className="rounded-md border px-3 py-2 text-xs"
								>
									<div className="truncate font-medium">{row.modelId}</div>
									<div className="mt-1 flex justify-between text-muted-foreground">
										<span>{formatNumber(row.requests)} запросов</span>
										<span>{formatFixed(row.roxCost)} Rox</span>
									</div>
								</div>
							))}
						</div>
					</div>

					<div className="space-y-2">
						<SectionTitle
							title="История баланса"
							count={overview?.ledger.length ?? 0}
						/>
						<div className="max-h-52 space-y-2 overflow-auto">
							{overview?.ledger.slice(0, 12).map((entry) => (
								<div
									key={entry.id}
									className="flex items-center justify-between rounded-md border px-3 py-2 text-xs"
								>
									<div>
										<div className="font-medium">{entry.kind}</div>
										<div className="text-muted-foreground">
											{formatDate(entry.createdAt)}
										</div>
									</div>
									<div className="font-mono">
										{formatMoney(entry.deltaRox)} Rox
									</div>
								</div>
							))}
							{overview?.ledger.length === 0 && (
								<p className="text-xs text-muted-foreground">
									История баланса пока пустая.
								</p>
							)}
						</div>
					</div>
				</div>
			</div>

			<div className="space-y-2">
				<SectionTitle title="Последние запросы" count={usageRequests.length} />
				<div className="max-h-64 overflow-auto rounded-md border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Время</TableHead>
								<TableHead>Модель</TableHead>
								<TableHead>Сессия</TableHead>
								<TableHead className="text-right">Входящие</TableHead>
								<TableHead className="text-right">Исходящие</TableHead>
								<TableHead className="text-right">Rox</TableHead>
								<TableHead className="text-right">USD</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{usageRequests.slice(0, 80).map((request) => (
								<TableRow key={request.id}>
									<TableCell>{formatDate(request.createdAt)}</TableCell>
									<TableCell>{request.modelId}</TableCell>
									<TableCell className="font-mono text-xs">
										{request.chatSessionId?.slice(0, 8) ?? "—"}
									</TableCell>
									<TableCell className="text-right">
										{formatNumber(request.tokensIn)}
									</TableCell>
									<TableCell className="text-right">
										{formatNumber(request.tokensOut)}
									</TableCell>
									<TableCell className="text-right">
										{formatFixed(toNumber(request.roxCost))}
									</TableCell>
									<TableCell className="text-right">
										{formatMoney(request.usdCost)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			</div>
		</section>
	);
}

function Metric({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-md border px-3 py-2">
			<div className="text-xs text-muted-foreground">{label}</div>
			<div className="mt-1 truncate text-lg font-semibold">{value}</div>
		</div>
	);
}

function SectionTitle({ title, count }: { title: string; count: number }) {
	return (
		<div className="flex items-center gap-2">
			<h4 className="text-sm font-medium">{title}</h4>
			<Badge variant="secondary">{formatNumber(count)}</Badge>
		</div>
	);
}
