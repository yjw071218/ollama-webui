import io.github.yjw071218.ollamawebui.client.ReleaseUpdatesAccess;

/** Exercises the Android update logic on a plain JVM; prints PASS lines or exits 1. */
public class ReleaseUpdatesHarness {
    static int failed = 0;
    static void check(String name, boolean ok) { System.out.println((ok ? "PASS " : "FAIL ") + name); if (!ok) failed++; }
    public static void main(String[] args) throws Exception {
        check("newer version", ReleaseUpdatesAccess.newer("native-v1.0.10", "1.0.9"));
        check("not older or equal", !ReleaseUpdatesAccess.newer("native-v1.0.6", "1.0.6") && !ReleaseUpdatesAccess.newer("native-v1.0.5", "1.0.6"));
        check("rejects pre-release tags", !ReleaseUpdatesAccess.newer("native-v2.0.0-beta", "1.0.0"));
        String body = "## 이번 버전\n- 앱 안에서 업데이트\n- 진행률\n\n## 서버 연결형 Android / Windows 앱\n- 오래된 설명";
        check("notes are the current version's section", ReleaseUpdatesAccess.releaseNotes(body).equals("- 앱 안에서 업데이트\n- 진행률"));
        check("notes fall back to the body", ReleaseUpdatesAccess.releaseNotes("- a").equals("- a"));
        String sums = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  OllamaWebUI-Client-1.0.7.apk\n"
            + "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB  other.exe\n";
        check("checksum for the APK", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".equals(ReleaseUpdatesAccess.expectedHash(sums, "OllamaWebUI-Client-1.0.7.apk")));
        check("checksum is lower-cased", ReleaseUpdatesAccess.expectedHash(sums, "other.exe").startsWith("bbbb"));
        check("no checksum for an unlisted file", ReleaseUpdatesAccess.expectedHash(sums, "OllamaWebUI-Client-1.0.7") == null);
        check("GitHub HTTPS trusted", ReleaseUpdatesAccess.trusted("https://github.com/x") && ReleaseUpdatesAccess.trusted("https://objects.githubusercontent.com/y"));
        for (String bad : new String[]{"http://github.com/x", "https://github.com.evil.example/x", "https://user@github.com/x", "https://evil.example/x"})
            check("untrusted " + bad, !ReleaseUpdatesAccess.trusted(bad));
        try { ReleaseUpdatesAccess.open("http://127.0.0.1:9/x"); check("open refuses untrusted host", false); }
        catch (java.io.IOException e) { check("open refuses untrusted host", e.getMessage().contains("신뢰하지 않는")); }
        if (failed > 0) System.exit(1);
    }
}
