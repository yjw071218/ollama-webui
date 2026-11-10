package io.github.yjw071218.ollamawebui.client;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.TextUtils;
import android.util.Base64;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.util.List;
import java.util.Locale;

/**
 * What is on screen when the floating button is pressed, for the floating AI.
 *
 * Turned on by the user in Android's accessibility settings, and only read at
 * that moment -- the press of the button -- never in the background: no events
 * are listened to, nothing is kept beyond the latest snapshot, and the
 * snapshot is cleared as soon as the floating window has taken it.
 *
 * Gathered: the app in front (name, package), its window title, the address
 * when it is a browser, the visible text, and on Android 11+ a screenshot for
 * models that can see.
 */
public final class ScreenContextService extends AccessibilityService {
    private static volatile ScreenContextService instance;
    private static volatile JSONObject latest;
    private static final int TEXT_MAX = 8000;

    static boolean enabled(Context context) {
        if (instance != null) return true;
        String list = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (list == null) return false;
        String me = new ComponentName(context, ScreenContextService.class).flattenToString();
        for (String s : list.split(":")) if (s.equalsIgnoreCase(me)) return true;
        return false;
    }
    static boolean running() { return instance != null; }

    /** The latest snapshot, handed over once. */
    static JSONObject latest() { JSONObject value = latest; latest = null; return value; }

    /**
     * Read the screen now. `done` runs on the main thread once the text and
     * (where possible) the picture are in, or after a short wait regardless.
     */
    static void snapshot(Runnable done) {
        ScreenContextService service = instance;
        if (service == null) { latest = null; done.run(); return; }
        service.capture(done);
    }

    @Override protected void onServiceConnected() {
        instance = this;
        AccessibilityServiceInfo info = getServiceInfo();
        if (info != null) {
            info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
                | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
            setServiceInfo(info);
        }
    }
    @Override public void onAccessibilityEvent(AccessibilityEvent event) { }
    @Override public void onInterrupt() { }
    @Override public void onDestroy() { if (instance == this) instance = null; latest = null; super.onDestroy(); }
    @Override public boolean onUnbind(android.content.Intent intent) { if (instance == this) instance = null; return super.onUnbind(intent); }

    private void capture(Runnable done) {
        Handler main = new Handler(Looper.getMainLooper());
        JSONObject snap = new JSONObject();
        try { readWindow(snap); } catch (Exception ignored) { }
        latest = snap;
        if (Build.VERSION.SDK_INT < 30) { main.post(done); return; }
        final boolean[] finished = {false};
        Runnable finish = () -> { if (!finished[0]) { finished[0] = true; done.run(); } };
        main.postDelayed(finish, 1500);
        try {
            takeScreenshot(Display.DEFAULT_DISPLAY, getMainExecutor(), new TakeScreenshotCallback() {
                @Override public void onSuccess(ScreenshotResult result) {
                    try {
                        Bitmap hw = Bitmap.wrapHardwareBuffer(result.getHardwareBuffer(), result.getColorSpace());
                        if (hw != null) {
                            Bitmap soft = hw.copy(Bitmap.Config.ARGB_8888, false);
                            hw.recycle();
                            int w = soft.getWidth(), h = soft.getHeight();
                            float scale = Math.min(1f, 1280f / Math.max(w, h));
                            Bitmap small = scale < 1f ? Bitmap.createScaledBitmap(soft, Math.round(w * scale), Math.round(h * scale), true) : soft;
                            ByteArrayOutputStream out = new ByteArrayOutputStream();
                            small.compress(Bitmap.CompressFormat.JPEG, 72, out);
                            snap.put("image", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
                            if (small != soft) small.recycle();
                            soft.recycle();
                        }
                        result.getHardwareBuffer().close();
                    } catch (Exception ignored) { }
                    finish.run();
                }
                @Override public void onFailure(int code) { finish.run(); }
            });
        } catch (Exception e) { finish.run(); }
    }

    private void readWindow(JSONObject snap) throws Exception {
        AccessibilityNodeInfo root = null;
        String title = null;
        // The front application window that is not ours (the floating button is ours).
        List<AccessibilityWindowInfo> windows = getWindows();
        if (windows != null) {
            for (AccessibilityWindowInfo w : windows) {
                if (w.getType() != AccessibilityWindowInfo.TYPE_APPLICATION) continue;
                AccessibilityNodeInfo r = w.getRoot();
                if (r == null) continue;
                if (getPackageName().contentEquals(String.valueOf(r.getPackageName()))) continue;
                root = r;
                if (Build.VERSION.SDK_INT >= 24 && w.getTitle() != null) title = w.getTitle().toString();
                break;
            }
        }
        if (root == null) root = getRootInActiveWindow();
        if (root == null) return;
        String pkg = String.valueOf(root.getPackageName());
        if (pkg.equals(getPackageName())) return;
        snap.put("package", pkg);
        try {
            PackageManager pm = getPackageManager();
            snap.put("app", pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString());
        } catch (Exception ignored) { snap.put("app", pkg); }
        if (title != null) snap.put("title", title);
        String url = findUrl(root);
        if (url != null) snap.put("url", url);
        StringBuilder text = new StringBuilder();
        collect(root, text, 0);
        snap.put("text", text.toString().trim());
        snap.put("at", System.currentTimeMillis());
    }

    private static final String[] URL_IDS = {
        "url_bar", "url_field", "mozac_browser_toolbar_url_view", "location_bar_edit_text", "search_box_text",
        "url", "address_bar_edit_text", "omnibox", "location_bar", "sbrowser_url_bar", "edit_url"
    };

    private String findUrl(AccessibilityNodeInfo node) {
        if (node == null) return null;
        String id = node.getViewIdResourceName();
        if (id != null) {
            String tail = id.substring(id.indexOf('/') + 1).toLowerCase(Locale.ROOT);
            for (String known : URL_IDS) if (tail.equals(known)) {
                CharSequence t = node.getText();
                if (!TextUtils.isEmpty(t)) return t.toString();
            }
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            String found = findUrl(child);
            if (found != null) return found;
        }
        return null;
    }

    private void collect(AccessibilityNodeInfo node, StringBuilder out, int depth) {
        if (node == null || out.length() >= TEXT_MAX || depth > 60) return;
        if (!node.isVisibleToUser()) return;
        // Never read what someone is typing as a password.
        if (node.isPassword()) return;
        CharSequence t = node.getText();
        if (TextUtils.isEmpty(t)) t = node.getContentDescription();
        if (!TextUtils.isEmpty(t)) {
            String line = t.toString().replaceAll("\\s+", " ").trim();
            if (!line.isEmpty() && out.indexOf(line) < 0) {
                out.append(line).append('\n');
                if (out.length() > TEXT_MAX) out.setLength(TEXT_MAX);
            }
        }
        for (int i = 0; i < node.getChildCount(); i++) collect(node.getChild(i), out, depth + 1);
    }
}
