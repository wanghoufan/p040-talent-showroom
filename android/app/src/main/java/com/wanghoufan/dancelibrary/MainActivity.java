package com.wanghoufan.dancelibrary;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ShareTargetPlugin.class);
        registerPlugin(ThemeBarsPlugin.class);
        registerPlugin(SystemInsetsPlugin.class);
        super.onCreate(savedInstanceState);
        // cold start：App 未运行时从分享面板进入
        PendingShareStore.capture(this, getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // warm start：App 已在后台/前台时再次分享
        PendingShareStore.capture(this, intent);
        notifyShareTarget();
    }

    /** 告知 JS 有新分享落盘，触发 drain（App 已在前台时不会有可见性变化事件）。 */
    private void notifyShareTarget() {
        Bridge bridge = getBridge();
        if (bridge == null) return;
        PluginHandle handle = bridge.getPlugin("ShareTarget");
        if (handle == null || !(handle.getInstance() instanceof ShareTargetPlugin)) return;
        ((ShareTargetPlugin) handle.getInstance()).notifyShareReceived();
    }
}
