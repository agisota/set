import { auth } from "@rox/auth/server";
import { db } from "@rox/db/client";
import { userProfiles } from "@rox/db/schema";
import * as authSchema from "@rox/db/schema/auth";
import { validateHandle } from "@rox/shared/username";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { env } from "@/env";
import { apiError } from "@/lib/api-response";
import { getHandleErrorMessage } from "./handle-error";
import { checkRegisterEmailRateLimit } from "./rate-limit";

export const dynamic = "force-dynamic";

const genderSchema = z.enum(["male", "female"]);

const registerEmailSchema = z
	.object({
		handle: z.string().trim().min(1),
		email: z.email().transform((value) => value.toLowerCase()),
		birthDate: z
			.string()
			.regex(
				/^\d{4}-\d{2}-\d{2}$/,
				"Дата рождения должна быть в формате YYYY-MM-DD",
			),
		gender: genderSchema,
		password: z.string().min(8, "Пароль должен быть не короче 8 символов"),
		confirmPassword: z.string(),
	})
	.refine((data) => data.password === data.confirmPassword, {
		message: "Пароли не совпадают",
		path: ["confirmPassword"],
	});

function checkBirthDate(value: string): boolean {
	const date = new Date(`${value}T00:00:00.000Z`);
	if (Number.isNaN(date.getTime())) return false;
	if (date.toISOString().slice(0, 10) !== value) return false;

	const today = new Date();
	const minDate = new Date(Date.UTC(1900, 0, 1));
	const maxDate = new Date(
		Date.UTC(
			today.getUTCFullYear() - 13,
			today.getUTCMonth(),
			today.getUTCDate(),
		),
	);
	return date >= minDate && date <= maxDate;
}

function isUniqueViolation(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "23505"
	);
}

function checkEmailResponse(): Response {
	return Response.json({
		ok: true,
		status: "check_email",
		message: "Мы отправили письмо с подтверждением на указанную почту.",
	});
}

async function cleanupRegistrationUser(userId: string): Promise<void> {
	const personalOrgSlug = `${userId.slice(0, 8)}-team`;
	const personalOrg = await db.query.organizations.findFirst({
		where: eq(authSchema.organizations.slug, personalOrgSlug),
		columns: { id: true },
	});

	if (personalOrg) {
		await db
			.delete(authSchema.organizations)
			.where(eq(authSchema.organizations.id, personalOrg.id));
	}

	await db.delete(authSchema.users).where(eq(authSchema.users.id, userId));
}

export async function POST(request: Request): Promise<Response> {
	const json = await request.json().catch(() => null);
	const parsed = registerEmailSchema.safeParse(json);
	if (!parsed.success) {
		return apiError("Проверьте поля формы и попробуйте еще раз.", 400, {
			ok: false,
			status: "error",
			issues: z.flattenError(parsed.error).fieldErrors,
		});
	}

	const handle = validateHandle(parsed.data.handle);
	if (!handle.ok || !handle.normalized) {
		return apiError(getHandleErrorMessage(handle.error), 400, {
			ok: false,
			status: "error",
		});
	}

	const canRegister = await checkRegisterEmailRateLimit(
		request,
		parsed.data.email,
	);
	if (!canRegister) {
		return apiError(
			"Слишком много попыток регистрации. Попробуйте позже.",
			429,
			{
				ok: false,
				status: "error",
			},
		);
	}

	if (!checkBirthDate(parsed.data.birthDate)) {
		return apiError("Укажите корректную дату рождения.", 400, {
			ok: false,
			status: "error",
		});
	}

	const existingUser = await db.query.users.findFirst({
		where: eq(authSchema.users.email, parsed.data.email),
		columns: { id: true, emailVerified: true },
	});

	const existingHandle = await db.query.userProfiles.findFirst({
		where: eq(userProfiles.handle, handle.normalized),
		columns: { userId: true },
	});
	if (
		existingHandle &&
		(!existingUser ||
			existingUser.emailVerified ||
			existingHandle.userId !== existingUser.id)
	) {
		return apiError("Этот никнейм уже занят.", 409, {
			ok: false,
			status: "error",
		});
	}

	if (existingUser) {
		if (!existingUser.emailVerified) {
			await cleanupRegistrationUser(existingUser.id);
		} else {
			return checkEmailResponse();
		}
	}

	const signup = await auth.api.signUpEmail({
		headers: request.headers,
		body: {
			name: handle.normalized,
			email: parsed.data.email,
			password: parsed.data.password,
			callbackURL: `${env.NEXT_PUBLIC_WEB_URL}/sign-in?verified=1`,
		},
	});

	if (!signup.user?.id) {
		console.error("[register-email] signUpEmail returned no user id");
		return apiError("Не удалось создать аккаунт. Попробуйте еще раз.", 500, {
			ok: false,
			status: "error",
		});
	}

	try {
		await db.insert(userProfiles).values({
			userId: signup.user.id,
			handle: handle.normalized,
			displayName: handle.normalized,
			registrationProvider: "email",
			birthDate: parsed.data.birthDate,
			gender: parsed.data.gender,
		});
	} catch (error) {
		await cleanupRegistrationUser(signup.user.id);

		if (isUniqueViolation(error)) {
			return apiError("Этот никнейм уже занят.", 409, {
				ok: false,
				status: "error",
			});
		}
		throw error;
	}

	return checkEmailResponse();
}
