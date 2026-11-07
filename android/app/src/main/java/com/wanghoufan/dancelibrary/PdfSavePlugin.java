package com.wanghoufan.dancelibrary;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.PluginMethod;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * A4 学习稿 PDF 落盘与分享（R3 P0）。
 *
 * <p>Android 11+ 走 MediaStore.Downloads：文件真实出现在系统「下载」目录，文件管理器可见，
 * 不需要「所有文件访问」权限；返回的 content:// 直接可用于系统分享与打开。
 * Android 10 及以下回退到公共下载目录 + 媒体库扫描。
 */
@CapacitorPlugin(name = "PdfSave")
public class PdfSavePlugin extends Plugin {

    private static final String MIME_PDF = "application/pdf";

    @PluginMethod
    public void saveToDownloads(PluginCall call) {
        String fileName = call.getString("fileName");
        String base64 = call.getString("base64");
        if (fileName == null || fileName.trim().isEmpty() || base64 == null || base64.isEmpty()) {
            call.reject("INVALID_INPUT", "缺少文件名或文件内容");
            return;
        }
        byte[] bytes;
        try {
            bytes = Base64.decode(base64, Base64.DEFAULT);
        } catch (IllegalArgumentException error) {
            call.reject("INVALID_BASE64", "PDF 内容编码无效");
            return;
        }
        if (bytes.length == 0) {
            call.reject("EMPTY_FILE", "PDF 内容为空");
            return;
        }
        try {
            JSObject result = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    ? saveViaMediaStore(fileName, bytes)
                    : saveLegacy(fileName, bytes);
            call.resolve(result);
        } catch (Exception error) {
            String reason = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
            call.reject("SAVE_FAILED", reason);
        }
    }

    private JSObject saveViaMediaStore(String fileName, byte[] bytes) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
        values.put(MediaStore.MediaColumns.MIME_TYPE, MIME_PDF);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);

        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new Exception("无法在系统下载目录创建文件");

        boolean finished = false;
        try (OutputStream out = resolver.openOutputStream(uri)) {
            if (out == null) throw new Exception("无法写入系统下载目录");
            out.write(bytes);
            out.flush();
            finished = true;
        } finally {
            if (!finished) resolver.delete(uri, null, null);
        }

        ContentValues done = new ContentValues();
        done.put(MediaStore.MediaColumns.IS_PENDING, 0);
        resolver.update(uri, done, null, null);

        JSObject result = describe(uri);
        result.put("uri", uri.toString());
        return result;
    }

    @SuppressWarnings("deprecation")
    private JSObject saveLegacy(String fileName, byte[] bytes) throws Exception {
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (!dir.exists() && !dir.mkdirs()) throw new Exception("无法创建下载目录");
        File target = new File(dir, fileName);
        try (FileOutputStream out = new FileOutputStream(target, false)) {
            out.write(bytes);
            out.flush();
        }
        android.media.MediaScannerConnection.scanFile(
                getContext(), new String[]{target.getAbsolutePath()}, new String[]{MIME_PDF}, null);
        JSObject result = new JSObject();
        result.put("uri", "file://" + target.getAbsolutePath());
        result.put("name", target.getName());
        result.put("path", "下载/" + target.getName());
        result.put("size", target.length());
        return result;
    }

    /** 以 MediaStore 的实际记录为准回读文件名与大小，避免同名时报告错误名称。 */
    private JSObject describe(Uri uri) {
        JSObject result = new JSObject();
        String[] projection = {
                MediaStore.MediaColumns.DISPLAY_NAME,
                MediaStore.MediaColumns.SIZE,
        };
        try (Cursor cursor = getContext().getContentResolver().query(uri, projection, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String name = cursor.getString(0);
                long size = cursor.getLong(1);
                result.put("name", name);
                result.put("path", "下载/" + name);
                result.put("size", size);
                return result;
            }
        } catch (Exception ignored) {
            // 回读失败不阻断保存结论；由 JS 用文件名兜底展示。
        }
        result.put("name", "");
        result.put("path", "下载/");
        result.put("size", 0);
        return result;
    }

    @PluginMethod
    public void share(PluginCall call) {
        String uriString = call.getString("uri");
        if (uriString == null || uriString.isEmpty()) {
            call.reject("INVALID_INPUT", "缺少文件地址");
            return;
        }
        try {
            Uri uri = Uri.parse(uriString);
            Intent intent = new Intent(Intent.ACTION_SEND);
            intent.setType(MIME_PDF);
            intent.putExtra(Intent.EXTRA_STREAM, uri);
            intent.setClipData(ClipData.newRawUri("", uri));
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            String title = call.getString("title", "分享 A4 学习稿");
            getActivity().startActivity(Intent.createChooser(intent, title));
            call.resolve();
        } catch (Exception error) {
            call.reject("SHARE_FAILED", error.getMessage());
        }
    }

    @PluginMethod
    public void open(PluginCall call) {
        String uriString = call.getString("uri");
        if (uriString == null || uriString.isEmpty()) {
            call.reject("INVALID_INPUT", "缺少文件地址");
            return;
        }
        try {
            Uri uri = Uri.parse(uriString);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, MIME_PDF);
            intent.setClipData(ClipData.newRawUri("", uri));
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("OPEN_FAILED", "没有可打开 PDF 的应用");
        }
    }
}
