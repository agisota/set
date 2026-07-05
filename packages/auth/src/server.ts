import { apiKey } from "@better-auth/api-key";
import { expo } from "@better-auth/expo";
import { oauthProvider } from "@better-auth/oauth-provider";
import { db } from "@rox/db/client";
import { members, userAttribution } from "@rox/db/schema";
import type { sessions } from "@rox/db/schema/auth";
import * as authSchema from "@rox/db/schema/auth";
import { seedDefaultStatuses } from "@rox/db/seed-default-statuses";
import { seedDemoProject } from "@rox/db/seed-demo-project";
import { EmailVerificationEmail } from "@rox/email/emails/email-verification";
import { MemberAddedEmail } from "@rox/email/emails/member-added";
import { MemberRemovedEmail } from "@rox/email/emails/member-removed";
import { OrganizationInvitationEmail } from "@rox/email/emails/organization-invitation";
import {
	ATTRIBUTION_COOKIE_NAME,
	parseAttributionCookieValue,
	parseCookieHeader,
} from "@rox/shared/attribution";
import { canInvite, type OrganizationRole } from "@rox/shared/auth";
import { ANALYTICS_EVENTS } from "@rox/shared/constants";
import { getTrustedVercelPreviewOrigins } from "@rox/shared/vercel-preview-origins";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
	bearer,
	customSession,
	genericOAuth,
	organization,
} from "better-auth/plugins";
import { jwt } from "better-auth/plugins/jwt";
import {
	and,
	asc,
	count,
	desc,
	eq,
	getTableColumns,
	inArray,
	ne,
	sql,
} from "drizzle-orm";
import { boolean, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { captureAuthEvent } from "./analytics";
import { env } from "./env";
import { acceptInvitationEndpoint } from "./lib/accept-invitation-endpoint";
import { generateMagicTokenForInvite } from "./lib/generate-magic-token";
import { invitationRateLimit } from "./lib/rate-limit";
import { resend } from "./lib/resend";
import {
	resolveSessionOrganizationState,
	type SessionOrganizationContext,
} from "./lib/resolve-session-organization-state";
import { upsertSocialProfile } from "./lib/social-profile";
import { telegramLogin } from "./lib/telegram-plugin";
import {
	buildYandexProvider,
	takePendingYandexProfile,
	YANDEX_PROVIDER_ID,
} from "./lib/yandex-oauth";

const userOptions = {
	additionalFields: {
		onboardedAt: {
			type: "date",
			required: false,
			input: false,
			fieldName: "onboarded_at",
		},
	},
} as const;

// Better Auth selects every column from the user table in adapter reads. Keep
// the adapter's user shape limited to columns that are guaranteed to exist in
// production so additive app-only columns cannot break OAuth callbacks while a
// production migration is still pending.
const authAdapterUsers = authSchema.authSchema.table("users", {
	id: uuid("id").primaryKey().defaultRandom(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: boolean("email_verified").default(false).notNull(),
	image: text("image"),
	organizationIds: uuid("organization_ids").array().default([]).notNull(),
	onboardedAt: timestamp("onboarded_at"),
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at")
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull(),
});

const authAdapterSchema = {
	...authSchema,
	users: authAdapterUsers,
};

const authAdapterUserColumnOmissions = new Set(["onboarding_progress"]);

function getSortedDatabaseColumnNames(
	table: Parameters<typeof getTableColumns>[0],
): string[] {
	return Object.values(getTableColumns(table))
		.map((column) => column.name)
		.sort();
}

function assertAuthAdapterUsersMatchCanonicalSchema(): void {
	const canonicalColumnNames = getSortedDatabaseColumnNames(
		authSchema.users,
	).filter((columnName) => !authAdapterUserColumnOmissions.has(columnName));
	const adapterColumnNames = getSortedDatabaseColumnNames(authAdapterUsers);
	const hasDrift =
		canonicalColumnNames.length !== adapterColumnNames.length ||
		canonicalColumnNames.some(
			(columnName, index) => adapterColumnNames[index] !== columnName,
		);

	if (hasDrift) {
		throw new Error(
			"Better Auth adapter users schema drifted from canonical auth.users schema",
		);
	}
}

assertAuthAdapterUsersMatchCanonicalSchema();

const desktopDevPort = process.env.DESKTOP_VITE_PORT || "5173";
const desktopDevOrigins =
	process.env.NODE_ENV === "development"
		? [
				`http://localhost:${desktopDevPort}`,
				`http://127.0.0.1:${desktopDevPort}`,
			]
		: [];

export const auth = betterAuth({
	baseURL: env.NEXT_PUBLIC_API_URL,
	secret: env.BETTER_AUTH_SECRET,
	// Encrypt OAuth access/refresh/id tokens at rest in `auth.accounts`.
	// better-auth's native at-rest encryption (keyed by `secret` above) wraps
	// tokens on write via `setTokenUtil` and decrypts on every INTERNAL read via
	// `decryptOAuthToken`. Crucially these tokens are only ever read back by
	// better-auth's own engine (token refresh / get-access-token), never by Rox
	// application code, so the native flag is the only mechanism that sits on the
	// real read path. Backward-compatible + lazy: `decryptOAuthToken` guards with
	// `isLikelyEncrypted`, so pre-existing plaintext rows pass through untouched
	// and re-encrypt on their next write. No data migration required.
	account: {
		encryptOAuthTokens: true,
	},
	disabledPaths: [],
	database: drizzleAdapter(db, {
		provider: "pg",
		usePlural: true,
		schema: authAdapterSchema,
	}),
	trustedOrigins: async (request) => [
		env.NEXT_PUBLIC_WEB_URL,
		env.NEXT_PUBLIC_API_URL,
		env.NEXT_PUBLIC_MARKETING_URL,
		env.NEXT_PUBLIC_ADMIN_URL,
		...(env.NEXT_PUBLIC_DESKTOP_URL ? [env.NEXT_PUBLIC_DESKTOP_URL] : []),
		...getTrustedVercelPreviewOrigins(request?.url ?? env.NEXT_PUBLIC_API_URL),
		...desktopDevOrigins,
		"rox://app",
		"rox://",
		...(process.env.NODE_ENV === "development"
			? ["exp://", "exp://**", "exp://192.168.*.*:*/**"]
			: []),
	],
	session: {
		expiresIn: 60 * 60 * 24 * 30,
		updateAge: 60 * 60 * 24,
		storeSessionInDatabase: true,
		cookieCache: {
			enabled: true,
			maxAge: 60 * 5,
		},
	},
	user: userOptions,
	advanced: {
		crossSubDomainCookies: {
			enabled: true,
			domain: env.NEXT_PUBLIC_COOKIE_DOMAIN,
		},
		database: {
			generateId: false,
		},
	},
	emailAndPassword: {
		enabled: true,
		autoSignIn: false,
		requireEmailVerification: true,
	},
	emailVerification: {
		sendOnSignUp: true,
		sendOnSignIn: true,
		expiresIn: 60 * 60,
		sendVerificationEmail: async ({ user, url }) => {
			if (process.env.NODE_ENV === "development") {
				console.info(`[auth] verification email for ${user.email}: ${url}`);
				return;
			}

			await resend.emails.send({
				from: "Rox <noreply@rox.one>",
				to: user.email,
				subject: "Подтвердите почту для Rox",
				react: EmailVerificationEmail({
					userName: user.name,
					verificationUrl: url,
				}),
			});
		},
	},
	socialProviders: {
		github: {
			clientId: env.GH_CLIENT_ID,
			clientSecret: env.GH_CLIENT_SECRET,
		},
	},
	rateLimit: {
		// ROX-522 security review: explicitly throttle the Telegram Login Widget
		// callback. Each request carries a fresh signed payload, so a tight window
		// blunts brute-force/replay attempts against the verification endpoint on
		// top of the HMAC + single-use KV guard. Path is relative to basePath.
		customRules: {
			"/telegram/callback": { window: 60, max: 10 },
		},
	},
	databaseHooks: {
		user: {
			create: {
				after: async (user, context?: unknown) => {
					// ROX-519: post-signup enrollment is best-effort. Wrap the entire
					// body so any failure (org enrollment, personal-team creation,
					// attribution) is logged and non-fatal — it must never block or
					// roll back account creation.
					try {
						const domain = user.email.split("@")[1]?.toLowerCase();
						let enrolledOrgId: string | null = null;

						if (domain) {
							const matchingOrgs = await db.query.organizations.findMany({
								where: sql`${authSchema.organizations.allowedDomains} @> ARRAY[${domain}]::text[]`,
							});

							for (const org of matchingOrgs) {
								try {
									await auth.api.addMember({
										body: {
											organizationId: org.id,
											userId: user.id,
											role: "member",
										},
									});
									if (!enrolledOrgId) {
										enrolledOrgId = org.id;
									}
								} catch (error) {
									console.error(
										`[auto-enroll] Failed to add user ${user.id} to org ${org.id}:`,
										error,
									);
									// addMember may have created the DB record before a downstream
									// hook (email, team-seeding) threw — check before falling back.
									const memberExists = await db.query.members.findFirst({
										where: and(
											eq(authSchema.members.organizationId, org.id),
											eq(authSchema.members.userId, user.id),
										),
									});
									if (memberExists && !enrolledOrgId) {
										enrolledOrgId = org.id;
									}
								}
							}
						}

						if (!enrolledOrgId) {
							const personalOrg = await auth.api.createOrganization({
								body: {
									name: `${user.name}'s Team`,
									slug: `${user.id.slice(0, 8)}-team`,
									userId: user.id,
								},
							});
							enrolledOrgId = personalOrg?.id ?? null;
						}

						if (enrolledOrgId) {
							await db
								.update(authSchema.sessions)
								.set({ activeOrganizationId: enrolledOrgId })
								.where(eq(authSchema.sessions.userId, user.id));
						}

						// First-touch attribution: persist the landing UTM/referrer captured
						// in the `rox_attribution` cookie. Best-effort — wrapped so a failure
						// here can never block account creation. Idempotent via the unique
						// user_id index (first-touch is never overwritten).
						try {
							const ctx = (context ?? {}) as {
								headers?: Headers;
								request?: { headers?: Headers };
							};
							const cookieHeader =
								ctx.headers?.get("cookie") ??
								ctx.request?.headers?.get("cookie") ??
								null;
							const attribution = parseAttributionCookieValue(
								parseCookieHeader(cookieHeader, ATTRIBUTION_COOKIE_NAME),
							);
							captureAuthEvent(ANALYTICS_EVENTS.ACCOUNT_CREATED, user.id, {
								...(attribution?.utm.utmSource
									? { utm_source: attribution.utm.utmSource }
									: {}),
								...(attribution?.utm.utmMedium
									? { utm_medium: attribution.utm.utmMedium }
									: {}),
								...(attribution?.utm.utmCampaign
									? { utm_campaign: attribution.utm.utmCampaign }
									: {}),
							});
							if (attribution) {
								await db
									.insert(userAttribution)
									.values({
										userId: user.id,
										utmSource: attribution.utm.utmSource,
										utmMedium: attribution.utm.utmMedium,
										utmCampaign: attribution.utm.utmCampaign,
										utmTerm: attribution.utm.utmTerm,
										utmContent: attribution.utm.utmContent,
										landingPage: attribution.landingPage,
										referrer: attribution.referrer,
									})
									.onConflictDoNothing();
							}
						} catch (error) {
							console.error(
								`[attribution] Failed to persist first-touch for ${user.id}:`,
								error,
							);
						}
					} catch (err) {
						console.error(
							`[user.create.after] post-signup enrollment failed (non-fatal) for ${user.id}:`,
							err,
						);
					}
				},
			},
		},
		account: {
			create: {
				// ROX-522: populate `user_profiles` for Yandex (genericOAuth) sign-ups.
				// genericOAuth's `mapProfileToUser` can only return Partial<User>, so
				// the cached provider identity (display username / avatar) is stashed
				// transiently in `yandex-oauth.ts` keyed by the Yandex account id and
				// drained here once the account row exists. Best-effort: a profile
				// write must never block authentication.
				after: async (account: {
					userId: string;
					providerId: string;
					accountId: string;
				}) => {
					if (account.providerId !== YANDEX_PROVIDER_ID) return;
					try {
						const pending = await takePendingYandexProfile(account.accountId);
						await upsertSocialProfile({
							userId: account.userId,
							registrationProvider: "yandex",
							providerAccountId: account.accountId,
							displayUsername: pending?.displayUsername ?? null,
							providerAvatarUrl: pending?.providerAvatarUrl ?? null,
						});
					} catch (error) {
						console.error(
							`[yandex] failed to write user_profiles for ${account.userId}:`,
							error,
						);
					}
				},
			},
		},
		session: {
			create: {
				after: async (session: { userId: string }) => {
					// signed_in: a new session = an authentication (login or signup).
					captureAuthEvent(ANALYTICS_EVENTS.SIGNED_IN, session.userId, {
						method: "github",
					});
				},
			},
		},
	},
	plugins: [
		apiKey({
			enableMetadata: true,
			enableSessionForAPIKeys: true,
			defaultPrefix: "sk_live_",
			rateLimit: {
				enabled: false,
			},
		}),
		jwt({
			jwks: {
				keyPairConfig: { alg: "RS256" },
			},
			jwt: {
				issuer: env.NEXT_PUBLIC_API_URL,
				audience: env.NEXT_PUBLIC_API_URL,
				expirationTime: "1h",
				definePayload: async ({
					user,
				}: {
					user: { id: string; email: string };
					session: Record<string, unknown>;
				}) => {
					const userMemberships = await db.query.members.findMany({
						where: eq(members.userId, user.id),
						columns: { organizationId: true },
					});
					const organizationIds = [
						...new Set(userMemberships.map((m) => m.organizationId)),
					];
					return { sub: user.id, email: user.email, organizationIds };
				},
			},
		}),
		oauthProvider({
			loginPage: `${env.NEXT_PUBLIC_WEB_URL}/sign-in`,
			consentPage: `${env.NEXT_PUBLIC_WEB_URL}/oauth/consent`,
			allowDynamicClientRegistration: true,
			allowUnauthenticatedClientRegistration: true,
			accessTokenExpiresIn: 60 * 60 * 24 * 7,
			validAudiences: [
				env.NEXT_PUBLIC_API_URL,
				`${env.NEXT_PUBLIC_API_URL}/`,
				`${env.NEXT_PUBLIC_API_URL}/api/agent/mcp`,
				`${env.NEXT_PUBLIC_API_URL}/api/v2/agent/mcp`,
			],
			silenceWarnings: {
				oauthAuthServerConfig: true,
				openidConfig: true,
			},
			postLogin: {
				// Org selection is handled in the consent page, so never redirect to a separate page
				page: `${env.NEXT_PUBLIC_WEB_URL}/oauth/consent`,
				shouldRedirect: () => false,
				consentReferenceId: async ({ user, session }) => {
					const { activeOrganizationId } =
						await resolveSessionOrganizationState({
							userId: user?.id,
							session: session as SessionOrganizationContext | undefined,
						});
					return activeOrganizationId ?? undefined;
				},
			},
			customAccessTokenClaims: async ({ user, referenceId, metadata }) => {
				const clientName =
					metadata && typeof metadata === "object" && "client_name" in metadata
						? metadata.client_name
						: undefined;
				// Mirror the JWT plugin's `definePayload` so OAuth access tokens
				// carry the user's full membership list. Without this, every
				// `ctx.organizationIds.includes(...)` check downstream rejects
				// the token because the claim defaults to `[]`.
				const memberRows = user?.id
					? await db.query.members.findMany({
							where: eq(members.userId, user.id),
							columns: { organizationId: true },
						})
					: [];
				const organizationIds = [
					...new Set(memberRows.map((m) => m.organizationId)),
				];
				return {
					organizationId: referenceId ?? undefined,
					organizationIds,
					client_name: typeof clientName === "string" ? clientName : undefined,
				};
			},
		}),
		expo(),
		// ROX-522: Yandex ID via genericOAuth. The provider list is empty when
		// Yandex credentials are absent, so the plugin is inert in environments
		// without RU social login (the callback path stays registered but no
		// provider matches).
		genericOAuth({
			config: [buildYandexProvider()].filter(
				(provider): provider is NonNullable<typeof provider> =>
					provider !== null,
			),
		}),
		// ROX-522: Telegram Login Widget (custom, not OAuth). Mounts
		// `GET /api/auth/telegram/callback`.
		telegramLogin(),
		organization({
			creatorRole: "owner",
			invitationExpiresIn: 60 * 60 * 24 * 7,
			teams: {
				enabled: true,
				maximumTeams: 25,
				allowRemovingAllTeams: false,
				defaultTeam: {
					enabled: true,
					customCreateDefaultTeam: async (organization) => {
						const [team] = await db
							.insert(authSchema.teams)
							.values({
								name: "Default Team",
								slug: "DEFAULT",
								organizationId: organization.id,
							})
							.returning();
						if (!team) throw new Error("Failed to create default team");
						return { ...team, updatedAt: team.updatedAt ?? undefined };
					},
				},
			},
			schema: {
				team: {
					additionalFields: {
						slug: { type: "string", input: true, required: true },
					},
				},
			},
			sendInvitationEmail: async (data) => {
				const token = await generateMagicTokenForInvite({
					invitationId: data.id,
				});

				const inviteLink = `${env.NEXT_PUBLIC_WEB_URL}/accept-invitation/${data.id}?token=${token}`;

				const existingUser = await db.query.users.findFirst({
					where: eq(authSchema.users.email, data.email),
					columns: { name: true },
				});

				await resend.emails.send({
					from: "Rox <noreply@rox.one>",
					to: data.email,
					subject: `${data.inviter.user.name} invited you to join ${data.organization.name}`,
					react: OrganizationInvitationEmail({
						organizationName: data.organization.name,
						inviterName: data.inviter.user.name,
						inviteLink,
						role: data.role,
						inviteeName: existingUser?.name ?? null,
						inviterEmail: data.inviter.user.email,
						expiresAt: data.invitation.expiresAt,
					}),
				});
			},
			organizationHooks: {
				beforeCreateInvitation: async (data) => {
					const { inviterId, organizationId, role, teamId } = data.invitation;

					const { success } = await invitationRateLimit.limit(inviterId);
					if (!success) {
						throw new Error(
							"Rate limit exceeded. Max 10 invitations per hour.",
						);
					}

					const inviterMember = await db.query.members.findFirst({
						where: and(
							eq(members.userId, inviterId),
							eq(members.organizationId, organizationId),
						),
					});

					if (!inviterMember) {
						throw new Error("Not a member of this organization");
					}

					if (
						!canInvite(
							inviterMember.role as OrganizationRole,
							role as OrganizationRole,
						)
					) {
						throw new Error("Cannot invite users with this role");
					}

					if (!teamId) {
						const oldestTeam = await db.query.teams.findFirst({
							where: eq(authSchema.teams.organizationId, organizationId),
							orderBy: asc(authSchema.teams.createdAt),
							columns: { id: true },
						});
						if (oldestTeam) {
							return {
								data: { ...data.invitation, teamId: oldestTeam.id },
							};
						}
					}
				},

				afterCreateOrganization: async ({ organization }) => {
					await seedDefaultStatuses(organization.id);
					// Seed the demo project so a freshly-created org lands in a usable
					// workspace instead of an empty project list (issue #26). Unlike
					// default statuses (the task system depends on them), the demo
					// project is non-essential onboarding UX, so its failure must never
					// block or roll back org creation — keep it best-effort.
					try {
						await seedDemoProject(organization.id);
					} catch (error) {
						console.error(
							`afterCreateOrganization: failed to seed demo project for org ${organization.id}`,
							error,
						);
					}
				},

				beforeRemoveMember: async ({ member, organization }) => {
					await db
						.delete(authSchema.teamMembers)
						.where(
							and(
								eq(authSchema.teamMembers.userId, member.userId),
								inArray(
									authSchema.teamMembers.teamId,
									db
										.select({ id: authSchema.teams.id })
										.from(authSchema.teams)
										.where(
											eq(authSchema.teams.organizationId, organization.id),
										),
								),
							),
						);
				},

				beforeRemoveTeamMember: async ({ teamMember, organization }) => {
					// Invariant: every org member belongs to ≥1 team. Reject the
					// removal if it would leave this user with zero teams in this
					// org. Self-leave and admin-removal both flow through this hook.
					const [otherMemberships] = await db
						.select({ value: count() })
						.from(authSchema.teamMembers)
						.where(
							and(
								eq(authSchema.teamMembers.userId, teamMember.userId),
								eq(authSchema.teamMembers.organizationId, organization.id),
								ne(authSchema.teamMembers.teamId, teamMember.teamId),
							),
						);
					if ((otherMemberships?.value ?? 0) === 0) {
						throw new Error("You should be a member of at least one team");
					}
				},

				beforeDeleteTeam: async ({ team }) => {
					// Linear-style: deleting a team would otherwise orphan any
					// members who were only in this team. Re-home them into the
					// next-oldest team in the org before the FK cascade fires.
					const teamMemberRows = await db
						.select({ userId: authSchema.teamMembers.userId })
						.from(authSchema.teamMembers)
						.where(eq(authSchema.teamMembers.teamId, team.id));

					if (teamMemberRows.length === 0) return;

					const memberUserIds = teamMemberRows.map((row) => row.userId);

					const safelyInOtherTeam = await db
						.select({ userId: authSchema.teamMembers.userId })
						.from(authSchema.teamMembers)
						.where(
							and(
								inArray(authSchema.teamMembers.userId, memberUserIds),
								eq(authSchema.teamMembers.organizationId, team.organizationId),
								ne(authSchema.teamMembers.teamId, team.id),
							),
						);
					const safeUserIds = new Set(safelyInOtherTeam.map((r) => r.userId));
					const orphanUserIds = memberUserIds.filter(
						(uid) => !safeUserIds.has(uid),
					);

					if (orphanUserIds.length === 0) return;

					const nextTeam = await db.query.teams.findFirst({
						where: and(
							eq(authSchema.teams.organizationId, team.organizationId),
							ne(authSchema.teams.id, team.id),
						),
						orderBy: asc(authSchema.teams.createdAt),
						columns: { id: true },
					});
					if (!nextTeam) return;

					await db
						.insert(authSchema.teamMembers)
						.values(
							orphanUserIds.map((userId) => ({
								teamId: nextTeam.id,
								userId,
								organizationId: team.organizationId,
							})),
						)
						.onConflictDoNothing();
				},

				afterAddMember: async ({ member, user, organization }) => {
					// Linear-style: auto-add new org members to the oldest team so
					// they aren't dropped into an empty teams view. Additional team
					// memberships are added explicitly by admins.
					const defaultTeam = await db.query.teams.findFirst({
						where: eq(authSchema.teams.organizationId, organization.id),
						orderBy: asc(authSchema.teams.createdAt),
						columns: { id: true },
					});
					if (defaultTeam) {
						// onConflictDoNothing keeps addMember robust if a stale row
						// ever exists from a partial earlier run — we never want this
						// hook to fail a member-add.
						await db
							.insert(authSchema.teamMembers)
							.values({
								teamId: defaultTeam.id,
								userId: member.userId,
								organizationId: organization.id,
							})
							.onConflictDoNothing();
					}

					// This email is invitation-specific. Auto-enroll and direct addMember
					// calls should not send the invite-style "you were added" message.
					const acceptedInvitation = await db.query.invitations.findFirst({
						where: and(
							eq(authSchema.invitations.organizationId, organization.id),
							eq(authSchema.invitations.email, user.email),
							eq(authSchema.invitations.status, "accepted"),
						),
						orderBy: desc(authSchema.invitations.createdAt),
					});

					if (acceptedInvitation) {
						await resend.emails.send({
							from: "Rox <noreply@rox.one>",
							to: user.email,
							subject: `You've been added to ${organization.name}`,
							react: MemberAddedEmail({
								memberName: user.name,
								organizationName: organization.name,
								role: member.role,
								addedByName: "A team admin",
								dashboardLink: env.NEXT_PUBLIC_WEB_URL,
							}),
						});
					}
				},

				afterRemoveMember: async ({ user, organization }) => {
					await resend.emails.send({
						from: "Rox <noreply@rox.one>",
						to: user.email,
						subject: `You've been removed from ${organization.name}`,
						react: MemberRemovedEmail({
							memberName: user.name,
							organizationName: organization.name,
							removedByName: "A team admin",
						}),
					});
				},
			},
		}),
		bearer(),
		customSession(
			async ({ user, session: baseSession }) => {
				const session = baseSession as typeof sessions.$inferSelect;
				const { activeOrganizationId, allMemberships, membership } =
					await resolveSessionOrganizationState({
						userId: session.userId ?? user.id,
						session,
					});

				const organizationIds = [
					...new Set(allMemberships.map((m) => m.organizationId)),
				];

				// #34.1: plan tiers removed — no subscription lookup. The field is
				// kept on the session shape (always null) so the client session type
				// stays stable for the few places that still read `session.plan`.
				const plan: string | null = null;

				// additionalFields declares onboardedAt for client typing, but the
				// drizzle adapter doesn't surface it on the passed-in user — read it
				// explicitly so the onboarding gate is deterministic.
				const userRow = await db.query.users.findFirst({
					where: eq(authSchema.users.id, user.id),
					columns: { onboardedAt: true },
				});

				return {
					user: { ...user, onboardedAt: userRow?.onboardedAt ?? null },
					session: {
						...session,
						activeOrganizationId,
						organizationIds,
						role: membership?.role,
						plan,
					},
				};
			},
			{ user: userOptions },
		),
		acceptInvitationEndpoint,
	],
});

export type Session = typeof auth.$Infer.Session;
export type User = typeof auth.$Infer.Session.user;

/**
 * Mints a short-lived JWT signed with the same JWKS key the Better Auth JWT
 * plugin uses for session-derived tokens. Used by headless service code
 * (e.g. the automations dispatcher) that needs to act on behalf of a user
 * without holding their session cookie.
 *
 * The resulting token is accepted by anything that verifies via the public
 * JWKS endpoint (the relay and any other downstream service), because it is
 * signed with the same RS256 key pair.
 */
export async function mintUserJwt(args: {
	userId: string;
	email?: string;
	organizationIds: string[];
	scope?: string;
	runId?: string;
	/** Token lifetime in seconds. Default 300 (5 minutes). */
	ttlSeconds?: number;
}): Promise<string> {
	const exp = Math.floor(Date.now() / 1000) + (args.ttlSeconds ?? 300);

	const response = await auth.api.signJWT({
		body: {
			payload: {
				sub: args.userId,
				email: args.email,
				organizationIds: args.organizationIds,
				scope: args.scope,
				runId: args.runId,
				exp,
			},
		},
	});

	return response.token;
}
