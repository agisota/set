import { Badge } from "@rox/ui/badge";
import { Button } from "@rox/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@rox/ui/card";
import { CreditCard, RefreshCw, WalletCards } from "lucide-react";
import type { AgentsSubscriptionSummary } from "../../agents/data";

type SubscriptionCardProps = {
	subscription: AgentsSubscriptionSummary;
};

export function SubscriptionCard({ subscription }: SubscriptionCardProps) {
	const isActive = subscription.status === "active";

	return (
		<Card className="rounded-lg">
			<CardHeader className="gap-1">
				<div className="flex items-start justify-between gap-3">
					<div>
						<CardTitle>Подписка</CardTitle>
						<p className="mt-1 text-sm text-muted-foreground">
							Текущий доступ построен на prepaid Rox-балансе.
						</p>
					</div>
					<Badge variant={isActive ? "default" : "secondary"}>
						{isActive ? "активна" : "нет данных"}
					</Badge>
				</div>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="rounded-lg border p-4">
					<div className="flex items-center gap-2 text-sm font-medium">
						<WalletCards className="size-4" />
						{subscription.planName}
					</div>
					<p className="mt-3 text-3xl font-semibold tracking-tight">
						{subscription.balanceRox
							? `${formatRox(subscription.balanceRox)} Rox`
							: "не загружено"}
					</p>
					<p className="mt-2 text-sm text-muted-foreground">
						{subscription.updatedAt
							? `Обновлено ${formatDate(subscription.updatedAt)}`
							: "Баланс появится после подключения локальной БД/API."}
					</p>
				</div>
				<Button type="button" className="w-full" disabled>
					<CreditCard className="size-4" />
					Продлить подписку
				</Button>
				<div className="flex items-start gap-2 rounded-lg bg-muted/60 p-3 text-muted-foreground text-xs">
					<RefreshCw className="mt-0.5 size-3.5 shrink-0" />
					<span>
						Платежный поток пока не подключен. Кнопка оставлена как локальный
						макет для проверки кабинета.
					</span>
				</div>
			</CardContent>
		</Card>
	);
}

function formatRox(value: string) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) {
		return value;
	}

	return new Intl.NumberFormat("ru-RU", {
		maximumFractionDigits: 2,
	}).format(numeric);
}

function formatDate(value: Date) {
	return new Intl.DateTimeFormat("ru-RU", {
		day: "2-digit",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
	}).format(value);
}
