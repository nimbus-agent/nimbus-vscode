import { describe, expect, test } from "vitest";

import { authFieldsFor, GENERIC_FIELD, isKnownProvider } from "../../src/connectors/catalog.js";

describe("authFieldsFor", () => {
  test("a PAT provider asks for one masked token", () => {
    const fields = authFieldsFor("github");
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ name: "personalAccessToken", secret: true, required: true });
  });

  test("Jira asks for its three fields, in order, and masks only the token", () => {
    expect(authFieldsFor("jira").map((f) => [f.name, f.secret])).toEqual([
      ["atlassianEmail", false],
      ["apiBaseUrl", false],
      ["token", true],
    ]);
  });

  test("aws is deliberately absent: its secret field name is not in the client's JSDoc", () => {
    expect(isKnownProvider("aws")).toBe(false);
    expect(authFieldsFor("aws")).toEqual([GENERIC_FIELD]);
  });

  test("an OAuth provider needs no fields — the Gateway drives the browser", () => {
    expect(authFieldsFor("google_drive")).toEqual([]);
    expect(isKnownProvider("google_drive")).toBe(true);
  });

  test("an unknown provider is not known, and gets the generic descriptor", () => {
    expect(isKnownProvider("mcp_acme")).toBe(false);
    expect(authFieldsFor("mcp_acme")).toEqual([GENERIC_FIELD]);
    expect(GENERIC_FIELD.secret).toBe(true);
  });
});
