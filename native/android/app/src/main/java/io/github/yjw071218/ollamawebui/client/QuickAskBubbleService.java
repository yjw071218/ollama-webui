package io.github.yjw071218.ollamawebui.client;

import android.animation.ValueAnimator;
import android.app.*;
import android.content.*;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.IBinder;
import android.provider.Settings;
import android.view.*;
import android.view.animation.DecelerateInterpolator;
import android.view.animation.OvershootInterpolator;

/**
 * The floating button. Explicitly enabled by the user.
 *
 * Drawn in the app's own palette -- the warm dark surface and the terracotta
 * accent of the chat -- rather than a purple orb that belonged to nothing.
 * It rests half-faded against the nearest edge, wakes on touch, can be
 * dragged anywhere, and snaps back to an edge when let go.
 *
 * A tap reads the screen first (ScreenContextService, when the user has turned
 * it on) so the floating AI knows what is in front of them, then opens it.
 */
public final class QuickAskBubbleService extends Service {
    private WindowManager manager;
    private BubbleView bubble;
    private WindowManager.LayoutParams position;
    private SharedPreferences preferences;
    private static final int SIZE = 52;
    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public int onStartCommand(Intent intent, int flags, int id) {
        if (intent != null && "stop".equals(intent.getAction())) { stopSelf(); return START_NOT_STICKY; }
        if (!Settings.canDrawOverlays(this)) { stopSelf(); return START_NOT_STICKY; }
        NotificationManager notifications = getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(new NotificationChannel("quick-ask-bubble", L.t("AI 플로팅 버튼", "AI floating button"), NotificationManager.IMPORTANCE_LOW));
        PendingIntent stop = PendingIntent.getService(this, 91, new Intent(this, QuickAskBubbleService.class).setAction("stop"), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        startForeground(902, new Notification.Builder(this, "quick-ask-bubble").setSmallIcon(R.drawable.ic_notification)
            .setColor(Color.rgb(217, 119, 87))
            .setContentTitle(L.t("AI에게 묻기", "Ask AI")).setContentText(L.t("버튼을 눌러 질문 · 길게 눌러 닫기", "Tap to ask, hold to close"))
            .setOngoing(true).addAction(new Notification.Action.Builder(null, L.t("버튼 끄기", "Turn off"), stop).build()).build());
        if (bubble == null) showBubble();
        else bubble.setVisibility(View.VISIBLE);
        return START_NOT_STICKY;
    }

    /** The button itself: a dark disc, a thin accent ring, a four-point spark. */
    private final class BubbleView extends View {
        private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG), ring = new Paint(Paint.ANTI_ALIAS_FLAG),
            spark = new Paint(Paint.ANTI_ALIAS_FLAG), glow = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path star = new Path();
        float pressed;
        BubbleView(Context c) {
            super(c);
            boolean night = (getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
                == android.content.res.Configuration.UI_MODE_NIGHT_YES;
            fill.setColor(night ? Color.rgb(38, 36, 32) : Color.rgb(31, 30, 27));
            ring.setStyle(Paint.Style.STROKE); ring.setStrokeWidth(dp(1.5f)); ring.setColor(Color.argb(150, 217, 119, 87));
            spark.setColor(Color.rgb(217, 119, 87));
            glow.setColor(Color.argb(40, 217, 119, 87));
            setLayerType(LAYER_TYPE_HARDWARE, null);
        }
        @Override protected void onDraw(Canvas canvas) {
            float w = getWidth(), h = getHeight(), cx = w / 2f, cy = h / 2f;
            float r = Math.min(w, h) / 2f - dp(4);
            canvas.drawCircle(cx, cy, r + dp(3) * pressed, glow);
            canvas.drawCircle(cx, cy, r, fill);
            canvas.drawCircle(cx, cy, r - dp(1), ring);
            float s = r * 0.52f, t = s * 0.22f;
            star.reset();
            star.moveTo(cx, cy - s);
            star.quadTo(cx + t, cy - t, cx + s, cy);
            star.quadTo(cx + t, cy + t, cx, cy + s);
            star.quadTo(cx - t, cy + t, cx - s, cy);
            star.quadTo(cx - t, cy - t, cx, cy - s);
            star.close();
            canvas.drawPath(star, spark);
            float m = s * 0.34f, mx = cx + s * 0.78f, my = cy - s * 0.78f, mt = m * 0.22f;
            star.reset();
            star.moveTo(mx, my - m); star.quadTo(mx + mt, my - mt, mx + m, my); star.quadTo(mx + mt, my + mt, mx, my + m);
            star.quadTo(mx - mt, my + mt, mx - m, my); star.quadTo(mx - mt, my - mt, mx, my - m); star.close();
            canvas.drawPath(star, spark);
        }
    }

    private void showBubble() {
        manager = getSystemService(WindowManager.class);
        preferences = getSharedPreferences("bubble", MODE_PRIVATE);
        bubble = new BubbleView(this);
        bubble.setContentDescription(L.t("AI에게 묻기. 끌어서 이동, 길게 눌러 닫기", "Ask AI. Drag to move, hold to close"));
        bubble.setElevation(dp(6));
        GradientDrawable shadowShape = new GradientDrawable(); shadowShape.setShape(GradientDrawable.OVAL); shadowShape.setColor(Color.TRANSPARENT);
        bubble.setOutlineProvider(new ViewOutlineProvider() {
            @Override public void getOutline(View view, android.graphics.Outline outline) {
                int inset = dp(4); outline.setOval(inset, inset, view.getWidth() - inset, view.getHeight() - inset);
            }
        });
        position = new WindowManager.LayoutParams(dp(SIZE), dp(SIZE), WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT);
        position.gravity = Gravity.TOP | Gravity.LEFT;
        position.x = preferences.getInt("x", dp(6)); position.y = preferences.getInt("y", dp(220));
        clamp();
        bubble.setAlpha(0.72f);
        bubble.setOnClickListener(v -> open());
        bubble.setOnLongClickListener(v -> {
            v.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
            stopSelf(); return true;
        });
        bubble.setOnTouchListener(new View.OnTouchListener() {
            float startX, startY; int x, y; boolean dragged;
            public boolean onTouch(View view, MotionEvent e) {
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        startX = e.getRawX(); startY = e.getRawY(); x = position.x; y = position.y; dragged = false;
                        press(true);
                        return false;
                    case MotionEvent.ACTION_MOVE: {
                        float dx = e.getRawX() - startX, dy = e.getRawY() - startY;
                        if (!dragged && Math.abs(dx) + Math.abs(dy) > dp(8)) { dragged = true; view.cancelLongPress(); }
                        if (dragged) {
                            position.x = x + (int) dx; position.y = y + (int) dy;
                            clamp();
                            manager.updateViewLayout(bubble, position); return true;
                        }
                        return false;
                    }
                    case MotionEvent.ACTION_UP: case MotionEvent.ACTION_CANCEL:
                        press(false);
                        if (dragged) { view.setPressed(false); snap(); return true; }
                        return false;
                }
                return false;
            }
        });
        manager.addView(bubble, position);
        bubble.setScaleX(0.4f); bubble.setScaleY(0.4f);
        bubble.animate().scaleX(1).scaleY(1).setDuration(260).setInterpolator(new OvershootInterpolator()).start();
    }

