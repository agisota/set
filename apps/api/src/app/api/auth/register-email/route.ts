import { auth } from "@rox/auth/server";
import { db } from "@rox/db/client";
import { userProfiles } from "@rox/db/schema";
import * as authSchema from "@rox/db/schema/auth";
import { validateHandle } from "@rox/shared/username";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { env } from "@/env";
import { apiError } from "@/lib/api-response";

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

	if (!checkBirthDate(parsed.data.birthDate)) {
		return apiError("Укажите корректную дату рождения.", 400, {
			ok: false,
			status: "error",
		});
	}

	const existingHandle = await db.query.userProfiles.findFirst({
		where: eq(userProfiles.handle, handle.normalized),
		columns: { userId: true },
	});
	if (existingHandle) {
		return apiError("Этот никнейм уже занят.", 409, {
			ok: false,
			status: "error",
		});
	}

	const existingUser = await db.query.users.findFirst({
		where: eq(authSchema.users.email, parsed.data.email),
		columns: { email: true, emailVerified: true },
	});
	if (existingUser) {
		if (!existingUser.emailVerified) {
			await auth.api
				.sendVerificationEmail({
					body: {
						email: parsed.data.email,
						callbackURL: `${env.NEXT_PUBLIC_WEB_URL}/sign-in?verified=1`,
					},
				})
				.catch((error) => {
					console.error(
						"[register-email] failed to resend verification email",
						error,
					);
				});
		}
		return checkEmailResponse();
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
		await db
			.delete(authSchema.users)
			.where(eq(authSchema.users.id, signup.user.id));

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
