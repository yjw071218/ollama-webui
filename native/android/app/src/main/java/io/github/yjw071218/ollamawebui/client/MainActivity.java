package io.github.yjw071218.ollamawebui.client;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.webkit.*;
import android.webkit.CookieManager;
import android.widget.*;
import android.media.projection.MediaProjectionManager;
import androidx.core.content.FileProvider;
import androidx.webkit.*;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

public class MainActivity extends Activity {
    private WebView web;
    private LoopbackProxy proxy;
    private LinearLayout layout;
    private android.content.SharedPreferences prefs;
    private final ExecutorService io = Executors.newCachedThreadPool();
    private ValueCallback<Uri[]> fileResult;
    private PermissionRequest mediaRequest;
    private String[] requestedResources;
    private Runnable permissionDone;
    private JavaScriptReplyProxy captureReply, saveReply;
    private String captureId, saveId, downloadURL;
    private byte[] saveBytes;
    private boolean connecting, notificationAllowed, pageReady;
    /** The chat a tapped notification is about, until the page can be told. */
    private String pendingChat;
    private static final int MEDIA = 41, FILE = 42, SAVE = 43, CAPTURE = 44, NOTIFY = 45, AUTH = 46;
    private static final String EXTRA_CHAT = "chat";
    private int dp(int n) { return (int) (getResources().getDisplayMetrics().density * n); }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("connection", MODE_PRIVATE);
        if (state == null) takeChat(getIntent());
        getWindow().setStatusBarColor(Color.rgb(17, 24, 39));
        getWindow().setNavigationBarColor(Color.rgb(17, 24, 39));
        // The address screen is for choosing a server, not a gate on every launch:
        // a saved server is opened directly, and "서버 변경" brings the screen back.
        String saved = prefs.getString("server", "");
        if (saved.isEmpty()) showSetup();
        else { showSplash(); connect(saved, null); }
        clearOldUpdates();
        checkUpdates(false);
    }
    /** Shown for the moment it takes to open the saved server. */
    private void showSplash() {
        int color = prefs.getInt("chrome", Color.rgb(26, 25, 22));
        layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL);
        layout.setGravity(Gravity.CENTER);
        setContentView(layout);
        applyChrome(color);
        layout.addView(new ProgressBar(this));
        TextView text = label("연결 중…", 15); text.setGravity(Gravity.CENTER);
        text.setTextColor(luminance(color) > 0.6 ? Color.rgb(60, 60, 60) : Color.rgb(220, 220, 220));
        layout.addView(text);
    }
    private static double luminance(int color) {
        return (0.299 * Color.red(color) + 0.587 * Color.green(color) + 0.114 * Color.blue(color)) / 255;
    }
    /**
     * Sign-in pages open in a Custom Tab: a real browser shown over the app (as a
     * sheet where the browser supports it). Google refuses sign-in inside a
     * WebView.
     */
    private void openAuthTab(Uri uri) {
        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        Bundle extras = new Bundle();
        extras.putBinder("android.support.customtabs.extra.SESSION", null);
        intent.putExtras(extras);
        intent.putExtra("android.support.customtabs.extra.TOOLBAR_COLOR", prefs.getInt("chrome", Color.rgb(26, 25, 22)));
        intent.putExtra("android.support.customtabs.extra.TITLE_VISIBILITY", 1);
        intent.putExtra("androidx.browser.customtabs.extra.INITIAL_ACTIVITY_HEIGHT_PX", (int) (getResources().getDisplayMetrics().heightPixels * 0.88));
        try { startActivityForResult(intent, AUTH); }
        catch (ActivityNotFoundException e) { message("로그인할 브라우저가 없습니다."); }
    }
    /**
     * Google's account chooser opened directly in the Custom Tab, answered on
     * 127.0.0.1:47615 (GoogleLoopback). If that port is taken, the server's page.
     */
    private void googleDirect(String server, String id, String clientId) {
        if (proxy == null) return;
        String gateway = proxy.origin;
        try {
            GoogleLoopback.start(id, gateway, () -> runOnUiThread(this::nudgeAuth));
            openAuthTab(Uri.parse(GoogleLoopback.authorizeUrl(id, clientId)));
        } catch (Exception e) {
            openAuthTab(Uri.parse(server + "/api/auth/native/page#" + id + "&app=android"));
        }
    }
    /** Tell the page to check for a finished sign-in now instead of at its next poll. */
    private void nudgeAuth() {
        if (web != null) web.evaluateJavascript("window.dispatchEvent(new Event('ollama-native-auth'))", null);
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // ollamawebui://auth is only a "come back" signal from the sign-in page; it carries nothing.
        if (intent != null && Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null
            && "ollamawebui".equals(intent.getData().getScheme())) nudgeAuth();
        if (takeChat(intent)) deliverChat();
    }
    /** A notification's chat, held until the page is there to open it. */
    private boolean takeChat(Intent intent) {
        String chat = intent == null ? null : intent.getStringExtra(EXTRA_CHAT);
        if (chat == null || chat.isEmpty()) return false;
        pendingChat = chat; intent.removeExtra(EXTRA_CHAT); return true;
    }
    /** Tell the page which chat to open. It also keeps it, for an app still starting up. */
    private void deliverChat() {
        if (pendingChat == null || web == null || !pageReady) return;
        String chat = JSONObject.quote(pendingChat); pendingChat = null;
        web.evaluateJavascript("window.__ollamaOpenChat=" + chat + ";window.dispatchEvent(new CustomEvent('ollama-native-open-chat',{detail:{chat:" + chat + "}}))", null);
    }
    /** Dialogs in the page's own light or dark, not the system default. */
    private AlertDialog.Builder dialog() {
        boolean light = luminance(prefs.getInt("chrome", Color.rgb(26, 25, 22))) > 0.6 && web != null;
        return new AlertDialog.Builder(this, light ? android.R.style.Theme_DeviceDefault_Light_Dialog_Alert : android.R.style.Theme_DeviceDefault_Dialog_Alert);
    }
    /** System bars, display cutout and keyboard, on every side (landscape puts them left or right). */
    private static int[] bars(WindowInsets insets) {
        if (Build.VERSION.SDK_INT >= 30) {
            android.graphics.Insets b = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
            return new int[]{b.left, b.top, b.right, Math.max(b.bottom, ime.bottom)};
        }
        return new int[]{insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom()};
    }
    private boolean notificationsAllowedBySystem() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false;
        NotificationManager manager = getSystemService(NotificationManager.class);
        return manager == null || manager.areNotificationsEnabled();
    }
    private UpdateDialog updateDialog;
    /** Check GitHub; on news, the in-app update screen (UpdateDialog) downloads and installs it. */
    private void checkUpdates(boolean manual) {
        if (updateDialog != null && updateDialog.showing()) return;
        io.execute(() -> {
            try {
                String current = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
                ReleaseUpdates.Update update = ReleaseUpdates.check(current);
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()) return;
                    if (update == null) { if (manual) message("최신 버전(" + current + ")을 사용 중입니다."); return; }
                    if (!manual && update.version.equals(prefs.getString("skippedUpdate", ""))) return;
                    updateDialog = new UpdateDialog(this, io, update, current);
                    updateDialog.show();
                });
            } catch (Exception e) { if (manual) runOnUiThread(() -> message("업데이트 확인에 실패했습니다. 네트워크 연결 또는 GitHub 요청 제한을 확인하세요.")); }
        });
    }
    /** Installer files from an earlier update are not needed once this version runs. */
    private void clearOldUpdates() {
        io.execute(() -> {
            File[] old = new File(getCacheDir(), "updates").listFiles();
            if (old != null) for (File f : old) f.delete();
        });
    }
    private void showSetup() {
        denyMedia();
        if (fileResult != null) { fileResult.onReceiveValue(null); fileResult = null; }
        stopService(new Intent(this, CaptureService.class));
        if (captureReply != null) { reply(captureReply, captureId, null, "연결을 종료했습니다."); captureReply = null; }
        if (web != null) { web.loadUrl("about:blank"); web.destroy(); web = null; }
        if (proxy != null) { proxy.close(); proxy = null; }
        notificationAllowed = false;
        layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(dp(24), dp(40), dp(24), dp(24));
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true);
        scroll.addView(layout);
        setContentView(scroll);
        int background = Color.rgb(26, 25, 22);
        scroll.setBackgroundColor(background);
        applyChrome(background);
        scroll.setOnApplyWindowInsetsListener((v, insets) -> {
            int[] b = bars(insets);
            layout.setPadding(dp(24) + b[0], Math.max(dp(40), b[1] + dp(16)), dp(24) + b[2], Math.max(dp(24), b[3] + dp(16)));
            return insets;
        });
        TextView title = label("Ollama WebUI", 28); title.setTypeface(android.graphics.Typeface.DEFAULT_BOLD); layout.addView(title);
        TextView intro = label("연결할 서버 주소를 입력하세요. PC에서 서버를 켰을 때 표시되는 주소입니다.", 15);
        intro.setTextColor(Color.rgb(185, 179, 167)); layout.addView(intro);
        EditText address = new EditText(this); address.setSingleLine(true);
        address.setTextColor(Color.rgb(238, 233, 224)); address.setHintTextColor(Color.rgb(120, 114, 104));
        address.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        address.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_GO);
        address.setHint("예: 192.168.0.5:5173");
        address.setBackground(rounded(Color.rgb(41, 38, 32), 12, Color.rgb(81, 74, 64)));
        address.setPadding(dp(14), dp(12), dp(14), dp(12));
        address.setText(prefs.getString("server", ""));
        LinearLayout.LayoutParams field = new LinearLayout.LayoutParams(-1, -2); field.topMargin = dp(8); field.bottomMargin = dp(4);
        layout.addView(address, field);
        TextView warning = label("http://로 연결하면 내용이 암호화되지 않습니다. 집 밖에서 쓰거나 비밀번호를 보호하려면 https://를 쓰세요. 신뢰하는 서버에만 연결하세요.\n\n서버를 바꾸면 로그인 정보가 지워지고, 서버마다 앱 데이터가 따로 저장됩니다.", 13);
        warning.setTextColor(Color.rgb(232, 196, 120)); layout.addView(warning);
        Button connect = button("연결하기", true);
        LinearLayout.LayoutParams primary = new LinearLayout.LayoutParams(-1, dp(50)); primary.topMargin = dp(8);
        layout.addView(connect, primary);
        Button updates = button("업데이트 확인", false);
        LinearLayout.LayoutParams secondary = new LinearLayout.LayoutParams(-1, dp(46)); secondary.topMargin = dp(10);
        layout.addView(updates, secondary);
        updates.setOnClickListener(v -> checkUpdates(true));
        address.setOnEditorActionListener((v, action, event) -> {
            boolean enter = event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER && event.getAction() == KeyEvent.ACTION_DOWN;
            if (action != android.view.inputmethod.EditorInfo.IME_ACTION_GO && !enter) return false;
            connect.performClick(); return true;
        });
        connect.setOnClickListener(v -> {
            if (connecting) return;
            try {
                String server = LoopbackProxy.normalize(address.getText().toString());
                address.setText(server);
                if (server.startsWith("http:")) dialog().setTitle("암호화되지 않은 연결")
                    .setMessage(server + "\n신뢰하는 서버인지 확인하세요. HTTP는 도청·변조 위험이 있습니다.")
                    .setNegativeButton("취소", null).setPositiveButton("연결", (d,w) -> connect(server, connect)).show();
                else connect(server, connect);
            } catch (Exception e) { address.setError(e.getMessage()); }
        });
    }
    private TextView label(String text, int size) {
        TextView view = new TextView(this); view.setText(text); view.setTextSize(size); view.setTextColor(Color.WHITE);
        view.setPadding(0, dp(12), 0, dp(12)); return view;
    }
    private android.graphics.drawable.GradientDrawable rounded(int color, int radius, int stroke) {
        android.graphics.drawable.GradientDrawable d = new android.graphics.drawable.GradientDrawable();
        d.setColor(color); d.setCornerRadius(dp(radius));
        if (stroke != 0) d.setStroke(dp(1), stroke);
        return d;
    }
    /** The setup screen's buttons, in the app's colours rather than the platform's light grey. */
    private Button button(String text, boolean primary) {
        Button b = new Button(this); b.setText(text); b.setAllCaps(false); b.setTextSize(15);
        b.setStateListAnimator(null);
        b.setBackground(primary ? rounded(Color.rgb(217, 119, 87), 12, 0) : rounded(Color.rgb(41, 38, 32), 12, Color.rgb(81, 74, 64)));
        b.setTextColor(primary ? Color.WHITE : Color.rgb(238, 233, 224));
        if (primary) b.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        return b;
    }
    private void connect(String server, Button button) {
        connecting = true;
        if (button != null) { button.setEnabled(false); button.setText("연결 중…"); }
        io.execute(() -> {
            try {
                int port = prefs.getInt("port:" + server, 0);
                LoopbackProxy candidate = new LoopbackProxy(server, port);
                if (port == 0) {
                    Set<Integer> used = new HashSet<>();
                    for (Map.Entry<String, ?> entry : prefs.getAll().entrySet())
                        if (entry.getKey().startsWith("port:") && entry.getValue() instanceof Integer) used.add((Integer) entry.getValue());
                    for (int attempt = 0; used.contains(candidate.port()); attempt++) {
                        candidate.close();
                        if (attempt > 50) throw new IOException("사용할 앱 포트가 없습니다.");
                        candidate = new LoopbackProxy(server, 0);
                    }
                }
                final LoopbackProxy ready = candidate;
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()) { ready.close(); return; }
                    proxy = ready;
                    Runnable open = () -> {
                        prefs.edit().putString("server", server).putInt("port:" + server, ready.port()).apply();
                        CookieManager cm = CookieManager.getInstance();
                        cm.setCookie(ready.origin, LoopbackProxy.COOKIE + "=" + ready.token + "; Path=/; HttpOnly; SameSite=Strict", ok -> {
                            connecting = false;
                            if (!ok) { showSetup(); message("앱 연결 쿠키를 설정하지 못했습니다."); return; }
                            cm.flush(); showWeb(server);
                        });
                    };
                    // Cookies are host-scoped, not port-scoped: clear them on server changes.
                    if (!server.equals(prefs.getString("server", ""))) CookieManager.getInstance().removeAllCookies(ok -> open.run());
                    else open.run();
                });
            } catch (Exception e) {
                runOnUiThread(() -> { connecting = false;
                    if (button != null) { button.setEnabled(true); button.setText("연결하기"); } else showSetup();
                    message(e instanceof BindException ? "저장된 앱 포트가 사용 중입니다. 앱을 완전히 종료하고 다시 열어 주세요." : "연결 준비 실패: " + e.getMessage()); });
            }
        });
    }
    private boolean local(String url) {
        if (proxy == null || url == null) return false;
        try {
            URI u = new URI(url), origin = new URI(proxy.origin);
            return Objects.equals(u.getScheme(), origin.getScheme()) && Objects.equals(u.getRawAuthority(), origin.getRawAuthority());
        } catch (Exception e) { return false; }
    }
    /** Paint the system bars and the area behind them in the page's own background colour. */
    private void applyChrome(int color) {
        if (layout != null) layout.setBackgroundColor(color);
        if (web != null) web.setBackgroundColor(color);
        getWindow().setStatusBarColor(color); getWindow().setNavigationBarColor(color);
        double luminance = (0.299 * Color.red(color) + 0.587 * Color.green(color) + 0.114 * Color.blue(color)) / 255;
        View decor = getWindow().getDecorView();
        int flags = decor.getSystemUiVisibility() & ~(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        if (luminance > 0.6) flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        decor.setSystemUiVisibility(flags);
    }
    private void confirmChangeServer(Runnable cancelled) {
        dialog().setTitle("서버 변경").setMessage("현재 연결과 진행 중인 녹음·화면 캡처를 종료하고 서버 주소 화면으로 이동할까요?")
            .setNegativeButton("취소", (d,w) -> { if (cancelled != null) cancelled.run(); })
            .setOnCancelListener(d -> { if (cancelled != null) cancelled.run(); })
            .setPositiveButton("변경", (d,w) -> { stopService(new Intent(this, CaptureService.class)); showSetup(); }).show();
    }
    private void showWeb(String server) {
        layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL);
        setContentView(layout);
        layout.setOnApplyWindowInsetsListener((v, insets) -> {
            int[] b = bars(insets);
            v.setPadding(b[0], b[1], b[2], b[3]); return insets;
        });
        pageReady = false;
        // Allowed once for this server, allowed after a restart too (and still
        // checked against the system setting, which can be turned off any time).
        notificationAllowed = prefs.getBoolean("notify:" + server, false) && notificationsAllowedBySystem();
        // No native button bar: reload and server change live in the page's own
        // account menu (window.ollamaNative.changeServer), so the app has no frame.
        web = new WebView(this); layout.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        applyChrome(prefs.getInt("chrome", Color.rgb(26, 25, 22)));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false); s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setMediaPlaybackRequiresUserGesture(true); s.setSupportMultipleWindows(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (local(url)) {
                    if ("/__native/auth".equals(request.getUrl().getPath())) {
                        String id = request.getUrl().getFragment();
                        String[] google = GoogleLoopback.parse(id);
                        if (request.isForMainFrame() && google != null) googleDirect(server, google[0], google[1]);
                        else if (request.isForMainFrame() && id != null) {
                            if (id.matches("[a-f0-9]{64}")) openAuthTab(Uri.parse(server + "/api/auth/native/page#" + id + "&app=android"));
                        }
                        return true;
                    }
                    return false;
                }
                if (!request.isForMainFrame()) return true;
                if (url.startsWith(server + "/") || url.equals(server)) { view.loadUrl(proxy.origin + url.substring(server.length())); return true; }
                if ("intent".equals(request.getUrl().getScheme())) return true;
                if ("http".equals(request.getUrl().getScheme()) || "https".equals(request.getUrl().getScheme()))
                    dialog().setTitle("외부 링크").setMessage(url).setNegativeButton("취소", null)
                        .setPositiveButton("브라우저로 열기", (d,w) -> { try { startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl())); } catch (Exception e) { message("링크를 열 앱이 없습니다."); } }).show();
                return true;
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) { pageReady = false; }
            @Override public void onPageFinished(WebView view, String url) {
                pageReady = local(url);
                deliverChat();
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame() || isFinishing() || isDestroyed()) return;
                dialog().setTitle("연결 실패").setMessage(server + "\n" + error.getDescription())
                    .setCancelable(false)
                    .setNegativeButton("서버 변경", (d,w) -> { stopService(new Intent(MainActivity.this, CaptureService.class)); showSetup(); })
                    .setPositiveButton("다시 시도", (d,w) -> { if (web != null) web.reload(); }).show();
            }
            @Override public void onReceivedSslError(WebView view, android.webkit.SslErrorHandler handler, android.net.http.SslError error) {
                handler.cancel(); message("서버 인증서를 확인할 수 없습니다. 인증서 검증을 우회하지 않습니다.");
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    if (!local(request.getOrigin().toString()) || mediaRequest != null) { request.deny(); return; }
                    ArrayList<String> resources = new ArrayList<>(), permissions = new ArrayList<>();
                    for (String resource : request.getResources()) {
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) { resources.add(resource); permissions.add(Manifest.permission.RECORD_AUDIO); }
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) { resources.add(resource); permissions.add(Manifest.permission.CAMERA); }
                    }
                    if (resources.isEmpty()) { request.deny(); return; }
                    mediaRequest = request; requestedResources = resources.toArray(new String[0]);
                    dialog().setTitle("마이크 / 카메라 접근")
                        .setMessage(server + "\n이 서버에 요청한 마이크·카메라 권한을 허용할까요?")
                        .setNegativeButton("거부", (d,w) -> denyMedia())
                        .setOnCancelListener(d -> denyMedia())
                        .setPositiveButton("허용", (d,w) -> {
                            if (mediaRequest != request || web == null || !local(web.getUrl())) return;
                            requestPermissions(permissions.toArray(new String[0]), MEDIA);
                        }).show();
                });
            }
            @Override public void onPermissionRequestCanceled(PermissionRequest request) { if (mediaRequest == request) mediaRequest = null; }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams parameters) {
                if (fileResult != null) fileResult.onReceiveValue(null); fileResult = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE);
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, parameters.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                String[] types = Arrays.stream(parameters.getAcceptTypes()).filter(t -> t.contains("/")).toArray(String[]::new);
                if (types.length > 0) intent.putExtra(Intent.EXTRA_MIME_TYPES, types);
                try { startActivityForResult(intent, FILE); } catch (Exception e) { fileResult.onReceiveValue(null); fileResult = null; }
                return true;
            }
            @Override public boolean onJsAlert(WebView view, String url, String text, JsResult result) {
                dialog().setMessage(text).setPositiveButton("확인", (d,w) -> result.confirm()).setOnCancelListener(d -> result.cancel()).show(); return true;
            }
        });
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addWebMessageListener(web, "NativeHost", Collections.singleton(proxy.origin), (view, message, source, main, reply) -> {
                if (!main || !local(source.toString()) || message.getData() == null) return;
                handle(message.getData(), reply);
            });
            try (InputStream in = getAssets().open("native.js")) {
                String js = new String(readBytes(in, 100000), StandardCharsets.UTF_8)
                    // The page learns at once that it may notify, before its first check.
                    .replace("static permission = 'default';", "static permission = '" + (notificationAllowed ? "granted" : "default") + "';");
                WebViewCompat.addDocumentStartJavaScript(web, js, Collections.singleton(proxy.origin));
            } catch (Exception e) { message("앱 확장 초기화 실패: " + e.getMessage()); }
        } else message("Android System WebView를 업데이트해야 화면 캡처·공유·알림 확장을 사용할 수 있습니다.");
        web.setDownloadListener((url, agent, disposition, type, length) -> {
            if (!local(url)) { message("외부 다운로드는 기본 브라우저에서 열어 주세요."); return; }
            if (saveId != null || downloadURL != null) { message("다른 저장 작업이 진행 중입니다."); return; }
            downloadURL = url; chooseSave(URLUtil.guessFileName(url, disposition, type), type);
        });
        web.loadUrl(proxy.origin + "/");
    }
    private void denyMedia() { if (mediaRequest != null) { mediaRequest.deny(); mediaRequest = null; } }
    private void reply(JavaScriptReplyProxy proxy, String id, Object value, String error) {
        if (proxy == null) return;
        try { JSONObject json = new JSONObject().put("id", id);
            if (error != null) json.put("error", error); else json.put("value", value == null ? JSONObject.NULL : value);
            proxy.postMessage(json.toString());
        } catch (Exception ignored) { }
    }
    private void handle(String data, JavaScriptReplyProxy reply) {
        String id = "";
        try {
            if (data.length() > 29000000) throw new IllegalArgumentException("파일이 너무 큽니다.");
            JSONObject request = new JSONObject(data); id = request.getString("id");
            String method = request.getString("method"), requestId = id;
            switch (method) {
                case "capture":
                    if (captureReply != null) throw new IllegalStateException("화면 캡처가 이미 진행 중입니다.");
                    captureReply = reply; captureId = id;
                    startActivityForResult(((MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE)).createScreenCaptureIntent(), CAPTURE); break;
                case "share":
                    Intent send = new Intent(Intent.ACTION_SEND);
                    send.putExtra(Intent.EXTRA_SUBJECT, request.optString("title"));
                    send.putExtra(Intent.EXTRA_TEXT, request.optString("text") + (request.optString("url").isEmpty() ? "" : "\n" + request.optString("url")));
                    JSONObject file = request.optJSONObject("file");
                    if (file != null) {
                        File dir = new File(getCacheDir(), "shared"); dir.mkdirs();
                        File dest = new File(dir, UUID.randomUUID() + "-" + safeName(file.optString("name")));
                        try (FileOutputStream out = new FileOutputStream(dest)) { out.write(decode(file.getString("data"))); }
                        Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".files", dest);
                        send.setType(file.optString("type", "application/octet-stream")); send.putExtra(Intent.EXTRA_STREAM, uri);
                        send.setClipData(ClipData.newRawUri("shared", uri)); send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    } else send.setType("text/plain");
                    startActivity(Intent.createChooser(send, "공유")); reply(reply, id, true, null); break;
                case "save":
                    if (saveId != null || downloadURL != null) throw new IllegalStateException("다른 저장 작업이 진행 중입니다.");
                    saveBytes = decode(request.getString("data")); saveReply = reply; saveId = id;
                    chooseSave(request.optString("name", "download"), request.optString("type")); break;
                case "clipboardWrite":
                    ((android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("Ollama WebUI", request.optString("text")));
                    reply(reply, id, true, null); break;
                case "clipboardRead": {
                    // "항상 허용" (다시 묻지 않기) is remembered per server, across restarts.
                    String always = "always:clipboardRead:" + prefs.getString("server", "");
                    Runnable readClip = () -> {
                        ClipData clip = ((android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE)).getPrimaryClip();
                        reply(reply, requestId, clip != null && clip.getItemCount() > 0 ? clip.getItemAt(0).coerceToText(this).toString() : "", null);
                    };
                    if (prefs.getBoolean(always, false)) { readClip.run(); break; }
                    dialog().setTitle("클립보드 읽기").setMessage("현재 서버가 클립보드의 텍스트를 읽도록 허용할까요?")
                        .setNegativeButton("거부", (d,w) -> reply(reply, requestId, null, "클립보드 읽기를 거부했습니다."))
                        .setOnCancelListener(d -> reply(reply, requestId, null, "취소했습니다."))
                        .setNeutralButton("항상 허용", (d,w) -> { prefs.edit().putBoolean(always, true).apply(); readClip.run(); })
                        .setPositiveButton("이번만 허용", (d,w) -> readClip.run()).show(); break;
                }
                case "notificationPermission": {
                    if (permissionDone != null) throw new IllegalStateException("권한 요청이 진행 중입니다.");
                    String key = "notify:" + prefs.getString("server", "");
                    if (notificationAllowed && notificationsAllowedBySystem()) { reply(reply, id, "granted", null); break; }
                    dialog().setTitle("완료 알림").setMessage("이 서버에서 작업 완료 알림을 표시하도록 허용할까요?")
                        .setNegativeButton("거부", (d,w) -> reply(reply, requestId, "denied", null))
                        .setOnCancelListener(d -> reply(reply, requestId, "denied", null))
                        .setPositiveButton("허용", (d,w) -> {
                            permissionDone = () -> {
                                notificationAllowed = notificationsAllowedBySystem();
                                // Kept per server, so the next launch does not quietly forget it.
                                prefs.edit().putBoolean(key, notificationAllowed).apply();
                                if (!notificationAllowed && Build.VERSION.SDK_INT >= 33
                                    && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
                                    message("휴대폰 설정에서 이 앱의 알림이 꺼져 있습니다. 설정 › 앱 › Ollama WebUI › 알림에서 켜 주세요.");
                                reply(reply, requestId, notificationAllowed ? "granted" : "denied", null);
                            };
                            if (Build.VERSION.SDK_INT >= 33) requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFY);
                            else { permissionDone.run(); permissionDone = null; }
                        }).show(); break;
                }
                case "notify": {
                    if (!notificationAllowed || !notificationsAllowedBySystem()) throw new SecurityException("알림 권한이 없습니다.");
                    NotificationManager manager = getSystemService(NotificationManager.class);
                    manager.createNotificationChannel(new NotificationChannel("jobs", "작업 완료", NotificationManager.IMPORTANCE_DEFAULT));
                    String tag = request.optString("tag", "ollama"), chat = request.optString("chat", "");
                    // Tapping it opens the chat it is about; one PendingIntent per tag so their chats differ.
                    Intent target = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
                    if (!chat.isEmpty()) target.putExtra(EXTRA_CHAT, chat);
                    PendingIntent open = PendingIntent.getActivity(this, tag.hashCode(), target, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
                    manager.notify(tag.hashCode(), new Notification.Builder(this, "jobs")
                        .setSmallIcon(R.drawable.ic_notification).setColor(Color.rgb(217, 119, 87))
                        .setContentTitle(request.optString("title"))
                        .setContentText(request.optString("body")).setStyle(new Notification.BigTextStyle().bigText(request.optString("body")))
                        .setContentIntent(open).setAutoCancel(true).build());
                    reply(reply, id, true, null); break;
                }
                case "changeServer":
                    confirmChangeServer(() -> reply(reply, requestId, false, null)); break;
                case "checkUpdates":
                    checkUpdates(true); reply(reply, id, true, null); break;
                case "chrome": {
                    String value = request.optString("color");
                    if (!value.matches("#[0-9a-fA-F]{6}")) throw new IllegalArgumentException("잘못된 색상입니다.");
                    int color = Color.parseColor(value);
                    prefs.edit().putInt("chrome", color).apply(); applyChrome(color);
                    reply(reply, id, true, null); break;
                }
                default: throw new IllegalArgumentException("지원하지 않는 앱 요청입니다.");
            }
        } catch (Exception e) { reply(reply, id, null, e.getMessage()); }
    }
    private static String safeName(String name) { return name.replaceAll("[^a-zA-Z0-9._가-힣-]", "_").replaceAll("^\\.+", "_"); }
    private static byte[] decode(String value) {
        if (value.length() > 28000000) throw new IllegalArgumentException("파일당 20 MB까지 지원합니다.");
        return android.util.Base64.decode(value, android.util.Base64.DEFAULT);
    }
    private void chooseSave(String name, String type) {
        try { startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType(type == null || type.isEmpty() ? "application/octet-stream" : type).putExtra(Intent.EXTRA_TITLE, safeName(name)), SAVE); }
        catch (Exception e) { reply(saveReply, saveId, null, e.getMessage()); resetSave(); message("저장 위치를 선택할 수 없습니다."); }
    }
    private void resetSave() { saveId = null; saveReply = null; saveBytes = null; downloadURL = null; }
    private static byte[] readBytes(InputStream in, int limit) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buf = new byte[8192]; int n;
        while ((n = in.read(buf)) != -1) { if (out.size() + n > limit) throw new IOException("파일이 너무 큽니다."); out.write(buf, 0, n); }
        return out.toByteArray();
    }
    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == MEDIA && mediaRequest != null) {
            boolean allowed = results.length > 0; for (int result : results) allowed &= result == PackageManager.PERMISSION_GRANTED;
            if (allowed && web != null && local(web.getUrl())) mediaRequest.grant(requestedResources); else mediaRequest.deny();
            mediaRequest = null;
        }
        if (code == NOTIFY && permissionDone != null) { permissionDone.run(); permissionDone = null; }
    }
    @Override protected void onActivityResult(int code, int result, Intent intent) {
        super.onActivityResult(code, result, intent);
        if (code == AUTH) { nudgeAuth(); return; }
        if (code == UpdateDialog.INSTALL_PERMISSION) { if (updateDialog != null) updateDialog.onPermissionResult(); return; }
        if (code == FILE && fileResult != null) {
            fileResult.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, intent)); fileResult = null;
        }
        if (code == CAPTURE) {
            if (result != RESULT_OK || intent == null) { reply(captureReply, captureId, null, null); captureReply = null; return; }
            CaptureService.result = (image, error) -> runOnUiThread(() -> { reply(captureReply, captureId, image, error); captureReply = null; });
            startForegroundService(new Intent(this, CaptureService.class).putExtra("code", result).putExtra("data", intent));
        }
        if (code == SAVE) {
            if (result != RESULT_OK || intent == null || intent.getData() == null) { reply(saveReply, saveId, null, "저장을 취소했습니다."); resetSave(); return; }
            Uri dest = intent.getData(); byte[] bytes = saveBytes; String url = downloadURL;
            String cookies = url == null ? null : CookieManager.getInstance().getCookie(url);
            JavaScriptReplyProxy callback = saveReply; String id = saveId; resetSave();
            io.execute(() -> {
                try (OutputStream out = getContentResolver().openOutputStream(dest)) {
                    if (out == null) throw new IOException("저장 파일을 열 수 없습니다.");
                    if (bytes != null) out.write(bytes);
                    else {
                        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
                        connection.setConnectTimeout(15000); connection.setReadTimeout(300000); connection.setInstanceFollowRedirects(false);
                        if (cookies != null) connection.setRequestProperty("Cookie", cookies);
                        try {
                            if (connection.getResponseCode() != 200) throw new IOException("다운로드 HTTP " + connection.getResponseCode());
                            try (InputStream in = connection.getInputStream()) { byte[] buffer = new byte[32768]; int n; while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n); }
                        } finally { connection.disconnect(); }
                    }
                    runOnUiThread(() -> { reply(callback, id, true, null); Toast.makeText(this, "저장했습니다.", Toast.LENGTH_SHORT).show(); });
                } catch (Exception e) { runOnUiThread(() -> { reply(callback, id, null, e.getMessage()); message("저장 실패: " + e.getMessage()); }); }
            });
        }
    }
    private void message(String text) { if (!isFinishing() && !isDestroyed()) dialog().setMessage(text).setPositiveButton("확인", null).show(); }
    /**
     * Back closes what is open in the page first -- a dialog, a menu, the
     * sidebar -- one per press (App.jsx answers 'ollama-native-back'). With
     * nothing open the app goes to the background, as other apps do; changing
     * server is in the account menu, not on the back button.
     */
    @Override public void onBackPressed() {
        if (web == null) { super.onBackPressed(); return; }
        WebView page = web;
        page.evaluateJavascript("(function(){var e=new Event('ollama-native-back',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented})()", handled -> {
            if ("true".equals(handled) || web != page) return;
            if (page.canGoBack()) page.goBack(); else moveTaskToBack(true);
        });
    }
    @Override protected void onDestroy() {
        denyMedia();
        if (fileResult != null) fileResult.onReceiveValue(null);
        stopService(new Intent(this, CaptureService.class)); CaptureService.result = null;
        if (web != null) web.destroy();
        if (proxy != null) proxy.close();
        io.shutdownNow(); super.onDestroy();
    }
}
