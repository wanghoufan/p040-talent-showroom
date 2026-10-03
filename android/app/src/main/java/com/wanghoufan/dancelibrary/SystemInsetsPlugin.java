package com.wanghoufan.dancelibrary;

import android.graphics.Point;
import android.graphics.Rect;
import android.os.Build;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 系统栏 inset 桥接（底部导航栏重叠 / 大片空白修复）。
 *
 * 背景：targetSdk 36 下 Android 15+ 强制 edge-to-edge，WebView 会铺到系统导航栏下方；
 * 而 Android WebView 不向 CSS 的 env(safe-area-inset-*) 暴露系统栏高度（实测恒为 0），
 * 所以由原生读 WindowInsetsCompat 注入 CSS 变量 --android-inset-*，CSS 用 max(env(), var()) 兜底两端。
 *
 * 坑一（单位）：read() 早期直接回物理 px，而前端把它当 CSS px 写进样式 → 值被放大 density 倍
 *   （实测 130px 物理被当成 130 CSS px，正确值应为 47 CSS px）。
 *   现在 read()/inject() 统一只输出 CSS px。
 *
 * 坑二（重复留白）：Android 14 及以下不强制 edge-to-edge，系统已把窗口内缩到系统栏之内
 *   （WebView 根本不与导航栏重叠），此时再按 inset 留白就成了「tab 与导航栏之间的大片空白」。
 *   故改为按几何实测决定：某一边需预留的高度 =
 *   max(0, 该边系统栏高度 − WebView 该边到屏幕边缘的距离)。
 *   WebView 完全铺到屏幕边缘（edge-to-edge）→ 预留整个 inset；
 *   WebView 已被系统内缩（窗口 not edge-to-edge）→ 预留 0。
 *
 * 不吞 insets（交回默认分发），避免与 Capacitor 内置 SystemBars 抢 decorView listener。
 */
@CapacitorPlugin(name = "SystemInsets")
public class SystemInsetsPlugin extends Plugin {

    @PluginMethod
    public void read(PluginCall call) {
        if (getActivity() == null || getBridge() == null || getBridge().getWebView() == null) {
            call.reject("no activity");
            return;
        }
        getActivity().runOnUiThread(() -> {
            View decor = getActivity().getWindow().getDecorView();
            // 主动 request，保证首次进入与页面切换后拿到最新值
            ViewCompat.requestApplyInsets(decor);
            call.resolve(snapshot());
        });
    }

    /**
     * 按几何实测算「需要预留的系统栏高度」（物理 px），再换算成 CSS px 注入。
     *
     * @return 同时带诊断字段的对象（top/right/bottom/left 为 CSS px，前端直接写入变量）
     */
    private JSObject snapshot() {
        JSObject out = new JSObject();

        Insets bars = windowInsets();
        if (bars == null) bars = Insets.NONE;

        View web = getBridge() != null ? getBridge().getWebView() : null;
        Point screen = screenSizePhysical();
        int[] loc = new int[2];
        int webW = 0, webH = 0;
        if (web != null) {
            web.getLocationOnScreen(loc);
            webW = web.getWidth();
            webH = web.getHeight();
        }
        boolean geometryKnown = web != null && screen != null && webW > 0 && webH > 0;

        int gapTop, gapRight, gapBottom, gapLeft;
        if (geometryKnown) {
            gapTop = loc[1];
            gapLeft = loc[0];
            gapRight = screen.x - (loc[0] + webW);
            gapBottom = screen.y - (loc[1] + webH);
        } else {
            gapTop = gapRight = gapBottom = gapLeft = 0;
        }

        // 需要预留的量 = 系统栏压在 WebView 上的部分；geometry 未知时退回「全量预留」（旧行为，避免临时压栏）
        int resTop = geometryKnown ? Math.max(0, bars.top - gapTop) : bars.top;
        int resRight = geometryKnown ? Math.max(0, bars.right - gapRight) : bars.right;
        int resBottom = geometryKnown ? Math.max(0, bars.bottom - gapBottom) : bars.bottom;
        int resLeft = geometryKnown ? Math.max(0, bars.left - gapLeft) : bars.left;

        // 软键盘弹出时导航栏被键盘顶起（WebView 也可能被 resize），不再额外留白，否则出现双层空隙
        boolean imeVisible = isImeVisible();
        if (imeVisible) resBottom = 0;

        float density = getContext().getResources().getDisplayMetrics().density;
        if (density <= 0f) density = 1f;

        out.put("top", Math.round(resTop / density));
        out.put("right", Math.round(resRight / density));
        out.put("bottom", Math.round(resBottom / density));
        out.put("left", Math.round(resLeft / density));

        // ---- 诊断字段（前端不使用，仅供真机实测核对根因）----
        out.put("density", density);
        out.put("rawTopPx", bars.top);
        out.put("rawRightPx", bars.right);
        out.put("rawBottomPx", bars.bottom);
        out.put("rawLeftPx", bars.left);
        out.put("reservedTopPx", resTop);
        out.put("reservedRightPx", resRight);
        out.put("reservedBottomPx", resBottom);
        out.put("reservedLeftPx", resLeft);
        out.put("screenWidthPx", screen == null ? 0 : screen.x);
        out.put("screenHeightPx", screen == null ? 0 : screen.y);
        out.put("webTopPx", geometryKnown ? loc[1] : 0);
        out.put("webLeftPx", geometryKnown ? loc[0] : 0);
        out.put("webWidthPx", webW);
        out.put("webHeightPx", webH);
        out.put("webBottomGapPx", gapBottom);
        out.put("webTopGapPx", gapTop);
        out.put("geometryKnown", geometryKnown);
        out.put("imeVisible", imeVisible);

        return out;
    }

