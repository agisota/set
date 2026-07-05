"use client";

import { Button } from "@rox/ui/button";
import { Calendar } from "@rox/ui/calendar";
import { Input } from "@rox/ui/input";
import { Label } from "@rox/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@rox/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@rox/ui/select";
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { env } from "@/env";

type Gender = "female" | "male";
type SubmissionState = "idle" | "check_email" | "success" | "error";
type HandleStatus = "idle" | "checking" | "available" | "taken" | "invalid";

type RegisterEmailResponse = {
	ok?: boolean;
	status?: "check_email" | "success" | "error";
	message?: string;
	error?: string;
};

type HandleCheckResponse = {
	available?: boolean;
	message?: string;
	error?: string;
};

const INITIAL_FORM = {
	handle: "",
	email: "",
	birthDate: "",
	gender: "" as Gender | "",
	password: "",
	confirmPassword: "",
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_BIRTH_DATE = new Date(1900, 0, 1);
const BIRTH_MONTHS = Array.from({ length: 12 }, (_, index) => ({
	value: String(index),
	label: new Intl.DateTimeFormat("ru-RU", { month: "long" }).format(
		new Date(2024, index, 1),
	),
}));

function getMaxBirthDate(): Date {
	const today = new Date();
	return new Date(today.getFullYear() - 13, today.getMonth(), today.getDate());
}

function getDefaultBirthDateMonth(): Date {
	return new Date(getMaxBirthDate().getFullYear(), 0, 1);
}

function getBirthYears(): number[] {
	const maxYear = getMaxBirthDate().getFullYear();
	return Array.from(
		{ length: maxYear - MIN_BIRTH_DATE.getFullYear() + 1 },
		(_, index) => maxYear - index,
	);
}

function clampBirthDateMonth(date: Date): Date {
	const maxBirthDate = getMaxBirthDate();
	const month = new Date(date.getFullYear(), date.getMonth(), 1);
	const minMonth = new Date(
		MIN_BIRTH_DATE.getFullYear(),
		MIN_BIRTH_DATE.getMonth(),
		1,
	);
	const maxMonth = new Date(
		maxBirthDate.getFullYear(),
		maxBirthDate.getMonth(),
		1,
	);

	if (month < minMonth) return minMonth;
	if (month > maxMonth) return maxMonth;
	return month;
}

function isBirthMonthDisabled(month: number, year: number): boolean {
	const maxBirthDate = getMaxBirthDate();

	return (
		(year === MIN_BIRTH_DATE.getFullYear() &&
			month < MIN_BIRTH_DATE.getMonth()) ||
		(year === maxBirthDate.getFullYear() && month > maxBirthDate.getMonth())
	);
}

function parseBirthDate(value: string): Date | undefined {
	if (!value) return undefined;
	const [year, month, day] = value.split("-").map(Number);
	if (!year || !month || !day) return undefined;
	const date = new Date(year, month - 1, day);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

function formatBirthDateValue(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function formatBirthDateLabel(value: string): string {
	const date = parseBirthDate(value);
	if (!date) return "Выберите дату";
	return new Intl.DateTimeFormat("ru-RU", {
		day: "2-digit",
		month: "long",
		year: "numeric",
	}).format(date);
}

function getResponseMessage(
	payload: RegisterEmailResponse,
	fallback: string,
): string {
	return payload.message ?? payload.error ?? fallback;
}

export function EmailRegistrationForm() {
	const handleId = useId();
	const emailId = useId();
	const birthDateId = useId();
	const genderId = useId();
	const passwordId = useId();
	const confirmPasswordId = useId();

	const [form, setForm] = useState(INITIAL_FORM);
	const [submissionState, setSubmissionState] =
		useState<SubmissionState>("idle");
	const [message, setMessage] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [handleStatus, setHandleStatus] = useState<HandleStatus>("idle");
	const [handleMessage, setHandleMessage] = useState<string | null>(null);
	const [isBirthDateOpen, setIsBirthDateOpen] = useState(false);
	const [birthDateMonth, setBirthDateMonth] = useState(
		getDefaultBirthDateMonth,
	);

	const updateField = (field: keyof typeof INITIAL_FORM, value: string) => {
		setForm((current) => ({ ...current, [field]: value }));
	};

	const selectedBirthDate = parseBirthDate(form.birthDate);
	const birthYears = getBirthYears();
	const maxBirthDate = getMaxBirthDate();

	const updateBirthDateMonth = (date: Date) => {
		setBirthDateMonth(clampBirthDateMonth(date));
	};

	useEffect(() => {
		const normalizedHandle = form.handle.trim().replace(/^@+/, "");
		if (!normalizedHandle) {
			setHandleStatus("idle");
			setHandleMessage(null);
			return;
		}

		const controller = new AbortController();
		const timeoutId = window.setTimeout(async () => {
			setHandleStatus("checking");
			setHandleMessage("Проверяем никнейм...");

			try {
				const response = await fetch(
					`${env.NEXT_PUBLIC_API_URL}/api/auth/register-email/handle?handle=${encodeURIComponent(normalizedHandle)}`,
					{ signal: controller.signal },
				);
				const payload = (await response.json().catch(() => ({}))) as
					| HandleCheckResponse
					| Record<string, never>;
				const nextMessage =
					payload.message ?? payload.error ?? "Не удалось проверить никнейм.";

				if (!response.ok) {
					setHandleStatus("invalid");
					setHandleMessage(nextMessage);
					return;
				}

				setHandleStatus(payload.available ? "available" : "taken");
				setHandleMessage(nextMessage);
			} catch (error) {
				if ((error as { name?: string }).name === "AbortError") return;
				setHandleStatus("invalid");
				setHandleMessage("Не удалось проверить никнейм.");
			}
		}, 350);

		return () => {
			window.clearTimeout(timeoutId);
			controller.abort();
		};
	}, [form.handle]);

	const submitRegistration = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setSubmissionState("idle");
		setMessage(null);

		const normalizedHandle = form.handle.trim().replace(/^@+/, "");
		const normalizedEmail = form.email.trim().toLowerCase();

		if (!EMAIL_PATTERN.test(normalizedEmail)) {
			setSubmissionState("error");
			setMessage("Укажите корректный email.");
			return;
		}

		if (handleStatus !== "available") {
			setSubmissionState("error");
			setMessage(handleMessage ?? "Проверьте никнейм.");
			return;
		}

		if (!form.birthDate) {
			setSubmissionState("error");
			setMessage("Укажите дату рождения.");
			return;
		}

		if (form.password !== form.confirmPassword) {
			setSubmissionState("error");
			setMessage("Пароли не совпадают.");
			return;
		}

		setIsSubmitting(true);

		try {
			const response = await fetch(
				`${env.NEXT_PUBLIC_API_URL}/api/auth/register-email`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						handle: normalizedHandle,
						email: normalizedEmail,
						birthDate: form.birthDate,
						gender: form.gender,
						password: form.password,
						confirmPassword: form.confirmPassword,
					}),
				},
			);
			const payload = (await response.json().catch(() => ({}))) as
				| RegisterEmailResponse
				| Record<string, never>;

			if (!response.ok) {
				setSubmissionState("error");
				setMessage(
					getResponseMessage(
						payload,
						"Не удалось создать аккаунт. Проверьте поля и попробуйте еще раз.",
					),
				);
				return;
			}

			const nextState =
				payload.status === "success" ? "success" : "check_email";
			setSubmissionState(nextState);
			setMessage(
				getResponseMessage(
					payload,
					nextState === "success"
						? "Аккаунт создан. Можно переходить ко входу."
						: "Мы отправили письмо с подтверждением на вашу почту.",
				),
			);
		} catch (err) {
			console.error("Email registration failed:", err);
			setSubmissionState("error");
			setMessage("Сервис регистрации сейчас недоступен. Попробуйте позже.");
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<form className="grid gap-4" onSubmit={submitRegistration}>
			{message && (
				<p
					className={
						submissionState === "error"
							? "text-destructive text-center text-sm"
							: "text-center text-sm text-emerald-300"
					}
				>
					{message}
				</p>
			)}

			<div className="grid gap-2">
				<Label htmlFor={handleId}>Никнейм</Label>
				<Input
					id={handleId}
					name="handle"
					autoComplete="username"
					placeholder="yourhandle"
					required
					minLength={4}
					maxLength={16}
					pattern="[A-Za-z0-9_]+"
					value={form.handle}
					onChange={(event) => updateField("handle", event.target.value)}
				/>
				<p className="text-muted-foreground text-xs">
					Публичный адрес профиля без @, латиница, цифры или подчеркивание.
				</p>
				{handleMessage && (
					<p
						className={
							handleStatus === "available"
								? "text-emerald-300 text-xs"
								: "text-destructive text-xs"
						}
					>
						{handleMessage}
					</p>
				)}
			</div>

			<div className="grid gap-2">
				<Label htmlFor={emailId}>Email</Label>
				<Input
					id={emailId}
					name="email"
					type="email"
					autoComplete="email"
					placeholder="you@example.com"
					required
					pattern="[^\s@]+@[^\s@]+\.[^\s@]+"
					value={form.email}
					onChange={(event) => updateField("email", event.target.value)}
				/>
			</div>

			<div className="grid gap-4 sm:grid-cols-2">
				<div className="grid gap-2">
					<Label htmlFor={birthDateId}>Дата рождения</Label>
					<input
						name="birthDate"
						required
						type="hidden"
						value={form.birthDate}
						readOnly
					/>
					<Popover open={isBirthDateOpen} onOpenChange={setIsBirthDateOpen}>
						<PopoverTrigger asChild>
							<Button
								id={birthDateId}
								type="button"
								variant="outline"
								className="border-input bg-background/50 hover:bg-background/70 h-10 w-full justify-between px-3 text-left font-normal"
							>
								<span
									className={
										form.birthDate ? "text-foreground" : "text-muted-foreground"
									}
								>
									{formatBirthDateLabel(form.birthDate)}
								</span>
								<CalendarIcon className="size-4 text-muted-foreground" />
							</Button>
						</PopoverTrigger>
						<PopoverContent
							align="start"
							className="w-[min(320px,calc(100vw-2rem))] border-white/10 bg-[#120d0a] p-3 shadow-2xl sm:p-4"
						>
							<div className="mb-3 flex items-center gap-2">
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									className="size-9 shrink-0 text-white/70 hover:bg-white/10 hover:text-white"
									aria-label="Предыдущий месяц"
									onClick={() =>
										setBirthDateMonth((current) =>
											clampBirthDateMonth(
												new Date(
													current.getFullYear(),
													current.getMonth() - 1,
													1,
												),
											),
										)
									}
									disabled={
										birthDateMonth.getFullYear() ===
											MIN_BIRTH_DATE.getFullYear() &&
										birthDateMonth.getMonth() === MIN_BIRTH_DATE.getMonth()
									}
								>
									<ChevronLeftIcon className="size-4" />
								</Button>
								<Select
									value={String(birthDateMonth.getMonth())}
									onValueChange={(value) =>
										setBirthDateMonth((current) =>
											clampBirthDateMonth(
												new Date(current.getFullYear(), Number(value), 1),
											),
										)
									}
								>
									<SelectTrigger
										aria-label="Месяц рождения"
										className="h-9 flex-1 border-white/15 bg-white/5 text-white hover:bg-white/10"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent className="max-h-72 border-white/10 bg-[#1b130f] text-white">
										{BIRTH_MONTHS.map((month) => (
											<SelectItem
												key={month.value}
												value={month.value}
												disabled={isBirthMonthDisabled(
													Number(month.value),
													birthDateMonth.getFullYear(),
												)}
											>
												{month.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<Select
									value={String(birthDateMonth.getFullYear())}
									onValueChange={(value) =>
										setBirthDateMonth((current) =>
											clampBirthDateMonth(
												new Date(Number(value), current.getMonth(), 1),
											),
										)
									}
								>
									<SelectTrigger
										aria-label="Год рождения"
										className="h-9 w-[92px] border-white/15 bg-white/5 text-white hover:bg-white/10"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent className="max-h-72 border-white/10 bg-[#1b130f] text-white">
										{birthYears.map((year) => (
											<SelectItem key={year} value={String(year)}>
												{year}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									className="size-9 shrink-0 text-white/70 hover:bg-white/10 hover:text-white"
									aria-label="Следующий месяц"
									onClick={() =>
										setBirthDateMonth((current) =>
											clampBirthDateMonth(
												new Date(
													current.getFullYear(),
													current.getMonth() + 1,
													1,
												),
											),
										)
									}
									disabled={
										birthDateMonth.getFullYear() ===
											maxBirthDate.getFullYear() &&
										birthDateMonth.getMonth() === maxBirthDate.getMonth()
									}
								>
									<ChevronRightIcon className="size-4" />
								</Button>
							</div>
							<Calendar
								mode="single"
								month={birthDateMonth}
								onMonthChange={updateBirthDateMonth}
								selected={selectedBirthDate}
								onSelect={(date) => {
									if (!date) return;
									updateField("birthDate", formatBirthDateValue(date));
									updateBirthDateMonth(date);
									setIsBirthDateOpen(false);
								}}
								hideNavigation
								startMonth={MIN_BIRTH_DATE}
								endMonth={maxBirthDate}
								disabled={{ after: maxBirthDate, before: MIN_BIRTH_DATE }}
								formatters={{
									formatWeekdayName: (date) =>
										date.toLocaleString("ru-RU", { weekday: "short" }),
								}}
								className="w-full rounded-md bg-transparent p-0 text-foreground [--cell-size:--spacing(8)] sm:[--cell-size:--spacing(9)]"
								classNames={{
									root: "w-full",
									months: "w-full",
									month: "w-full gap-2",
									month_caption: "hidden",
									weekdays: "grid grid-cols-7",
									week: "grid grid-cols-7 gap-1",
									weekday:
										"h-8 text-center text-[11px] font-medium uppercase text-white/55",
									day: "h-9 p-0 text-center text-sm text-white/85",
									day_button:
										"size-9 rounded-md text-sm text-white/85 hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/30 data-[selected-single=true]:bg-white data-[selected-single=true]:text-[#120d0a]",
									outside: "text-white/25",
									disabled: "text-white/20 opacity-40",
									selected:
										"rounded-md bg-white text-black hover:bg-white hover:text-black",
									today: "rounded-md bg-white/10 font-semibold text-white",
								}}
								buttonVariant="ghost"
							/>
						</PopoverContent>
					</Popover>
				</div>

				<div className="grid gap-2">
					<Label htmlFor={genderId}>Пол</Label>
					<Select
						value={form.gender}
						onValueChange={(value) => updateField("gender", value)}
						required
					>
						<SelectTrigger id={genderId} className="w-full">
							<SelectValue placeholder="Выберите" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="male">Мужской</SelectItem>
							<SelectItem value="female">Женский</SelectItem>
						</SelectContent>
					</Select>
				</div>
			</div>

			<div className="grid gap-2">
				<Label htmlFor={passwordId}>Пароль</Label>
				<Input
					id={passwordId}
					name="password"
					type="password"
					autoComplete="new-password"
					required
					minLength={8}
					value={form.password}
					onChange={(event) => updateField("password", event.target.value)}
				/>
			</div>

			<div className="grid gap-2">
				<Label htmlFor={confirmPasswordId}>Повторите пароль</Label>
				<Input
					id={confirmPasswordId}
					name="confirmPassword"
					type="password"
					autoComplete="new-password"
					required
					minLength={8}
					value={form.confirmPassword}
					onChange={(event) =>
						updateField("confirmPassword", event.target.value)
					}
				/>
			</div>

			<Button
				type="submit"
				disabled={isSubmitting || handleStatus !== "available"}
				className="w-full"
			>
				{isSubmitting ? "Создаем аккаунт..." : "Создать аккаунт"}
			</Button>
		</form>
	);
}
