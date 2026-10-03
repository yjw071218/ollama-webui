package io.github.yjw071218.ollamawebui.client;

/** Test-only bridge to the package-private ReleaseUpdates (compiled only by native/tests). */
public final class ReleaseUpdatesAccess {
    public static boolean newer(String a, String b) { return ReleaseUpdates.newer(a, b); }
    public static String releaseNotes(String body) { return ReleaseUpdates.releaseNotes(body); }
    public static String expectedHash(String sums, String name) { return ReleaseUpdates.expectedHash(sums, name); }
    public static boolean trusted(String url) throws Exception { return ReleaseUpdates.trusted(new java.net.URL(url)); }
    public static void open(String url) throws java.io.IOException { ReleaseUpdates.open(url).disconnect(); }
}
