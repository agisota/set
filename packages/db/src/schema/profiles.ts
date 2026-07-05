import { relations } from "drizzle-orm";
import {
	boolean,
	date,
	index,
	integer,
	pgEnum,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { registrationProviderValues } from "./enums";

// Which provider a user originally registered through (ROX-522). Backed by
// `enums.ts` so the Zod enum and pgEnum stay in lockstep.
export const registrationProvider = pgEnum(
	"registration_provider",
	registrationProviderValues,
);

export const userProfiles = pgTable(
	"user_profiles",
	{
		userId: uuid("user_id")
			.primaryKey()
			.references(() => users.id, { onDelete: "cascade" }),
		// `handle` is the canonical slug-safe, unique public nickname and the
		// `@<handle>` route namespace (rox.one/@<handle>). Nullable until the user
		// claims one — provider sign-ups (telegram/x/github/…) land without a
		// handle and pick it later. Validated via `validateHandle` from
		// `@rox/shared/username` before write.
		handle: text("handle").unique(),
		// Provider the user originally registered through. Sourced from
		// better-auth's `auth.accounts.provider_id`; nullable for legacy rows.
		registrationProvider: registrationProvider("registration_provider"),
		// Cached provider identity, denormalized from `auth.accounts` so the
		// public profile can render without re-joining the OAuth account row.
		// `providerAccountId` is the upstream account id (accounts.account_id);
		// `displayUsername` / `providerAvatarUrl` are the provider's handle/avatar.
		providerAccountId: text("provider_account_id"),
		displayUsername: text("display_username"),
		providerAvatarUrl: text("provider_avatar_url"),
		displayName: text("display_name"),
		bio: text("bio"),
		avatarUrl: text("avatar_url"),
		isPublic: boolean("is_public").default(false).notNull(),
		// Minimal public profile metadata.
		location: text("location"),
		websiteUrl: text("website_url"),
		contactEmail: text("contact_email"),
		birthDate: date("birth_date"),
		gender: text("gender"),
		telegram: text("telegram"),
		max: text("max"),
		wechat: text("wechat"),
		twitter: text("twitter"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index("user_profiles_user_id_idx").on(table.userId),
		index("user_profiles_handle_idx").on(table.handle),
	],
);

export type SelectUserProfile = typeof userProfiles.$inferSelect;
export type InsertUserProfile = typeof userProfiles.$inferInsert;

export const usageDaily = pgTable(
	"usage_daily",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		date: date("date").notNull(),
		tool: text("tool").notNull(),
		model: text("model").notNull(),
		inputTokens: integer("input_tokens").default(0).notNull(),
		outputTokens: integer("output_tokens").default(0).notNull(),
		totalTokens: integer("total_tokens").default(0).notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		unique("usage_daily_user_tool_model_date_unique").on(
			table.userId,
			table.tool,
			table.model,
			table.date,
		),
		index("usage_daily_user_id_idx").on(table.userId),
		index("usage_daily_date_idx").on(table.date),
	],
);

export type SelectUsageDaily = typeof usageDaily.$inferSelect;
export type InsertUsageDaily = typeof usageDaily.$inferInsert;

export const profileNotes = pgTable(
	"profile_notes",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		body: text("body").notNull(),
		isPublished: boolean("is_published").default(false).notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("profile_notes_user_id_idx").on(table.userId),
		index("profile_notes_created_at_idx").on(table.createdAt),
	],
);

export type SelectProfileNote = typeof profileNotes.$inferSelect;
export type InsertProfileNote = typeof profileNotes.$inferInsert;

export const achievements = pgTable("achievements", {
	id: uuid("id").primaryKey().defaultRandom(),
	key: text("key").notNull().unique(),
	title: text("title").notNull(),
	description: text("description"),
	icon: text("icon"),
	tier: text("tier"),
});

export type SelectAchievement = typeof achievements.$inferSelect;
export type InsertAchievement = typeof achievements.$inferInsert;

export const userAchievements = pgTable(
	"user_achievements",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		achievementId: uuid("achievement_id")
			.notNull()
			.references(() => achievements.id, { onDelete: "cascade" }),
		awardedAt: timestamp("awarded_at").defaultNow().notNull(),
	},
	(table) => [
		unique("user_achievements_user_achievement_unique").on(
			table.userId,
			table.achievementId,
		),
		index("user_achievements_user_id_idx").on(table.userId),
		index("user_achievements_achievement_id_idx").on(table.achievementId),
	],
);

export type SelectUserAchievement = typeof userAchievements.$inferSelect;
export type InsertUserAchievement = typeof userAchievements.$inferInsert;

export const userProfilesRelations = relations(userProfiles, ({ one }) => ({
	user: one(users, {
		fields: [userProfiles.userId],
		references: [users.id],
	}),
}));
export const usageDailyRelations = relations(usageDaily, ({ one }) => ({
	user: one(users, {
		fields: [usageDaily.userId],
		references: [users.id],
	}),
}));
export const profileNotesRelations = relations(profileNotes, ({ one }) => ({
	user: one(users, {
		fields: [profileNotes.userId],
		references: [users.id],
	}),
}));
export const achievementsRelations = relations(achievements, ({ many }) => ({
	userAchievements: many(userAchievements),
}));
export const userAchievementsRelations = relations(
	userAchievements,
	({ one }) => ({
		user: one(users, {
			fields: [userAchievements.userId],
			references: [users.id],
		}),
		achievement: one(achievements, {
			fields: [userAchievements.achievementId],
			references: [achievements.id],
		}),
	}),
);
