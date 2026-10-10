package io.github.yjw071218.ollamawebui.client;

import android.app.PendingIntent;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/** A quick-settings tile: pull down the shade, tap, and a new chat is listening. */
public class ChatTile extends TileService {
    @Override public void onStartListening() {
        Tile tile = getQsTile();
        if (tile == null) return;
        tile.setLabel(L.t("AI에게 묻기", "Ask AI"));
        if (Build.VERSION.SDK_INT >= 29) tile.setSubtitle(L.t("음성 질문", "Voice question"));
        tile.setIcon(Icon.createWithResource(this, R.drawable.ic_widget_mic));
        tile.setState(Tile.STATE_INACTIVE);
        tile.updateTile();
    }
    // The Intent form is only reached below Android 14, where it is the only one.
    @SuppressWarnings("deprecation")
    @android.annotation.SuppressLint("StartActivityAndCollapseDeprecated")
    @Override public void onClick() {
        Intent intent = new Intent(this, MainActivity.class).setAction(MainActivity.ACTION_VOICE)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 801, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        } else {
            startActivityAndCollapse(intent);
        }
    }
}
