import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const accounts = pgTable("accounts", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }),
});

export const sessions = pgTable("sessions", {
  token: text("token"),
});

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    email: text("email"),
  },
  (t) => ({
    emailIdx: uniqueIndex("email_idx").on(t.email),
  }),
);
