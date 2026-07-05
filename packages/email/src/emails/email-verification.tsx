import { Heading, Text } from "@react-email/components";
import { Button, StandardLayout } from "../components";

interface EmailVerificationEmailProps {
	userName?: string | null;
	verificationUrl: string;
}

export function EmailVerificationEmail({
	userName,
	verificationUrl = "https://app.rox.one/verify-email?token=sample",
}: EmailVerificationEmailProps) {
	const greeting = userName?.trim()
		? `Здравствуйте, ${userName}!`
		: "Здравствуйте!";

	return (
		<StandardLayout preview="Подтвердите почту для аккаунта Rox">
			<Heading className="text-lg font-normal leading-7 mb-8 text-foreground text-center">
				Подтвердите почту
			</Heading>

			<Text className="text-base leading-[26px] mb-4 text-foreground">
				{greeting}
			</Text>

			<Text className="text-base leading-[26px] text-foreground mb-4">
				Нажмите кнопку ниже, чтобы активировать аккаунт Rox. До подтверждения
				почты аккаунт не считается активированным.
			</Text>

			<Button href={verificationUrl}>Подтвердить почту</Button>

			<Text className="text-sm leading-[22px] text-muted-foreground mt-6">
				Если вы не регистрировались в Rox, просто проигнорируйте это письмо.
			</Text>
		</StandardLayout>
	);
}

export default EmailVerificationEmail;
