package io.github.yjw071218.ollamawebui.client;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.*;
import java.util.concurrent.*;
import javax.net.ssl.*;

/** A private, authenticated loopback gateway. Bodies (including SSE and WebSockets)
 * are streamed unchanged; no buffering, decompression, or TLS verification bypass.
 * Connections are kept alive: one page connection keeps one server connection, so
 * a request does not pay for a new TCP (and TLS) handshake every time. */
public final class LoopbackProxy implements Closeable {
    private final URI target;
    private final ServerSocket listener;
    private final ExecutorService workers = new ThreadPoolExecutor(0, 64, 30, TimeUnit.SECONDS, new SynchronousQueue<>());
    private final Set<Socket> sockets = ConcurrentHashMap.newKeySet();
    public final String origin, token;
    public static final String COOKIE = "__ollama_native_gate";
    public static String normalize(String raw) throws Exception {
        String text = raw.trim();
        // "192.168.0.5:5173" is what people type; it means http.
        if (!text.isEmpty() && !text.matches("(?i)^[a-z][a-z0-9+.-]*://.*")) text = "http://" + text;
        URI u = new URI(text);
        if (!("http".equals(u.getScheme()) || "https".equals(u.getScheme())) || u.getHost() == null ||
            u.getUserInfo() != null || u.getRawQuery() != null || u.getRawFragment() != null ||
            !(u.getRawPath() == null || u.getRawPath().isEmpty() || "/".equals(u.getRawPath())) ||
            u.getPort() < -1 || u.getPort() == 0 || u.getPort() > 65535)
            throw new IllegalArgumentException("서버 주소를 확인하세요. 예: 192.168.0.5:5173 또는 https://example.com (경로·로그인 정보는 넣지 마세요)");
        return u.getScheme() + "://" + u.getRawAuthority();
    }
    public LoopbackProxy(String server, int port) throws Exception {
        target = new URI(normalize(server));
        byte[] secret = new byte[32]; new SecureRandom().nextBytes(secret);
        StringBuilder hex = new StringBuilder(); for (byte b : secret) hex.append(String.format("%02x", b));
        token = hex.toString();
        listener = new ServerSocket();
        listener.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port));
        origin = "http://127.0.0.1:" + listener.getLocalPort();
        Thread accept = new Thread(() -> {
            while (!listener.isClosed()) {
                try {
                    Socket client = listener.accept(); sockets.add(client);
                    try { workers.execute(() -> serve(client)); }
                    catch (RejectedExecutionException busy) { sockets.remove(client); client.close(); }
                } catch (IOException ignored) { }
            }
        }, "native-loopback"); accept.setDaemon(true); accept.start();
    }
    public int port() { return listener.getLocalPort(); }
    private static String line(InputStream in) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') bytes.write(c);
            if (bytes.size() > 16384) throw new IOException("Header too long");
        }
        if (c == -1 && bytes.size() == 0) return null;
        return bytes.toString(StandardCharsets.ISO_8859_1.name());
    }
    private static List<String[]> headers(InputStream in) throws IOException {
        List<String[]> result = new ArrayList<>(); String text; int total = 0;
        while ((text = line(in)) != null && !text.isEmpty()) {
            total += text.length();
            if (total > 65536 || result.size() > 100) throw new IOException("Headers too large");
            int colon = text.indexOf(':');
            if (colon < 1 || text.charAt(0) == ' ' || text.charAt(0) == '\t') throw new IOException("Bad header");
            result.add(new String[]{text.substring(0, colon).toLowerCase(Locale.ROOT), text.substring(colon + 1).trim()});
        }
        return result;
    }
    private static String header(List<String[]> h, String key) {
        for (String[] pair : h) if (pair[0].equals(key)) return pair[1];
        return "";
    }
    private static boolean has(String value, String token) {
        for (String part : value.split(",")) if (part.trim().equalsIgnoreCase(token)) return true;
        return false;
    }
    private static int statusCode(String status) {
        String[] parts = status.split(" ", 3);
        try { return parts.length > 1 ? Integer.parseInt(parts[1].trim()) : 0; } catch (NumberFormatException e) { return 0; }
    }
    private static void write(OutputStream out, String s) throws IOException { out.write(s.getBytes(StandardCharsets.ISO_8859_1)); }
    private static void pump(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[32768]; int n;
        while ((n = in.read(buffer)) != -1) { out.write(buffer, 0, n); out.flush(); }
    }
    /** Exactly n bytes; flushed as they come when a response streams. */
    private static void copyFixed(InputStream in, OutputStream out, long n, boolean flush) throws IOException {
        byte[] buffer = new byte[32768];
        while (n > 0) {
            int read = in.read(buffer, 0, (int) Math.min(buffer.length, n));
            if (read == -1) throw new EOFException("Body ended early");
            out.write(buffer, 0, read); n -= read;
            if (flush) out.flush();
        }
        out.flush();
    }
    /** A chunked body, framing and all, flushed chunk by chunk (SSE arrives this way). */
    private static void copyChunked(InputStream in, OutputStream out) throws IOException {
        while (true) {
            String size = line(in);
            if (size == null) throw new EOFException("Chunked body ended early");
            int semi = size.indexOf(';');
            long n = Long.parseLong((semi < 0 ? size : size.substring(0, semi)).trim(), 16);
            if (n < 0) throw new IOException("Bad chunk");
            write(out, size + "\r\n");
            if (n == 0) {
                String trailer;
                while ((trailer = line(in)) != null && !trailer.isEmpty()) write(out, trailer + "\r\n");
                write(out, "\r\n"); out.flush(); return;
            }
            copyFixed(in, out, n, false);
            String end = line(in);
            if (end == null || !end.isEmpty()) throw new IOException("Bad chunk");
            write(out, "\r\n"); out.flush();
        }
    }
    /** One connection to the server, kept for the page connection it serves. */
    private static final class Upstream {
        Socket socket; InputStream in; OutputStream out; long idleSince = System.currentTimeMillis();
    }
    /* Node closes an idle keep-alive connection after 5 s (keepAliveTimeout), so
       one idle longer than this is not trusted with the next request. */
    private static final long UPSTREAM_IDLE_MS = 4000;
    private static final int CLIENT_IDLE_MS = 60000;
    private Upstream openUpstream() throws IOException {
        boolean secure = "https".equals(target.getScheme());
        int port = target.getPort() < 0 ? (secure ? 443 : 80) : target.getPort();
        Socket raw = new Socket(); sockets.add(raw);
        Socket socket = raw;
        try {
            raw.connect(new InetSocketAddress(target.getHost(), port), 15000);
            if (secure) {
                SSLSocket ssl = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(raw, target.getHost(), port, true);
                SSLParameters parameters = ssl.getSSLParameters(); parameters.setEndpointIdentificationAlgorithm("HTTPS"); ssl.setSSLParameters(parameters);
                socket = ssl; sockets.remove(raw); sockets.add(ssl);
                ssl.setSoTimeout(300000); ssl.startHandshake();
            }
            socket.setSoTimeout(0); // No generation/stream idle deadline.
            Upstream up = new Upstream();
            up.socket = socket;
            up.in = new BufferedInputStream(socket.getInputStream());
            up.out = new BufferedOutputStream(socket.getOutputStream(), 32768);
            return up;
        } catch (IOException e) {
            try { socket.close(); } catch (IOException ignored) { }
            sockets.remove(socket); sockets.remove(raw); throw e;
        }
    }
    private void close(Upstream up) {
        if (up == null) return;
        try { up.socket.close(); } catch (IOException ignored) { }
        sockets.remove(up.socket);
    }
    private static final String OFFLINE = "서버에 연결하지 못했습니다. 주소와 서버 실행 상태를 확인한 뒤 다시 시도하세요.";
    /** What a page load gets when the server cannot be reached, with the ways out on it. */
    private String offlinePage() {
        String server = target.toString().replace("&", "&amp;").replace("<", "&lt;");
        return "<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">"
            + "<title>연결 실패</title><style>html,body{margin:0;height:100%;background:#1a1916;color:#ece9e2;font:15px/1.6 system-ui,sans-serif}"
            + "main{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;text-align:center}"
            + "h1{font-size:20px;margin:0 0 8px}p{margin:0 0 6px;color:#b8b3a7}code{color:#d97757;word-break:break-all}"
            + "div{display:flex;gap:10px;margin-top:22px;flex-wrap:wrap;justify-content:center}"
            + "button{font:inherit;border:0;border-radius:10px;padding:11px 20px;min-height:44px;cursor:pointer}"
            + ".go{background:#d97757;color:#fff}.alt{background:#2f2d29;color:#ece9e2}</style></head><body><main>"
            + "<h1>서버에 연결할 수 없습니다</h1><p><code>" + server + "</code></p><p>서버가 켜져 있는지, 같은 네트워크에 있는지 확인하세요.</p>"
            + "<div><button class=\"go\" onclick=\"location.reload()\">다시 시도</button>"
            + "<button class=\"alt\" id=\"change\" hidden onclick=\"window.ollamaNative.changeServer()\">서버 변경</button></div></main>"
            + "<script>if(window.ollamaNative&&window.ollamaNative.changeServer)document.getElementById('change').hidden=false</script></body></html>";
    }
    private void serve(Socket client) {
        Upstream up = null; boolean responseStarted = false; String requestPath = null; List<String[]> h = null;
        try {
            client.setSoTimeout(300000);
            InputStream input = new BufferedInputStream(client.getInputStream());
            OutputStream browser = new BufferedOutputStream(client.getOutputStream(), 32768);
            String host = new URI(origin).getRawAuthority();
            for (boolean first = true; ; first = false) {
                responseStarted = false; requestPath = null; h = null;
                // Keep-alive: the page's next request comes on this same connection.
                if (!first) client.setSoTimeout(CLIENT_IDLE_MS);
                String request;
                try { request = line(input); } catch (SocketTimeoutException idle) { return; }
                if (request == null) return;
                client.setSoTimeout(300000);
                String[] parts = request.split(" ", 3);
                if (parts.length > 1) requestPath = parts[1];
                h = headers(input);
                boolean authenticated = Arrays.stream(header(h, "cookie").split(";"))
                    .anyMatch(v -> v.trim().equals(COOKIE + "=" + token));
                if (parts.length != 3 || !parts[1].startsWith("/") || parts[1].startsWith("//") ||
                    !host.equals(header(h, "host")) || !authenticated ||
                    (!header(h, "origin").isEmpty() && !origin.equals(header(h, "origin"))) ||
                    "cross-site".equals(header(h, "sec-fetch-site"))) {
                    responseStarted = true;
                    write(browser, "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); browser.flush(); return;
                }
                if ("GET".equals(parts[0]) && "/__native/info".equals(parts[1])) {
                    byte[] body = "{\"nativeGoogle\":true,\"googleLoopback\":47615}".getBytes(StandardCharsets.UTF_8); // GoogleLoopback.PORT
                    responseStarted = true;
                    write(browser, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n");
                    browser.write(body); browser.flush(); return;
                }
                boolean websocket = "websocket".equalsIgnoreCase(header(h, "upgrade"));
                boolean clientClose = has(header(h, "connection"), "close") || "HTTP/1.0".equals(parts[2].trim());
                boolean chunkedRequest = has(header(h, "transfer-encoding"), "chunked");
                String lengthHeader = header(h, "content-length");
                long requestLength = chunkedRequest || lengthHeader.isEmpty() ? 0 : Long.parseLong(lengthHeader.trim());
                if (requestLength < 0) throw new IOException("Bad Content-Length");
                boolean hasBody = chunkedRequest || requestLength > 0;

                StringBuilder head = new StringBuilder(request).append("\r\nHost: ").append(target.getRawAuthority()).append("\r\n");
                for (String[] pair : h) {
                    String name = pair[0], value = pair[1];
                    if (name.equals("host") || name.equals("forwarded") || name.startsWith("x-forwarded-") ||
                        name.startsWith("proxy-") || (!websocket && (name.equals("connection") || name.equals("keep-alive")))) continue;
                    if (name.equals("cookie")) {
                        StringJoiner cookies = new StringJoiner("; ");
                        for (String cookie : value.split(";")) if (!cookie.trim().startsWith(COOKIE + "=")) cookies.add(cookie.trim());
                        value = cookies.toString();
                    }
                    if (name.equals("origin") && value.equals(origin)) value = target.toString();
                    if (name.equals("referer") && value.startsWith(origin + "/")) value = target + value.substring(origin.length());
                    head.append(name).append(": ").append(value).append("\r\n");
                }
                if (!websocket && clientClose) head.append("Connection: close\r\n");
                head.append("\r\n");
                byte[] headBytes = head.toString().getBytes(StandardCharsets.ISO_8859_1);

                // A websocket gets a connection of its own; a kept one gone stale is replaced.
                if (up != null && (websocket || System.currentTimeMillis() - up.idleSince > UPSTREAM_IDLE_MS)) { close(up); up = null; }
                String status = null;
                for (int attempt = 0; ; attempt++) {
                    boolean reused = up != null;
                    if (up == null) up = openUpstream();
                    try {
                        up.out.write(headBytes); up.out.flush();
                        if (hasBody || websocket) break;
                        status = line(up.in);
                        if (status == null) throw new EOFException("Empty response");
                        break;
                    } catch (IOException e) {
                        close(up); up = null;
                        // The server closed a kept connection just as it was reused:
                        // a request without a body is safe to send again on a new one.
                        if (!reused || hasBody || attempt > 0) throw e;
                    }
                }
                client.setSoTimeout(0);
                final Upstream current = up;
                Future<?> upload = null;
                if (websocket) upload = workers.submit(() -> { try { pump(input, current.socket.getOutputStream()); } catch (IOException ignored) { } });
                else if (hasBody) {
                    final long length = requestLength;
                    upload = workers.submit(() -> {
                        if (chunkedRequest) copyChunked(input, current.out); else copyFixed(input, current.out, length, false);
                        return null;
                    });
                }
                boolean headRequest = "HEAD".equals(parts[0]);
                while (true) {
                    if (status == null) { status = line(up.in); if (status == null) throw new EOFException("Empty response"); }
                    List<String[]> rh = headers(up.in);
                    int code = statusCode(status);
                    boolean interim = code >= 100 && code < 200 && code != 101;
                    responseStarted = true;
                    write(browser, status + "\r\n");
                    for (String[] pair : rh) {
                        String name = pair[0], value = pair[1];
                        if (!websocket && (name.equals("connection") || name.equals("keep-alive") || name.equals("proxy-connection"))) continue;
                        if (name.equals("set-cookie")) {
                            if (value.startsWith(COOKIE + "=")) continue;
                            value = value.replaceAll("(?i);\\s*Domain=[^;]*", "");
                        }
                        if (name.equals("location")) {
                            URI u = target.resolve(value);
                            if (Objects.equals(u.getScheme(), target.getScheme()) && Objects.equals(u.getRawAuthority(), target.getRawAuthority()))
                                value = origin + (u.getRawPath().isEmpty() ? "/" : u.getRawPath()) + (u.getRawQuery() == null ? "" : "?" + u.getRawQuery()) + (u.getRawFragment() == null ? "" : "#" + u.getRawFragment());
                        }
                        if (name.equals("access-control-allow-origin") && value.equals(target.toString())) value = origin;
                        write(browser, name + ": " + value + "\r\n");
                    }
                    if (interim) { write(browser, "\r\n"); browser.flush(); status = null; continue; }
                    if (websocket) {
                        write(browser, "\r\n"); browser.flush();
                        pump(up.in, client.getOutputStream()); return;
                    }
                    boolean chunked = has(header(rh, "transfer-encoding"), "chunked");
                    String responseLength = header(rh, "content-length");
                    boolean noBody = headRequest || code == 204 || code == 304;
                    long length = noBody || chunked || responseLength.isEmpty() ? -1 : Long.parseLong(responseLength.trim());
                    boolean upstreamClose = has(header(rh, "connection"), "close") || status.startsWith("HTTP/1.0");
                    boolean keep = (noBody || chunked || length >= 0) && !upstreamClose && !clientClose;
                    write(browser, keep ? "Connection: keep-alive\r\n\r\n" : "Connection: close\r\n\r\n"); browser.flush();
                    if (chunked && !noBody) copyChunked(up.in, browser);
                    else if (length >= 0) copyFixed(up.in, browser, length, true);
                    else if (!noBody) { pump(up.in, browser); return; } // Ends when the server closes.
                    browser.flush();
                    if (upload != null) upload.get();
                    if (!keep) return;
                    up.idleSince = System.currentTimeMillis();
                    break;
                }
            }
        } catch (Exception ignored) {
            if (!responseStarted) try {
                // The page's own API calls parse JSON, so they are answered in JSON:
                // a plain sentence there surfaced as "Unexpected token '서'".
                boolean api = requestPath != null && requestPath.startsWith("/api/");
                boolean page = !api && h != null && ("document".equals(header(h, "sec-fetch-dest")) || header(h, "accept").contains("text/html"));
                String type = api ? "application/json" : page ? "text/html" : "text/plain";
                byte[] body = (api ? "{\"error\":\"" + OFFLINE + "\",\"code\":\"offline\"}" : page ? offlinePage() : OFFLINE).getBytes(StandardCharsets.UTF_8);
                OutputStream out = client.getOutputStream();
                write(out, "HTTP/1.1 502 Bad Gateway\r\nContent-Type: " + type + "; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n");
                out.write(body); out.flush();
            } catch (IOException alsoIgnored) { }
        } finally {
            try { client.close(); } catch (IOException ignored) { } sockets.remove(client);
            close(up);
        }
    }
    @Override public void close() {
        try { listener.close(); } catch (IOException ignored) { }
        for (Socket socket : sockets) try { socket.close(); } catch (IOException ignored) { }
        sockets.clear(); workers.shutdownNow();
    }
}
