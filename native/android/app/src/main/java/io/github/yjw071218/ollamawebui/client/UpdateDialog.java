package io.github.yjw071218.ollamawebui.client;

import android.app.Activity;
import android.app.Dialog;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.*;
import androidx.core.content.FileProvider;
import java.io.File;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.ExecutorService;

/**
 * The in-app update screen: what is new, a download with progress, and the
 * hand-over to Android's installer. Android always asks the user to confirm an
 * install; that last tap cannot be skipped by any app.
 */
final class UpdateDialog {
    static final int INSTALL_PERMISSION = 47;
    private static final int BG = Color.rgb(41, 38, 32), CARD = Color.rgb(33, 31, 28), BORDER = Color.rgb(61, 57, 50),
        TEXT = Color.rgb(238, 233, 224), MUTED = Color.rgb(185, 173, 155), PRIMARY = Color.rgb(218, 197, 165),
        ON_PRIMARY = Color.rgb(40, 35, 29), SECONDARY = Color.rgb(59, 53, 45), DANGER = Color.rgb(255, 207, 200);

    private final Activity activity;
    private final ExecutorService io;
    private final ReleaseUpdates.Update update;
    private final String current;
    private Dialog dialog;
    private TextView badge, title, subtitle, percent, detail, error;
    private LinearLayout notesBox, progressBox, buttons;
    private ProgressBar bar;
    private volatile boolean cancelled;
    private File apk;
    private boolean awaitingPermission;

    UpdateDialog(Activity activity, ExecutorService io, ReleaseUpdates.Update update, String current) {
        this.activity = activity; this.io = io; this.update = update; this.current = current;
    }
    private int dp(int n) { return (int) (activity.getResources().getDisplayMetrics().density * n); }
    private GradientDrawable round(int color, int radius, int stroke) {
        GradientDrawable d = new GradientDrawable(); d.setColor(color); d.setCornerRadius(dp(radius));
        if (stroke != 0) d.setStroke(dp(1), stroke);
        return d;
    }
    private TextView text(int size, int color, boolean bold) {
        TextView t = new TextView(activity); t.setTextSize(size); t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return t;
    }
    private static String size(double bytes) {
        if (!(bytes > 0)) return "0 MB";
        return bytes >= 1e9 ? String.format(Locale.ROOT, "%.2f GB", bytes / 1e9) : String.format(Locale.ROOT, "%.1f MB", bytes / 1e6);
    }

    void show() {
        LinearLayout root = new LinearLayout(activity); root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(22), dp(22), dp(22), dp(16)); root.setBackground(round(BG, 18, Color.rgb(81, 74, 64)));

        LinearLayout hero = new LinearLayout(activity); hero.setGravity(Gravity.CENTER_VERTICAL);
        badge = text(24, ON_PRIMARY, true); badge.setGravity(Gravity.CENTER);
        hero.addView(badge, new LinearLayout.LayoutParams(dp(50), dp(50)));
        LinearLayout heading = new LinearLayout(activity); heading.setOrientation(LinearLayout.VERTICAL);
        heading.setPadding(dp(14), 0, 0, 0);
        title = text(19, TEXT, true); subtitle = text(13, MUTED, false);
        heading.addView(title); heading.addView(subtitle);
        hero.addView(heading, new LinearLayout.LayoutParams(0, -2, 1));
        root.addView(hero);

