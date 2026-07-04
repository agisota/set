import { db, dbWs } from "@rox/db/client";
import {
	members,
	roxBalances,
	roxLedger,
	usageRequests,
	users,
} from "@rox/db/schema";
import {
	ACTIVATION_STEPS,
	normalizeOnboardingStatus,
	type OnboardingStatus,
	REQUIRED_SURFACE_TOURS,
	type SurfaceTourId,
} from "@rox/shared/onboarding";
import { TRPCError, type TRPCRouterRecord } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { generateImagePathname, uploadImage } from "../../lib/upload";
import { protectedProcedure } from "../../trpc";
import { ensureBalance } from "../economy/economy.service";

const activationStepSchema = z.enum(ACTIVATION_STEPS);
const surfaceTourIdSchema = z.enum(REQUIRED_SURFACE_TOURS);
const POSTGRES_UNDEFINED_COLUMN = "42703";

const productionSafeUserReturning = {
	id: users.id,
	name: users.name,
	email: users.email,
	emailVerified: users.emailVerified,
	image: users.image,
	organizationIds: users.organizationIds,
	onboardedAt: users.onboardedAt,
	createdAt: users.createdAt,
	updatedAt: users.updatedAt,
};

const onboardingProgressPatchSchema = z.object({
	activation: z
		.object({
			completedAt: z.string().datetime().nullable().optional(),
			currentStep: activationStepSchema.optional(),
			completedSteps: z
				.partialRecord(activationStepSchema, z.string().datetime())
				.optional(),
			projectId: z.string().nullable().optional(),
			workspaceId: z.string().nullable().optional(),
			providerSkippedAt: z.string().datetime().nullable().optional(),
		})
		.optional(),
	tours: z
		.object({
			activeTourId: surfaceTourIdSchema.nullable().optional(),
			activeStepId: z.string().nullable().optional(),
			pausedAt: z.string().datetime().nullable().optional(),
			completedSteps: z
				.partialRecord(
					surfaceTourIdSchema,
					z.record(z.string(), z.string().datetime()),
				)
				.optional(),
			completedTours: z
				.partialRecord(surfaceTourIdSchema, z.string().datetime())
				.optional(),
			dismissedTours: z
				.partialRecord(surfaceTourIdSchema, z.string().datetime())
				.optional(),
			lastRoute: z.string().nullable().optional(),
		})
		.optional(),
});

function mergeTourCompletedSteps(
	current: OnboardingStatus["tours"]["completedSteps"],
	patch?: OnboardingStatus["tours"]["completedSteps"],
): OnboardingStatus["tours"]["completedSteps"] {
	if (!patch) {
		return current;
	}

	const next = { ...current };
	for (const [tourId, completedSteps] of Object.entries(patch) as [
		SurfaceTourId,
		Record<string, string>,
	][]) {
		next[tourId] = {
			...(next[tourId] ?? {}),
			...completedSteps,
		};
	}

	return next;
}

function mergeOnboardingStatus(
	current: OnboardingStatus | null | undefined,
	patch: z.infer<typeof onboardingProgressPatchSchema>,
): OnboardingStatus {
	const normalized = normalizeOnboardingStatus(current);

	return normalizeOnboardingStatus({
		activation: {
			...normalized.activation,
			...(patch.activation ?? {}),
			completedSteps: {
				...normalized.activation.completedSteps,
				...(patch.activation?.completedSteps ?? {}),
			},
		},
		tours: {
			...normalized.tours,
			...(patch.tours ?? {}),
			completedSteps: mergeTourCompletedSteps(
				normalized.tours.completedSteps,
				patch.tours?.completedSteps,
			),
			completedTours: {
				...normalized.tours.completedTours,
				...(patch.tours?.completedTours ?? {}),
			},
			dismissedTours: {
				...normalized.tours.dismissedTours,
				...(patch.tours?.dismissedTours ?? {}),
			},
		},
	});
}

function getErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return undefined;
	}

	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function getErrorCause(error: unknown): unknown {
	if (typeof error !== "object" || error === null || !("cause" in error)) {
		return undefined;
	}

	return (error as { cause?: unknown }).cause;
}

function isOnboardingProgressColumnMissing(error: unknown): boolean {
	const message = error instanceof Error ? error.message : "";
	if (
		getErrorCode(error) === POSTGRES_UNDEFINED_COLUMN &&
		message.includes("onboarding_progress")
	) {
		return true;
	}

	const cause = getErrorCause(error);
	return cause !== undefined && isOnboardingProgressColumnMissing(cause);
}

