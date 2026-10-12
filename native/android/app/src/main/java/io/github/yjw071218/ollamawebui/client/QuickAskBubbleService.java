package io.github.yjw071218.ollamawebui.client;

import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.IBinder;
import android.provider.Settings;
import android.view.*;
import android.widget.TextView;

/** Explicitly enabled shortcut. No accessibility service or screen collection. */
public final class QuickAskBubbleService extends Service {
    private WindowManager manager;
    private TextView bubble;
    private WindowManager.LayoutParams position;
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public int onStartCommand(Intent intent, int flags, int id) {
        if (intent != null && "stop".equals(intent.getAction())) { stopSelf(); return START_NOT_STICKY; }
        if (!Settings.canDrawOverlays(this)) { stopSelf(); return START_NOT_STICKY; }
        NotificationManager notifications = getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(new NotificationChannel("quick-ask-bubble", L.t("AI 플로팅 버튼", "AI floating button"), NotificationManager.IMPORTANCE_LOW));
        PendingIntent stop = PendingIntent.getService(this, 91, new Intent(this, QuickAskBubbleService.class).setAction("stop"), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        startForeground(902, new Notification.Builder(this, "quick-ask-bubble").setSmallIcon(R.drawable.ic_widget_mic)
            .setContentTitle(L.t("AI에게 묻기", "Ask AI")).setContentText(L.t("버튼을 눌러 질문 · 길게 눌러 닫기", "Tap to ask, hold to close"))
            .setOngoing(true).addAction(new Notification.Action.Builder(null, L.t("버튼 끄기", "Turn off"), stop).build()).build());
        if (bubble == null) showBubble();
        return START_NOT_STICKY;
    }
    private void showBubble() {
        manager = getSystemService(WindowManager.class);
        bubble = new TextView(this); bubble.setText("✦"); bubble.setTextSize(28); bubble.setTextColor(Color.WHITE);
        bubble.setGravity(Gravity.CENTER); bubble.setContentDescription(L.t("AI에게 묻기. 이동 가능, 길게 눌러 닫기", "Ask AI. Drag to move, hold to close"));
        GradientDrawable background = new GradientDrawable(GradientDrawable.Orientation.TL_BR, new int[]{0xff9b89ee,0xff6353bf});
        background.setShape(GradientDrawable.OVAL); background.setStroke(dp(2),0xffcbbff7);
        bubble.setBackground(background); bubble.setElevation(dp(8));
        position = new WindowManager.LayoutParams(dp(56), dp(56), WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL, PixelFormat.TRANSLUCENT);
        position.gravity = Gravity.TOP | Gravity.LEFT;
        android.content.SharedPreferences preferences = getSharedPreferences("bubble", MODE_PRIVATE);
        position.x = preferences.getInt("x", dp(12)); position.y = preferences.getInt("y", dp(180));
        bubble.setOnClickListener(v -> {
            startActivity(new Intent(this, QuickAskActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP));
        });
        bubble.setOnLongClickListener(v -> { stopSelf(); return true; });
        bubble.setOnTouchListener(new View.OnTouchListener() {
            float startX, startY; int x, y; boolean dragged;
            public boolean onTouch(View view, android.view.MotionEvent e) {
                if (e.getAction() == MotionEvent.ACTION_DOWN) { startX=e.getRawX(); startY=e.getRawY(); x=position.x; y=position.y; dragged=false; return false; }
                if (e.getAction() == MotionEvent.ACTION_MOVE) {
                    float dx=e.getRawX()-startX, dy=e.getRawY()-startY;
                    if (Math.abs(dx)+Math.abs(dy)>dp(8)) { dragged=true; view.cancelLongPress(); }
                    if (dragged) {
                        android.util.DisplayMetrics m=getResources().getDisplayMetrics();
                        position.x=Math.max(0,Math.min(m.widthPixels-dp(56),x+(int)dx));
                        position.y=Math.max(0,Math.min(m.heightPixels-dp(90),y+(int)dy));
                        manager.updateViewLayout(bubble,position); return true;
                    }
                }
                if (e.getAction()==MotionEvent.ACTION_UP && dragged) {
                    view.setPressed(false); preferences.edit().putInt("x",position.x).putInt("y",position.y).apply(); return true;
                }
                return false;
            }
        });
        manager.addView(bubble,position);
    }
    @Override public void onDestroy() {
        if (bubble != null) { manager.removeView(bubble); bubble=null; }
        super.onDestroy();
    }
}
