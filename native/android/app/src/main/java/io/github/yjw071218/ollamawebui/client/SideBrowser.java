package io.github.yjw071218.ollamawebui.client;

import android.animation.ValueAnimator;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.animation.DecelerateInterpolator;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/**
 * Links from the page open here: a browser docked on the left of the app,
 * not a full-screen Custom Tab over it. On a wide screen (tablet, landscape,
 * unfolded) it sits beside the chat and the chat shrinks to make room -- the
 * edge between them can be dragged. On a phone it slides in over the left of
 * the app and leaves a strip of the chat showing; tapping that strip closes it.
 */
final class SideBrowser {
    interface Host { void onSideBrowserChanged(boolean open); }

    private final Activity activity;
    private final FrameLayout stage;
    private final View main;
    private final Host host;
    private LinearLayout panel;
    private View scrim, handle;
    private WebView web;
    private TextView title;
    private ProgressBar progress;
    private TextView backButton;
    private boolean open;
    private float share;

    SideBrowser(Activity activity, FrameLayout stage, View main, Host host) {
        this.activity = activity; this.stage = stage; this.main = main; this.host = host;
        share = activity.getSharedPreferences("connection", Activity.MODE_PRIVATE).getFloat("sideShare", 0.46f);
    }

    private int dp(float n) { return Math.round(activity.getResources().getDisplayMetrics().density * n); }
    private boolean night() {
        return (activity.getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
            == android.content.res.Configuration.UI_MODE_NIGHT_YES;
    }
    private int surface() { return night() ? Color.rgb(31, 30, 27) : Color.rgb(250, 249, 245); }
    private int bar() { return night() ? Color.rgb(38, 36, 32) : Color.rgb(240, 238, 230); }
    private int ink() { return night() ? Color.rgb(238, 233, 224) : Color.rgb(36, 33, 29); }
    private int muted() { return night() ? Color.rgb(160, 154, 143) : Color.rgb(120, 113, 102); }
    private static final int ACCENT = Color.rgb(217, 119, 87);

    /** Wide enough that the chat stays usable beside the browser. */
    private boolean wide() {
        float w = stage.getWidth() > 0 ? stage.getWidth() : activity.getResources().getDisplayMetrics().widthPixels;
        return w / activity.getResources().getDisplayMetrics().density >= 600;
    }

    boolean isOpen() { return open; }

    void open(Uri uri) {
        if (panel == null) build();
        web.loadUrl(uri.toString());
        title.setText(uri.getHost() == null ? uri.toString() : uri.getHost());
        if (open) return;
        open = true;
        layout(true);
        host.onSideBrowserChanged(true);
    }

    void close() {
        if (!open) return;
        open = false;
        int width = panel.getWidth();
        panel.animate().translationX(-width).setDuration(180).setInterpolator(new DecelerateInterpolator()).withEndAction(() -> {
            if (open) return;
            panel.setVisibility(View.GONE); scrim.setVisibility(View.GONE); handle.setVisibility(View.GONE);
            if (web != null) { web.stopLoading(); web.loadUrl("about:blank"); web.clearHistory(); }
        }).start();
        scrim.animate().alpha(0).setDuration(180).start();
        animateMainMargin(0);
        host.onSideBrowserChanged(false);
    }

    /** Back: the panel's own history first, then the panel itself. */
    boolean back() {
        if (!open) return false;
        if (web != null && web.canGoBack()) web.goBack(); else close();
        return true;
    }

    /** Rotation, folding, split-screen: work the widths out again. */
    void relayout() { if (open) stage.post(() -> layout(false)); }

    void destroy() {
        if (web != null) { web.stopLoading(); web.destroy(); web = null; }
    }

    private void layout(boolean animate) {
        int total = stage.getWidth() > 0 ? stage.getWidth() : activity.getResources().getDisplayMetrics().widthPixels;
        boolean wide = wide();
        int width = wide ? Math.round(total * share) : Math.round(total * 0.86f);
        width = Math.max(dp(260), Math.min(width, total - (wide ? dp(320) : dp(44))));
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) panel.getLayoutParams();
        lp.width = width; panel.setLayoutParams(lp);
        panel.setVisibility(View.VISIBLE);
        scrim.setVisibility(wide ? View.GONE : View.VISIBLE);
        handle.setVisibility(wide ? View.VISIBLE : View.GONE);
        FrameLayout.LayoutParams hp = (FrameLayout.LayoutParams) handle.getLayoutParams();
        hp.leftMargin = width - dp(12); handle.setLayoutParams(hp);
        if (animate) {
            panel.setTranslationX(-width);
            panel.animate().translationX(0).setDuration(220).setInterpolator(new DecelerateInterpolator()).start();
            if (!wide) { scrim.setAlpha(0); scrim.animate().alpha(1).setDuration(220).start(); }
        } else panel.setTranslationX(0);
        if (wide) { if (animate) animateMainMargin(width); else setMainMargin(width); }
        else setMainMargin(0);
    }

