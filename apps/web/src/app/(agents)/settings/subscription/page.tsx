import type { Metadata } from "next";
import { api } from "@/trpc/server";
import { buildSubscriptionSummary } from "../../agents/data";
import { SubscriptionCard } from "../../components/AgentsCabinet/SubscriptionCard";

export const metadata: Metadata = {
	title: "Подписка — Rox",
};

export default async function SubscriptionSettingsPage() {
	const trpc = await api();
	const balance = await trpc.economy.balance.query().catch((error) => {
		console.error(
			"[SubscriptionSettingsPage] failed to load Rox balance",
			error,
		);
		return null;
	});

	return (
		<div className="mx-auto w-full max-w-3xl px-4 py-10">
			<header className="mb-8">
				<h1 className="font-medium text-2xl leading-none">Подписка</h1>
				<p className="mt-2 text-muted-foreground text-sm">
					Текущий доступ, Rox-баланс и будущая точка продления подписки.
				</p>
			</header>
			<SubscriptionCard subscription={buildSubscriptionSummary(balance)} />
		</div>
	);
}
