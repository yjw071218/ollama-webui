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
    private boolean connecting, notificationAllowed;
    private static final int MEDIA = 41, FILE = 42, SAVE = 43, CAPTURE = 44, NOTIFY = 45;
    private int dp(int n) { return (int) (getResources().getDisplayMetrics().density * n); }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("connection", MODE_PRIVATE);
        getWindow().setStatusBarColor(Color.rgb(17, 24, 39));
        getWindow().setNavigationBarColor(Color.rgb(17, 24, 39));
        showSetup();
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
        layout.setBackgroundColor(Color.rgb(17, 24, 39));
        setContentView(layout);
        layout.setOnApplyWindowInsetsListener((v, insets) -> {
            v.setPadding(dp(24), Math.max(dp(40), insets.getSystemWindowInsetTop()), dp(24), Math.max(dp(24), insets.getSystemWindowInsetBottom()));
            return insets;
        });
        TextView title = label("Ollama WebUI", 30); layout.addView(title);
        layout.addView(label("연결할 서버의 기본 주소를 입력하세요.", 16));
        EditText address = new EditText(this); address.setSingleLine(true);
        address.setTextColor(Color.WHITE); address.setHintTextColor(Color.LTGRAY);
        address.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        address.setHint("http://218.48.73.149.nip.io:5173/");
        address.setText(prefs.getString("server", "")); layout.addView(address);
        TextView warning = label("HTTP 통신은 암호화되지 않습니다. 대화·비밀번호·첨부 파일을 보호하려면 HTTPS를 사용하세요. 신뢰하는 서버에만 연결하세요.\n\n서버 변경 시 로그인 쿠키는 삭제됩니다. 서버별 앱 저장 데이터는 분리됩니다.", 14);
        warning.setTextColor(Color.rgb(252, 211, 77)); layout.addView(warning);
        Button connect = new Button(this); connect.setText("연결하기"); layout.addView(connect);
        connect.setOnClickListener(v -> {
            if (connecting) return;
            try {
                String server = LoopbackProxy.normalize(address.getText().toString());
                if (server.startsWith("http:")) new AlertDialog.Builder(this).setTitle("암호화되지 않은 연결")
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
    private void connect(String server, Button button) {
        connecting = true; button.setEnabled(false); button.setText("연결 중…");
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
                runOnUiThread(() -> { connecting = false; button.setEnabled(true); button.setText("연결하기");
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
    private void showWeb(String server) {
        layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackgroundColor(Color.rgb(17, 24, 39)); setContentView(layout);
        layout.setOnApplyWindowInsetsListener((v, insets) -> {
            v.setPadding(0, insets.getSystemWindowInsetTop(), 0, insets.getSystemWindowInsetBottom()); return insets;
        });
        LinearLayout toolbar = new LinearLayout(this);
        Button change = new Button(this); change.setText("서버 변경"); toolbar.addView(change);
        change.setOnClickListener(v -> new AlertDialog.Builder(this).setMessage("진행 중인 녹음·화면 캡처와 연결을 종료할까요?")
            .setNegativeButton("취소", null).setPositiveButton("변경", (d,w) -> { stopService(new Intent(this, CaptureService.class)); showSetup(); }).show());
        Button reload = new Button(this); reload.setText("새로고침"); toolbar.addView(reload); reload.setOnClickListener(v -> web.reload());
        layout.addView(toolbar);
        web = new WebView(this); layout.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false); s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setMediaPlaybackRequiresUserGesture(true); s.setSupportMultipleWindows(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (local(url)) return false;
                if (!request.isForMainFrame()) return true;
                if (url.startsWith(server + "/") || url.equals(server)) { view.loadUrl(proxy.origin + url.substring(server.length())); return true; }
                if ("http".equals(request.getUrl().getScheme()) || "https".equals(request.getUrl().getScheme()))
                    new AlertDialog.Builder(MainActivity.this).setTitle("외부 링크").setMessage(url).setNegativeButton("취소", null)
                        .setPositiveButton("브라우저로 열기", (d,w) -> { try { startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl())); } catch (Exception e) { message("링크를 열 앱이 없습니다."); } }).show();
                return true;
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) message("연결 실패: " + error.getDescription() + "\n상단에서 새로고침하거나 서버 주소를 변경하세요.");
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
                    new AlertDialog.Builder(MainActivity.this).setTitle("마이크 / 카메라 접근")
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
                new AlertDialog.Builder(MainActivity.this).setMessage(text).setPositiveButton("확인", (d,w) -> result.confirm()).setOnCancelListener(d -> result.cancel()).show(); return true;
            }
        });
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addWebMessageListener(web, "NativeHost", Collections.singleton(proxy.origin), (view, message, source, main, reply) -> {
                if (!main || !local(source.toString()) || message.getData() == null) return;
                handle(message.getData(), reply);
            });
            try (InputStream in = getAssets().open("native.js")) {
                String js = new String(readBytes(in, 100000), StandardCharsets.UTF_8);
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
                case "clipboardRead":
                    new AlertDialog.Builder(this).setTitle("클립보드 읽기").setMessage("현재 서버가 클립보드의 텍스트를 읽도록 허용할까요?")
                        .setNegativeButton("거부", (d,w) -> reply(reply, requestId, null, "클립보드 읽기를 거부했습니다."))
                        .setOnCancelListener(d -> reply(reply, requestId, null, "취소했습니다."))
                        .setPositiveButton("허용", (d,w) -> {
                            ClipData clip = ((android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE)).getPrimaryClip();
                            reply(reply, requestId, clip != null && clip.getItemCount() > 0 ? clip.getItemAt(0).coerceToText(this).toString() : "", null);
                        }).show(); break;
                case "notificationPermission":
                    if (permissionDone != null) throw new IllegalStateException("권한 요청이 진행 중입니다.");
                    new AlertDialog.Builder(this).setTitle("완료 알림").setMessage("이 서버에서 작업 완료 알림을 표시하도록 허용할까요?")
                        .setNegativeButton("거부", (d,w) -> reply(reply, requestId, "denied", null))
                        .setOnCancelListener(d -> reply(reply, requestId, "denied", null))
                        .setPositiveButton("허용", (d,w) -> {
                            permissionDone = () -> {
                                notificationAllowed = Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
                                reply(reply, requestId, notificationAllowed ? "granted" : "denied", null);
                            };
                            if (Build.VERSION.SDK_INT >= 33) requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFY);
                            else { permissionDone.run(); permissionDone = null; }
                        }).show(); break;
                case "notify":
                    if (!notificationAllowed) throw new SecurityException("알림 권한이 없습니다.");
                    NotificationManager manager = getSystemService(NotificationManager.class);
                    manager.createNotificationChannel(new NotificationChannel("jobs", "작업 완료", NotificationManager.IMPORTANCE_DEFAULT));
                    PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
                    manager.notify(request.optString("tag", "ollama").hashCode(), new Notification.Builder(this, "jobs")
                        .setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle(request.optString("title"))
                        .setContentText(request.optString("body")).setStyle(new Notification.BigTextStyle().bigText(request.optString("body")))
                        .setContentIntent(open).setAutoCancel(true).build());
                    reply(reply, id, true, null); break;
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
    private void message(String text) { if (!isFinishing() && !isDestroyed()) new AlertDialog.Builder(this).setMessage(text).setPositiveButton("확인", null).show(); }
    @Override public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else if (web != null) showSetup(); else super.onBackPressed();
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
