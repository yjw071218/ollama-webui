package io.github.yjw071218.ollamawebui.client;

import android.os.Bundle;
import android.content.res.Configuration;
import android.view.*;

/** A normal floating activity: no overlay permission and no main-task activation. */
public final class QuickAskActivity extends MainActivity {
    @Override protected boolean floatingAsk() { return true; }
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        setFinishOnTouchOutside(true);
        resize();
    }
    private void resize() {
        android.util.DisplayMetrics metrics = getResources().getDisplayMetrics();
        getWindow().setLayout(Math.min((int)(520 * metrics.density), (int)(metrics.widthPixels * .94)),
            (int)(metrics.heightPixels * .78));
        getWindow().setGravity(Gravity.CENTER);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    }
    @Override public void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config); resize();
    }
    @Override public void onBackPressed() { finish(); }
}