    private void press(boolean down) {
        bubble.animate().cancel();
        bubble.animate().alpha(down ? 1f : 0.72f).scaleX(down ? 0.92f : 1f).scaleY(down ? 0.92f : 1f).setDuration(120).start();
        ValueAnimator a = ValueAnimator.ofFloat(bubble.pressed, down ? 1f : 0f).setDuration(160);
        a.addUpdateListener(v -> { bubble.pressed = (float) v.getAnimatedValue(); bubble.invalidate(); });
        a.start();
    }

    private void clamp() {
        android.util.DisplayMetrics m = getResources().getDisplayMetrics();
        position.x = Math.max(0, Math.min(m.widthPixels - dp(SIZE), position.x));
        position.y = Math.max(dp(24), Math.min(m.heightPixels - dp(SIZE + 48), position.y));
    }

    /** Let go: glide to the nearer side edge, then remember the place. */
    private void snap() {
        android.util.DisplayMetrics m = getResources().getDisplayMetrics();
        int target = position.x + dp(SIZE) / 2 < m.widthPixels / 2 ? dp(6) : m.widthPixels - dp(SIZE + 6);
        ValueAnimator a = ValueAnimator.ofInt(position.x, target).setDuration(220);
        a.setInterpolator(new DecelerateInterpolator());
        a.addUpdateListener(v -> {
            if (bubble == null) return;
            position.x = (int) v.getAnimatedValue();
            try { manager.updateViewLayout(bubble, position); } catch (Exception ignored) { }
        });
        a.addListener(new android.animation.AnimatorListenerAdapter() {
            @Override public void onAnimationEnd(android.animation.Animator animation) {
                preferences.edit().putInt("x", position.x).putInt("y", position.y).apply();
            }
        });
        a.start();
    }

    /**
     * Read the screen (with the button itself out of the way, so it is not in
     * the screenshot), then open the floating AI next to where the button was.
     */
    private void open() {
        Runnable launch = () -> {
            if (bubble != null) bubble.setVisibility(View.VISIBLE);
            android.util.DisplayMetrics m = getResources().getDisplayMetrics();
            startActivity(new Intent(this, QuickAskActivity.class)
                .putExtra("fromBubble", true)
                .putExtra("anchorRight", position.x + dp(SIZE) / 2 > m.widthPixels / 2)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP));
        };
        if (!ScreenContextService.running()) { launch.run(); return; }
        bubble.setVisibility(View.INVISIBLE);
        // One frame for the button to leave the screen before the picture is taken.
        bubble.postDelayed(() -> ScreenContextService.snapshot(launch), 60);
    }

    @Override public void onDestroy() {
        if (bubble != null) { try { manager.removeView(bubble); } catch (Exception ignored) { } bubble = null; }
        super.onDestroy();
    }
}
