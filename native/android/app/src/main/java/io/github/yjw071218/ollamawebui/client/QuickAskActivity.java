package io.github.yjw071218.ollamawebui.client;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.content.res.Configuration;
import android.view.*;

/**
 * A normal floating activity: no overlay permission and no main-task activation.
 *
 * The window can be moved: the page's header is a handle (quickask.js sends
 * the drag here as "quickAskMove"), and where it was left is where it opens
 * next time.
 */
public final class QuickAskActivity extends MainActivity {
    private SharedPreferences place;
    @Override protected boolean floatingAsk() { return true; }
    @Override public void onCreate(Bundle state) {
        place = getSharedPreferences("quickask-window", MODE_PRIVATE);
        // A screen read for an earlier press is not about this one.
        if (!getIntent().getBooleanExtra("fromBubble", false)) ScreenContextService.latest();
        super.onCreate(state);
        setFinishOnTouchOutside(true);
        resize();
        if (getIntent().getBooleanExtra("enableBubble", false)) minimizeToBubble();
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent != null && intent.getBooleanExtra("fromBubble", false)) pageEvent("ollama-screen-context");
    }
    private static final int OVERLAY_PERMISSION = 3302;
    public void minimizeToBubble() {
        if (!android.provider.Settings.canDrawOverlays(this)) {
            startActivityForResult(new android.content.Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                android.net.Uri.parse("package:" + getPackageName())), OVERLAY_PERMISSION);
            return;
        }
        startForegroundService(new android.content.Intent(this, QuickAskBubbleService.class));
        finish();
    }
    @Override protected void onActivityResult(int request, int result, android.content.Intent intent) {
        super.onActivityResult(request, result, intent);
        if (request == OVERLAY_PERMISSION && android.provider.Settings.canDrawOverlays(this)) minimizeToBubble();
    }

    private int width, height;
    private void resize() {
        android.util.DisplayMetrics metrics = getResources().getDisplayMetrics();
        width = Math.min((int)(400 * metrics.density), (int)(metrics.widthPixels * .94));
        height = Math.min((int)(520 * metrics.density), (int)(metrics.heightPixels * .72));
        getWindow().setLayout(width, height);
        getWindow().setGravity(Gravity.TOP | Gravity.LEFT);
        WindowManager.LayoutParams lp = getWindow().getAttributes();
        String key = metrics.widthPixels > metrics.heightPixels ? "land" : "port";
        int defaultX = (metrics.widthPixels - width) / 2, defaultY = (metrics.heightPixels - height) / 2;
        lp.x = place.getInt(key + ":x", defaultX);
        lp.y = place.getInt(key + ":y", defaultY);
        clamp(lp, metrics);
        getWindow().setAttributes(lp);
        getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(android.graphics.Color.TRANSPARENT));
        getWindow().getDecorView().setPadding(0, 0, 0, 0);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    }
    private void clamp(WindowManager.LayoutParams lp, android.util.DisplayMetrics m) {
        int edge = (int) (8 * m.density);
        lp.x = Math.max(edge - width / 2, Math.min(m.widthPixels - width / 2 - edge, lp.x));
        lp.y = Math.max(edge, Math.min(m.heightPixels - (int) (72 * m.density), lp.y));
    }
    /** The header was dragged by (dx, dy) device pixels. */
    void moveBy(int dx, int dy, boolean end) {
        runOnUiThread(() -> {
            android.util.DisplayMetrics metrics = getResources().getDisplayMetrics();
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.x += dx; lp.y += dy;
            clamp(lp, metrics);
            getWindow().setAttributes(lp);
            if (end) {
                String key = metrics.widthPixels > metrics.heightPixels ? "land" : "port";
                place.edit().putInt(key + ":x", lp.x).putInt(key + ":y", lp.y).apply();
            }
        });
    }
    @Override public void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config); resize();
    }
    @Override public void onBackPressed() { finish(); }
}
