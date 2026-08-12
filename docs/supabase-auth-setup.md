# Hosted authentication with Supabase

`auth.mode: supabase` moves login, password storage, and session issuance
to a [supabase.com](https://supabase.com) project instead of this backend's
own bcrypt/HS256 implementation (`auth.mode: local`, the default). This page
is the dashboard walkthrough for an operator setting up a fresh Supabase
project for that purpose, in the order you'll actually click through it.
For how the backend consumes what you configure here, see
[Authentication and user accounts](backend-architecture.md#authentication-and-user-accounts)
in the architecture doc.

## 1. Create the project

Create a project at [supabase.com](https://supabase.com) and note its URL:
`https://<ref>.supabase.co`. That's the only piece of project identity the
backend needs — everything else below is either a key or a dashboard toggle.

## 2. Settings → JWT Keys: rotate off the legacy shared secret

Supabase projects ship with a legacy, symmetric JWT secret (HS256). **This
backend does not support it, at all, in `supabase` mode** — the verifier
(`app/core/supabase_auth.py`) only accepts asymmetric signatures
(`algorithms=["ES256", "RS256"]`) verified against the project's published
JWKS. A shared-secret token is rejected outright, the same as any other
malformed token. In **Settings → JWT Keys**, migrate to the new asymmetric
signing keys and rotate — **ES256 is recommended**. There is no backend
configuration knob for this: it's purely a property of how your Supabase
project signs tokens, and the verifier fetches whichever public key the
token's `kid` names from `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`.

## 3. Settings → API Keys: create the two keys the backend needs

Create a **publishable key** and a **secret key**. The backend reads them
from the environment, never from `config.yaml`:

- `FW_SUPABASE_PUBLISHABLE_KEY` — used for the user-facing GoTrue calls
  (sign-in, refresh, password-reset request, OTP verification). Safe to
  treat as public-ish, same as any client-side Supabase key.
- `FW_SUPABASE_SECRET_KEY` — used only for the admin API (inviting users,
  setting passwords, forcing global sign-out, bootstrap). This key never
  leaves the backend process and must be kept as secret as the database
  itself.

## 4. Auth → Providers: email only, everything else off

Enable **Email** and turn off **anonymous sign-ins** and every OAuth
provider. This is the dashboard-level version of the app's identity model:
one email/password account per user, provisioned by an admin.

Turning these off is worth doing, but it is **not** the control that keeps
an anonymous or third-party-authenticated caller out. The backend
independently rejects anonymous tokens by inspecting their claims —
`SupabaseTokenVerifier.verify()` raises on `is_anonymous: true` and on any
`role` other than `"authenticated"` — regardless of what the dashboard is
set to. If Supabase ever shipped a project with anonymous sign-ins on by
mistake (or a future project reuses this checklist incompletely), a
drive-by anonymous session still cannot mint a local user row. Think of the
dashboard toggle as defence in depth on top of that check, not the
mechanism itself.

## 5. Auth → Settings: invitation-only signup

Turn **"Allow new users to sign up" OFF**. This app has no self-service
registration — every account is created by an admin, either directly
(`POST /api/admin/users` with a password) or via invite
(same endpoint with no password, which calls Supabase's admin
`invite_user_by_email`). Also turn on **email confirmations**.

One thing to know about that toggle: admin-API invites and admin-created
users are exempt from it — an admin can always provision an account through
the GoTrue admin API regardless of what "Allow new users to sign up"
says, because that switch governs Supabase's own public signup endpoint,
not the admin API this backend calls. That's Supabase's behavior, not a
guarantee this app makes on Supabase's behalf: if a future Supabase release
ever changes admin invites to respect the public-signup toggle, this is the
page that needs revisiting, not the application code — the backend has no
opinion on the toggle either way, since it never calls the public signup
endpoint at all.

## 6. Auth → URL Configuration

Set **Site URL** to your deployment's origin — for a local run, e.g.
`http://localhost:9090` works, since the reset/invite links Supabase mails
out just need to open on the same machine that's running the backend. Add
the same origin under **additional redirect URLs**. This is what makes a
password-reset or invite email's link land back on your app instead of a
generic Supabase page.

## 7. Auth → Email Templates: point them at the app, not Supabase's verify page

**Do this or password reset and invite acceptance silently do nothing.**
Supabase's stock "Reset Password" and "Invite user" templates link to
`{{ .ConfirmationURL }}`, which routes through Supabase's own
`/auth/v1/verify` endpoint and lands back on your Site URL with the tokens
in the URL **fragment** (`#access_token=...&type=recovery`) — not a
`token_hash` query parameter. This backend's frontend
(`LoginGate.tsx`'s `readResetParams()`) only recognizes
`?token_hash=...&type=recovery|invite` in the query string, because the
backend verifies the link server-side via `verify_otp({token_hash, type})`
(`supabase_gateway.py`) rather than trusting a client-side session GoTrue's
verify page hands back. With the stock templates, the link opens the
ordinary login form with no error — both flows fail closed, silently.

For **each** of the "Reset Password" and "Invite user" templates (**Auth →
Email Templates**), replace the link with:

- Reset Password: `{{ .SiteURL }}/?token_hash={{ .TokenHash }}&type=recovery`
- Invite user: `{{ .SiteURL }}/?token_hash={{ .TokenHash }}&type=invite`

`{{ .SiteURL }}` resolves to the Site URL set in §6 above, so this only
works once that field is filled in.

## 8. Auth → Email (SMTP)

Supabase's built-in email sender is **rate-limited for development use** —
fine for testing the flow, not for production traffic (a burst of invites
or reset requests will start bouncing). For a production deployment,
configure **custom SMTP** here before you rely on invite or reset emails
actually arriving.

## 9. Access-token TTL

The default access-token lifetime (1 hour) is fine as-is — there's no need
to shorten it for security reasons. Revocation in this app is enforced
mostly at the backend's own verification layer: a password change backdates
`password_changed_at` and rejects every access token minted before that
instant on the next request. The one exception is deliberate: a token
minted in the final `IAT_LEEWAY_SECONDS` (60s) before the change stays
valid until it expires on its own. A global Supabase sign-out runs
alongside the backdate, but it revokes **refresh tokens and sessions
only** — access tokens are stateless JWTs this backend verifies locally
against Supabase's published JWKS, so Supabase is never consulted per
request and cannot revoke one already issued (see
[Revocation and eviction](backend-architecture.md#authentication-and-user-accounts)
in the architecture doc for the full picture). In practice that residual
window is bounded and no replacement token can be minted for it — the
refresh token dies with the sign-out — but it is not "immediately
worthless." A short TTL only forces more silent background refreshes; it
doesn't add revocation the backend doesn't already have.

## 10. Wire it into the backend

`config.yaml`:

```yaml
auth:
  mode: supabase
  supabase:
    url: https://<ref>.supabase.co
```

`fabulous.env` (or however you inject environment variables):

```
FW_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
FW_SUPABASE_SECRET_KEY=sb_secret_...
FW_ADMIN_EMAIL=you@example.com
FW_ADMIN_PASSWORD=<bootstrap password, min 12 chars>
```

`FW_AUTH_SECRET` — required in `auth.mode: local` — is **not needed** in
supabase mode. Nothing on this deployment ever signs a local JWT; every
token in circulation was minted by Supabase and verified against its JWKS.

**Bootstrap semantics.** On the very first start, while the local `users`
table is still empty, the backend uses `FW_ADMIN_EMAIL`/`FW_ADMIN_PASSWORD`
to create the admin account **in Supabase** (via the admin API — or link an
already-existing Supabase user with that email, if you're re-running
bootstrap against a project that already has one) and records a local row
pointing at it. Once any user exists — admin or not — those two variables
are read no further: they can never serve as a standing password reset, in
this mode any more than in local mode. If you need to change the bootstrap
admin's password after the fact, do it through the Supabase dashboard or
the admin API, not by changing the environment variables and restarting.
