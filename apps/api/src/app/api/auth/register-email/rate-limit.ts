import { createHash } from "node:crypto";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { env } from "@/env";

const kv = new Redis({
	url: env.KV_REST_API_URL,
	token: env.KV_REST_API_TOKEN,
});

const registrationRateLimit = new Ratelimit({
	redis: kv,
	limiter: Ratelimit.slidingWindow(5, "15 m"),
	prefix: "ratelimit:register-email",
});

const handleCheckRateLimit = new Ratelimit({
	redis: kv,
	limiter: Ratelimit.slidingWindow(30, "5 m"),
	prefix: "ratelimit:register-email-handle",
});

function getClientIp(request: Request): string {
	return (
		request.headers.get("cf-connecting-ip") ??
		request.headers.get("x-real-ip") ??
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
		"unknown"
	);
}

function hashRateLimitPart(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export async function checkRegisterEmailRateLimit(
	request: Request,
	email?: string,
): Promise<boolean> {
	const emailKey = email ? hashRateLimitPart(email) : "unknown";
	const key = `${getClientIp(request)}:${emailKey}`;

	try {
		const result = await registrationRateLimit.limit(key);
		return result.success;
	} catch (error) {
		console.error("[register-email] rate limit check failed", error);
		return false;
	}
}

export async function checkHandleRateLimit(request: Request): Promise<boolean> {
	const key = getClientIp(request);

	try {
		const result = await handleCheckRateLimit.limit(key);
		return result.success;
	} catch (error) {
		console.error("[register-email] handle rate limit check failed", error);
		return false;
	}
}