function normalizeOnboardingStatusFromUser(
	user:
		| { onboardedAt: Date | null; onboardingProgress?: OnboardingStatus | null }
		| null
		| undefined,
) {
	const progress = normalizeOnboardingStatus(user?.onboardingProgress);

	if (user?.onboardedAt && !progress.activation.completedAt) {
		progress.activation.completedAt = user.onboardedAt.toISOString();
		progress.activation.currentStep = "first_agent_action";
	}

	return progress;
}

async function findUserOnboardedAt(userId: string) {
	const [user] = await db
		.select({ onboardedAt: users.onboardedAt })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);

	if (!user) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "User not found",
		});
	}

	return user;
}

async function updateOnboardedAtOnly(userId: string, completedAt: Date) {
	const [updatedUser] = await db
		.update(users)
		.set({ onboardedAt: completedAt })
		.where(eq(users.id, userId))
		.returning(productionSafeUserReturning);

	if (!updatedUser) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "User not found",
		});
	}

	return updatedUser;
}

export const userRouter = {
	me: protectedProcedure.query(({ ctx }) => ctx.session.user),

	myOrganization: protectedProcedure.query(async ({ ctx }) => {
		const activeOrganizationId = ctx.activeOrganizationId;

		const membership = await db.query.members.findFirst({
			where: activeOrganizationId
				? and(
						eq(members.userId, ctx.session.user.id),
						eq(members.organizationId, activeOrganizationId),
					)
				: eq(members.userId, ctx.session.user.id),
			orderBy: desc(members.createdAt),
			with: {
				organization: true,
			},
		});

		return membership?.organization ?? null;
	}),

	myOrganizations: protectedProcedure.query(async ({ ctx }) => {
		const memberships = await db.query.members.findMany({
			where: eq(members.userId, ctx.session.user.id),
			orderBy: desc(members.createdAt),
			with: {
				organization: true,
			},
		});

		return memberships.map((m) => m.organization);
	}),

	accountOverview: protectedProcedure.query(async ({ ctx }) => {
		const userId = ctx.session.user.id;
		const organizationId = ctx.activeOrganizationId;

		// T8: single-source the seed-on-first-read via the economy service so the
		// 500-Rox starting grant logic lives in exactly one place. The read shape
		// below is unchanged so the desktop AccountUsagePanel keeps compiling.
		await ensureBalance(userId);

		const balance = await db.query.roxBalances.findFirst({
			where: eq(roxBalances.userId, userId),
			columns: {
				balanceRox: true,
				updatedAt: true,
			},
		});

		const ledgerRows = await db
			.select({
				id: roxLedger.id,
				deltaRox: roxLedger.deltaRox,
				kind: roxLedger.kind,
				usageRequestId: roxLedger.usageRequestId,
				topupId: roxLedger.topupId,
				createdAt: roxLedger.createdAt,
			})
			.from(roxLedger)
			.where(eq(roxLedger.userId, userId))
			.orderBy(desc(roxLedger.createdAt))
			.limit(100);

		const usageWhere = organizationId
			? and(
					eq(usageRequests.userId, userId),
					eq(usageRequests.organizationId, organizationId),
				)
			: eq(usageRequests.userId, userId);

		const usageRows = await db
			.select({
				id: usageRequests.id,
				organizationId: usageRequests.organizationId,
				chatSessionId: usageRequests.chatSessionId,
				modelId: usageRequests.modelId,
				tokensIn: usageRequests.tokensIn,
				tokensOut: usageRequests.tokensOut,
				usdCost: usageRequests.usdCost,
				roxCost: usageRequests.roxCost,
				trace: usageRequests.trace,
				createdAt: usageRequests.createdAt,
			})
			.from(usageRequests)
			.where(usageWhere)
			.orderBy(desc(usageRequests.createdAt))
			.limit(500);

		return {
			organizationId,
			balance: {
				balanceRox: balance?.balanceRox ?? "500",
				updatedAt: balance?.updatedAt ?? new Date(),
			},
			ledger: ledgerRows,
			usageRequests: usageRows,
		};
	}),

	updateProfile: protectedProcedure
		.input(z.object({ name: z.string().min(1).max(100) }))
		.mutation(async ({ ctx, input }) => {
			const [updatedUser] = await db
				.update(users)
				.set({ name: input.name })
				.where(eq(users.id, ctx.session.user.id))
				.returning(productionSafeUserReturning);
			return updatedUser;
		}),

	onboardingProgress: protectedProcedure.query(async ({ ctx }) => {
		try {
			const user = await db.query.users.findFirst({
				where: eq(users.id, ctx.session.user.id),
				columns: {
					onboardedAt: true,
					onboardingProgress: true,
				},
			});

			return normalizeOnboardingStatusFromUser(user);
		} catch (error) {
			if (!isOnboardingProgressColumnMissing(error)) {
				throw error;
			}

			return normalizeOnboardingStatusFromUser(
				await findUserOnboardedAt(ctx.session.user.id),
			);
		}
	}),

	updateOnboardingProgress: protectedProcedure
		.input(onboardingProgressPatchSchema)
		.mutation(async ({ ctx, input }) => {
			try {
				return await dbWs.transaction(async (tx) => {
					const [user] = await tx
						.select({ onboardingProgress: users.onboardingProgress })
						.from(users)
						.where(eq(users.id, ctx.session.user.id))
						.for("update")
						.limit(1);

					if (!user) {
						throw new TRPCError({
							code: "NOT_FOUND",
							message: "User not found",
						});
					}

					const next = mergeOnboardingStatus(user.onboardingProgress, input);

					await tx
						.update(users)
						.set({ onboardingProgress: next })
						.where(eq(users.id, ctx.session.user.id));

					return next;
				});
			} catch (error) {
				if (!isOnboardingProgressColumnMissing(error)) {
					throw error;
				}

				const current = normalizeOnboardingStatusFromUser(
					await findUserOnboardedAt(ctx.session.user.id),
				);
				return mergeOnboardingStatus(current, input);
			}
		}),

	completeActivation: protectedProcedure
		.input(
			z.object({
				projectId: z.string().optional(),
				workspaceId: z.string().optional(),
				completionSource: z.string().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const completedAt = new Date();
			const completedAtIso = completedAt.toISOString();
			try {
				return await dbWs.transaction(async (tx) => {
					const [user] = await tx
						.select({ onboardingProgress: users.onboardingProgress })
						.from(users)
						.where(eq(users.id, ctx.session.user.id))
						.for("update")
						.limit(1);

					if (!user) {
						throw new TRPCError({
							code: "NOT_FOUND",
							message: "User not found",
						});
					}

					const next = mergeOnboardingStatus(user.onboardingProgress, {
						activation: {
							completedAt: completedAtIso,
							currentStep: "first_agent_action",
							completedSteps: {
								first_agent_action: completedAtIso,
							},
							projectId: input.projectId ?? null,
							workspaceId: input.workspaceId ?? null,
						},
					});

					const [updatedUser] = await tx
						.update(users)
						.set({ onboardedAt: completedAt, onboardingProgress: next })
						.where(eq(users.id, ctx.session.user.id))
						.returning(productionSafeUserReturning);

					return updatedUser;
				});
			} catch (error) {
				if (!isOnboardingProgressColumnMissing(error)) {
					throw error;
				}

				return updateOnboardedAtOnly(ctx.session.user.id, completedAt);
			}
		}),

	completeOnboarding: protectedProcedure.mutation(async ({ ctx }) => {
		const completedAt = new Date();
		const completedAtIso = completedAt.toISOString();
		try {
			return await dbWs.transaction(async (tx) => {
				const [user] = await tx
					.select({ onboardingProgress: users.onboardingProgress })
					.from(users)
					.where(eq(users.id, ctx.session.user.id))
					.for("update")
					.limit(1);

				if (!user) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "User not found",
					});
				}

				const next = mergeOnboardingStatus(user.onboardingProgress, {
					activation: {
						completedAt: completedAtIso,
						currentStep: "first_agent_action",
						completedSteps: {
							first_agent_action: completedAtIso,
						},
					},
				});

				const [updatedUser] = await tx
					.update(users)
					.set({ onboardedAt: completedAt, onboardingProgress: next })
					.where(eq(users.id, ctx.session.user.id))
					.returning(productionSafeUserReturning);
				return updatedUser;
			});
		} catch (error) {
			if (!isOnboardingProgressColumnMissing(error)) {
				throw error;
			}

			return updateOnboardedAtOnly(ctx.session.user.id, completedAt);
		}
	}),

	uploadAvatar: protectedProcedure
		.input(
			z.object({
				fileData: z.string(),
				fileName: z.string(),
				mimeType: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;

			const user = await db.query.users.findFirst({
				where: eq(users.id, userId),
				columns: {
					image: true,
				},
			});

			if (!user) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "User not found",
				});
			}

			const pathname = generateImagePathname({
				prefix: `user/${userId}/avatar`,
				mimeType: input.mimeType,
			});

			try {
				const url = await uploadImage({
					fileData: input.fileData,
					mimeType: input.mimeType,
					pathname,
					existingUrl: user.image,
				});

				const [updatedUser] = await db
					.update(users)
					.set({ image: url })
					.where(eq(users.id, userId))
					.returning(productionSafeUserReturning);

				return { success: true, url, user: updatedUser };
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				console.error("[user/uploadAvatar] Upload failed:", error);
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "Failed to upload avatar",
				});
			}
		}),
} satisfies TRPCRouterRecord;
