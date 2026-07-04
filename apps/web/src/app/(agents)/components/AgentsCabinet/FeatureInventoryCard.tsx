import { Badge } from "@rox/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@rox/ui/card";
import {
	ArrowRight,
	Building2,
	Contact,
	FolderKanban,
	Globe2,
	MessageSquareText,
	Palette,
	Plug,
	Search,
	Settings,
	Share2,
	Sparkles,
	Users,
} from "lucide-react";
import Link from "next/link";

const accountSurfaces = [
	{
		title: "Профиль",
		description: "OAuth-аккаунты, Telegram и публичный handle.",
		href: "/settings/identity",
		icon: Settings,
		status: "готово",
	},
	{
		title: "Организация",
		description: "Название активной организации и slug.",
		href: "/settings/organization",
		icon: Building2,
		status: "готово",
	},
	{
		title: "Участники",
		description: "Инвайты, роли и удаление участников.",
		href: "/settings/members",
		icon: Users,
		status: "готово",
	},
	{
		title: "Команды",
		description: "Создание и список команд.",
		href: "/settings/teams",
		icon: FolderKanban,
		status: "готово",
	},
	{
		title: "Внешний вид",
		description: "Локальные настройки темы и обоев.",
		href: "/settings/appearance",
		icon: Palette,
		status: "локально",
	},
	{
		title: "Публичный профиль",
		description: "Страница handle и будущие публичные секции.",
		href: "/settings/identity",
		icon: Globe2,
		status: "частично",
	},
	{
		title: "Подписка",
		description: "Rox-баланс и локальная кнопка продления.",
		href: "/settings/subscription",
		icon: Sparkles,
		status: "локально",
	},
] as const;

const hiddenSurfaces = [
	{
		title: "Поиск",
		description: "Unified search по объектам, комнатам и агентам.",
		href: "/agents/search",
		icon: Search,
	},
	{
		title: "Источники",
		description: "Подключение источников для agent-native flows.",
		href: "/agents/sources",
		icon: Plug,
	},
	{
		title: "Комментарии",
		description: "Threads-as-objects surface для совместной работы.",
		href: "/agents/comments",
		icon: MessageSquareText,
	},
	{
		title: "Контакты",
		description: "CRM contacts surface, закрыт org/feature gate.",
		href: "/agents/contacts",
		icon: Contact,
	},
	{
		title: "Шаблоны",
		description: "Marketplace шаблонов и будущих agent configs.",
		href: "/agents/templates",
		icon: Sparkles,
	},
	{
		title: "Публичные ресурсы",
		description: "Shared profile/resources готовы к наполнению.",
		href: "/settings/identity",
		icon: Share2,
	},
] as const;

export function FeatureInventoryCard() {
	return (
		<Card className="rounded-lg">
			<CardHeader className="gap-1">
				<CardTitle>Что уже есть в личном кабинете</CardTitle>
				<p className="text-sm text-muted-foreground">
					Собрано из текущего main, скрытых route surfaces и старых
					веток-аудитов.
				</p>
			</CardHeader>
			<CardContent className="space-y-5">
				<SurfaceGroup title="Аккаунт и организация" items={accountSurfaces} />
				<SurfaceGroup
					title="Скрытые рабочие поверхности"
					items={hiddenSurfaces}
				/>
			</CardContent>
		</Card>
	);
}

type SurfaceItem =
	| (typeof accountSurfaces)[number]
	| (typeof hiddenSurfaces)[number];

function SurfaceGroup({
	title,
	items,
}: {
	title: string;
	items: readonly SurfaceItem[];
}) {
	return (
		<section className="space-y-3">
			<div className="text-sm font-medium">{title}</div>
			<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
				{items.map((item) => {
					const Icon = item.icon;
					return (
						<Link
							key={item.title}
							href={item.href}
							className="group rounded-lg border p-4 transition-colors hover:bg-muted/50"
						>
							<div className="flex items-start justify-between gap-3">
								<div className="flex min-w-0 items-center gap-2">
									<div className="rounded-md border bg-muted p-1.5 text-muted-foreground">
										<Icon className="size-4" />
									</div>
									<div className="truncate text-sm font-medium">
										{item.title}
									</div>
								</div>
								<ArrowRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
							</div>
							<p className="mt-3 line-clamp-2 text-muted-foreground text-sm">
								{item.description}
							</p>
							{"status" in item ? (
								<Badge variant="outline" className="mt-3">
									{item.status}
								</Badge>
							) : null}
						</Link>
					);
				})}
			</div>
		</section>
	);
}
