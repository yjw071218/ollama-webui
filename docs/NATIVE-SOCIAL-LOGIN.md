# Native social sign-in

## Buttons and native compatibility
The native Google button uses a white, 40px provider button with the Google mark
and "Google 계정으로 계속하기". Kakao keeps its yellow provider button.

Updated native clients advertise `nativeKakao: true` in authenticated
`/__native/info`. Older clients retain their existing in-window Kakao flow.
Rebuild/install the native client for the new external Kakao flow; update and
restart the server for the new routes and web UI. Included in native-v1.0.6;
provider configuration and real-account login still require separate verification.

## Google direct account selection
Do not enable this merely because a URL probe reached a Google /signin path.
Google error pages also live under /signin. Decode authError and distinguish
redirect_uri_mismatch from a real account-selection page.

1. Configure a publicly reachable HTTPS origin for the server.
2. In the Google Cloud web OAuth client, register this exact **authorized redirect URI**:
   `https://YOUR-SERVER/api/auth/native/google/callback`.
   An authorized JavaScript origin is a different setting and is not sufficient.
3. Set the server environment:
   `GOOGLE_NATIVE_REDIRECT_URI=https://YOUR-SERVER/api/auth/native/google/callback`.
4. Restart the server and connect the app to that same HTTPS origin.

This uses Google's documented OIDC implicit ID-token response. It does not
require a client secret. An automatic redirect replaces the intermediate page;
there is no second sign-in button. The callback checks browser-bound random
state and expiry, removes the URL fragment, and posts the ID token for server
audience, issuer, expiry and nonce verification. The polling secret never goes
to the external browser. Public HTTP callbacks are not enabled.

Until this variable is configured, the previous GIS-button login remains
available so an unregistered callback does not break existing sign-in.
The running server configuration and Google Cloud settings were not changed.
Actual Google login still requires provider-side registration and user testing.

## Kakao
The new native flow opens `/api/auth/native/kakao?id=...`, which immediately
redirects to Kakao; there is no intermediate button. Existing
`KAKAO_REST_KEY` / `VITE_KAKAO_REST_KEY`, optional `KAKAO_CLIENT_SECRET`,
and `KAKAO_REDIRECT_URI` / `PUBLIC_ORIGIN` settings are used.
Register the exact `/kakao/callback` URI in Kakao Developers.
A console-enabled client secret must still be configured on the server; code
cannot bypass provider settings.

The external browser owns the OAuth state cookie. The server exchanges the code
and fetches the profile, then retains a short-lived result. Only the original app
with its independent polling secret can redeem that result once and receive
its own session cookie. No Kakao access or refresh token reaches the client.
Cancellation is reported to the app; retry supersedes the old polling loop.

## Verification
`node --test scripts/native-google.test.mjs scripts/native-login-retry.test.mjs scripts/native-social-direct.test.mjs scripts/native-kakao-routes.test.mjs native/tests/*.test.mjs`

The route tests use a temporary database and mocked provider responses. They do
not prove that real provider credentials, redirects or device login are valid.

References:
- https://developers.google.com/identity/openid-connect/reference
- https://developers.kakao.com/docs/ko/kakaologin/rest-api
