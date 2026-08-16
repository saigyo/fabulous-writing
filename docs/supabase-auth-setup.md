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

Configure the URL that GoTrue mints as the token **issuer** — nothing
else works. That is the **canonical** `https://<ref>.supabase.co` URL,
with exactly one exception: a fully **activated custom domain** (the paid
add-on, DNS-verified and switched live via `supabase domains activate`),
after which Supabase Auth uses the custom domain and you configure that
instead. A **vanity subdomain** (`<name>.supabase.co`) never qualifies —
it serves requests but the issuer stays canonical. The definitive check
either way:
`curl https://<your-domain>/auth/v1/.well-known/openid-configuration` — the
`issuer` field reads `https://<domain>/auth/v1`. Configure `auth.supabase.url`
as that value **with the trailing `/auth/v1` removed**: the backend appends
it itself (`SupabaseTokenVerifier.__init__`), so configuring the full issuer
string would double the suffix. With any other URL configured, tokens are
perfectly signed yet fail the issuer check, which surfaces as an instant
post-login 401 loop with no JWKS warning in the log. Switching
domains later bounces every active session to the login form once (old
tokens carry the old issuer) — do it before real users exist, and update
the Site URL / redirect URLs (§6) in the same pass.

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

Turning these off is worth doing, and it genuinely is defence in depth here,
not the sole control: the backend independently rejects anonymous **and**
non-email-provider (OAuth/SSO) tokens by inspecting their claims —
`SupabaseTokenVerifier.verify()` raises on `is_anonymous: true`, on any
`role` other than `"authenticated"`, and on any `app_metadata.provider`
other than `"email"` — regardless of what the dashboard is set to.
`app_metadata` is GoTrue's server-controlled `raw_app_meta_data` (not the
user-editable `user_metadata`), and its `provider` field names whichever
identity provider minted the session — `"google"`, `"github"`, etc. for an
OAuth/SSO login, `"email"` only for the email/password flow this app uses.
If Supabase ever shipped a project with anonymous sign-ins or an OAuth
provider on by mistake (or a future project reuses this checklist
incompletely), a drive-by anonymous session or an OAuth-authenticated
caller still cannot mint a local user row. Think of the dashboard toggles
as defence in depth on top of that check, not the mechanism itself.

The dashboard toggle also genuinely cannot be enabled accidentally without
the next restart catching it: on startup, the backend reads GoTrue's own
provider configuration (`GET {url}/auth/v1/settings`) and refuses to come
up at all if anything other than **Email** is enabled, naming the
offending providers. A transient Supabase outage at that check logs a
warning and lets startup continue rather than bricking every restart — the
check simply re-runs on the next one.

Two independent checks, closing two different windows. The startup check
above and the per-token `app_metadata.provider` guard both look at the
identity's **first** provider — the provider that originally created the
account — so together they are a **config-level gate**: correct as of the
last restart, but blind to a provider flipped on in the dashboard while the
process keeps running. `SupabaseTokenVerifier.verify()` closes that
remaining window with a second, independent check on every request: it also
inspects the **session's own** authentication method, GoTrue's `amr` claim
(`[{"method": "password"|"otp", ...}]`, minted per session and carried
through refresh), and rejects any token whose methods are not a subset of
`{"password", "otp"}` — the two flows this app's login and
recovery/invite-confirm routes ever produce. A token minted by a
since-enabled OAuth/SSO provider on an otherwise email-first identity
carries an `amr` entry outside that set (or none at all) and is rejected
regardless of `app_metadata.provider`, and regardless of whether the
next restart's startup check would have caught the dashboard change.
One honest caveat: passwordless email sign-in (magic link / email OTP)
is **not** blocked by this check — GoTrue mints the same `otp` method
for it that recovery and invite confirmations carry, and its issuance
cannot be disabled separately while those flows stay on. This is a
trust-anchor equivalence rather than a hole: a magic link only ever
reaches the account's own mailbox, and mailbox control already implies
account control through the password-reset flow.
The first-provider guards stay in place too — they are what keeps a
*brand-new* OAuth-origin identity from ever reaching this backend in the
first place — but it is the per-request `amr` check that now covers the
gap between one restart and the next.

### Enabling leaked password protection

**Auth → Providers → Email**, under that provider's password requirements,
carries a **"Leaked password protection"** toggle (a Pro-plan-and-above
feature, backed by the HaveIBeenPwned k-anonymity API) that GoTrue's
security advisor recommends turning on. It was previously unsafe to enable
here: a rejection from GoTrue used to arrive *after* the one-time reset or
invite link had already been burned (`verify_otp` succeeds before the
password update is even attempted), stranding a confirmed identity behind a
dead link with no way back in except a fresh admin-issued invite or reset
email.

