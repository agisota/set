"use client";

/**
 * AppearanceWallpaper — bridges the {@link AppearanceProvider}'s resolved
 * current wallpaper into the pure {@link WallpaperLayer}. Kept separate so the
 * fixed full-bleed background can be mounted once near the app root while the
 * rotation timer / state stay in the provider.
 */

import { WallpaperLayer } from "@rox/ui/wallpaper-layer";
import { usePathname } from "next/navigation";
import { useAppearance } from "./AppearanceProvider";
import { isAuthPagePathname } from "./authRoutes";

/** Render the current wallpaper as a fixed background behind the app. */
export function AppearanceWallpaper() {
	const pathname = usePathname();
	const { currentWallpaper } = useAppearance();

	if (isAuthPagePathname(pathname)) {
		return null;
	}

	return <WallpaperLayer wallpaper={currentWallpaper} />;
}
