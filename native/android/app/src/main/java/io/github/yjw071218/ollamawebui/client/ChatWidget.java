package io.github.yjw071218.ollamawebui.client;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

/**
 * The home-screen widget: a new chat, a spoken question, or back to the last
 * chat. Each button opens MainActivity with what to do (MainActivity.takeIntent).
 */
public class ChatWidget extends AppWidgetProvider {
    private static PendingIntent open(Context context, String action, int code) {
        Intent intent = new Intent(context, MainActivity.class).setAction(action)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(context, code, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
    @Override public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) {
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_chat);
            views.setTextViewText(R.id.widget_ask, L.t("무엇이든 물어보세요", "Ask anything"));
            views.setOnClickPendingIntent(R.id.widget_ask, open(context, MainActivity.ACTION_NEW_CHAT, 701));
            views.setOnClickPendingIntent(R.id.widget_new, open(context, MainActivity.ACTION_NEW_CHAT, 702));
            views.setOnClickPendingIntent(R.id.widget_voice, open(context, MainActivity.ACTION_VOICE, 703));
            views.setOnClickPendingIntent(R.id.widget_open, open(context, Intent.ACTION_MAIN, 704));
            manager.updateAppWidget(id, views);
        }
    }
}