That is no longer true. `POST /api/auth/reset-confirm` now separates
verifying the link from updating the password
(`supabase_gateway.py#verify_token_hash` only burns the link; the password
update is the caller's own, separately retryable step) — any rejection
after that point, weak-password or otherwise, hands back a `retry_token`
instead of stranding the session, and the form resubmits through it without
ever needing a second link. A breach rejection specifically (GoTrue's
`pwned` reason) surfaces to the person resetting or accepting an invite as
an honest, specific message — "this password appears in known data
breaches — please pick a different one" — not a generic failure, so they
know exactly what to change and can retry immediately. Enabling the
toggle is safe to do at any point after this shipped; there is no
migration step or config flag on the backend side, since the corresponding
`password_weak`/`reasons` handling has been in place since the retry flow
landed.

One more thing worth knowing about this flow, unrelated to the toggle
above: deactivating a user in the app also stops `reset-request` from
mailing that address and blocks `reset-confirm` from rotating the
credential via an already-issued link — but only at this app's layer. The
remote GoTrue identity itself stays active throughout; deactivation is
app-local state that Supabase never sees (B32, #106; see
`docs/backend-architecture.md`'s reset-confirm section for the details).

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

An invitation that expired, or whose email never arrived, doesn't need a
brand-new account: the admin view's **"Resend invitation"** button (next to
a pending user's row) re-issues it through the same GoTrue admin API.
Resending invalidates the previous link — only the newest one still
verifies — and if the account was accepted in the meantime, the button
honestly reports that (`already_active`) instead of silently sending out a
link nobody needs.

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
in a differently-shaped URL **fragment** (`#access_token=...&type=recovery`)
— not the `token_hash` fragment this app expects. This backend's frontend
(`LoginGate.tsx`'s `readResetParams()`) only recognizes
`#token_hash=...&type=recovery|invite` in the URL fragment, because the
backend verifies the link server-side via `verify_otp({token_hash, type})`
(`supabase_gateway.py`) rather than trusting a client-side session GoTrue's
verify page hands back. With the stock templates, the link opens the
ordinary login form with no error — both flows fail closed, silently.

For **each** of the "Reset Password" and "Invite user" templates (**Auth →
Email Templates**), replace the link with:

- Reset Password: `{{ .SiteURL }}/#token_hash={{ .TokenHash }}&type=recovery`
- Invite user: `{{ .SiteURL }}/#token_hash={{ .TokenHash }}&type=invite`

The credential goes in the fragment, not the query string: a URL fragment
is never sent in the HTTP request (browsers strip it before the initial
navigation and any same-origin asset fetch), so this one-time token cannot
reach uvicorn/reverse-proxy access logs or leak via a `Referer` header the
way a query parameter would.

`{{ .SiteURL }}` resolves to the Site URL set in §6 above, so this only
works once that field is filled in.

The committed local-stack templates under `supabase/templates/` carry this
exact fragment contract and are exercised by the offline e2e suite
(`scripts/e2e-supabase.sh`), so template-contract drift breaks a test before
it breaks production.

## 8. Auth → Email (SMTP)

Supabase's built-in email sender is **rate-limited for development use** —
fine for testing the flow, not for production traffic (a burst of invites
or reset requests will start bouncing). For a production deployment,
configure **custom SMTP** here before you rely on invite or reset emails
actually arriving.

### AWS SES: two SMTP flavors, and a silent-failure trap

SES offers two SMTP credential methods, and they debug very differently
(learned the hard way during this app's acceptance test):

- **IAM SMTP credentials** (classic): the console creates an
  `ses-smtp-user.*` IAM user; the SMTP password is *derived* from the
  secret key and is **region-specific** — pasting a raw IAM secret key, or
  using credentials against another region's endpoint, fails with
  `535 5.7.8 Authentication Credentials Invalid`. A send failure happens
  **synchronously**: GoTrue reports the error and the Supabase auth logs
  carry the SMTP status line.
- **Mail Manager SMTP** (managed, no IAM user): you get an *ingress
  endpoint* (`…mail-manager-smtp.amazonaws.com`) with a Secrets-Manager
  password, and mail is processed by a **traffic policy + rule set** whose
  `Send` action performs the actual SES outbound send. The trap: the
  ingress **accepts the message and GoTrue reports success before the
  rule set runs**. If the Send action then fails — most commonly SES
  **sandbox mode** with an unverified recipient — the mail is dropped
  *asynchronously* and nothing in Supabase ever shows an error. A
  "sent" invite that never arrives is this, until proven otherwise.

Diagnosis checklist for "GoTrue says sent, nothing arrives" on Mail
Manager: (1) `aws sesv2 get-account` — `ProductionAccessEnabled: false`
means sandbox: every recipient must be a verified identity until you
request production access; (2) enable CloudWatch log delivery on the
ingress point (Mail Manager → Ingress endpoints → your endpoint →
logging) and check the application log for the message reaching the rule
set; (3) compare the ingress log against the `AWS/SES` `Send`/`Delivery`
CloudWatch metrics — an ingress entry *without* a matching `Send`
datapoint means the rule-set action failed. Note the metrics can lag a
few minutes. In both flavors, request **production access** before real
users: sandbox delivery works only to individually verified addresses.

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
admin's password after the fact, do it through the **application** — the
account menu's password-change form, or another admin's PATCH on this
account through the admin API — not by changing the environment variables
and restarting. Both of those rotate the credential at Supabase *and* evict
this backend's own outstanding sessions (`mark_password_changed`) in the
same request. Changing the password directly in the Supabase dashboard
still revokes the account's refresh tokens at Supabase, but any access
token already issued stays valid here until it expires on its own —
`mark_password_changed` never runs, since the dashboard has no way to call
back into this backend.
