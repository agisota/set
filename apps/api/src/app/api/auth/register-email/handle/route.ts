import { db } from "@rox/db/client";
import { userProfiles } from "@rox/db/schema";
import { validateHandle } from "@rox/shared/username";
import { eq } from "drizzle-orm";

import { apiError } from "@/lib/api-response";
import { checkHandleRateLimit } from "../rate-limit";

export const dynamic = "force-dynamic";

function getHandleErrorMessage(error: string | undefined): string {
	switch (error) {
		case "too_short":
			return "Никнейм должен быть не короче 4 символов.";
		case "too_long":
			return "Никнейм должен быть не длиннее 16 символов.";
		case "invalid_chars":
			return "Никнейм может содержать только латиницу, цифры и подчеркивание.";
		case "reserved":
			return "Этот никнейм нельзя использовать.";
		default:
			return "Некорректный никнейм.";
	}
}

export async function GET(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const handleInput = url.searchParams.get("handle") ?? "";
	const handle = validateHandle(handleInput);

	if (!handle.ok || !handle.normalized) {
		return apiError(getHandleErrorMessage(handle.error), 400, {
			ok: false,
			available: false,
			status: "invalid",
		});
	}

	const canCheckHandle = await checkHandleRateLimit(request, handle.normalized);
	if (!canCheckHandle) {
		return apiError("Слишком много проверок никнейма. Попробуйте позже.", 429, {
			ok: false,
			available: false,
			status: "rate_limited",
		});
	}

	const existingHandle = await db.query.userProfiles.findFirst({
		where: eq(userProfiles.handle, handle.normalized),
		columns: { userId: true },
	});

	if (existingHandle) {
		return Response.json({
			ok: true,
			available: false,
			status: "taken",
			message: "Этот никнейм уже занят.",
		});
	}

	return Response.json({
		ok: true,
		available: true,
		status: "available",
		message: "Никнейм свободен.",
		normalized: handle.normalized,
	});
}
