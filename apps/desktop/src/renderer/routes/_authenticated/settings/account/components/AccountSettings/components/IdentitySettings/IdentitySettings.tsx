import { validateHandle } from "@rox/shared/username";
import type { RouterOutputs } from "@rox/trpc";
import { Avatar } from "@rox/ui/atoms/Avatar";
import { Badge } from "@rox/ui/badge";
import { Button } from "@rox/ui/button";
import { Input } from "@rox/ui/input";
import { Label } from "@rox/ui/label";
import { Skeleton } from "@rox/ui/skeleton";
import { toast } from "@rox/ui/sonner";
import { useEffect, useState } from "react";
import { apiTrpcClient } from "renderer/lib/api-trpc-client";

type Identity = RouterOutputs["identity"]["getMine"];
type ConnectedAccount = Identity["connectedAccounts"][number];

/** Display labels for known providers (RU UI copy); falls back to the id. */
const PROVIDER_LABELS: Record<string, string> = {
	github: "GitHub",
	telegram: "Telegram",
	x: "X (Twitter)",
	yandex: "Яндекс",
	email: "Электронная почта",
};

function providerLabel(providerId: string): string {
	return PROVIDER_LABELS[providerId] ?? providerId;
}

export function IdentitySettings() {
	const [identity, setIdentity] = useState<Identity | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [handleValue, setHandleValue] = useState("");
	const [isSaving, setIsSaving] = useState(false);

	useEffect(() => {
		let cancelled = false;

		async function load() {
			setIsLoading(true);
			try {
				const result = await apiTrpcClient.identity.getMine
					.query()
					.catch(() => null);
				if (cancelled) return;
				setIdentity(result);
				setHandleValue(result?.handle ?? "");
			} finally {
				if (!cancelled) setIsLoading(false);
			}
		}

		void load();
		return () => {
			cancelled = true;
		};
	}, []);

	async function handleClaim() {
		const trimmed = handleValue.trim();
		if (!identity?.canClaimHandle) return;
		if (trimmed === (identity?.handle ?? "")) return;

		const result = validateHandle(trimmed);
		if (!result.ok) {
			toast.error(
				"Имя пользователя: 4–16 символов, строчные латинские буквы, цифры и подчёркивание.",
			);
			return;
		}

		setIsSaving(true);
		try {
			const saved = await apiTrpcClient.identity.claimHandle.mutate({
				handle: trimmed,
			});
			setIdentity((prev) => (prev ? { ...prev, handle: saved.handle } : prev));
			setHandleValue(saved.handle ?? "");
			toast.success("Имя пользователя обновлено");
		} catch {
			toast.error(
				"Не удалось сохранить имя пользователя. Возможно, оно занято.",
			);
			setHandleValue(identity?.handle ?? "");
		} finally {
			setIsSaving(false);
		}
	}

	// Cache-first: render the existing identity rows while a refetch is in
	// flight; only show the skeleton when we have nothing yet (AGENTS.md #9).
	if (isLoading && !identity) {
		return (
			<section className="space-y-3 rounded-lg border p-4">
				<Skeleton className="h-5 w-40" />
				<Skeleton className="h-12 w-full" />
				<Skeleton className="h-10 w-80" />
			</section>
		);
	}

	const canClaim = identity?.canClaimHandle ?? false;
	const connectedAccounts = identity?.connectedAccounts ?? [];

	return (
		<section className="space-y-5 rounded-lg border p-4">
			<div>
				<h3 className="text-sm font-semibold">Идентичность</h3>
				<p className="text-xs text-muted-foreground">
					Привязанные аккаунты и ваше имя пользователя в Rox.
				</p>
			</div>

			<div className="space-y-2">
				<Label>Привязанные аккаунты</Label>
				{connectedAccounts.length === 0 ? (
					<p className="text-xs text-muted-foreground">
						Нет привязанных аккаунтов.
					</p>
				) : (
					<ul className="space-y-2">
						{connectedAccounts.map((account) => (
							<ConnectedAccountRow
								key={`${account.providerId}:${account.providerAccountId}`}
								account={account}
							/>
						))}
					</ul>
				)}
			</div>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor="identity-username">Имя пользователя</Label>
				<div className="flex items-center gap-2">
					<Input
						id="identity-username"
						value={handleValue}
						onChange={(event) => setHandleValue(event.target.value)}
						placeholder="имя_пользователя"
						autoCapitalize="none"
						autoCorrect="off"
						spellCheck={false}
						className="w-72"
						disabled={!canClaim || isSaving}
					/>
					<Button
						type="button"
						variant="outline"
						onClick={handleClaim}
						disabled={
							!canClaim ||
							isSaving ||
							handleValue.trim() === (identity?.handle ?? "")
						}
					>
						Сохранить
					</Button>
				</div>

				{canClaim ? (
					<p className="text-xs text-muted-foreground">
						Публичный профиль: rox.one/@
						{handleValue.trim() || "имя_пользователя"}
					</p>
				) : (
					<p className="select-text cursor-text text-xs text-amber-600 dark:text-amber-500">
						Имя пользователя можно выбрать после подтверждения аккаунта через
						поддерживаемый способ входа. Подключите или подтвердите аккаунт в
						разделе входа.
					</p>
				)}
			</div>
		</section>
	);
}

function ConnectedAccountRow({ account }: { account: ConnectedAccount }) {
	const label = providerLabel(account.providerId);
	const displayName = account.displayUsername ?? label;

	return (
		<li className="flex items-center gap-3 rounded-md border p-2.5">
			<Avatar
				size="md"
				fullName={displayName}
				image={account.providerAvatarUrl}
			/>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="truncate text-sm font-medium">
						{account.displayUsername ?? label}
					</span>
					<Badge variant="secondary">{label}</Badge>
				</div>
				<div className="select-text cursor-text truncate text-xs text-muted-foreground">
					ID: {account.providerAccountId}
				</div>
			</div>
		</li>
	);
}
