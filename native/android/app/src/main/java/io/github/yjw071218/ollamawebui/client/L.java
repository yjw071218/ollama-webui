package io.github.yjw071218.ollamawebui.client;

import java.util.Locale;

/**
 * The app's own words in Korean or English. The page has twelve languages of
 * its own; what the app says around it -- dialogs, the address screen, the
 * update window -- follows the phone: Korean on a Korean phone, English on
 * any other. Written where used, as {@code L.t("한국어", "English")}, as the
 * Windows app does (desktop/i18n.mjs).
 */
final class L {
    private L() {}
    static boolean korean() { return "ko".equals(Locale.getDefault().getLanguage()); }
    static String t(String ko, String en) { return korean() ? ko : en; }
}
