package io.github.yjw071218.ollamawebui.client;

import org.json.*;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;

final class ReleaseUpdates {
    static final String REPO = "yjw071218/ollama-webui";
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
    static String check(String current) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL("https://api.github.com/repos/" + REPO + "/releases?per_page=100").openConnection();
        connection.setConnectTimeout(8000); connection.setReadTimeout(8000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("Accept", "application/vnd.github+json");
        connection.setRequestProperty("User-Agent", "OllamaWebUI-Client");
        try {
            if (connection.getResponseCode() != 200) throw new IOException("Update check failed");
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (InputStream in = connection.getInputStream()) {
                byte[] buffer = new byte[8192]; int n;
                while ((n = in.read(buffer)) != -1) {
                    if (bytes.size() + n > 2000000) throw new IOException("Release response too large");
                    bytes.write(buffer, 0, n);
                }
            }
            JSONArray releases = new JSONArray(bytes.toString(StandardCharsets.UTF_8.name()));
            String best = null;
            for (int i = 0; i < releases.length(); i++) {
                JSONObject r = releases.getJSONObject(i);
                String tag = r.optString("tag_name");
                if (r.optBoolean("draft") || r.optBoolean("prerelease") || !tag.startsWith("native-v") ||
                    !newer(tag, best == null ? current : best.substring(8))) continue;
                JSONArray assets = r.optJSONArray("assets");
                if (assets == null) continue;
                for (int j = 0; j < assets.length(); j++) {
                    JSONObject asset = assets.getJSONObject(j);
                    String name = asset.optString("name");
                    if ("uploaded".equals(asset.optString("state")) && name.startsWith("OllamaWebUI-Client-") && name.endsWith(".apk")) { best = tag; break; }
                }
            }
            return best;
        } finally { connection.disconnect(); }
    }
}
