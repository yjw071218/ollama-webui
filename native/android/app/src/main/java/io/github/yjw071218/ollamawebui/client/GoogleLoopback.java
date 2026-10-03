package io.github.yjw071218.ollamawebui.client;

import android.webkit.CookieManager;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.json.JSONObject;

/**
 * Google sign-in straight to the account chooser (same as native/desktop/googleLoopback.mjs).
 *
 * Google sends a plain-HTTP redirect only to loopback, so for the few minutes a
 * sign-in takes the app listens on 127.0.0.1:47615, the one redirect URI
 * registered in the Google console. The Custom Tab opens Google itself; Google
 * returns the ID token in the URL fragment to this listener's page, which hands
 * it here, and it goes on through the app's own gateway (with the WebView's
 * cookies) to the server's /api/auth/native/finish, where it is verified.
 */
final class GoogleLoopback implements Closeable {
    static final int PORT = 47615;
    static final String ORIGIN = "http://127.0.0.1:" + PORT;
    static final String CALLBACK = "/api/auth/native/google/callback";
    static final String REDIRECT = ORIGIN + CALLBACK;
    private static final String CLIENT_ID = "[0-9]{6,30}-[a-z0-9]{10,64}\\.apps\\.googleusercontent\\.com";
    private static GoogleLoopback active;

    /** {id, clientId} from "google:<id>:<clientId>", or null. */
    static String[] parse(String fragment) {
        if (fragment == null || !fragment.startsWith("google:")) return null;
        String[] parts = fragment.substring(7).split(":", 2);
        if (parts.length != 2 || !parts[0].matches("[a-f0-9]{64}") || !parts[1].matches(CLIENT_ID)) return null;
        return parts;
    }
    static String authorizeUrl(String id, String clientId) {
        try {
            return "https://accounts.google.com/o/oauth2/v2/auth?client_id=" + URLEncoder.encode(clientId, "UTF-8")
                + "&redirect_uri=" + URLEncoder.encode(REDIRECT, "UTF-8")
                + "&response_type=id_token&response_mode=fragment&scope=openid%20email%20profile"
                + "&nonce=" + id + "&state=" + id + "&prompt=select_account";
        } catch (UnsupportedEncodingException e) { throw new IllegalStateException(e); }
    }

    static final String PAGE = "<!doctype html><html lang=\"ko\"><meta charset=\"utf-8\">\n"
        + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Google 로그인</title>\n"
        + "<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1f1d1a;color:#eee9e0;font:16px system-ui,sans-serif}\n"
        + "main{max-width:420px;padding:32px;text-align:center}h1{font-size:20px;margin:0 0 10px}p{color:#b9ad9b;line-height:1.6;margin:0}\n"
        + "a{display:inline-block;margin-top:20px;padding:11px 20px;border-radius:10px;background:#dac5a5;color:#28231d;text-decoration:none;font-weight:600}</style>\n"
        + "<main><h1 id=\"title\">로그인 확인 중…</h1><p id=\"status\">잠시만 기다려 주세요.</p><a id=\"back\" href=\"ollamawebui://auth\" hidden>앱으로 돌아가기</a></main>\n"
        + "<script src=\"" + CALLBACK + ".js\"></script></html>";
    static final String SCRIPT = "(async () => {\n"
        + "  const params = new URLSearchParams(location.hash.slice(1));\n"
        + "  history.replaceState(null, '', location.pathname);\n"
        + "  const title = document.getElementById('title'), status = document.getElementById('status');\n"
        + "  try {\n"
        + "    if (params.get('error')) throw new Error('로그인이 취소되었습니다. 앱에서 다시 시도하세요.');\n"
        + "    const response = await fetch('" + CALLBACK + "/finish', { method: 'POST', headers: { 'Content-Type': 'application/json' },\n"
        + "      body: JSON.stringify({ state: params.get('state') || '', credential: params.get('id_token') || '' }) });\n"
        + "    const result = await response.json().catch(() => ({}));\n"
        + "    if (!response.ok) throw new Error(result.error || '로그인 연결에 실패했습니다. 앱에서 다시 시도하세요.');\n"
        + "    title.textContent = '로그인되었습니다';\n"
        + "    status.textContent = result.android ? '앱으로 돌아갑니다…' : '이 탭을 닫고 앱으로 돌아가세요.';\n"
        + "    if (result.android) { document.getElementById('back').hidden = false; location.replace('ollamawebui://auth'); }\n"
        + "    else setTimeout(() => window.close(), 400);\n"
        + "  } catch (error) { title.textContent = '로그인하지 못했습니다'; status.textContent = error.message; }\n"
        + "})();";

    private final ServerSocket listener;
    private final String id, finishUrl, gatewayOrigin;
    private final Runnable onDone;
    private volatile boolean finished;

