import { ease, motionDuration, useShouldAnimate } from "@rox/ui/motion";
import {
	createFileRoute,
	Outlet,
	useLocation,
	useNavigate,
} from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	type SettingsSection,
	useSetSettingsSearchQuery,
	useSettingsOriginRoute,
	useSettingsSearchQuery,
} from "renderer/stores/settings-state";
import { NavigationControls } from "../_dashboard/components/NavigationControls";
import { SearchResultsBanner } from "./components/SearchResultsBanner";
import { SettingsSidebar } from "./components/SettingsSidebar";
import {
	getMatchCountBySection,
	searchSettings,
} from "./utils/settings-search";

export const Route = createFileRoute("/_authenticated/settings")({
	component: SettingsLayout,
});

const SECTION_ORDER: SettingsSection[] = [
	"account",
	"appearance",
	"ringtones",
	"keyboard",
	"voice",
	"behavior",
	"git",
	"terminal",
	"links",
	"shares",
	"models",
	"organization",
	"teams",
	"integrations",
	"apikeys",
	"permissions",
	"hosts",
	"experimental",
];

function getSectionFromPath(pathname: string): SettingsSection | null {
	if (pathname.includes("/settings/account")) return "account";
	if (pathname.includes("/settings/organization")) return "organization";
	if (pathname.includes("/settings/teams")) return "teams";
	if (pathname.includes("/settings/appearance")) return "appearance";
	if (pathname.includes("/settings/ringtones")) return "ringtones";
	if (pathname.includes("/settings/keyboard")) return "keyboard";
	if (pathname.includes("/settings/voice")) return "voice";
	if (pathname.includes("/settings/behavior")) return "behavior";
	if (pathname.includes("/settings/git")) return "git";
	if (pathname.includes("/settings/terminal")) return "terminal";
	if (pathname.includes("/settings/links")) return "links";
	if (pathname.includes("/settings/shares")) return "shares";
	if (pathname.includes("/settings/models")) return "models";
	if (pathname.includes("/settings/experimental")) return "experimental";
	if (pathname.includes("/settings/integrations")) return "integrations";
	if (pathname.includes("/settings/permissions")) return "permissions";
	if (pathname.includes("/settings/hosts")) return "hosts";
	if (pathname.includes("/settings/project")) return "project";
	return null;
}

function getPathFromSection(section: SettingsSection): string {
	switch (section) {
		case "account":
			return "/settings/account";
		case "organization":
			return "/settings/organization";
		case "teams":
			return "/settings/teams";
		case "appearance":
			return "/settings/appearance";
		case "ringtones":
			return "/settings/ringtones";
		case "keyboard":
			return "/settings/keyboard";
		case "voice":
			return "/settings/voice";
		case "behavior":
			return "/settings/behavior";
		case "git":
			return "/settings/git";
		case "terminal":
			return "/settings/terminal";
		case "links":
			return "/settings/links";
		case "shares":
			return "/settings/shares";
		case "models":
			return "/settings/models";
		case "experimental":
			return "/settings/experimental";
		case "integrations":
			return "/settings/integrations";
		case "permissions":
			return "/settings/permissions";
		case "hosts":
			return "/settings/hosts";
		default:
			return "/settings/account";
	}
}

function SettingsLayout() {
	const { data: platform } = electronTrpc.window.getPlatform.useQuery();
	const isMac = platform === undefined || platform === "darwin";
	const searchQuery = useSettingsSearchQuery();
	const setSearchQuery = useSetSettingsSearchQuery();
	const originRoute = useSettingsOriginRoute();
	const location = useLocation();
	const navigate = useNavigate();
	const normalizedSearchQuery = searchQuery.trim();
	const isSearchActive = normalizedSearchQuery.length > 0;
	const totalMatches = isSearchActive
		? searchSettings(normalizedSearchQuery).length
		: 0;

	useEffect(() => {
		if (!isSearchActive) return;

		const currentSection = getSectionFromPath(location.pathname);
		if (!currentSection) return;

		if (currentSection === "project") return;
		if (currentSection === "hosts") return;

		const matchCounts = getMatchCountBySection(normalizedSearchQuery);
		const currentHasMatches = (matchCounts[currentSection] ?? 0) > 0;

		if (!currentHasMatches) {
			const firstMatch = SECTION_ORDER.find(
				(section) => (matchCounts[section] ?? 0) > 0,
			);
			if (firstMatch) {
				navigate({ to: getPathFromSection(firstMatch), replace: true });
			}
		}
	}, [isSearchActive, location.pathname, navigate, normalizedSearchQuery]);

	useHotkeys(
		"escape",
		(event) => {
			if (document.querySelector('[data-state="open"]')) return;
			const segments = location.pathname.split("/").filter(Boolean);
			event.preventDefault();
			if (segments.length <= 2) {
				navigate({ to: originRoute });
				return;
			}

			const parent = `/${segments.slice(0, -1).join("/")}`;
			navigate({ to: parent });
		},
		{ enableOnFormTags: false, enableOnContentEditable: false },
		[navigate, location.pathname, originRoute],
	);

	const shouldAnimate = useShouldAnimate("decorative");
	const section: string =
		getSectionFromPath(location.pathname) ?? location.pathname;

	const usesInnerSidebar =
		location.pathname.startsWith("/settings/projects") ||
		location.pathname.startsWith("/settings/hosts") ||
		location.pathname.startsWith("/settings/agents");

	return (
		<div className="flex flex-col h-screen w-screen bg-tertiary">
			<div
				className="drag flex h-12 w-full items-center gap-1.5 bg-tertiary"
				style={{
					paddingLeft: isMac ? "96px" : "8px",
				}}
			>
				<NavigationControls />
			</div>

			<div className="flex flex-1 overflow-hidden">
				<SettingsSidebar />
				<div className="flex-1 m-3 bg-background rounded overflow-auto">
					{isSearchActive && (
						<SearchResultsBanner
							query={normalizedSearchQuery}
							matchCount={totalMatches}
							onClear={() => setSearchQuery("")}
						/>
					)}
					<AnimatePresence mode="wait" initial={false}>
						{shouldAnimate ? (
							<motion.div
								key={section}
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								transition={{
									duration: motionDuration.fast,
									ease: ease.standard,
								}}
							>
								{usesInnerSidebar ? (
									<Outlet />
								) : (
									<div className="mx-auto w-full max-w-7xl">
										<Outlet />
									</div>
								)}
							</motion.div>
						) : usesInnerSidebar ? (
							<Outlet />
						) : (
							<div className="mx-auto w-full max-w-7xl">
								<Outlet />
							</div>
						)}
					</AnimatePresence>
				</div>
			</div>
		</div>
	);
}
