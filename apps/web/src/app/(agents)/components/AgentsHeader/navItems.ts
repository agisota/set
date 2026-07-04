/**
 * Top-nav entries for the agents cabinet header. Extracted from the component
 * so the link set is unit-testable (WS-B T6). Adding Workspaces + Pipelines
 * here is half of the 404 fix: flag-ON users previously could not navigate to
 * those routes because the nav only listed Агенты + Интеграции.
 */
export interface AgentsNavItem {
	label: string;
	href: string;
}

export const navItems: AgentsNavItem[] = [
	{ label: "Агенты", href: "/agents" },
	{ label: "Рабочие области", href: "/agents/workspaces" },
	{ label: "Пайплайны", href: "/agents/pipelines" },
	{ label: "Доска", href: "/agents/board" },
	{ label: "Шаблоны", href: "/agents/templates" },
	{ label: "Поиск", href: "/agents/search" },
	{ label: "Источники", href: "/agents/sources" },
	{ label: "Контакты", href: "/agents/contacts" },
	{ label: "Комментарии", href: "/agents/comments" },
	{ label: "Входящие", href: "/inbox" },
	{ label: "Календарь", href: "/calendar" },
	{ label: "Интеграции", href: "/integrations" },
	{ label: "Диск", href: "/drive" },
	{ label: "Заметки", href: "/notes" },
];
