package io.github.yjw071218.ollamawebui.client;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.*;
import java.util.concurrent.*;
import javax.net.ssl.*;

/** A private, authenticated loopback gateway. Bodies (including SSE and WebSockets)
 * are streamed unchanged; no buffering, decompression, or TLS verification bypass. */
public final class LoopbackProxy implements Closeable {
    private final URI target;
    private final ServerSocket listener;
    private final ExecutorService workers = new ThreadPoolExecutor(0, 64, 30, TimeUnit.SECONDS, new SynchronousQueue<>());
    private final Set<Socket> sockets = ConcurrentHashMap.newKeySet();
    public final String origin, token;
    public static final String COOKIE = "__ollama_native_gate";
    public static String normalize(String raw) throws Exception {
        URI u = new URI(raw.trim());
        if (!("http".equals(u.getScheme()) || "https".equals(u.getScheme())) || u.getHost() == null ||
            u.getUserInfo() != null || u.getRawQuery() != null || u.getRawFragment() != null ||
            !(u.getRawPath() == null || u.getRawPath().isEmpty() || "/".equals(u.getRawPath())) ||
            u.getPort() < -1 || u.getPort() == 0 || u.getPort() > 65535)
            throw new IllegalArgumentException("http:// 또는 https:// 서버 기본 주소를 입력하세요. 경로·로그인 정보는 넣지 마세요.");
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
    private static void write(OutputStream out, String s) throws IOException { out.write(s.getBytes(StandardCharsets.ISO_8859_1)); }
    private static void pump(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[32768]; int n;
        while ((n = in.read(buffer)) != -1) { out.write(buffer, 0, n); out.flush(); }
    }
    private void serve(Socket client) {
        Socket upstream = null; boolean responseStarted = false;
        try {
            client.setSoTimeout(300000);
            InputStream input = new BufferedInputStream(client.getInputStream());
            String request = line(input);
            if (request == null) return;
            String[] parts = request.split(" ", 3);
            List<String[]> h = headers(input);
            boolean authenticated = Arrays.stream(header(h, "cookie").split(";"))
                .anyMatch(v -> v.trim().equals(COOKIE + "=" + token));
            String host = new URI(origin).getRawAuthority();
            if (parts.length != 3 || !parts[1].startsWith("/") || parts[1].startsWith("//") ||
                !host.equals(header(h, "host")) || !authenticated ||
                (!header(h, "origin").isEmpty() && !origin.equals(header(h, "origin"))) ||
                "cross-site".equals(header(h, "sec-fetch-site"))) {
                write(client.getOutputStream(), "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); return;
            }
            if ("GET".equals(parts[0]) && "/__native/info".equals(parts[1])) {
                byte[] body = "{\"nativeGoogle\":true}".getBytes(StandardCharsets.UTF_8);
                write(client.getOutputStream(), "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n");
                client.getOutputStream().write(body); return;
            }
            boolean secure = "https".equals(target.getScheme());
            int port = target.getPort() < 0 ? (secure ? 443 : 80) : target.getPort();
            Socket raw = new Socket(); sockets.add(raw); upstream = raw;
            raw.connect(new InetSocketAddress(target.getHost(), port), 15000);
            if (secure) {
                SSLSocket ssl = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(raw, target.getHost(), port, true);
                SSLParameters parameters = ssl.getSSLParameters(); parameters.setEndpointIdentificationAlgorithm("HTTPS"); ssl.setSSLParameters(parameters);
                upstream = ssl; sockets.remove(raw); sockets.add(ssl);
                ssl.setSoTimeout(300000); ssl.startHandshake();
            }
            upstream.setSoTimeout(0); // No generation/stream idle deadline.
            client.setSoTimeout(0);
            boolean websocket = "websocket".equalsIgnoreCase(header(h, "upgrade"));
            OutputStream output = upstream.getOutputStream();
            write(output, request + "\r\nHost: " + target.getRawAuthority() + "\r\n");
            for (String[] pair : h) {
                String name = pair[0], value = pair[1];
                if (name.equals("host") || name.equals("forwarded") || name.startsWith("x-forwarded-") ||
                    name.startsWith("proxy-") || (!websocket && name.equals("connection"))) continue;
                if (name.equals("cookie")) {
                    StringJoiner cookies = new StringJoiner("; ");
                    for (String cookie : value.split(";")) if (!cookie.trim().startsWith(COOKIE + "=")) cookies.add(cookie.trim());
                    value = cookies.toString();
                }
                if (name.equals("origin") && value.equals(origin)) value = target.toString();
                if (name.equals("referer") && value.startsWith(origin + "/")) value = target + value.substring(origin.length());
                write(output, name + ": " + value + "\r\n");
            }
            if (!websocket) write(output, "Connection: close\r\n");
            write(output, "\r\n"); output.flush();
            Socket finalUpstream = upstream;
            workers.execute(() -> {
                try { pump(input, finalUpstream.getOutputStream()); }
                catch (IOException ignored) { }
            });
            InputStream response = new BufferedInputStream(upstream.getInputStream());
            String status;
            do {
                status = line(response);
                if (status == null) throw new IOException("Empty response");
                List<String[]> rh = headers(response);
                OutputStream browser = client.getOutputStream();
                responseStarted = true;
                write(browser, status + "\r\n");
                for (String[] pair : rh) {
                    String name = pair[0], value = pair[1];
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
                write(browser, "\r\n"); browser.flush();
            } while (status.matches("HTTP/1\\.[01] 1(?!01).*"));
            pump(response, client.getOutputStream());
        } catch (Exception ignored) {
            if (!responseStarted) try {
                byte[] body = "서버 연결에 실패했습니다. 주소와 서버 실행 상태를 확인하고 상단 새로고침을 누르세요.".getBytes(StandardCharsets.UTF_8);
                write(client.getOutputStream(), "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n");
                client.getOutputStream().write(body);
            } catch (IOException alsoIgnored) { }
        } finally {
            try { client.close(); } catch (IOException ignored) { } sockets.remove(client);
            if (upstream != null) { try { upstream.close(); } catch (IOException ignored) { } sockets.remove(upstream); }
        }
    }
    @Override public void close() {
        try { listener.close(); } catch (IOException ignored) { }
        for (Socket socket : sockets) try { socket.close(); } catch (IOException ignored) { }
        sockets.clear(); workers.shutdownNow();
    }
}
