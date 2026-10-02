package com.wanghoufan.dancelibrary;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;

/** 把原生落盘的 PendingShare 交给 JS（T052）。以 JSON 字符串返回，避免数组序列化歧义。 */
@CapacitorPlugin(name = "ShareTarget")
public class ShareTargetPlugin extends Plugin {

    @PluginMethod
    public void drain(PluginCall call) {
        JSONArray array = PendingShareStore.drain(getContext());
        JSObject ret = new JSObject();
        ret.put("json", array.toString());
        call.resolve(ret);
    }

    @PluginMethod
    public void peek(PluginCall call) {
        JSONArray array = PendingShareStore.peek(getContext());
        JSObject ret = new JSObject();
        ret.put("json", array.toString());
        call.resolve(ret);
    }

    /** 原生收到新分享时通知 JS（warm start，App 已在前台）。 */
    public void notifyShareReceived() {
        notifyListeners("shareReceived", new JSObject());
    }
}