    /** 注入 CSS 变量；值一律为 CSS px，由 snapshot() 统一换算。 */
    private void inject() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        JSObject snap = snapshot();
        String script = String.format(java.util.Locale.US,
            "try{var r=document.documentElement.style;r.setProperty('--android-inset-top','%1$dpx');"
                + "r.setProperty('--android-inset-right','%2$dpx');r.setProperty('--android-inset-bottom','%3$dpx');"
                + "r.setProperty('--android-inset-left','%4$dpx');"
                // tabbar 的 padding 变化不改 content-box，ResizeObserver 不触发；显式通知布局重算
                + "window.dispatchEvent(new Event('dance-insets-changed'));}catch(e){}",
            snap.getInteger("top", 0), snap.getInteger("right", 0),
            snap.getInteger("bottom", 0), snap.getInteger("left", 0));
        getBridge().getWebView().evaluateJavascript(script, null);
    }

    /** 系统栏（状态栏+导航栏+刘海）的窗口 inset，物理 px；取不到返回 null。 */
    private Insets windowInsets() {
        if (getActivity() == null) return null;
        View decor = getActivity().getWindow().getDecorView();
        WindowInsetsCompat compat = ViewCompat.getRootWindowInsets(decor);
        if (compat != null) {
            return compat.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsets raw = decor.getRootWindowInsets();
            if (raw != null) {
                android.graphics.Insets bars = raw.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                return Insets.of(bars.left, bars.top, bars.right, bars.bottom);
            }
        }
        return null;
    }

    private boolean isImeVisible() {
        if (getActivity() == null) return false;
        WindowInsetsCompat compat = ViewCompat.getRootWindowInsets(getActivity().getWindow().getDecorView());
        return compat != null && compat.isVisible(WindowInsetsCompat.Type.ime());
    }

    /** 屏幕物理尺寸（含系统栏区域），与 getLocationOnScreen 同一坐标系。 */
    private Point screenSizePhysical() {
        if (getActivity() == null) return null;
        WindowManager wm = getActivity().getWindowManager();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Rect bounds = wm.getMaximumWindowMetrics().getBounds();
            return new Point(bounds.width(), bounds.height());
        }
        Point p = new Point();
        wm.getDefaultDisplay().getRealSize(p);
        return p;
    }

    @Override
    public void load() {
        super.load();
        // 页面就绪与配置变化时都重新注入，覆盖首次进入/旋转/导航模式切换
        getBridge().addWebViewListener(new com.getcapacitor.WebViewListener() {
            @Override
            public void onPageCommitVisible(android.webkit.WebView view, String url) {
                super.onPageCommitVisible(view, url);
                if (getActivity() == null) return;
                getActivity().runOnUiThread(() -> inject());
            }
        });
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (getActivity() != null) getActivity().runOnUiThread(() -> inject());
    }
}
