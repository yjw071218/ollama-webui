package io.github.yjw071218.ollamawebui.client;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.graphics.*;
import android.hardware.display.*;
import android.media.*;
import android.media.projection.*;
import android.os.*;
import android.util.*;
import java.io.*;
import java.nio.ByteBuffer;
import java.util.function.BiConsumer;

public class CaptureService extends Service {
    public static BiConsumer<String, String> result;
    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean finished;
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("capture", "화면 캡처", NotificationManager.IMPORTANCE_LOW));
        Notification notification = new Notification.Builder(this, "capture").setSmallIcon(android.R.drawable.ic_menu_camera)
            .setContentTitle("화면을 한 장 캡처하는 중").setContentText("캡처 후 화면 공유가 즉시 종료됩니다.").build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(7301, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        else startForeground(7301, notification);
        try {
            if (intent == null) throw new IOException("화면 캡처 요청이 없습니다.");
            Intent consent = intent.getParcelableExtra("data");
            projection = getSystemService(MediaProjectionManager.class).getMediaProjection(intent.getIntExtra("code", 0), consent);
            if (projection == null) throw new IOException("화면 캡처 권한이 없습니다.");
            projection.registerCallback(new MediaProjection.Callback() {
                @Override public void onStop() { finish(null, "화면 공유가 종료되었습니다."); }
            }, handler);
            DisplayMetrics metrics = getResources().getDisplayMetrics();
            int width = metrics.widthPixels, height = metrics.heightPixels;
            reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
            long readyAt = SystemClock.elapsedRealtime() + 1500;
            reader.setOnImageAvailableListener(source -> {
                if (finished) return;
                try (Image image = source.acquireLatestImage()) {
                    if (image == null || SystemClock.elapsedRealtime() < readyAt) return;
                    Image.Plane plane = image.getPlanes()[0];
                    ByteBuffer buffer = plane.getBuffer();
                    int paddedWidth = plane.getRowStride() / plane.getPixelStride();
                    Bitmap padded = Bitmap.createBitmap(paddedWidth, image.getHeight(), Bitmap.Config.ARGB_8888);
                    padded.copyPixelsFromBuffer(buffer);
                    Bitmap cropped = Bitmap.createBitmap(padded, 0, 0, image.getWidth(), image.getHeight());
                    float scale = Math.min(1f, 1920f / Math.max(cropped.getWidth(), cropped.getHeight()));
                    Bitmap scaled = Bitmap.createScaledBitmap(cropped, Math.max(1, Math.round(cropped.getWidth() * scale)), Math.max(1, Math.round(cropped.getHeight() * scale)), true);
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    scaled.compress(Bitmap.CompressFormat.JPEG, 86, out);
                    String encoded = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
                    if (scaled != cropped) scaled.recycle();
                    if (cropped != padded) cropped.recycle();
                    padded.recycle();
                    handler.post(() -> finish(encoded, null));
                } catch (Exception e) { handler.post(() -> finish(null, e.getMessage())); }
            }, handler);
            display = projection.createVirtualDisplay("Ollama WebUI screenshot", width, height, metrics.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, handler);
            handler.postDelayed(() -> finish(null, "화면 캡처 시간이 초과되었습니다."), 15000);
        } catch (Exception e) { finish(null, e.getMessage()); }
        return START_NOT_STICKY;
    }
    private void finish(String image, String error) {
        if (finished) return;
        finished = true;
        BiConsumer<String, String> callback = result; result = null;
        if (callback != null) callback.accept(image, error);
        cleanup(); stopSelf();
    }
    private void cleanup() {
        handler.removeCallbacksAndMessages(null);
        if (display != null) { display.release(); display = null; }
        if (reader != null) { reader.close(); reader = null; }
        if (projection != null) { projection.stop(); projection = null; }
        stopForeground(STOP_FOREGROUND_REMOVE);
    }
    @Override public void onDestroy() { finish(null, "화면 캡처를 취소했습니다."); cleanup(); super.onDestroy(); }
}
