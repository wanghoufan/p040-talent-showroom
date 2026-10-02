package com.wanghoufan.dancelibrary;

import android.graphics.Color;
import android.os.Build;
import android.view.View;
import android.view.Window;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 系统状态栏/导航栏跟随 App 主题（T013/T083）。
 *
 * 不使用额外依赖：仅设置系统栏颜色与图标明暗，使深色页不再出现白色系统栏。
 */
@CapacitorPlugin(name = "ThemeBars")
public class ThemeBarsPlugin extends Plugin {

    private static final int DARK_BG = Color.parseColor("#060b12");
    private static final int LIGHT_BG = Color.parseColor("#f6f8fb");

    @PluginMethod
    public void setDark(PluginCall call) {
        final boolean dark = Boolean.TRUE.equals(call.getBoolean("dark", Boolean.TRUE));
        if (getActivity() == null) {
            call.reject("no activity");
            return;
        }
        getActivity().runOnUiThread(() -> apply(dark));
        call.resolve();
    }

    private void apply(boolean dark) {
        Window window = getActivity().getWindow();
        View decor = window.getDecorView();
        int flags = decor.getSystemUiVisibility();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (dark) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            else flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (dark) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            else flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        decor.setSystemUiVisibility(flags);
        window.setStatusBarColor(dark ? DARK_BG : LIGHT_BG);
        window.setNavigationBarColor(dark ? DARK_BG : LIGHT_BG);
    }
}
