package io.github.yjw071218.ollamawebui.client;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.*;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
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
    private WebChromeClient.FileChooserParams fileParams;
    private Uri cameraOutput;
    private PermissionRequest mediaRequest;
    private String[] requestedResources;
    private Runnable permissionDone;
    private JavaScriptReplyProxy captureReply, saveReply;
    private String captureId, saveId, downloadURL;
    private byte[] saveBytes;
    private boolean connecting, notificationAllowed, pageReady, onSetup;
    /** The chat a tapped notification is about, until the page can be told. */
    private String pendingChat;
    /** What the page is asked to do once it is there: a new chat, a share (src/nativeEvents.js). */
    private final List<String> pendingActions = new ArrayList<>();
    private ConnectivityManager.NetworkCallback network;
    private static final int MEDIA = 41, FILE = 42, SAVE = 43, CAPTURE = 44, NOTIFY = 45, AUTH = 46, CAMERA_FOR_FILE = 47;
    private static final String EXTRA_CHAT = "chat";
    static final String ACTION_NEW_CHAT = "io.github.yjw071218.ollamawebui.client.NEW_CHAT";
    /** A new chat that starts listening: the home-screen widget's microphone. */
    static final String ACTION_VOICE = "io.github.yjw071218.ollamawebui.client.VOICE";
    /** "Reply" typed straight into a finished-answer notification. */
    static final String ACTION_REPLY = "io.github.yjw071218.ollamawebui.client.REPLY";
    static final String KEY_REPLY = "reply";
    /** A share from another app: 20 MB a file, 25 MB in all, ten files. */
    private static final int SHARE_FILE_MAX = 20 * 1024 * 1024, SHARE_TOTAL_MAX = 25 * 1024 * 1024, SHARE_FILES_MAX = 10;
    private static final int RECENT_MAX = 6;
    private int dp(int n) { return (int) (getResources().getDisplayMetrics().density * n); }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("connection", MODE_PRIVATE);
        if (state == null) takeIntent(getIntent());
        getWindow().setStatusBarColor(Color.rgb(17, 24, 39));
        getWindow().setNavigationBarColor(Color.rgb(17, 24, 39));
        // The address screen is for choosing a server, not a gate on every launch:
        // a saved server is opened directly, and "서버 변경" brings the screen back.
        String rejected = migrateSaved();
        String saved = prefs.getString("server", "");
        if (saved.isEmpty()) { showSetup(); if (rejected != null) message(rejected); }
        else { showSplash(); connect(saved, null); }
        watchNetwork();
        clearOldUpdates();
        checkUpdates(false);
    }
    /* ------------------------------------------------------------ palette */
    /** The phone's own light or dark, for the screens the app draws itself. */
    private boolean night() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }
    private int bg() { return night() ? Color.rgb(26, 25, 22) : Color.rgb(250, 249, 245); }
    private int ink() { return night() ? Color.rgb(238, 233, 224) : Color.rgb(36, 33, 29); }
    private int muted() { return night() ? Color.rgb(185, 179, 167) : Color.rgb(107, 100, 90); }
    private int field() { return night() ? Color.rgb(41, 38, 32) : Color.WHITE; }
    private int stroke() { return night() ? Color.rgb(81, 74, 64) : Color.rgb(217, 211, 199); }
    private int warn() { return night() ? Color.rgb(232, 196, 120) : Color.rgb(154, 106, 18); }
    @Override public void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config);
        // The address screen follows a theme switch made while it is open.
        if (onSetup && web == null && !connecting) showSetup();
    }

    /** Shown for the moment it takes to open the saved server. */
    private void showSplash() {
        onSetup = false;
        int color = prefs.getInt("chrome", Color.rgb(26, 25, 22));
        layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL);
        layout.setGravity(Gravity.CENTER);
        setContentView(layout);
        applyChrome(color);
        layout.addView(new ProgressBar(this));
        TextView text = label(L.t("연결 중…", "Connecting…"), 15); text.setGravity(Gravity.CENTER);
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
        catch (ActivityNotFoundException e) { message(L.t("로그인할 브라우저가 없습니다.", "There is no browser to sign in with.")); }
    }
    /**
     * A link from the page opens inside the app, in a Custom Tab over it --
     * back returns to the chat -- rather than leaving for the browser.
     */
    private void openLinkTab(Uri uri) {
        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        Bundle extras = new Bundle();
        extras.putBinder("android.support.customtabs.extra.SESSION", null);
        intent.putExtras(extras);
        intent.putExtra("android.support.customtabs.extra.TOOLBAR_COLOR", prefs.getInt("chrome", Color.rgb(26, 25, 22)));
        intent.putExtra("android.support.customtabs.extra.TITLE_VISIBILITY", 1);
        intent.putExtra("android.support.customtabs.extra.SHARE_STATE", 1);
        try { startActivity(intent); }
        catch (ActivityNotFoundException e) { message(L.t("링크를 열 앱이 없습니다.", "There is no app to open the link.")); }
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
        takeIntent(intent);
    }
    /** What an intent asks for: a notification's chat, a new chat (launcher shortcut), or a share. */
    private void takeIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (ACTION_REPLY.equals(action)) { takeReply(intent); return; }
        if (takeChat(intent)) deliverChat();
        if (ACTION_NEW_CHAT.equals(action)) {
            intent.setAction(Intent.ACTION_MAIN);
            queueAction("{\"type\":\"new-chat\"}");
        } else if (ACTION_VOICE.equals(action)) {
            intent.setAction(Intent.ACTION_MAIN);
            queueAction("{\"type\":\"voice\"}");
        } else if (Intent.ACTION_PROCESS_TEXT.equals(action)) {
            CharSequence picked = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT);
            intent.setAction(Intent.ACTION_MAIN);
            if (picked != null && picked.toString().trim().length() > 0) askAboutText(picked.toString());
        } else if (Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            intent.setAction(Intent.ACTION_MAIN);
            takeShare(intent);
        }
    }
    /** What a notification's reply field said: asked in the chat that notification was about. */
    private void takeReply(Intent intent) {
        intent.setAction(Intent.ACTION_MAIN);
        Bundle results = RemoteInput.getResultsFromIntent(intent);
        CharSequence said = results == null ? null : results.getCharSequence(KEY_REPLY);
        String chat = intent.getStringExtra(EXTRA_CHAT);
        String tag = intent.getStringExtra("tag");
        if (tag != null) getSystemService(NotificationManager.class).cancel(tag.hashCode());
        if (said == null || said.toString().trim().isEmpty()) { if (takeChat(intent)) deliverChat(); return; }
        intent.removeExtra(EXTRA_CHAT);
        try {
            JSONObject ask = new JSONObject().put("type", "ask").put("text", said.toString().trim());
            if (chat != null && !chat.isEmpty()) ask.put("chat", chat);
            queueAction(ask.toString());
        } catch (JSONException ignored) { }
    }
    /**
     * Text selected in another app and "Ollama WebUI에게 묻기" picked from the
     * selection menu: what to do with it, then a new question in the app.
     */
    private void askAboutText(String text) {
        final String quoted = "\n\n\"\"\"\n" + (text.length() > 60000 ? text.substring(0, 60000) : text).trim() + "\n\"\"\"";
        final String[] labels = {
            L.t("📝 요약", "📝 Summarise"), L.t("🌐 번역", "🌐 Translate"), L.t("💡 쉽게 설명", "💡 Explain"),
            L.t("✏️ 맞춤법·문장 다듬기", "✏️ Proofread"), L.t("💬 직접 질문하기…", "💬 Ask your own question…") };
        final String[] prompts = {
            L.t("다음 내용을 핵심만 간결하게 요약해 줘.", "Summarise the following briefly, keeping only what matters."),
            L.t("다음 내용을 번역해 줘. 한국어면 영어로, 그 밖의 언어면 한국어로 옮겨 줘.", "Translate the following. Into English if it is Korean, otherwise into Korean."),
            L.t("다음 내용을 쉽게 풀어서 설명해 줘.", "Explain the following in plain words."),
            L.t("다음 글의 맞춤법과 문장을 자연스럽게 다듬어 줘. 고친 글만 보여 줘.", "Proofread and smooth the following. Show only the corrected text."), "" };
        String preview = text.trim().replaceAll("\\s+", " ");
        if (preview.length() > 90) preview = preview.substring(0, 90) + "…";
        dialog().setTitle(L.t("선택한 글에 대해 묻기", "Ask about the selection")).setItems(labels, (d, which) -> {
            if (which < 4) { sendAsk(prompts[which] + quoted); return; }
            EditText input = new EditText(this);
            input.setHint(L.t("무엇이 궁금한가요?", "What would you like to know?"));
            input.setSingleLine(false); input.setMinLines(2);
            FrameLayout box = new FrameLayout(this); box.setPadding(dp(20), dp(8), dp(20), 0); box.addView(input);
            dialog().setTitle(L.t("직접 질문하기", "Ask your own question")).setView(box)
                .setNegativeButton(L.t("취소", "Cancel"), null)
                .setPositiveButton(L.t("보내기", "Send"), (d2, w2) -> {
                    String q = input.getText().toString().trim();
                    sendAsk((q.isEmpty() ? L.t("다음 내용에 대해 알려 줘.", "Tell me about the following.") : q) + quoted);
                }).show();
            input.requestFocus();
        }).setNegativeButton(L.t("취소", "Cancel"), null).show();
        Toast.makeText(this, preview, Toast.LENGTH_SHORT).show();
    }
    private void sendAsk(String text) {
        try { queueAction("{\"type\":\"new-chat\"}"); queueAction(new JSONObject().put("type", "ask").put("text", text).toString()); }
        catch (JSONException ignored) { }
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
    private void queueAction(String json) { pendingActions.add(json); deliverActions(); }
    /** Hand the page what it was asked to do, through the queue it reads (src/nativeEvents.js). */
    private void deliverActions() {
        if (pendingActions.isEmpty() || web == null || !pageReady || !local(web.getUrl())) return;
        for (String json : pendingActions)
            web.evaluateJavascript("(window.__ollamaNative=window.__ollamaNative||[]).push(" + json + ");window.dispatchEvent(new Event('ollama-native-action'))", null);
        pendingActions.clear();
    }
    /**
     * Text, pictures and documents shared from another app, read off the main
     * thread and attached to the composer. Kept until a server's page is open
     * -- a first launch shares into the address screen, then into the page.
     */
    private void takeShare(Intent intent) {
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            ArrayList<Uri> many = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (many != null) uris.addAll(many);
        } else {
            Uri one = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (one != null) uris.add(one);
        }
        String fallbackType = intent.getType();
        io.execute(() -> {
            try {
                JSONObject share = new JSONObject().put("type", "share");
                String body = text != null && !text.trim().isEmpty() ? text : (subject != null ? subject : "");
                share.put("text", body);
                JSONArray files = new JSONArray();
                long total = 0; int skipped = 0;
                for (Uri uri : uris) {
                    if (files.length() >= SHARE_FILES_MAX) { skipped++; continue; }
                    String name = "shared", type = getContentResolver().getType(uri);
                    try (Cursor c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                        if (c != null && c.moveToFirst() && !c.isNull(0)) name = c.getString(0);
                    } catch (Exception ignored) { }
                    byte[] bytes;
                    try (InputStream in = getContentResolver().openInputStream(uri)) {
                        if (in == null) { skipped++; continue; }
                        bytes = readBytes(in, SHARE_FILE_MAX);
                    } catch (IOException tooBig) { skipped++; continue; }
                    if (total + bytes.length > SHARE_TOTAL_MAX) { skipped++; continue; }
                    total += bytes.length;
                    files.put(new JSONObject().put("name", name)
                        .put("type", type != null ? type : (fallbackType != null && !fallbackType.contains("*") ? fallbackType : "application/octet-stream"))
                        .put("data", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)));
                }
                share.put("files", files);
                final int left = skipped;
                runOnUiThread(() -> {
                    if (files.length() > 0 || !body.isEmpty()) queueAction(share.toString());
                    if (left > 0) Toast.makeText(this, L.t("파일 " + left + "개는 너무 크거나 읽을 수 없어 빠졌습니다 (파일당 20 MB).", left + " file(s) were too large or unreadable and were left out (20 MB each)."), Toast.LENGTH_LONG).show();
                    if (web == null && !connecting && prefs.getString("server", "").isEmpty())
                        Toast.makeText(this, L.t("서버에 연결하면 공유한 내용이 입력창에 첨부됩니다.", "Connect to a server and what you shared is attached to the message box."), Toast.LENGTH_LONG).show();
                });
            } catch (Exception e) { runOnUiThread(() -> message(L.t("공유한 내용을 읽지 못했습니다: ", "Could not read what was shared: ") + e.getMessage())); }
        });
    }
    /** Dialogs in the page's own light or dark (the phone's, on the address screen). */
    private AlertDialog.Builder dialog() {
        boolean light = web != null ? luminance(prefs.getInt("chrome", Color.rgb(26, 25, 22))) > 0.6 : !night();
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
    /**
     * The network coming back reloads a page that could not reach the server
     * (LoopbackProxy's offline page marks itself), so Wi-Fi rejoining needs
     * no tap. The WebView is also told, for the page's own online/offline.
     */
    private void watchNetwork() {
        ConnectivityManager manager = getSystemService(ConnectivityManager.class);
        if (manager == null) return;
        network = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network n) {
                runOnUiThread(() -> {
                    if (web == null) return;
                    web.setNetworkAvailable(true);
                    web.evaluateJavascript("window.__ollamaOffline&&location.reload()", null);
                });
            }
            @Override public void onLost(Network n) { runOnUiThread(() -> { if (web != null) web.setNetworkAvailable(false); }); }
        };
        try { manager.registerDefaultNetworkCallback(network); } catch (Exception e) { network = null; }
    }
    private final List<Long> crashes = new ArrayList<>();
    /** Left open for days, the app still hears of a new version: checked again on return after six hours. */
    private static final long UPDATE_EVERY = 6L * 60 * 60 * 1000;
    private long lastUpdateCheck;
    @Override protected void onResume() {
        super.onResume();
        if (lastUpdateCheck > 0 && System.currentTimeMillis() - lastUpdateCheck > UPDATE_EVERY) checkUpdates(false);
    }
    private UpdateDialog updateDialog;
    /** Check GitHub; on news, the in-app update screen (UpdateDialog) downloads and installs it. */
    private void checkUpdates(boolean manual) {
        lastUpdateCheck = System.currentTimeMillis();
        if (updateDialog != null && updateDialog.showing()) return;
        io.execute(() -> {
            try {
                String current = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
                ReleaseUpdates.Update update = ReleaseUpdates.check(current);
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()) return;
                    if (update == null) { if (manual) message(L.t("최신 버전(" + current + ")을 사용 중입니다.", "You have the latest version (" + current + ").")); return; }
                    if (!manual && update.version.equals(prefs.getString("skippedUpdate", ""))) return;
                    updateDialog = new UpdateDialog(this, io, update, current);
                    updateDialog.show();
                });
            } catch (Exception e) { if (manual) runOnUiThread(() -> message(L.t("업데이트 확인에 실패했습니다. 네트워크 연결 또는 GitHub 요청 제한을 확인하세요.", "Could not check for updates. Check the network, or the GitHub request limit."))); }
        });
    }
    /** Installer files from an earlier update are not needed once this version runs. */
    private void clearOldUpdates() {
        io.execute(() -> {
            File[] old = new File(getCacheDir(), "updates").listFiles();
            if (old != null) for (File f : old) f.delete();
        });
    }
    /**
     * Addresses saved before only <IPv4>.nip.io:<port> was taken
     * (LoopbackProxy.normalize). An IPv4 one is written in the new form and
     * keeps its app port -- and so its sign-in and data, which belong to that
     * port's origin. Anything else (a web site saved as the server) is
     * dropped: the app opens on the address screen, saying why, instead of
     * on that site with no way back. Returns that sentence, or null.
     */
    private String migrateSaved() {
        String saved = prefs.getString("server", "");
        SharedPreferences.Editor edit = prefs.edit();
        String rejected = null;
        if (!saved.isEmpty()) {
            try {
                String server = LoopbackProxy.normalize(saved);
                if (!server.equals(saved)) {
                    edit.putString("server", server);
                    int port = prefs.getInt("port:" + saved, 0);
                    if (port != 0 && !prefs.contains("port:" + server)) edit.putInt("port:" + server, port);
                }
            } catch (Exception e) {
                edit.remove("server");
                rejected = saved + "\n" + L.t("저장된 주소가 Ollama WebUI 서버 주소 형식이 아니어서 지웠습니다. 0.0.0.0.nip.io:0000 형식으로 다시 입력하세요.",
                    "The saved address is not an Ollama WebUI server address and was removed. Enter it again as 0.0.0.0.nip.io:0000.");
            }
        }
        List<String> list = new ArrayList<>();
        try { JSONArray a = new JSONArray(prefs.getString("recent", "[]")); for (int i = 0; i < a.length(); i++) {
            try { String s = LoopbackProxy.normalize(a.getString(i)); if (!list.contains(s)) list.add(s); } catch (Exception ignored) { }
        } } catch (Exception ignored) { }
        edit.putString("recent", new JSONArray(list).toString()).apply();
        return rejected;
    }
    /* ----------------------------------------------------- recent servers */
    private List<String> recent() {
        List<String> list = new ArrayList<>();
        try { JSONArray a = new JSONArray(prefs.getString("recent", "[]")); for (int i = 0; i < a.length(); i++) list.add(a.getString(i)); }
        catch (Exception ignored) { }
        String saved = prefs.getString("server", "");
        if (list.isEmpty() && !saved.isEmpty()) list.add(saved);
        return list;
    }
    private void saveRecent(List<String> list) { prefs.edit().putString("recent", new JSONArray(list).toString()).apply(); }
    private void rememberRecent(String server) {
        List<String> list = recent(); list.remove(server); list.add(0, server);
        while (list.size() > RECENT_MAX) list.remove(list.size() - 1);
        saveRecent(list);
    }

    private void showSetup() {
        onSetup = true;
        denyMedia();
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (fileResult != null) { fileResult.onReceiveValue(null); fileResult = null; }
        stopService(new Intent(this, CaptureService.class));
        if (captureReply != null) { reply(captureReply, captureId, null, L.t("연결을 종료했습니다.", "Disconnected.")); captureReply = null; }
        if (web != null) { web.loadUrl("about:blank"); web.destroy(); web = null; }
        if (proxy != null) { proxy.close(); proxy = null; }
        notificationAllowed = false;
        layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(dp(24), dp(40), dp(24), dp(24));
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true);
        scroll.addView(layout);
        setContentView(scroll);
        int background = bg();
        scroll.setBackgroundColor(background);
        applyChrome(background);
        scroll.setOnApplyWindowInsetsListener((v, insets) -> {
            int[] b = bars(insets);
            layout.setPadding(dp(24) + b[0], Math.max(dp(40), b[1] + dp(16)), dp(24) + b[2], Math.max(dp(24), b[3] + dp(16)));
            return insets;
        });
        TextView title = label("Ollama WebUI", 28); title.setTypeface(android.graphics.Typeface.DEFAULT_BOLD); layout.addView(title);
        TextView intro = label(L.t("연결할 서버 주소를 입력하세요. PC에서 서버를 켰을 때 표시되는 주소입니다.", "Enter the server's address -- the one shown when the server starts on your PC."), 15);
        intro.setTextColor(muted()); layout.addView(intro);
        EditText address = new EditText(this); address.setSingleLine(true);
        address.setTextColor(ink()); address.setHintTextColor(night() ? Color.rgb(120, 114, 104) : Color.rgb(163, 154, 139));
        address.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        address.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_GO);
        address.setHint(L.t("예: ", "e.g. ") + LoopbackProxy.EXAMPLE);
        address.setBackground(rounded(field(), 12, stroke()));
        address.setPadding(dp(14), dp(12), dp(14), dp(12));
        address.setText(prefs.getString("server", ""));
        LinearLayout.LayoutParams fieldParams = new LinearLayout.LayoutParams(-1, -2); fieldParams.topMargin = dp(8); fieldParams.bottomMargin = dp(4);
        layout.addView(address, fieldParams);
        TextView form = label(L.t("0.0.0.0.nip.io:0000 형식으로 입력하세요. IP만 입력하면(192.168.0.5:5173) 자동으로 바꿔 줍니다.",
            "Enter it as 0.0.0.0.nip.io:0000. An IP address alone (192.168.0.5:5173) is written that way for you."), 13);
        form.setTextColor(muted()); form.setPadding(0, 0, 0, dp(4)); layout.addView(form);
        TextView warning = label(L.t("http://로 연결하면 내용이 암호화되지 않습니다. 집 밖에서 쓰거나 비밀번호를 보호하려면 https://를 쓰세요. 신뢰하는 서버에만 연결하세요.\n\n서버를 바꾸면 로그인 정보가 지워지고, 서버마다 앱 데이터가 따로 저장됩니다.",
            "Over http:// nothing is encrypted. Use https:// away from home or to protect passwords, and connect only to servers you trust.\n\nChanging server signs you out, and each server keeps its own app data."), 13);
        warning.setTextColor(warn()); layout.addView(warning);
        Button connect = button(L.t("연결하기", "Connect"), true);
        LinearLayout.LayoutParams primary = new LinearLayout.LayoutParams(-1, dp(50)); primary.topMargin = dp(8);
        layout.addView(connect, primary);
        // Servers used before, newest first: a tap connects, a long press removes.
        List<String> servers = recent();
        if (!servers.isEmpty()) {
            TextView heading = label(L.t("최근 연결한 서버", "Recent servers"), 13);
            heading.setTextColor(muted()); heading.setPadding(0, dp(18), 0, dp(4)); layout.addView(heading);
            for (String server : servers) {
                Button item = button(server, false);
                item.setGravity(Gravity.START | Gravity.CENTER_VERTICAL); item.setPadding(dp(14), 0, dp(14), 0);
                item.setTypeface(android.graphics.Typeface.MONOSPACE); item.setTextSize(14);
                item.setSingleLine(true); item.setEllipsize(android.text.TextUtils.TruncateAt.END);
                item.setOnClickListener(v -> { address.setText(server); connect.performClick(); });
                item.setOnLongClickListener(v -> {
                    dialog().setTitle(L.t("목록에서 지우기", "Remove from the list")).setMessage(server)
                        .setNegativeButton(L.t("취소", "Cancel"), null)
                        .setPositiveButton(L.t("지우기", "Remove"), (d, w) -> { List<String> list = recent(); list.remove(server); saveRecent(list); showSetup(); }).show();
                    return true;
                });
                LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, dp(46)); p.topMargin = dp(6);
                layout.addView(item, p);
            }
            TextView tip = label(L.t("길게 누르면 목록에서 지웁니다.", "Press and hold to remove one."), 12);
            tip.setTextColor(muted()); tip.setPadding(0, dp(6), 0, 0); layout.addView(tip);
        }
        Button updates = button(L.t("업데이트 확인", "Check for updates"), false);
        LinearLayout.LayoutParams secondary = new LinearLayout.LayoutParams(-1, dp(46)); secondary.topMargin = dp(18);
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
                if (server.startsWith("http:")) dialog().setTitle(L.t("암호화되지 않은 연결", "Unencrypted connection"))
                    .setMessage(server + "\n" + L.t("신뢰하는 서버인지 확인하세요. HTTP는 도청·변조 위험이 있습니다.", "Make sure you trust this server. HTTP can be read and altered on the way."))
                    .setNegativeButton(L.t("취소", "Cancel"), null).setPositiveButton(L.t("연결", "Connect"), (d,w) -> connect(server, connect)).show();
                else connect(server, connect);
            } catch (Exception e) { address.setError(e.getMessage()); }
        });
    }
    private TextView label(String text, int size) {
        TextView view = new TextView(this); view.setText(text); view.setTextSize(size); view.setTextColor(onSetup ? ink() : Color.WHITE);
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
        b.setBackground(primary ? rounded(Color.rgb(217, 119, 87), 12, 0) : rounded(field(), 12, stroke()));
        b.setTextColor(primary ? Color.WHITE : ink());
        if (primary) b.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        return b;
    }
    private void connect(String server, Button button) {
        connecting = true;
        if (button != null) { button.setEnabled(false); button.setText(L.t("연결 중…", "Connecting…")); }
        io.execute(() -> {
            try {
                /* Is it an Ollama WebUI server? Asked before anything is opened or
                   saved. A saved server that does not answer is still opened: the
                   page that says so retries by itself (LoopbackProxy). */
                try { LoopbackProxy.probe(server); }
                catch (LoopbackProxy.NotServerException notServer) { throw notServer; }
                catch (IOException unreachable) { if (button != null) throw new IOException(L.t("서버에 연결할 수 없습니다. 주소와 서버 실행 상태를 확인하세요.", "The server is not answering. Check the address and that the server is running."), unreachable); }
                int port = prefs.getInt("port:" + server, 0);
                LoopbackProxy candidate = new LoopbackProxy(server, port);
                if (port == 0) {
                    Set<Integer> used = new HashSet<>();
                    for (Map.Entry<String, ?> entry : prefs.getAll().entrySet())
                        if (entry.getKey().startsWith("port:") && entry.getValue() instanceof Integer) used.add((Integer) entry.getValue());
                    for (int attempt = 0; used.contains(candidate.port()); attempt++) {
                        candidate.close();
                        if (attempt > 50) throw new IOException(L.t("사용할 앱 포트가 없습니다.", "No free port for the app."));
                        candidate = new LoopbackProxy(server, 0);
                    }
                }
                final LoopbackProxy ready = candidate;
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()) { ready.close(); return; }
                    proxy = ready;
                    Runnable open = () -> {
                        prefs.edit().putString("server", server).putInt("port:" + server, ready.port()).apply();
                        rememberRecent(server);
                        CookieManager cm = CookieManager.getInstance();
                        cm.setCookie(ready.origin, LoopbackProxy.COOKIE + "=" + ready.token + "; Path=/; HttpOnly; SameSite=Strict", ok -> {
                            connecting = false;
                            if (!ok) { showSetup(); message(L.t("앱 연결 쿠키를 설정하지 못했습니다.", "Could not set the app's connection cookie.")); return; }
                            cm.flush(); showWeb(server);
                        });
                    };
                    // Cookies are host-scoped, not port-scoped: clear them on server changes.
                    if (!server.equals(prefs.getString("server", ""))) CookieManager.getInstance().removeAllCookies(ok -> open.run());
                    else open.run();
                });
            } catch (Exception e) {
                runOnUiThread(() -> { connecting = false;
                    if (button != null) { button.setEnabled(true); button.setText(L.t("연결하기", "Connect")); } else showSetup();
                    message(e instanceof BindException ? L.t("저장된 앱 포트가 사용 중입니다. 앱을 완전히 종료하고 다시 열어 주세요.", "The app's saved port is in use. Close the app completely and open it again.")
                        : e instanceof LoopbackProxy.NotServerException || e.getCause() != null ? server + "\n" + e.getMessage()
                        : L.t("연결 준비 실패: ", "Could not prepare the connection: ") + e.getMessage()); });
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
        dialog().setTitle(L.t("서버 변경", "Change server")).setMessage(L.t("현재 연결과 진행 중인 녹음·화면 캡처를 종료하고 서버 주소 화면으로 이동할까요?", "End this connection, and any recording or screen capture, and go to the server address screen?"))
            .setNegativeButton(L.t("취소", "Cancel"), (d,w) -> { if (cancelled != null) cancelled.run(); })
            .setOnCancelListener(d -> { if (cancelled != null) cancelled.run(); })
            .setPositiveButton(L.t("변경", "Change"), (d,w) -> { stopService(new Intent(this, CaptureService.class)); showSetup(); }).show();
    }
    private void showWeb(String server) {
        onSetup = false;
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
                    openLinkTab(request.getUrl());
                return true;
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) { pageReady = false; }
            @Override public void onPageFinished(WebView view, String url) {
                pageReady = local(url);
                deliverChat();
                deliverActions();
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame() || isFinishing() || isDestroyed()) return;
                dialog().setTitle(L.t("연결 실패", "Connection failed")).setMessage(server + "\n" + error.getDescription())
                    .setCancelable(false)
                    .setNegativeButton(L.t("서버 변경", "Change server"), (d,w) -> { stopService(new Intent(MainActivity.this, CaptureService.class)); showSetup(); })
                    .setPositiveButton(L.t("다시 시도", "Try again"), (d,w) -> { if (web != null) web.reload(); }).show();
            }
            /* The page's process died (out of memory, mostly). Not handled, Android
               ends the whole app; instead the page is opened again in a fresh
               WebView -- unless it keeps happening, then the address screen. */
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                long now = System.currentTimeMillis();
                crashes.removeIf(t -> now - t > 60000); crashes.add(now);
                if (web == view) web = null;
                ViewParent parent = view.getParent();
                if (parent instanceof ViewGroup) ((ViewGroup) parent).removeView(view);
                view.destroy();
                if (isFinishing() || isDestroyed()) return true;
                if (crashes.size() > 2 || proxy == null) { crashes.clear(); showSetup(); message(L.t("페이지가 반복해서 종료되어 연결을 닫았습니다.", "The page kept stopping, so the connection was closed.")); }
                else showWeb(server);
                return true;
            }
            @Override public void onReceivedSslError(WebView view, android.webkit.SslErrorHandler handler, android.net.http.SslError error) {
                handler.cancel(); message(L.t("서버 인증서를 확인할 수 없습니다. 인증서 검증을 우회하지 않습니다.", "The server's certificate could not be verified. The check is not bypassed."));
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
                    /* "항상 허용" is kept per server and per kind (microphone,
                       camera): voice input used to ask on every tap. Android's
                       own permission is still asked for, and still decides. */
                    List<String> always = new ArrayList<>();
                    for (String p : permissions) always.add("always:media:" + p + ":" + server);
                    boolean remembered = true;
                    for (String key : always) remembered &= prefs.getBoolean(key, false);
                    String[] needed = permissions.toArray(new String[0]);
                    if (remembered) { requestPermissions(needed, MEDIA); return; }
                    String what = permissions.size() == 2 ? L.t("마이크·카메라", "microphone and camera")
                        : permissions.contains(Manifest.permission.CAMERA) ? L.t("카메라", "camera") : L.t("마이크", "microphone");
                    dialog().setTitle(L.t("마이크 / 카메라 접근", "Microphone / camera"))
                        .setMessage(server + "\n" + L.t("이 서버가 " + what + "를 사용하도록 허용할까요?", "Let this server use the " + what + "?"))
                        .setNegativeButton(L.t("거부", "Deny"), (d,w) -> denyMedia())
                        .setOnCancelListener(d -> denyMedia())
                        .setNeutralButton(L.t("항상 허용", "Always allow"), (d,w) -> {
                            if (mediaRequest != request || web == null || !local(web.getUrl())) return;
                            SharedPreferences.Editor edit = prefs.edit();
                            for (String key : always) edit.putBoolean(key, true);
                            edit.apply();
                            requestPermissions(needed, MEDIA);
                        })
                        .setPositiveButton(L.t("이번만 허용", "Allow once"), (d,w) -> {
                            if (mediaRequest != request || web == null || !local(web.getUrl())) return;
                            requestPermissions(needed, MEDIA);
                        }).show();
                });
            }
            @Override public void onPermissionRequestCanceled(PermissionRequest request) { if (mediaRequest == request) mediaRequest = null; }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams parameters) {
                if (fileResult != null) fileResult.onReceiveValue(null);
                fileResult = callback; fileParams = parameters;
                // A picture can be taken there and then: the camera is offered beside the files.
                if (wantsImages(parameters) && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED
                    && !prefs.getBoolean("cameraAsked", false)) {
                    prefs.edit().putBoolean("cameraAsked", true).apply();
                    requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_FOR_FILE);
                    return true;
                }
                openFileChooser();
                return true;
            }
            @Override public boolean onJsAlert(WebView view, String url, String text, JsResult result) {
                dialog().setMessage(text).setPositiveButton(L.t("확인", "OK"), (d,w) -> result.confirm()).setOnCancelListener(d -> result.cancel()).show(); return true;
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
            } catch (Exception e) { message(L.t("앱 확장 초기화 실패: ", "The app extension did not start: ") + e.getMessage()); }
        } else message(L.t("Android System WebView를 업데이트해야 화면 캡처·공유·알림 확장을 사용할 수 있습니다.", "Update Android System WebView to use screen capture, sharing and notifications."));
        web.setDownloadListener((url, agent, disposition, type, length) -> {
            if (!local(url)) { message(L.t("외부 다운로드는 기본 브라우저에서 열어 주세요.", "Open outside downloads in your browser.")); return; }
            if (saveId != null || downloadURL != null) { message(L.t("다른 저장 작업이 진행 중입니다.", "Another save is in progress.")); return; }
            downloadURL = url; chooseSave(URLUtil.guessFileName(url, disposition, type), type);
        });
        web.loadUrl(proxy.origin + "/");
    }
    /* ------------------------------------------------------- file chooser */
    private static boolean wantsImages(WebChromeClient.FileChooserParams p) {
        if (p == null) return false;
        String[] types = p.getAcceptTypes();
        if (types == null || types.length == 0) return true;
        boolean any = false;
        for (String t : types) {
            if (t == null || t.trim().isEmpty()) continue;
            any = true;
            String v = t.trim().toLowerCase(Locale.ROOT);
            if (v.startsWith("image/") || v.equals("*/*") || v.matches("\\.(png|jpe?g|webp|heic|gif)")) return true;
        }
        return !any;
    }
    /** Files, with the camera offered beside them when pictures are wanted and allowed. */
    private void openFileChooser() {
        if (fileResult == null) return;
        WebChromeClient.FileChooserParams parameters = fileParams;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE);
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, parameters != null && parameters.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE);
        String[] types = parameters == null ? new String[0] : Arrays.stream(parameters.getAcceptTypes()).filter(t -> t.contains("/")).toArray(String[]::new);
        if (types.length > 0) intent.putExtra(Intent.EXTRA_MIME_TYPES, types);
        Intent chooser = intent;
        cameraOutput = null;
        if (wantsImages(parameters) && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            try {
                File dir = new File(getCacheDir(), "camera"); dir.mkdirs();
                File[] old = dir.listFiles(); if (old != null) for (File f : old) f.delete();
                File photo = new File(dir, "photo-" + System.currentTimeMillis() + ".jpg");
                cameraOutput = FileProvider.getUriForFile(this, getPackageName() + ".files", photo);
                Intent camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, cameraOutput)
                    .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                camera.setClipData(ClipData.newRawUri("photo", cameraOutput));
                chooser = Intent.createChooser(intent, L.t("첨부할 파일 또는 사진", "Attach a file or a photo"));
                chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{camera});
            } catch (Exception e) { cameraOutput = null; chooser = intent; }
        }
        try { startActivityForResult(chooser, FILE); } catch (Exception e) { fileResult.onReceiveValue(null); fileResult = null; }
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
            if (data.length() > 29000000) throw new IllegalArgumentException(L.t("파일이 너무 큽니다.", "The file is too large."));
            JSONObject request = new JSONObject(data); id = request.getString("id");
            String method = request.getString("method"), requestId = id;
            switch (method) {
                case "capture":
                    if (captureReply != null) throw new IllegalStateException(L.t("화면 캡처가 이미 진행 중입니다.", "A screen capture is already running."));
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
                    startActivity(Intent.createChooser(send, L.t("공유", "Share"))); reply(reply, id, true, null); break;
                case "save":
                    if (saveId != null || downloadURL != null) throw new IllegalStateException(L.t("다른 저장 작업이 진행 중입니다.", "Another save is in progress."));
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
                    dialog().setTitle(L.t("클립보드 읽기", "Read the clipboard")).setMessage(L.t("현재 서버가 클립보드의 텍스트를 읽도록 허용할까요?", "Let this server read the text on the clipboard?"))
                        .setNegativeButton(L.t("거부", "Deny"), (d,w) -> reply(reply, requestId, null, L.t("클립보드 읽기를 거부했습니다.", "Reading the clipboard was denied.")))
                        .setOnCancelListener(d -> reply(reply, requestId, null, L.t("취소했습니다.", "Cancelled.")))
                        .setNeutralButton(L.t("항상 허용", "Always allow"), (d,w) -> { prefs.edit().putBoolean(always, true).apply(); readClip.run(); })
                        .setPositiveButton(L.t("이번만 허용", "Allow once"), (d,w) -> readClip.run()).show(); break;
                }
                case "notificationPermission": {
                    if (permissionDone != null) throw new IllegalStateException(L.t("권한 요청이 진행 중입니다.", "A permission request is in progress."));
                    String key = "notify:" + prefs.getString("server", "");
                    if (notificationAllowed && notificationsAllowedBySystem()) { reply(reply, id, "granted", null); break; }
                    dialog().setTitle(L.t("완료 알림", "Notifications")).setMessage(L.t("이 서버에서 작업 완료 알림을 표시하도록 허용할까요?", "Let this server notify you when work is done?"))
                        .setNegativeButton(L.t("거부", "Deny"), (d,w) -> reply(reply, requestId, "denied", null))
                        .setOnCancelListener(d -> reply(reply, requestId, "denied", null))
                        .setPositiveButton(L.t("허용", "Allow"), (d,w) -> {
                            permissionDone = () -> {
                                notificationAllowed = notificationsAllowedBySystem();
                                // Kept per server, so the next launch does not quietly forget it.
                                prefs.edit().putBoolean(key, notificationAllowed).apply();
                                if (!notificationAllowed && Build.VERSION.SDK_INT >= 33
                                    && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
                                    message(L.t("휴대폰 설정에서 이 앱의 알림이 꺼져 있습니다. 설정 › 앱 › Ollama WebUI › 알림에서 켜 주세요.", "Notifications for this app are off. Turn them on in Settings › Apps › Ollama WebUI › Notifications."));
                                reply(reply, requestId, notificationAllowed ? "granted" : "denied", null);
                            };
                            if (Build.VERSION.SDK_INT >= 33) requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFY);
                            else { permissionDone.run(); permissionDone = null; }
                        }).show(); break;
                }
                case "notify": {
                    if (!notificationAllowed || !notificationsAllowedBySystem()) throw new SecurityException(L.t("알림 권한이 없습니다.", "Notifications are not allowed."));
                    NotificationManager manager = getSystemService(NotificationManager.class);
                    manager.createNotificationChannel(new NotificationChannel("jobs", L.t("작업 완료", "Work done"), NotificationManager.IMPORTANCE_DEFAULT));
                    String tag = request.optString("tag", "ollama"), chat = request.optString("chat", "");
                    // Tapping it opens the chat it is about; one PendingIntent per tag so their chats differ.
                    Intent target = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
                    if (!chat.isEmpty()) target.putExtra(EXTRA_CHAT, chat);
                    PendingIntent open = PendingIntent.getActivity(this, tag.hashCode(), target, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
                    Notification.Builder note = new Notification.Builder(this, "jobs")
                        .setSmallIcon(R.drawable.ic_notification).setColor(Color.rgb(217, 119, 87))
                        .setContentTitle(request.optString("title"))
                        .setContentText(request.optString("body")).setStyle(new Notification.BigTextStyle().bigText(request.optString("body")))
                        .setContentIntent(open).setAutoCancel(true);
                    // Answer straight from the notification: the reply is asked in that chat.
                    Intent replyTarget = new Intent(this, MainActivity.class).setAction(ACTION_REPLY).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
                        .putExtra("tag", tag);
                    if (!chat.isEmpty()) replyTarget.putExtra(EXTRA_CHAT, chat);
                    int mutable = Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0;
                    PendingIntent replyIntent = PendingIntent.getActivity(this, ("reply:" + tag).hashCode(), replyTarget, mutable | PendingIntent.FLAG_UPDATE_CURRENT);
                    RemoteInput field = new RemoteInput.Builder(KEY_REPLY).setLabel(L.t("이어서 질문하기…", "Ask a follow-up…")).build();
                    note.addAction(new Notification.Action.Builder(android.graphics.drawable.Icon.createWithResource(this, R.drawable.ic_shortcut_chat), L.t("답장", "Reply"), replyIntent)
                        .addRemoteInput(field).setAllowGeneratedReplies(true).build());
                    manager.notify(tag.hashCode(), note.build());
                    reply(reply, id, true, null); break;
                }
                case "busy":
                    // The screen stays on while an answer is being written, and only then.
                    if (request.optBoolean("value")) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    reply(reply, id, true, null); break;
                case "changeServer":
                    confirmChangeServer(() -> reply(reply, requestId, false, null)); break;
                case "checkUpdates":
                    checkUpdates(true); reply(reply, id, true, null); break;
                case "chrome": {
                    String value = request.optString("color");
                    if (!value.matches("#[0-9a-fA-F]{6}")) throw new IllegalArgumentException(L.t("잘못된 색상입니다.", "Not a colour."));
                    int color = Color.parseColor(value);
                    prefs.edit().putInt("chrome", color).apply(); applyChrome(color);
                    reply(reply, id, true, null); break;
                }
                default: throw new IllegalArgumentException(L.t("지원하지 않는 앱 요청입니다.", "Not something the app can do."));
            }
        } catch (Exception e) { reply(reply, id, null, e.getMessage()); }
    }
    private static String safeName(String name) { return name.replaceAll("[^a-zA-Z0-9._가-힣-]", "_").replaceAll("^\\.+", "_"); }
    private static byte[] decode(String value) {
        if (value.length() > 28000000) throw new IllegalArgumentException(L.t("파일당 20 MB까지 지원합니다.", "Up to 20 MB a file."));
        return android.util.Base64.decode(value, android.util.Base64.DEFAULT);
    }
    private void chooseSave(String name, String type) {
        try { startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType(type == null || type.isEmpty() ? "application/octet-stream" : type).putExtra(Intent.EXTRA_TITLE, safeName(name)), SAVE); }
        catch (Exception e) { reply(saveReply, saveId, null, e.getMessage()); resetSave(); message(L.t("저장 위치를 선택할 수 없습니다.", "Could not choose where to save.")); }
    }
    private void resetSave() { saveId = null; saveReply = null; saveBytes = null; downloadURL = null; }
    private static byte[] readBytes(InputStream in, int limit) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buf = new byte[8192]; int n;
        while ((n = in.read(buf)) != -1) { if (out.size() + n > limit) throw new IOException(L.t("파일이 너무 큽니다.", "The file is too large.")); out.write(buf, 0, n); }
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
        // Allowed or not, the files open; with the camera beside them if it was allowed.
        if (code == CAMERA_FOR_FILE) openFileChooser();
    }
    @Override protected void onActivityResult(int code, int result, Intent intent) {
        super.onActivityResult(code, result, intent);
        if (code == AUTH) { nudgeAuth(); return; }
        if (code == UpdateDialog.INSTALL_PERMISSION) { if (updateDialog != null) updateDialog.onPermissionResult(); return; }
        if (code == FILE && fileResult != null) {
            Uri[] picked = WebChromeClient.FileChooserParams.parseResult(result, intent);
            /* Several files come back as ClipData, which parseResult ignores: only
               the first photo of a multi-select reached the page. */
            if (result == RESULT_OK && intent != null && intent.getClipData() != null && intent.getClipData().getItemCount() > 0) {
                ClipData clip = intent.getClipData();
                java.util.ArrayList<Uri> all = new java.util.ArrayList<>();
                for (int i = 0; i < clip.getItemCount(); i++) { Uri u = clip.getItemAt(i).getUri(); if (u != null && !all.contains(u)) all.add(u); }
                if (!all.isEmpty()) picked = all.toArray(new Uri[0]);
            }
            // A photo just taken comes back with no data: it is in the file it was given.
            if ((picked == null || picked.length == 0) && result == RESULT_OK && cameraOutput != null) {
                File photo = new File(new File(getCacheDir(), "camera"), cameraOutput.getLastPathSegment());
                if (photo.length() > 0) picked = new Uri[]{cameraOutput};
            }
            fileResult.onReceiveValue(picked); fileResult = null; cameraOutput = null;
        }
        if (code == CAPTURE) {
            if (result != RESULT_OK || intent == null) { reply(captureReply, captureId, null, null); captureReply = null; return; }
            CaptureService.result = (image, error) -> runOnUiThread(() -> { reply(captureReply, captureId, image, error); captureReply = null; });
            startForegroundService(new Intent(this, CaptureService.class).putExtra("code", result).putExtra("data", intent));
        }
        if (code == SAVE) {
            if (result != RESULT_OK || intent == null || intent.getData() == null) { reply(saveReply, saveId, null, L.t("저장을 취소했습니다.", "Saving was cancelled.")); resetSave(); return; }
            Uri dest = intent.getData(); byte[] bytes = saveBytes; String url = downloadURL;
            String cookies = url == null ? null : CookieManager.getInstance().getCookie(url);
            JavaScriptReplyProxy callback = saveReply; String id = saveId; resetSave();
            io.execute(() -> {
                try (OutputStream out = getContentResolver().openOutputStream(dest)) {
                    if (out == null) throw new IOException(L.t("저장 파일을 열 수 없습니다.", "Could not open the file to save into."));
                    if (bytes != null) out.write(bytes);
                    else {
                        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
                        connection.setConnectTimeout(15000); connection.setReadTimeout(300000); connection.setInstanceFollowRedirects(false);
                        if (cookies != null) connection.setRequestProperty("Cookie", cookies);
                        try {
                            if (connection.getResponseCode() != 200) throw new IOException(L.t("다운로드 HTTP ", "Download HTTP ") + connection.getResponseCode());
                            try (InputStream in = connection.getInputStream()) { byte[] buffer = new byte[32768]; int n; while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n); }
                        } finally { connection.disconnect(); }
                    }
                    runOnUiThread(() -> { reply(callback, id, true, null); Toast.makeText(this, L.t("저장했습니다.", "Saved."), Toast.LENGTH_SHORT).show(); });
                } catch (Exception e) { runOnUiThread(() -> { reply(callback, id, null, e.getMessage()); message(L.t("저장 실패: ", "Could not save: ") + e.getMessage()); }); }
            });
        }
    }
    private void message(String text) { if (!isFinishing() && !isDestroyed()) dialog().setMessage(text).setPositiveButton(L.t("확인", "OK"), null).show(); }
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
        if (network != null) { try { getSystemService(ConnectivityManager.class).unregisterNetworkCallback(network); } catch (Exception ignored) { } }
        if (web != null) web.destroy();
        if (proxy != null) proxy.close();
        io.shutdownNow(); super.onDestroy();
    }
}
