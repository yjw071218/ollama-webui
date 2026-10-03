package io.github.yjw071218.ollamawebui.client;

/** Test-only bridge to the package-private GoogleLoopback (compiled only by native/tests). */
public final class GoogleLoopbackAccess {
    public static String[] parse(String fragment) { return GoogleLoopback.parse(fragment); }
    public static String authorizeUrl(String id, String clientId) { return GoogleLoopback.authorizeUrl(id, clientId); }
    public static String redirect() { return GoogleLoopback.REDIRECT; }
    public static String script() { return GoogleLoopback.SCRIPT; }
    public static String page() { return GoogleLoopback.PAGE; }
}
