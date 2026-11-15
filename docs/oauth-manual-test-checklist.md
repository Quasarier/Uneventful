# Manual OAuth verification (Google development project)

Use a dedicated **development** Google Cloud project and OAuth client. Do not
use production credentials or real user data. The application still performs
the domain checks itself; Google's `hd` authorization parameter is only a
sign-in hint and is not an authorization control.

## Preparation

- [ ] In Google Cloud Console, select or create the development project.
- [ ] Configure the OAuth consent screen for testing and add only designated
      test accounts as test users if the app is in Testing status.
- [ ] Create an OAuth client of type **Web application**.
- [ ] Add the exact local API callback URI to **Authorized redirect URIs**:
      `http://localhost:3001/api/v1/auth/google/callback`
- [ ] Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from this client.
- [ ] Set `UNIVERSITY_EMAIL_DOMAIN` to the exact university domain used by the
      test account, and configure `NEXT_PUBLIC_WEB_ORIGIN` and
      `NEXT_PUBLIC_API_BASE_URL` for the local web and API origins.
- [ ] Start the local API and web app over a setup that supports the auth
      cookie's `Secure` attribute (normally HTTPS locally, or a documented local
      TLS proxy). Do not weaken the production cookie setting to make this test pass.
- [ ] Open browser developer tools with **Preserve log** enabled. Confirm the
      OAuth transaction cookie is HttpOnly and scoped to the callback path. Never
      copy tokens or cookie values into tickets or logs.

## Allowed university account

- [ ] Start **Continue with Google** and authenticate with a test account whose
      hosted domain and verified email exactly match the configured university
      domain.
- [ ] Confirm Google returns to the configured callback and the popup closes
      after reporting success.
- [ ] Confirm the opener receives only `type: "uneventful:auth"` and a boolean
      `success` flag. No access or refresh token should appear in the message.
- [ ] Confirm the opener calls `POST /api/v1/auth/refresh` with credentials and
      receives the session response; the refresh cookie is HttpOnly, Secure, and
      SameSite=Lax.
- [ ] Confirm the database contains one user for this Google subject and that
      no credential or token is written to application logs.

## Disallowed university domain

- [ ] Sign out and repeat login using a test Google account from a domain other
      than the configured university domain.
- [ ] Confirm the callback reports an error, the opener does not fetch a
      session, and no refresh cookie is issued.
- [ ] Confirm no user is created or updated for the disallowed Google subject.

## Tampered OAuth state

- [ ] Start a fresh login and pause before Google redirects to the callback.
- [ ] In a controlled browser test environment, change one character in the
      callback `state` query value while leaving the transaction cookie unchanged.
- [ ] Complete the callback request.
- [ ] Confirm state validation fails, the popup reports an error, and no
      authenticated session or refresh cookie is issued.

## Missing PKCE

- [ ] Start a fresh login and inspect the Google authorization request. Record
      that it contains `code_challenge` and `code_challenge_method=S256`.
- [ ] In the controlled test environment, remove the PKCE challenge from the
      authorization request while preserving the OAuth state and cookie, then
      attempt the callback/code exchange.
- [ ] Confirm the authorization-code exchange fails and no authenticated
      session or refresh cookie is issued. Do not change the production client or
      disable PKCE to complete this test.

## Repeat login

- [ ] Sign in successfully with an allowed test account, then start and
      complete Google login again using that same account.
- [ ] Confirm both logins map to one user record for the Google subject and the
      second login obtains a session successfully.
- [ ] Confirm the newly issued refresh token is distinct and stored only as a
      hash. The current implementation creates a separate refresh-token family for
      each successful login; a repeat login does not automatically revoke an
      earlier device/session family.
