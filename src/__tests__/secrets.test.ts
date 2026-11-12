import { describe, expect, it } from "vitest";
import { findSecrets } from "../map/secrets.ts";

describe("findSecrets", () => {
  it.each([
    ["aws key", "AKIAIOSFODNN7EXAMPLE"],
    ["private key", "-----BEGIN RSA PRIVATE KEY-----"],
    ["stripe key", "sk_live_abcdefghijklmnop1234"],
    ["github token", "ghp_" + "a".repeat(36)],
    ["slack token", "xoxb-1234567890-abc"],
    ["assigned secret", 'password: "hunter2hunter2"'],
    ["url with credentials", "postgres://user:pass@host/db"],
    ["azure account key", "AccountKey=" + "A".repeat(40)],
    ["jwt", "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY.SflKxwRJSMeKKF2QT4f"],
  ])("finds %s", (name, text) => expect(findSecrets(text)).toContain(name));

  it("doesn't flag env var names or prose", () =>
    expect(
      findSecrets(
        "Reads DATABASE_URL and SENDGRID_API_KEY. The token expires.",
      ),
    ).toEqual([]));
});
