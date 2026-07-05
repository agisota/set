const AUTH_PAGE_ROUTE_PREFIXES = ["/sign-in", "/sign-up"] as const;

export function isAuthPagePathname(pathname: string | null): boolean {
	if (!pathname) {
		return false;
	}

	return AUTH_PAGE_ROUTE_PREFIXES.some(
		(route) => pathname === route || pathname.startsWith(`${route}/`),
	);
}