    /** Listen for one sign-in; throws when the port is taken (caller falls back to the page). */
    static synchronized GoogleLoopback start(String id, String gatewayOrigin, Runnable onDone) throws IOException {
        if (active != null) active.close();
        active = new GoogleLoopback(id, gatewayOrigin, onDone);
        return active;
    }
    private GoogleLoopback(String id, String gatewayOrigin, Runnable onDone) throws IOException {
        this.id = id; this.gatewayOrigin = gatewayOrigin; this.finishUrl = gatewayOrigin + "/api/auth/native/finish"; this.onDone = onDone;
        listener = new ServerSocket();
        listener.setReuseAddress(true);
        listener.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT));
        Thread accept = new Thread(() -> {
            long deadline = System.currentTimeMillis() + 300_000;
            try { listener.setSoTimeout(5000); } catch (IOException ignored) { }
            while (!listener.isClosed() && System.currentTimeMillis() < deadline) {
                try (Socket client = listener.accept()) { serve(client); }
                catch (SocketTimeoutException ignored) { }
                catch (IOException ignored) { }
            }
            close();
        }, "google-loopback");
        accept.setDaemon(true); accept.start();
    }

    private static String line(InputStream in) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); int c;
        while ((c = in.read()) != -1 && c != '\n') { if (c != '\r') bytes.write(c); if (bytes.size() > 8192) throw new IOException("long"); }
        return bytes.toString(StandardCharsets.ISO_8859_1.name());
    }
    private static void send(Socket client, int code, String type, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        String status = code == 200 ? "OK" : code == 404 ? "Not Found" : code == 403 ? "Forbidden" : "Error";
        String head = "HTTP/1.1 " + code + " " + status + "\r\nContent-Type: " + type + "\r\nContent-Length: " + bytes.length
            + "\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY"
            + "\r\nContent-Security-Policy: default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'"
            + "\r\nConnection: close\r\n\r\n";
        OutputStream out = client.getOutputStream();
        out.write(head.getBytes(StandardCharsets.ISO_8859_1)); out.write(bytes); out.flush();
    }
    private static String error(String message) { return "{\"error\":" + JSONObject.quote(message) + "}"; }

    private void serve(Socket client) throws IOException {
        client.setSoTimeout(15000);
        InputStream in = new BufferedInputStream(client.getInputStream());
        String[] request = line(in).split(" ");
        Map<String, String> h = new HashMap<>();
        for (String text; !(text = line(in)).isEmpty(); ) {
            int colon = text.indexOf(':');
            if (colon > 0) h.put(text.substring(0, colon).trim().toLowerCase(Locale.ROOT), text.substring(colon + 1).trim());
            if (h.size() > 100) return;
        }
        if (request.length != 3 || !("127.0.0.1:" + PORT).equals(h.get("host"))) { send(client, 403, "text/plain", "Forbidden"); return; }
        String path = request[1].split("\\?", 2)[0];
        if ("GET".equals(request[0]) && CALLBACK.equals(path)) { send(client, 200, "text/html; charset=utf-8", PAGE); return; }
        if ("GET".equals(request[0]) && (CALLBACK + ".js").equals(path)) { send(client, 200, "text/javascript; charset=utf-8", SCRIPT); return; }
        if (!"POST".equals(request[0]) || !(CALLBACK + "/finish").equals(path)) { send(client, 404, "text/plain", "Not found"); return; }
        String type = h.getOrDefault("content-type", "");
        if (!ORIGIN.equals(h.get("origin")) || !type.startsWith("application/json")) { send(client, 403, "application/json", error("잘못된 요청입니다.")); return; }
        int length;
        try { length = Integer.parseInt(h.getOrDefault("content-length", "-1")); } catch (NumberFormatException e) { length = -1; }
        if (length < 0 || length > 16384) { send(client, 413, "application/json", error("요청이 너무 큽니다.")); return; }
        byte[] raw = new byte[length]; int read = 0;
        while (read < length) { int n = in.read(raw, read, length - read); if (n < 0) break; read += n; }
        JSONObject body;
        try { body = new JSONObject(new String(raw, 0, read, StandardCharsets.UTF_8)); } catch (Exception e) { body = new JSONObject(); }
        if (finished) { send(client, 409, "application/json", error("이미 처리된 로그인입니다.")); return; }
        if (!id.equals(body.optString("state"))) { send(client, 400, "application/json", error("앱에서 시작한 로그인이 아닙니다. 앱에서 다시 시도하세요.")); return; }
        String credential = body.optString("credential");
        if (credential.isEmpty() || credential.length() > 8192) { send(client, 400, "application/json", error("Google 인증 결과가 없습니다.")); return; }
        String failure = forward(credential);
        if (failure != null) { send(client, 400, "application/json", error(failure)); return; }
        finished = true;
        send(client, 200, "application/json", "{\"ok\":true,\"android\":true}");
        try { onDone.run(); } catch (RuntimeException ignored) { }
        new Thread(() -> { try { Thread.sleep(2000); } catch (InterruptedException ignored) { } close(); }).start();
    }

    /** POST to the server through the app's gateway, carrying the WebView's cookies. */
    private String forward(String credential) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(finishUrl).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(15000); c.setReadTimeout(15000);
            c.setRequestMethod("POST"); c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            String cookies = CookieManager.getInstance().getCookie(gatewayOrigin);
            if (cookies != null) c.setRequestProperty("Cookie", cookies);
            byte[] payload = new JSONObject().put("id", id).put("credential", credential).toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream out = c.getOutputStream()) { out.write(payload); }
            int code = c.getResponseCode();
            if (code >= 200 && code < 300) return null;
            String detail = "";
            try (InputStream err = c.getErrorStream()) {
                if (err != null) detail = new JSONObject(ReleaseUpdates.readText(err, 16384)).optString("error");
            } catch (Exception ignored) { }
            return "서버가 로그인을 거부했습니다" + (detail.isEmpty() ? "." : ": " + detail) + " 앱에서 다시 시도하세요.";
        } catch (Exception e) {
            return "서버에 연결하지 못했습니다. 앱에서 다시 시도하세요.";
        } finally { if (c != null) c.disconnect(); }
    }

    @Override public void close() {
        synchronized (GoogleLoopback.class) { if (active == this) active = null; }
        try { listener.close(); } catch (IOException ignored) { }
    }
}
