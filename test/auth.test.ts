import assert from "node:assert/strict";
import { verify } from "node:crypto";
import { afterEach, beforeEach, describe, test } from "node:test";

import { appJwt, createAppAuth } from "../src/auth.ts";
import { createGitHub } from "../src/github.ts";
import { startFakeGitHub, type FakeGitHub } from "./fake-github.ts";
import { REPO } from "./fixtures.ts";
import { failure, harness, KEYS, TEST_KEY } from "./helpers.ts";

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

let gh: FakeGitHub;
let clock: number;
beforeEach(async () => {
  gh = await startFakeGitHub();
  clock = Date.parse("2026-11-17T12:00:00Z");
});
afterEach(async () => {
  await gh.close();
});

const auth = () => createAppAuth({ appId: "123456", installationId: "7890123", privateKey: TEST_KEY, apiUrl: gh.url, now: () => clock });
const mints = () => gh.requests.filter(request => request.path.endsWith("/access_tokens"));

describe("auth", () => {
  test("UT-070 auth: JWT claims iss, iat = now−60, exp = now+540, RS256 signature", async () => {
    const jwt = appJwt("123456", KEYS.privateKey, clock);
    const [header, payload, signature] = jwt.split(".") as [string, string, string];
    assert.deepEqual(decode(header), { alg: "RS256", typ: "JWT" });
    const now = clock / 1000;
    assert.deepEqual(decode(payload), { iat: now - 60, exp: now + 540, iss: "123456" });
    assert.ok(verify("sha256", Buffer.from(`${header}.${payload}`), KEYS.publicKey, Buffer.from(signature, "base64url")));
    // The mint request carries that JWT and scopes the token to the allowlisted repository.
    await auth().token(REPO);
    assert.equal(mints()[0]!.headers.authorization?.split(".").length, 3);
    assert.deepEqual(mints()[0]!.body, { repositories: ["widgets"] });
  });

  test("UT-071 auth: token expiring in 4 min is refreshed; 6 min ahead is reused", async () => {
    const a = auth();
    gh.state.tokenExpiresAt = new Date(clock + 6 * 60_000).toISOString();
    assert.equal(await a.token(REPO), "ghs_fake1");
    assert.equal(await a.token(REPO), "ghs_fake1");
    assert.equal(mints().length, 1);
    clock += 2 * 60_000; // now 4 min before expiry
    assert.equal(await a.token(REPO), "ghs_fake2");
    assert.equal(mints().length, 2);
  });

  test("UT-072 auth: 401 on a call clears the cache, retries once, then credential_invalid", async () => {
    const a = auth();
    const client = createGitHub({ apiUrl: gh.url, repo: REPO, tokens: a, now: () => clock });
    gh.state.rejectTokens = 1;
    await client.rest("GET", `/repos/${REPO}/pulls/231`);
    assert.equal(mints().length, 2, "one retry with a fresh token");
    gh.state.rejectTokens = 2;
    await assert.rejects(client.rest("GET", `/repos/${REPO}/pulls/231`), (error: any) => error.code === "credential_invalid");
    assert.equal(mints().length, 3, "cached token, then one fresh retry");
  });

  test("UT-072 auth: tools surface credential_invalid as tool_unavailable", async () => {
    const h = await harness();
    h.gh.state.rejectTokens = 2;
    const error = await failure(h.call("pr_context", { repo: REPO, number: 231 }));
    assert.equal(error.code, "credential_invalid");
    assert.equal(error.toolCode, "tool_unavailable");
    await h.close();
  });
});