        notesBox = new LinearLayout(activity); notesBox.setOrientation(LinearLayout.VERTICAL);
        notesBox.setPadding(dp(14), dp(12), dp(14), dp(12)); notesBox.setBackground(round(CARD, 12, BORDER));
        TextView notesTitle = text(12, MUTED, true); notesTitle.setText("이번 버전 변경 사항"); notesBox.addView(notesTitle);
        TextView notes = text(14, TEXT, false); notes.setLineSpacing(0, 1.25f); notes.setPadding(0, dp(6), 0, 0);
        notes.setText(formatNotes(update.notes));
        /* Capped, so long notes scroll inside the box instead of pushing the
           buttons below the bottom of the screen. Worked out on every measure
           so a rotation gets the height of the new orientation. */
        ScrollView scroll = new ScrollView(activity) {
            @Override protected void onMeasure(int widthSpec, int heightSpec) {
                int screen = activity.getResources().getDisplayMetrics().heightPixels;
                int max = Math.max(dp(72), Math.min(screen / 2, screen - dp(320)));
                int mode = MeasureSpec.getMode(heightSpec), size = MeasureSpec.getSize(heightSpec);
                super.onMeasure(widthSpec, MeasureSpec.makeMeasureSpec(mode == MeasureSpec.UNSPECIFIED ? max : Math.min(size, max), MeasureSpec.AT_MOST));
            }
        };
        scroll.setScrollBarStyle(android.view.View.SCROLLBARS_OUTSIDE_OVERLAY);
        scroll.addView(notes);
        notesBox.addView(scroll, new LinearLayout.LayoutParams(-1, -2));
        LinearLayout.LayoutParams notesParams = new LinearLayout.LayoutParams(-1, -2); notesParams.topMargin = dp(16);
        root.addView(notesBox, notesParams);
        if (update.notes == null || update.notes.isEmpty()) notesBox.setVisibility(android.view.View.GONE);

