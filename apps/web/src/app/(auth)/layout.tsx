import { auth } from "@rox/auth/server";
import { headers } from "next/headers";
import Image from "next/image";
import { redirect } from "next/navigation";

import { env } from "@/env";

export default async function AuthLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const session = await auth.api.getSession({
		headers: await headers(),
	});

	if (session) {
		redirect("/");
	}

	return (
		<div className="dark relative isolate flex min-h-screen flex-col overflow-hidden bg-[#0a0705] text-foreground">
			<div
				aria-hidden
				className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_50%_18%,rgba(210,86,17,0.28),transparent_34%),radial-gradient(circle_at_18%_82%,rgba(240,121,42,0.13),transparent_30%),linear-gradient(180deg,#140d07_0%,#0a0705_54%,#050403_100%)]"
			/>
			<div
				aria-hidden
				className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(120deg,transparent_0%,rgba(255,255,255,0.045)_42%,transparent_70%)]"
			/>
			<header className="container relative z-10 mx-auto px-6 py-6">
				<a href={env.NEXT_PUBLIC_MARKETING_URL}>
					<Image
						src="/rox-logo-light.png"
						alt="Rox"
						width={26}
						height={40}
						priority
					/>
				</a>
			</header>
			<main className="relative z-10 flex flex-1 items-center justify-center px-6 py-12">
				{children}
			</main>
		</div>
	);
}
