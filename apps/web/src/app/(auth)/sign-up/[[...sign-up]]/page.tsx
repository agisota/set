"use client";

import { authClient } from "@rox/auth/client";
import { Button } from "@rox/ui/button";
import Link from "next/link";
import { useState } from "react";
import { env } from "@/env";
import { EmailRegistrationForm } from "../../components/EmailRegistrationForm";

export default function SignUpPage() {
	// Public social registration is Yandex-only for now. Email registration below
	// creates verified email/password accounts through the API route.
	const [isLoadingYandex, setIsLoadingYandex] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const signUpWithYandex = async () => {
		setIsLoadingYandex(true);
		setError(null);

		try {
			await authClient.signIn.oauth2({
				providerId: "yandex",
				callbackURL: env.NEXT_PUBLIC_WEB_URL,
			});
		} catch (err) {
			console.error("Yandex sign up failed:", err);
			setError(
				"Не удалось зарегистрироваться через Яндекс. Попробуйте еще раз.",
			);
			setIsLoadingYandex(false);
		}
	};

	return (
		<div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[460px]">
			<div className="flex flex-col space-y-2 text-center">
				<h1 className="text-2xl font-semibold tracking-tight">
					Создайте аккаунт
				</h1>
				<p className="text-muted-foreground text-sm">
					Зарегистрируйтесь, чтобы начать работу с Rox
				</p>
			</div>
			<div className="grid gap-4">
				{error && (
					<p className="text-destructive text-center text-sm">{error}</p>
				)}
				<Button
					variant="outline"
					disabled={isLoadingYandex}
					onClick={signUpWithYandex}
					className="w-full"
				>
					<span
						aria-hidden
						className="mr-2 flex size-4 items-center justify-center rounded-full bg-[#FC3F1D] text-[10px] font-bold text-white"
					>
						Я
					</span>
					{isLoadingYandex ? "Загрузка..." : "Зарегистрироваться через Яндекс"}
				</Button>
				<div className="flex items-center gap-3">
					<span className="h-px flex-1 bg-white/10" />
					<span className="text-foreground text-xs uppercase">
						или через email
					</span>
					<span className="h-px flex-1 bg-white/10" />
				</div>
				<EmailRegistrationForm />
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
					Уже есть аккаунт?{" "}
					<Link
						href="/sign-in"
						className="hover:text-primary underline underline-offset-4"
					>
						Войти
					</Link>
				</p>
			</div>
		</div>
	);
}
