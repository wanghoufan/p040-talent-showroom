package com.wanghoufan.dancelibrary;

import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;

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

    @PluginMethod
    public void keepAwake(PluginCall call) {
        final boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        getActivity().runOnUiThread(() -> {
            if (enabled) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }

    private void apply(boolean dark) {
        Window window = getActivity().getWindow();
        int color = dark ? DARK_BG : LIGHT_BG;

        // 关键：只有声明「由 App 绘制系统栏背景」时，setStatusBarColor/setNavigationBarColor 才会生效；
        // Capacitor 默认主题未声明该 flag，因此此前设置被系统忽略（MIUI 下表现为恒白）。
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS
                | WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION);

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

        // 兜底：部分 ROM 会以窗口背景色填充系统栏区域，同步窗口/Decor 背景避免残留白条。
        window.setStatusBarColor(color);
        window.setNavigationBarColor(color);
        decor.setBackground(new ColorDrawable(color));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }
    }
}
