"use client";

import { authClient } from "@rox/auth/client";
import { DEV_EMAIL, DEV_NAME, DEV_PASSWORD } from "@rox/shared/dev-credentials";
import { Button } from "@rox/ui/button";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { env } from "@/env";

export default function SignInPage() {
	const searchParams = useSearchParams();
	const redirect = searchParams.get("redirect");
	// Treat `redirect` as a PATH only: it must start with a single "/" (not "//",
	// which browsers resolve as a protocol-relative foreign host). This blocks
	// open-redirect payloads like `redirect=@evil.com` or `redirect=//evil.com`
	// from producing a callback URL on a host other than our own web app.
	const callbackURL =
		redirect?.startsWith("/") && !redirect.startsWith("//")
			? `${env.NEXT_PUBLIC_WEB_URL}${redirect}`
			: env.NEXT_PUBLIC_WEB_URL;

	// Public login is Yandex-only for now. Email/password remains available for
	// verified accounts and for the dev-gated Local Admin shortcut below.
	const isDev = process.env.NODE_ENV === "development";

	const [isLoadingYandex, setIsLoadingYandex] = useState(false);
	const [isLoadingDev, setIsLoadingDev] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const signInWithYandex = async () => {
		setIsLoadingYandex(true);
		setError(null);

		try {
			await authClient.signIn.oauth2({
				providerId: "yandex",
				callbackURL,
			});
		} catch (err) {
			console.error("Yandex sign in failed:", err);
			setError("Не удалось войти через Яндекс. Попробуйте еще раз.");
			setIsLoadingYandex(false);
		}
	};

	const signInAsDev = async () => {
		setIsLoadingDev(true);
		setError(null);

		try {
			let res = await authClient.signIn.email({
				email: DEV_EMAIL,
				password: DEV_PASSWORD,
			});
			if (res.error) {
				const signUpRes = await authClient.signUp.email({
					email: DEV_EMAIL,
					password: DEV_PASSWORD,
					name: DEV_NAME,
				});
				if (signUpRes.error) throw new Error(signUpRes.error.message);
				res = await authClient.signIn.email({
					email: DEV_EMAIL,
					password: DEV_PASSWORD,
				});
			}
			if (res.error) throw new Error(res.error.message);
			window.location.href = callbackURL;
		} catch (err) {
			console.error("Dev sign in failed:", err);
			setError(
				err instanceof Error ? err.message : "Не удалось войти как разработчик",
			);
			setIsLoadingDev(false);
		}
	};

	const isLoading = isLoadingYandex || isLoadingDev;

	return (
		<div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[350px]">
			<div className="flex flex-col space-y-2 text-center">
				<h1 className="text-2xl font-semibold tracking-tight">
					С возвращением
				</h1>
				<p className="text-muted-foreground text-sm">
					Войдите, чтобы продолжить работу с Rox
				</p>
			</div>
			<div className="grid gap-4">
				{error && (
					<p className="text-destructive text-center text-sm">{error}</p>
				)}
				{isDev && (
					<Button
						variant="outline"
						disabled={isLoading}
						onClick={signInAsDev}
						className="w-full"
					>
						{isLoadingDev
							? "Выполняется вход..."
							: "Войти как локальный администратор (dev)"}
					</Button>
				)}
				<Button
					variant="outline"
					disabled={isLoading}
					onClick={signInWithYandex}
					className="w-full"
				>
					<span
						aria-hidden
						className="mr-2 flex size-4 items-center justify-center rounded-full bg-[#FC3F1D] text-[10px] font-bold text-white"
					>
						Я
					</span>
					{isLoadingYandex ? "Загрузка..." : "Войти через Яндекс"}
				</Button>
				<p className="text-muted-foreground px-8 text-center text-sm">
					Нажимая «Продолжить», вы соглашаетесь с нашими{" "}
					<a
						href={`${env.NEXT_PUBLIC_MARKETING_URL}/terms`}
						target="_blank"
						rel="noopener noreferrer"
						className="hover:text-primary underline underline-offset-4"
					>
						Условиями обслуживания
					</a>{" "}
					и{" "}
					<a
						href={`${env.NEXT_PUBLIC_MARKETING_URL}/privacy`}
						target="_blank"
						rel="noopener noreferrer"
						className="hover:text-primary underline underline-offset-4"
					>
						Политикой конфиденциальности
					</a>
					.
				</p>
				<p className="text-center text-sm">
					Еще нет аккаунта?{" "}
					<Link
						href="/sign-up"
						className="hover:text-primary underline underline-offset-4"
					>
						Зарегистрироваться
					</Link>
				</p>
			</div>
		</div>
	);
}