        progressBox = new LinearLayout(activity); progressBox.setOrientation(LinearLayout.VERTICAL);
        bar = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100); bar.setProgressTintList(android.content.res.ColorStateList.valueOf(PRIMARY));
        bar.setProgressBackgroundTintList(android.content.res.ColorStateList.valueOf(SECONDARY));
        progressBox.addView(bar, new LinearLayout.LayoutParams(-1, dp(10)));
        LinearLayout line = new LinearLayout(activity); line.setPadding(0, dp(6), 0, 0);
        percent = text(13, TEXT, true); detail = text(12, MUTED, false); detail.setGravity(Gravity.END);
        line.addView(percent); line.addView(detail, new LinearLayout.LayoutParams(0, -2, 1));
        progressBox.addView(line);
        LinearLayout.LayoutParams progressParams = new LinearLayout.LayoutParams(-1, -2); progressParams.topMargin = dp(16);
        root.addView(progressBox, progressParams);

        error = text(13, DANGER, false); error.setPadding(dp(12), dp(10), dp(12), dp(10));
        error.setBackground(round(Color.rgb(61, 37, 34), 10, 0));
        LinearLayout.LayoutParams errorParams = new LinearLayout.LayoutParams(-1, -2); errorParams.topMargin = dp(12);
        root.addView(error, errorParams);

        buttons = new LinearLayout(activity); buttons.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams buttonParams = new LinearLayout.LayoutParams(-1, -2); buttonParams.topMargin = dp(18);
        root.addView(buttons, buttonParams);

        dialog = new Dialog(activity);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        dialog.setContentView(root);
        dialog.setCancelable(false);
        Window w = dialog.getWindow();
        if (w != null) {
            w.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            w.setLayout((int) Math.min(activity.getResources().getDisplayMetrics().widthPixels * 0.92, dp(480)), ViewGroup.LayoutParams.WRAP_CONTENT);
        }
        available();
        dialog.show();
    }

    private static CharSequence formatNotes(String notes) {
        StringBuilder out = new StringBuilder();
        for (String raw : (notes == null ? "" : notes).split("\n")) {
            String line = raw.trim();
            if (line.isEmpty() || line.matches("#+")) continue;
            if (out.length() > 0) out.append('\n');
            out.append(line.matches("^[-*•]\\s+.*") ? "• " + line.replaceFirst("^[-*•]\\s+", "") : line.replaceFirst("^#+\\s*", ""));
        }
        return out;
    }

    private void button(String label, int style, Runnable action) {
        Button b = new Button(activity, null, 0, android.R.style.Widget_Material_Button_Borderless);
        b.setText(label); b.setAllCaps(false); b.setTextSize(14);
        b.setPadding(dp(16), dp(8), dp(16), dp(8)); b.setMinHeight(dp(42)); b.setMinimumHeight(dp(42));
        if (style == 2) { b.setBackground(round(PRIMARY, 10, 0)); b.setTextColor(ON_PRIMARY); b.setTypeface(Typeface.DEFAULT, Typeface.BOLD); }
        else if (style == 1) { b.setBackground(round(SECONDARY, 10, Color.rgb(91, 81, 67))); b.setTextColor(TEXT); }
        else { b.setBackground(null); b.setTextColor(MUTED); }
        b.setOnClickListener(v -> action.run());
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-2, -2); p.leftMargin = dp(8);
        buttons.addView(b, p);
    }
    private void state(String badgeText, int badgeColor, int badgeTextColor, String heading, String sub) {
        badge.setText(badgeText); badge.setBackground(round(badgeColor, 16, 0)); badge.setTextColor(badgeTextColor);
        title.setText(heading); subtitle.setText(sub);
        error.setVisibility(android.view.View.GONE);
        buttons.removeAllViews();
    }
    private void spacer() { buttons.addView(new android.view.View(activity), new LinearLayout.LayoutParams(0, 1, 1)); }

    private void available() {
        state("↑", PRIMARY, ON_PRIMARY, "새 버전 " + update.version + " 사용 가능",
            "현재 " + current + " → " + update.version + " · " + size(update.apkSize));
        progressBox.setVisibility(android.view.View.GONE);
        button("건너뛰기", 0, () -> {
            activity.getSharedPreferences("connection", Activity.MODE_PRIVATE).edit().putString("skippedUpdate", update.version).apply();
            dismiss();
        });
        spacer();
        button("나중에", 1, this::dismiss);
        button("지금 업데이트", 2, this::download);
    }

    private void download() {
        cancelled = false;
        state("↓", PRIMARY, ON_PRIMARY, update.version + " 다운로드 중", "다운로드가 끝나면 파일 무결성(SHA-256)을 확인합니다.");
        progressBox.setVisibility(android.view.View.VISIBLE);
        bar.setProgress(0); percent.setText("0%"); detail.setText("");
        button("취소", 1, () -> cancelled = true);
        File dir = new File(activity.getCacheDir(), "updates");
        io.execute(() -> {
            try {
                File file = ReleaseUpdates.download(update, dir, new ReleaseUpdates.Progress() {
                    @Override public void on(long received, long total, double bps) {
                        activity.runOnUiThread(() -> {
                            int p = total > 0 ? (int) Math.min(100, received * 100 / total) : 0;
                            bar.setProgress(p); percent.setText(p + "%");
                            String eta = bps > 0 && total > received ? " · 약 " + Math.max(1, Math.round((total - received) / bps)) + "초 남음" : "";
                            detail.setText(size(received) + " / " + size(total) + " · " + size(bps) + "/s" + eta);
                        });
                    }
                    @Override public boolean cancelled() { return cancelled; }
                });
                verifyArchive(file);
                activity.runOnUiThread(() -> { apk = file; ready(); });
            } catch (Exception e) {
                activity.runOnUiThread(() -> {
                    if (cancelled) available();
                    else failed("다운로드하지 못했습니다.", e.getMessage());
                });
            }
        });
    }

    /* Same app, the advertised version, signed with the same key as this copy. */
    @SuppressWarnings("deprecation")
    private void verifyArchive(File file) throws Exception {
        PackageManager pm = activity.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo archive = pm.getPackageArchiveInfo(file.getPath(), flags);
        PackageInfo installed = pm.getPackageInfo(activity.getPackageName(), flags);
        if (archive == null) throw new Exception("설치 파일을 읽을 수 없습니다.");
        if (!activity.getPackageName().equals(archive.packageName)) throw new Exception("다른 앱의 설치 파일입니다.");
        if (!update.version.equals(archive.versionName)) throw new Exception("설치 파일 버전이 릴리스 정보와 다릅니다.");
        if (!signers(archive).equals(signers(installed))) throw new Exception("설치 파일의 서명이 현재 앱과 다릅니다. 이 파일은 설치하지 않습니다.");
    }
    @SuppressWarnings("deprecation")
    private static Set<String> signers(PackageInfo info) throws Exception {
        Signature[] list = Build.VERSION.SDK_INT >= 28 && info.signingInfo != null
            ? info.signingInfo.getApkContentsSigners() : info.signatures;
        Set<String> out = new HashSet<>();
        if (list == null) return out;
        MessageDigest sha = MessageDigest.getInstance("SHA-256");
        for (Signature s : list) {
            StringBuilder hex = new StringBuilder();
            for (byte b : sha.digest(s.toByteArray())) hex.append(String.format(Locale.ROOT, "%02x", b));
            out.add(hex.toString());
        }
        return out;
    }

    private void ready() {
        state("✓", Color.rgb(60, 90, 62), Color.rgb(205, 236, 204), update.version + " 설치 준비 완료",
            "검증을 마쳤습니다. 설치를 누르면 Android 설치 확인 화면이 열립니다.");
        progressBox.setVisibility(android.view.View.VISIBLE);
        bar.setProgress(100); percent.setText("100%"); detail.setText(size(update.apkSize) + " · 검증 완료");
        button("나중에", 1, this::dismiss);
        button("설치", 2, this::install);
    }

    private void install() {
        if (apk == null || !apk.isFile()) { download(); return; }
        if (!activity.getPackageManager().canRequestPackageInstalls()) {
            awaitingPermission = true;
            state("!", PRIMARY, ON_PRIMARY, "설치 권한이 필요합니다",
                "다음 화면에서 '이 출처 허용'을 켠 뒤 돌아오면 설치를 계속합니다.");
            button("취소", 1, this::dismiss);
            button("설정 열기", 2, this::askPermission);
            askPermission();
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".files", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
            dismiss();
        } catch (Exception e) { failed("설치 화면을 열지 못했습니다.", e.getMessage()); }
    }
    private void askPermission() {
        try {
            activity.startActivityForResult(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + activity.getPackageName())), INSTALL_PERMISSION);
        } catch (Exception e) { failed("설정 화면을 열지 못했습니다.", e.getMessage()); }
    }
    /** Back from the "install unknown apps" setting. */
    void onPermissionResult() {
        if (!awaitingPermission || dialog == null || !dialog.isShowing()) return;
        awaitingPermission = false;
        if (!activity.getPackageManager().canRequestPackageInstalls()) {
            failed("설치 권한이 허용되지 않았습니다.", "설정에서 이 앱의 '출처를 알 수 없는 앱 설치'를 허용한 뒤 다시 시도하세요.");
            return;
        }
        install();
    }

    private void failed(String message, String why) {
        state("!", Color.rgb(107, 47, 42), Color.rgb(255, 217, 212), "업데이트 오류", message);
        if (why != null && !why.isEmpty()) { error.setText(why); error.setVisibility(android.view.View.VISIBLE); }
        progressBox.setVisibility(android.view.View.GONE);
        button("릴리스 페이지", 0, () -> {
            try { activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(update.pageUrl))); } catch (Exception ignored) { }
        });
        spacer();
        button("닫기", 1, this::dismiss);
        button("다시 시도", 2, () -> { if (apk != null && apk.isFile()) install(); else download(); });
    }

    void dismiss() { cancelled = true; if (dialog != null && dialog.isShowing()) dialog.dismiss(); }
    boolean showing() { return dialog != null && dialog.isShowing(); }
}
