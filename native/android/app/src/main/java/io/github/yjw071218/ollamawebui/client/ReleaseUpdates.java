package io.github.yjw071218.ollamawebui.client;

import org.json.*;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.regex.*;

/** Public GitHub release metadata, and the verified download of the APK it lists. */
final class ReleaseUpdates {
    static final String REPO = "yjw071218/ollama-webui";

    static final class Update {
        String tag, version, notes, apkName, apkUrl, sumsUrl, pageUrl;
        long apkSize;
    }
    interface Progress {
        void on(long received, long total, double bytesPerSecond);
        boolean cancelled();
    }

    static boolean newer(String candidate, String current) {
        String a = candidate.replaceFirst("^native-v", "");
        if (!a.matches("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)") ||
            !current.matches("[0-9]+\\.[0-9]+\\.[0-9]+")) return false;
        String[] x = a.split("\\."), y = current.split("\\.");
        try {
            for (int i = 0; i < 3; i++) {
                long left = Long.parseLong(x[i]), right = Long.parseLong(y[i]);
                if (left != right) return left > right;
            }
        } catch (NumberFormatException ignored) { }
        return false;
    }

    /** The "## 이번 버전" section of a release body, or its start when there is none. */
    static String releaseNotes(String body) {
        String text = body == null ? "" : body.replace("\r\n", "\n");
        Matcher m = Pattern.compile("(?m)^##\\s*이번 버전[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|\\z)").matcher(text);
        String notes = (m.find() ? m.group(1) : text).trim();
        return notes.length() > 4000 ? notes.substring(0, 4000) + "…" : notes;
    }

    static Update check(String current) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL("https://api.github.com/repos/" + REPO + "/releases?per_page=100").openConnection();
        connection.setConnectTimeout(8000); connection.setReadTimeout(8000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("Accept", "application/vnd.github+json");
        connection.setRequestProperty("User-Agent", "OllamaWebUI-Client");
        try {
            if (connection.getResponseCode() != 200) throw new IOException("Update check failed");
            JSONArray releases = new JSONArray(readText(connection.getInputStream(), 2_000_000));
            Update best = null;
            for (int i = 0; i < releases.length(); i++) {
                JSONObject r = releases.getJSONObject(i);
                String tag = r.optString("tag_name");
                if (r.optBoolean("draft") || r.optBoolean("prerelease") || !tag.startsWith("native-v") ||
                    !newer(tag, best == null ? current : best.version)) continue;
                JSONArray assets = r.optJSONArray("assets");
                if (assets == null) continue;
                Update u = new Update();
                for (int j = 0; j < assets.length(); j++) {
                    JSONObject asset = assets.getJSONObject(j);
                    String name = asset.optString("name");
                    if (!"uploaded".equals(asset.optString("state"))) continue;
                    if (name.matches("OllamaWebUI-Client-[0-9.]+\\.apk")) {
                        u.apkName = name; u.apkSize = asset.optLong("size"); u.apkUrl = asset.optString("browser_download_url");
                    } else if ("SHA256SUMS.txt".equals(name)) u.sumsUrl = asset.optString("browser_download_url");
                }
                if (u.apkName == null) continue;
                u.tag = tag; u.version = tag.substring(8);
                u.notes = releaseNotes(r.optString("body"));
                u.pageUrl = "https://github.com/" + REPO + "/releases/tag/" + tag;
                best = u;
            }
            return best;
        } finally { connection.disconnect(); }
    }

    /* Release files live on github.com and are served from GitHub's own asset hosts. */
    static boolean trusted(URL u) {
        if (!"https".equals(u.getProtocol()) || u.getUserInfo() != null) return false;
        String host = u.getHost().toLowerCase(Locale.ROOT);
        return host.equals("github.com") || host.equals("objects.githubusercontent.com")
            || host.equals("release-assets.githubusercontent.com") || host.equals("github-releases.githubusercontent.com");
    }

