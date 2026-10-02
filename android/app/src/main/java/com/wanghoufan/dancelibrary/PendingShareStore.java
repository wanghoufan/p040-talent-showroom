package com.wanghoufan.dancelibrary;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONObject;

import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * PendingShare 本地落盘（T052/T053）。
 *
 * ACTION_SEND 一进入 App 就写入 SharedPreferences（本地磁盘），
 * 即使 WebView 尚未就绪或随后失败，分享内容也不会丢失。
 * 去重 token = sha256(mime + 文本/URI)，重复 intent 不重复入队。
 */
public final class PendingShareStore {
    private PendingShareStore() {}

    private static final String PREFS = "dance_pending_shares";
    private static final String KEY = "shares";

    private static final String TAG = "DanceShareTarget";

    public static void capture(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action)) return;
        String type = intent.getType();
        if (type == null) return;
        String sharedText = null;
        String streamUri = null;
        if (type.startsWith("text/")) {
            sharedText = intent.getStringExtra(Intent.EXTRA_TEXT);
            // MIUI 分享面板可能把文本放进 ClipData 而非 EXTRA_TEXT。
            if (sharedText == null && intent.getClipData() != null && intent.getClipData().getItemCount() > 0) {
                CharSequence text = intent.getClipData().getItemAt(0).getText();
                if (text != null) sharedText = text.toString();
            }
            if (sharedText == null) return;
        } else if (type.startsWith("video/")) {
            Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri == null && intent.getClipData() != null && intent.getClipData().getItemCount() > 0) {
                uri = intent.getClipData().getItemAt(0).getUri();
            }
            if (uri == null) return;
            streamUri = uri.toString();
        } else {
            return;
        }
        try {
            JSONObject share = new JSONObject();
            String token = token(type, sharedText != null ? sharedText : streamUri);
            share.put("id", token);
            share.put("token", token);
            if (sharedText != null) share.put("sharedText", sharedText);
            if (streamUri != null) share.put("streamUri", streamUri);
            share.put("mime", type);
            share.put("receivedAt", nowIso());
            share.put("submitState", "PENDING");
            append(context, share);
        } catch (Exception error) {
            // 落盘失败不应让分享崩溃；最坏情况是这条分享丢失。
            android.util.Log.e(TAG, "capture failed: " + error);
        }
    }

    private static synchronized void append(Context context, JSONObject share) throws Exception {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONArray array = new JSONArray(prefs.getString(KEY, "[]"));
        for (int i = 0; i < array.length(); i++) {
            if (share.getString("token").equals(array.getJSONObject(i).optString("token"))) return; // 去重
        }
        array.put(share);
        prefs.edit().putString(KEY, array.toString()).apply();
    }

    /** 读取并清空本地队列（由 JS 落盘接管）。 */
    public static synchronized JSONArray drain(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONArray array;
        try { array = new JSONArray(prefs.getString(KEY, "[]")); } catch (Exception e) { array = new JSONArray(); }
        prefs.edit().putString(KEY, "[]").apply();
        return array;
    }

    public static synchronized JSONArray peek(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        try { return new JSONArray(prefs.getString(KEY, "[]")); } catch (Exception e) { return new JSONArray(); }
    }

    private static String nowIso() {
        SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US);
        fmt.setTimeZone(TimeZone.getTimeZone("UTC"));
        return fmt.format(new Date());
    }

    private static String token(String type, String value) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] bytes = digest.digest((type + "|" + value).getBytes("UTF-8"));
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }
}