    private void setMainMargin(int left) {
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) main.getLayoutParams();
        lp.leftMargin = left; main.setLayoutParams(lp);
    }
    private void animateMainMargin(int to) {
        int from = ((FrameLayout.LayoutParams) main.getLayoutParams()).leftMargin;
        if (from == to) return;
        ValueAnimator a = ValueAnimator.ofInt(from, to).setDuration(200);
        a.setInterpolator(new DecelerateInterpolator());
        a.addUpdateListener(v -> setMainMargin((int) v.getAnimatedValue()));
        a.start();
    }

    private TextView tool(String glyph, String label, View.OnClickListener click) {
        TextView b = new TextView(activity);
        b.setText(glyph); b.setTextSize(18); b.setTextColor(ink()); b.setGravity(Gravity.CENTER);
        b.setContentDescription(label); b.setOnClickListener(click);
        GradientDrawable bg = new GradientDrawable(); bg.setCornerRadius(dp(10)); bg.setColor(Color.TRANSPARENT);
        b.setBackground(new android.graphics.drawable.RippleDrawable(
            android.content.res.ColorStateList.valueOf(night() ? 0x33FFFFFF : 0x22000000), bg, null));
        b.setLayoutParams(new LinearLayout.LayoutParams(dp(40), dp(40)));
        if (android.os.Build.VERSION.SDK_INT >= 26) b.setTooltipText(label);
        return b;
    }

    private void build() {
        scrim = new View(activity);
        scrim.setBackgroundColor(0x66000000);
        scrim.setOnClickListener(v -> close());
        scrim.setVisibility(View.GONE);
        stage.addView(scrim, new FrameLayout.LayoutParams(-1, -1));

        panel = new LinearLayout(activity);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setBackgroundColor(surface());
        panel.setElevation(dp(12));
        panel.setClickable(true);
        panel.setVisibility(View.GONE);
        stage.addView(panel, new FrameLayout.LayoutParams(dp(360), -1, Gravity.START));

        LinearLayout toolbar = new LinearLayout(activity);
        toolbar.setOrientation(LinearLayout.HORIZONTAL);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(6), dp(4), dp(6), dp(4));
        toolbar.setBackgroundColor(bar());
        backButton = tool("‹", L.t("뒤로", "Back"), v -> { if (web.canGoBack()) web.goBack(); });
        backButton.setTextSize(24);
        toolbar.addView(backButton);
        toolbar.addView(tool("↻", L.t("새로고침", "Reload"), v -> web.reload()));
        title = new TextView(activity);
        title.setTextColor(ink()); title.setTextSize(13); title.setSingleLine(true);
        title.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
        title.setPadding(dp(6), 0, dp(6), 0);
        toolbar.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
        toolbar.addView(tool("↗", L.t("브라우저에서 열기", "Open in browser"), v -> external(Uri.parse(web.getUrl()))));
        toolbar.addView(tool("✕", L.t("닫기", "Close"), v -> close()));
        panel.addView(toolbar, new LinearLayout.LayoutParams(-1, -2));

        progress = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100); progress.setIndeterminate(false);
        progress.setProgressTintList(android.content.res.ColorStateList.valueOf(ACCENT));
        progress.setProgressBackgroundTintList(android.content.res.ColorStateList.valueOf(Color.TRANSPARENT));
        panel.addView(progress, new LinearLayout.LayoutParams(-1, dp(3)));

        web = new WebView(activity);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false); s.setAllowContentAccess(false);
        s.setSupportZoom(true); s.setBuiltInZoomControls(true); s.setDisplayZoomControls(false);
        s.setUseWideViewPort(true); s.setLoadWithOverviewMode(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.setBackgroundColor(Color.WHITE);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme();
                if (scheme.equals("http") || scheme.equals("https")) {
                    // A WebView draws no PDF: hand those to a reader app.
                    String path = uri.getPath() == null ? "" : uri.getPath().toLowerCase(java.util.Locale.ROOT);
                    if (request.isForMainFrame() && path.endsWith(".pdf")) { external(uri); return true; }
                    return false;
                }
                if (scheme.equals("intent")) {
                    try {
                        Intent intent = Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME);
                        String fallback = intent.getStringExtra("browser_fallback_url");
                        if (fallback != null) { view.loadUrl(fallback); return true; }
                    } catch (Exception ignored) { }
                    return true;
                }
                external(uri);
                return true;
            }
            @Override public void onPageFinished(WebView view, String url) { sync(); }
            @Override public void doUpdateVisitedHistory(WebView view, String url, boolean reload) { sync(); }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int p) {
                progress.setProgress(p); progress.setVisibility(p >= 100 ? View.INVISIBLE : View.VISIBLE);
            }
            @Override public void onReceivedTitle(WebView view, String t) { sync(); }
        });
        web.setDownloadListener((url, agent, disposition, type, length) -> external(Uri.parse(url)));
        panel.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));

        // The edge between browser and chat, dragged to share the width (wide screens only).
        handle = new View(activity);
        GradientDrawable grip = new GradientDrawable(); grip.setCornerRadius(dp(3)); grip.setColor(night() ? 0x55FFFFFF : 0x44000000);
        handle.setBackground(new android.graphics.drawable.InsetDrawable(grip, dp(10), 0, dp(10), 0));
        handle.setElevation(dp(13));
        handle.setContentDescription(L.t("패널 너비 조절", "Resize panel"));
        FrameLayout.LayoutParams hp = new FrameLayout.LayoutParams(dp(24), dp(56), Gravity.CENTER_VERTICAL);
        handle.setVisibility(View.GONE);
        stage.addView(handle, hp);
        handle.setOnTouchListener(new View.OnTouchListener() {
            float startX; int startWidth;
            @Override public boolean onTouch(View v, MotionEvent e) {
                int total = stage.getWidth();
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN: startX = e.getRawX(); startWidth = panel.getWidth(); return true;
                    case MotionEvent.ACTION_MOVE: {
                        int w = Math.max(dp(260), Math.min(total - dp(320), startWidth + Math.round(e.getRawX() - startX)));
                        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) panel.getLayoutParams();
                        lp.width = w; panel.setLayoutParams(lp);
                        FrameLayout.LayoutParams h = (FrameLayout.LayoutParams) handle.getLayoutParams();
                        h.leftMargin = w - dp(12); handle.setLayoutParams(h);
                        setMainMargin(w);
                        return true;
                    }
                    case MotionEvent.ACTION_UP: case MotionEvent.ACTION_CANCEL:
                        if (total > 0) {
                            share = panel.getWidth() / (float) total;
                            activity.getSharedPreferences("connection", Activity.MODE_PRIVATE).edit().putFloat("sideShare", share).apply();
                        }
                        return true;
                }
                return false;
            }
        });
    }

    private void sync() {
        if (web == null) return;
        String t = web.getTitle();
        String url = web.getUrl();
        if (t == null || t.isEmpty() || (url != null && t.equals(url))) {
            Uri u = url == null ? null : Uri.parse(url);
            t = u == null || u.getHost() == null ? (url == null ? "" : url) : u.getHost();
        }
        title.setText(t);
        boolean can = web.canGoBack();
        backButton.setEnabled(can); backButton.setTextColor(can ? ink() : muted());
    }

    private void external(Uri uri) {
        if (uri == null) return;
        try { activity.startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); }
        catch (ActivityNotFoundException e) {
            android.widget.Toast.makeText(activity, L.t("열 수 있는 앱이 없습니다.", "There is no app to open it."), android.widget.Toast.LENGTH_SHORT).show();
        }
    }
}
