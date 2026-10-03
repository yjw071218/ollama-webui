import io.github.yjw071218.ollamawebui.client.GoogleLoopbackAccess;
import java.net.URLDecoder;

/** The Android Google loopback pieces that run without Android; prints PASS lines or exits 1. Arg 0/1: the desktop page and script. */
public class GoogleLoopbackHarness {
    static int failed = 0;
    static void check(String name, boolean ok) { System.out.println((ok ? "PASS " : "FAIL ") + name); if (!ok) failed++; }
    public static void main(String[] args) throws Exception {
        String id = "a".repeat(64), client = "123456789012-abcdefghijklmnop0123456789abcdef.apps.googleusercontent.com";
        String[] parsed = GoogleLoopbackAccess.parse("google:" + id + ":" + client);
        check("parses handoff", parsed != null && parsed[0].equals(id) && parsed[1].equals(client));
        for (String bad : new String[]{id, "google:" + id, "google:zz:" + client, "google:" + id + ":evil.example", "kakao:" + id, null})
            check("rejects " + bad, GoogleLoopbackAccess.parse(bad) == null);
        String url = GoogleLoopbackAccess.authorizeUrl(id, client);
        check("Google authorize endpoint", url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?"));
        check("loopback redirect", URLDecoder.decode(url, "UTF-8").contains("redirect_uri=http://127.0.0.1:47615/api/auth/native/google/callback&"));
        check("nonce and state are the handoff", url.contains("&nonce=" + id + "&state=" + id + "&"));
        check("id token in fragment", url.contains("response_type=id_token&response_mode=fragment"));
        String page = new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(args[0].substring(5))), "UTF-8");
        String script = new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(args[1].substring(5))), "UTF-8");
        check("same page as the desktop app", GoogleLoopbackAccess.page().equals(page));
        check("same script as the desktop app", GoogleLoopbackAccess.script().equals(script));
        if (failed > 0) System.exit(1);
    }
}
