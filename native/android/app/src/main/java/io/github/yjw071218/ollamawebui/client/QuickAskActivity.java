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
        getWindow().setLayout(Math.min((int)(380 * metrics.density), (int)(metrics.widthPixels * .92)),
            Math.min((int)(460 * metrics.density), (int)(metrics.heightPixels * .66)));
        getWindow().setGravity(Gravity.CENTER);
        getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(android.graphics.Color.TRANSPARENT));
        getWindow().getDecorView().setPadding(0, 0, 0, 0);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    }
    @Override public void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config); resize();
    }
    @Override public void onBackPressed() { finish(); }
}