    /** GET following at most five redirects, each to a trusted host. */
    static HttpURLConnection open(String start) throws IOException {
        URL url = new URL(start);
        for (int hop = 0; hop < 6; hop++) {
            if (!trusted(url)) throw new IOException("신뢰하지 않는 다운로드 주소입니다.");
            HttpURLConnection c = (HttpURLConnection) url.openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(15000); c.setReadTimeout(30000);
            c.setRequestProperty("User-Agent", "OllamaWebUI-Client");
            c.setRequestProperty("Accept", "application/octet-stream");
            int code = c.getResponseCode();
            if (code >= 300 && code < 400) {
                String next = c.getHeaderField("Location");
                c.disconnect();
                if (next == null) throw new IOException("다운로드 리다이렉트 오류");
                url = new URL(url, next);
                continue;
            }
            if (code != 200) { c.disconnect(); throw new IOException("다운로드 HTTP " + code); }
            return c;
        }
        throw new IOException("리다이렉트가 너무 많습니다.");
    }

    static String readText(InputStream in, int max) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (InputStream input = in) {
            byte[] buffer = new byte[8192]; int n;
            while ((n = input.read(buffer)) != -1) {
                if (bytes.size() + n > max) throw new IOException("응답이 너무 큽니다.");
                bytes.write(buffer, 0, n);
            }
        }
        return bytes.toString(StandardCharsets.UTF_8.name());
    }

    static String expectedHash(String sums, String name) {
        for (String line : sums.split("\\r?\\n")) {
            Matcher m = Pattern.compile("^([a-fA-F0-9]{64})\\s+\\*?(.+)$").matcher(line.trim());
            if (m.matches() && m.group(2).equals(name)) return m.group(1).toLowerCase(Locale.ROOT);
        }
        return null;
    }

    /**
     * Download the APK into `dir`, verified against the release's size and the
     * SHA-256 in its SHA256SUMS.txt. The file only gets its final name once both
     * match; anything else is deleted.
     */
    static File download(Update u, File dir, Progress progress) throws Exception {
        if (u.sumsUrl == null || u.apkUrl == null) throw new IOException("이 릴리스에는 검증 정보(SHA256SUMS)가 없습니다.");
        HttpURLConnection sumsConnection = open(u.sumsUrl);
        String sums;
        try { sums = readText(sumsConnection.getInputStream(), 64 * 1024); } finally { sumsConnection.disconnect(); }
        String hash = expectedHash(sums, u.apkName);
        if (hash == null) throw new IOException("검증 정보에 설치 파일이 없습니다.");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("저장 폴더를 만들 수 없습니다.");
        File part = new File(dir, u.apkName + ".part"), done = new File(dir, u.apkName);
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long received = 0, started = System.nanoTime(), lastReport = 0;
        HttpURLConnection c = open(u.apkUrl);
        boolean ok = false;
        try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(part)) {
            byte[] buffer = new byte[64 * 1024]; int n;
            while ((n = in.read(buffer)) != -1) {
                if (progress.cancelled()) throw new InterruptedIOException("취소했습니다.");
                received += n;
                if (u.apkSize > 0 && received > u.apkSize) throw new IOException("설치 파일 크기가 릴리스 정보와 다릅니다.");
                digest.update(buffer, 0, n);
                out.write(buffer, 0, n);
                long now = System.nanoTime();
                if (now - lastReport > 120_000_000L || received == u.apkSize) {
                    lastReport = now;
                    double seconds = Math.max(0.001, (now - started) / 1e9);
                    progress.on(received, u.apkSize, received / seconds);
                }
            }
            if (u.apkSize > 0 && received != u.apkSize) throw new IOException("다운로드가 완료되지 않았습니다.");
            StringBuilder hex = new StringBuilder();
            for (byte b : digest.digest()) hex.append(String.format(Locale.ROOT, "%02x", b));
            if (!hex.toString().equals(hash)) throw new IOException("설치 파일 검증(SHA-256)에 실패했습니다. 다시 시도하세요.");
            ok = true;
        } finally {
            c.disconnect();
            if (!ok) part.delete();
        }
        done.delete();
        if (!part.renameTo(done)) throw new IOException("설치 파일을 저장하지 못했습니다.");
        return done;
    }
}
