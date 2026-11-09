package com.wanghoufan.dancelibrary;

import android.app.Activity;
import android.net.Uri;
import android.os.StatFs;
import android.util.Log;
import android.view.WindowManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.net.Proxy;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 旧手机 → 新手机的局域网直传（不经服务器、不迁移登录 token）。
 *
 * <p>迁出端：把曲库快照（曲名/学习进度/谱面页码）写成 state.json，扫描 dance-offline
 * 下的缓存视频/音乐/封面/谱件，计算 SHA-256 后由本机 HTTP 服务提供断点续传。
 *
 * <p>迁入端：同 Wi-Fi 时自动发现旧手机（UDP 发现 + 旧手机点一次「允许」），
 * 或手动输入 6 位数字配对码；随后逐文件 Range 断点续传，边下边算 SHA-256。
 * 目标已存在且内容相同则跳过，不同则写入隔离区，绝不静默覆盖原有文件。
 */
@CapacitorPlugin(name = "Migration")
public class MigrationPlugin extends Plugin {

    private static final int MAX_STATE_BYTES = 8 * 1024 * 1024;
    private static final int MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
    private static final int MAX_FILES = 20_000;
    private static final long MAX_FILE_BYTES = 2L * 1024 * 1024 * 1024;
    private static final long MAX_TOTAL_BYTES = 6L * 1024 * 1024 * 1024;
    private static final long SPACE_MARGIN = 64L * 1024 * 1024;
    private static final long LOW_SPACE_BYTES = 8L * 1024 * 1024;
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 60_000;
    private static final long CODE_TTL_MS = 10L * 60L * 1000L;
    private static final int PROTOCOL_SCHEMA = 3;
    private static final String SHARE_DIR = "migration-share";
    private static final String INBOX_DIR = "migration-inbox";
    private static final String STATE_REL = SHARE_DIR + "/state.json";

    private final SecureRandom random = new SecureRandom();
    private final ExecutorService receiveExecutor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "migration-receive");
        thread.setDaemon(true);
        return thread;
    });
    private final ExecutorService discoverExecutor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "migration-discover");
        thread.setDaemon(true);
        return thread;
    });

    private volatile MigrationShareServer shareServer;
    private volatile MigrationShareServer.Manifest manifest;
    private volatile boolean shareBuilding;
    private volatile String shareError;
    private volatile long codeExpiresAt;
    private volatile long shareGeneration;

    private volatile boolean receiveRunning;
    private volatile boolean receiveCancelled;
    private volatile HttpURLConnection currentConnection;
    private volatile ReceiveSession receiveSession;
    private volatile long lastProgressAt;
    /** 本次接收已清理过旧断点的目录（每个目录只扫一次，避免逐文件遍历）。 */
    private final Set<String> sweptPartDirs = new HashSet<>();

    private static final class ReceiveSession {
        final String host;
        final int port;
        final String handshakeId;
        final MigrationCrypto.Keys keys;
        final long expiresAt;
        final long clockOffset;

        ReceiveSession(String host, int port, String handshakeId, MigrationCrypto.Keys keys, long expiresAt, long clockOffset) {
            this.host = host;
            this.port = port;
            this.handshakeId = handshakeId;
            this.keys = keys;
            this.expiresAt = expiresAt;
            this.clockOffset = clockOffset;
        }
    }

    private static final class EntryInfo {
        final String id;
        final String role;
        final String path;
        final String mime;
        final String sha256;
        final long size;

        EntryInfo(String id, String role, String path, String mime, String sha256, long size) {
            this.id = id;
            this.role = role;
            this.path = path;
            this.mime = mime;
            this.sha256 = sha256;
            this.size = size;
        }
    }

    private static final class ManifestInfo {
        final long totalBytes;
        final List<EntryInfo> entries;

        ManifestInfo(long totalBytes, List<EntryInfo> entries) {
            this.totalBytes = totalBytes;
            this.entries = entries;
        }
    }

    private static final class FileResult {
        String path;
        String destination;
        String uri;
        String sha256;
        String status;
        String error;
        boolean retryable;
        long size;

        FileResult(String path, String status) {
            this.path = path;
            this.status = status;
        }

        JSObject toJson() {
            JSObject object = new JSObject();
            object.put("path", path);
            object.put("destination", destination == null ? "" : destination);
            object.put("uri", uri == null ? "" : uri);
            object.put("sha256", sha256 == null ? "" : sha256);
            object.put("status", status);
            object.put("error", error == null ? "" : error);
            object.put("retryable", retryable);
            object.put("sizeBytes", size);
            return object;
        }
    }

    private static final class MigrationFailure extends Exception {
        final String code;
        final boolean retryable;

        MigrationFailure(String code, String message, boolean retryable) {
            super(message);
            this.code = code;
            this.retryable = retryable;
        }
    }

    @PluginMethod
    public void startShare(PluginCall call) {
        String stateJson = call.getString("stateJson");
        if (stateJson == null) {
            call.reject("INVALID_STATE", "缺少迁移数据");
            return;
        }
        if (stateJson.contains("\"dance.owner-token\"") || stateJson.contains("\"dance.device-settings\"")) {
            call.reject("INVALID_STATE", "迁移数据包含登录凭据或设备地址，已拒绝");
            return;
        }
        byte[] bytes;
        try {
            bytes = stateJson.getBytes(StandardCharsets.UTF_8);
        } catch (Exception error) {
            call.reject("INVALID_STATE", "迁移数据编码无效");
            return;
        }
        if (bytes.length == 0 || bytes.length > MAX_STATE_BYTES) {
            call.reject("INVALID_STATE", "迁移数据为空或超过 8 MB");
            return;
        }
        try {
            stopShareInternal();
            File dataDir = getContext().getFilesDir();
            File shareDir = new File(dataDir, SHARE_DIR);
            if (!shareDir.exists() && !shareDir.mkdirs()) throw new IOException("无法创建迁移目录");
            File stateFile = new File(shareDir, "state.json");
            File tempFile = new File(shareDir, "state.json.tmp");
            writeAtomic(tempFile, stateFile, bytes);
            String key = MigrationWire.newPairingCode(random);
            codeExpiresAt = System.currentTimeMillis() + CODE_TTL_MS;
            MigrationShareServer server = new MigrationShareServer(dataDir, stateFile, key, codeExpiresAt, random);
            server.setPairRequestListener(new MigrationShareServer.PairRequestListener() {
                @Override
                public void onPairRequest(String handshakeId, String ip) {
                    JSObject data = new JSObject();
                    data.put("handshakeId", handshakeId);
                    data.put("ip", ip);
                    notifyOnUiThread("pairRequest", data);
                }

                @Override
                public void onPairRequestCleared(String handshakeId) {
                    JSObject data = new JSObject();
                    data.put("handshakeId", handshakeId);
                    notifyOnUiThread("pairRequestCleared", data);
                }
            });
            int port = server.start();
            shareServer = server;
            manifest = null;
            shareError = null;
            shareBuilding = true;
            long generation = ++shareGeneration;
            startManifestBuild(dataDir, stateFile, generation);
            keepScreenOn(true);

            JSObject result = new JSObject();
            result.put("port", port);
            result.put("code", key);
            JSArray addresses = new JSArray();
            for (String address : MigrationShareServer.localAddresses()) addresses.put(address);
            result.put("addresses", addresses);
            result.put("expiresAt", codeExpiresAt);
            result.put("stateBytes", bytes.length);
            result.put("autoDiscovery", server.isDiscoveryRunning());
            call.resolve(result);
        } catch (Exception error) {
            stopShareInternal();
            call.reject("SHARE_START_FAILED", message(error));
        }
    }

    @PluginMethod
    public void stopShare(PluginCall call) {
        stopShareInternal();
        call.resolve();
    }

    @PluginMethod
    public void shareStatus(PluginCall call) {
        MigrationShareServer server = shareServer;
        MigrationShareServer.Manifest current = manifest;
        JSObject result = new JSObject();
        result.put("running", server != null && server.isRunning());
        result.put("building", shareBuilding);
        result.put("ready", current != null);
        result.put("fileCount", current == null ? 0 : current.files.size());
        result.put("totalBytes", current == null ? 0 : current.totalBytes);
        result.put("codeExpiresAt", codeExpiresAt);
        result.put("error", shareError == null ? "" : shareError);
        call.resolve(result);
    }

    /** 新手机在同一 Wi-Fi 广播探针，收集旧手机应答（旧手机需在本页点「开始迁移分享」）。 */
    @PluginMethod
    public void discover(PluginCall call) {
        discoverExecutor.execute(() -> {
            try {
                List<JSONObject> found = performDiscovery();
                JSArray devices = new JSArray();
                for (JSONObject item : found) devices.put(item);
                JSObject result = new JSObject();
                result.put("devices", devices);
                call.resolve(result);
            } catch (Exception error) {
                call.reject("DISCOVERY_FAILED", "搜索旧手机失败，可改用下面的数字配对码", error);
            }
        });
    }

    private List<JSONObject> performDiscovery() throws Exception {
        List<InetAddress> targets = new ArrayList<>();
        targets.add(InetAddress.getByName("255.255.255.255"));
        for (NetworkInterface network : Collections.list(NetworkInterface.getNetworkInterfaces())) {
            if (!network.isUp() || network.isLoopback()) continue;
            for (InterfaceAddress address : network.getInterfaceAddresses()) {
                InetAddress broadcast = address.getBroadcast();
                if (broadcast != null) targets.add(broadcast);
            }
        }
        byte[] probe = MigrationWire.DISCOVERY_PROBE.getBytes(StandardCharsets.US_ASCII);
        List<JSONObject> found = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        DatagramSocket socket = new DatagramSocket();
        try {
            socket.setBroadcast(true);
            socket.setSoTimeout(300);
            for (InetAddress target : targets) {
                try {
                    socket.send(new DatagramPacket(probe, probe.length, target, MigrationWire.DISCOVERY_PORT));
                } catch (Exception ignored) {
                    // 某些网卡不允许广播，跳过即可；还能用数字配对码。
                }
            }
            long deadline = System.currentTimeMillis() + 2500L;
            byte[] buffer = new byte[512];
            while (System.currentTimeMillis() < deadline) {
                try {
                    DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                    socket.receive(packet);
                    InetAddress source = packet.getAddress();
                    if (source == null || !MigrationWire.isPrivateAddress(source)) continue;
                    JSONObject reply;
                    try {
                        reply = new JSONObject(new String(packet.getData(), packet.getOffset(),
                                packet.getLength(), StandardCharsets.UTF_8));
                    } catch (Exception malformed) {
                        continue;
                    }
                    if (reply.optInt("schema", -1) != PROTOCOL_SCHEMA) continue;
                    int tcpPort = reply.optInt("tcpPort", 0);
                    String token = reply.optString("token", "");
                    if (tcpPort < 1 || tcpPort > 65535 || token.length() != 32) continue;
                    String host = MigrationWire.normalizeIp(source.getHostAddress());
                    String key = host + ":" + tcpPort;
                    if (!seen.add(key)) continue;
                    JSONObject item = new JSONObject();
                    item.put("host", host);
                    item.put("port", tcpPort);
                    item.put("token", token);
                    found.add(item);
                } catch (SocketTimeoutException ignored) {
                    // 继续收下一轮应答。
                }
            }
        } finally {
            socket.close();
        }
        return found;
    }

    /** 旧手机用户点「允许」：放行这次自动发现连接。 */
    @PluginMethod
    public void allowPair(PluginCall call) {
        String handshakeId = call.getString("handshakeId", "");
        MigrationShareServer server = shareServer;
        boolean ok = server != null && server.allowPair(handshakeId);
        JSObject result = new JSObject();
        result.put("ok", ok);
        call.resolve(result);
    }

    /** 旧手机用户点「拒绝」：清掉会话，新手机会收到明确的拒绝信息。 */
    @PluginMethod
    public void denyPair(PluginCall call) {
        String handshakeId = call.getString("handshakeId", "");
        MigrationShareServer server = shareServer;
        boolean ok = server != null && server.denyPair(handshakeId);
        JSObject result = new JSObject();
        result.put("ok", ok);
        call.resolve(result);
    }

    private void notifyOnUiThread(String event, JSObject data) {
        Activity activity = getActivity();
        if (activity == null) {
            notifyListeners(event, data);
            return;
        }
        activity.runOnUiThread(() -> notifyListeners(event, data));
    }

    @PluginMethod
    public void receive(PluginCall call) {
        String host = call.getString("host", "").trim();
        Integer portValue = call.getInt("port");
        int port = portValue == null ? 0 : portValue;
        String rawKey = call.getString("key", "");
        String key = rawKey == null || rawKey.trim().isEmpty() ? null : MigrationWire.normalizePairingCode(rawKey);
        String rawToken = call.getString("discoveryToken", "");
        String discoveryToken = rawToken == null || rawToken.trim().isEmpty() ? null : rawToken.trim();
        if (discoveryToken != null && !discoveryToken.matches("[0-9a-f]{32}")) {
            call.reject("INVALID_TOKEN", "自动发现的连接信息无效，请重新搜索");
            return;
        }
        if (!host.matches("[A-Za-z0-9.\\-]{1,253}")) {
            call.reject("INVALID_HOST", "请输入旧手机在局域网内的地址");
            return;
        }
        if (port < 1 || port > 65535) {
            call.reject("INVALID_PORT", "端口无效");
            return;
        }
        if (rawKey != null && !rawKey.trim().isEmpty() && key == null) {
            call.reject("INVALID_KEY", "配对码格式无效，请输入旧手机显示的 6 位数字");
            return;
        }
        if (discoveryToken == null && key == null) {
            call.reject("KEY_REQUIRED", "请先用「自动搜索旧手机」连接，或输入旧手机显示的 6 位数字配对码");
            return;
        }
        if (receiveRunning) {
            call.reject("BUSY", "正在接收，请先等待当前任务结束或取消");
            return;
        }
        receiveRunning = true;
        receiveCancelled = false;
        lastProgressAt = 0;
        sweptPartDirs.clear();
        keepScreenOn(true);
        receiveExecutor.execute(() -> {
            try {
                InetAddress[] resolved = InetAddress.getAllByName(host);
                if (resolved.length == 0) throw new MigrationFailure("INVALID_HOST", "无法解析旧手机地址", false);
                for (InetAddress address : resolved) {
                    if (!MigrationWire.isPrivateAddress(address)) {
                        throw new MigrationFailure("INSECURE_HOST", "只允许家庭局域网或私有网络地址", false);
                    }
                }
                ReceiveSession session = receiveSession;
                long now = System.currentTimeMillis();
                if (session == null || !session.host.equals(host) || session.port != port || session.expiresAt <= now) {
                    session = pair(host, port, key, discoveryToken);
                    receiveSession = session;
                }
                JSONObject manifestJson = pollManifest(session);
                ManifestInfo info = validateManifest(manifestJson);
                long available = availableBytes();
                if (available < info.totalBytes + SPACE_MARGIN) {
                    throw new MigrationFailure("INSUFFICIENT_SPACE",
                            "新手机空间不足：需要约 " + humanBytes(info.totalBytes + SPACE_MARGIN)
                                    + "，可用 " + humanBytes(available), false);
                }
                File dataDir = getContext().getFilesDir();
                File inbox = new File(dataDir, INBOX_DIR);
                if (!inbox.exists() && !inbox.mkdirs()) throw new MigrationFailure("INBOX_FAILED", "无法创建迁移收件目录", false);
                List<FileResult> results = new ArrayList<>();
                long transferredBytes = 0;
                boolean stateOk = false;
                for (int index = 0; index < info.entries.size(); index++) {
                    checkCancelled();
                    EntryInfo entry = info.entries.get(index);
                    FileResult result;
                    try {
                        result = receiveEntry(session, entry, dataDir, inbox, index, info.entries.size(), transferredBytes, info.totalBytes);
                    } catch (MigrationFailure failure) {
                        if (isFatalReceive(failure, entry)) throw failure;
                        result = new FileResult(entry.path, "failed");
                        result.error = failure.getMessage();
                        result.retryable = failure.retryable;
                        result.size = entry.size;
                    } catch (Exception error) {
                        if ("state".equals(entry.role)) throw error;
                        result = new FileResult(entry.path, "failed");
                        result.error = message(error);
                        result.retryable = true;
                        result.size = entry.size;
                    }
                    results.add(result);
                    if (!"failed".equals(result.status)) transferredBytes += entry.size;
                    if ("state".equals(entry.role) && !"failed".equals(result.status)) stateOk = true;
                    long reportedBytes = "failed".equals(result.status) ? 0 : entry.size;
                    notifyProgress("download", index + 1, info.entries.size(), entry.path, reportedBytes, entry.size,
                            transferredBytes, info.totalBytes, false);
                }
                boolean complete = stateOk;
                for (FileResult result : results) if ("failed".equals(result.status)) complete = false;
                JSObject result = new JSObject();
                JSArray files = new JSArray();
                String statePath = "";
                for (FileResult file : results) {
                    files.put(file.toJson());
                    if (file.path.equals(STATE_REL)) statePath = file.destination;
                }
                result.put("files", files);
                result.put("statePath", statePath);
                result.put("complete", complete);
                result.put("totalBytes", info.totalBytes);
                result.put("receivedBytes", transferredBytes);
                result.put("availableBytes", availableBytes());
                result.put("sessionExpiresAt", session.expiresAt);
                call.resolve(result);
            } catch (MigrationFailure error) {
                Log.w("MigrationPlugin", "receive failed: " + error.code + " / " + error.getMessage(), error);
                call.reject(error.code, error.getMessage());
            } catch (Exception error) {
                Log.w("MigrationPlugin", "receive crashed", error);
                call.reject("MIGRATION_FAILED", message(error));
            } finally {
                currentConnection = null;
                receiveRunning = false;
                keepScreenOn(false);
            }
        });
    }

    @PluginMethod
    public void cancelReceive(PluginCall call) {
        receiveCancelled = true;
        HttpURLConnection connection = currentConnection;
        if (connection != null) {
            try {
                connection.disconnect();
            } catch (Exception ignored) {
                // 断开失败时下载循环仍会检查取消标志。
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void readState(PluginCall call) {
        String path = call.getString("path", "").trim();
        if (!path.startsWith(INBOX_DIR + "/")) {
            call.reject("INVALID_PATH", "迁移状态文件路径无效");
            return;
        }
        try {
            String safe = MigrationWire.safeRelativePath(path);
            File dataDir = getContext().getFilesDir();
            File file = new File(dataDir, safe);
            String root = dataDir.getCanonicalPath() + File.separator;
            if (!file.getCanonicalPath().startsWith(root)) {
                call.reject("INVALID_PATH", "迁移状态文件路径无效");
                return;
            }
            if (!file.isFile()) {
                call.reject("STATE_NOT_FOUND", "迁移状态文件不存在");
                return;
            }
            if (file.length() > MAX_STATE_BYTES) {
                call.reject("STATE_TOO_LARGE", "迁移状态文件超过 8 MB");
                return;
            }
            byte[] bytes = readAll(file, MAX_STATE_BYTES);
            JSObject result = new JSObject();
            result.put("stateJson", new String(bytes, StandardCharsets.UTF_8));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("STATE_READ_FAILED", message(error));
        }
    }

    @PluginMethod
    public void freeSpace(PluginCall call) {
        JSObject result = new JSObject();
        result.put("availableBytes", availableBytes());
        call.resolve(result);
    }

    private void startManifestBuild(File dataDir, File stateFile, long generation) {
        Thread thread = new Thread(() -> {
            try {
                MigrationShareServer.Manifest built = buildManifest(dataDir, stateFile);
                if (generation != shareGeneration) return;
                MigrationShareServer server = shareServer;
                if (server == null) return;
                server.setManifest(built);
                manifest = built;
                shareBuilding = false;
                shareError = null;
                JSObject data = new JSObject();
                data.put("fileCount", built.files.size());
                data.put("totalBytes", built.totalBytes);
                notifyListeners("shareReady", data);
            } catch (Exception error) {
                if (generation != shareGeneration) return;
                shareBuilding = false;
                shareError = message(error);
                JSObject data = new JSObject();
                data.put("message", shareError);
                notifyListeners("shareError", data);
            }
        }, "migration-manifest");
        thread.setDaemon(true);
        thread.start();
    }

    private MigrationShareServer.Manifest buildManifest(File dataDir, File stateFile) throws Exception {
        long createdAt = System.currentTimeMillis();
        List<File> mediaFiles = new ArrayList<>();
        scanRoot(new File(dataDir, "dance-offline"), dataDir, mediaFiles);
        // 单视频收录的私有副本与 sidecar：新机可据 sidecar 重建视频索引，不依赖旧机 localStorage。
        scanRoot(new File(dataDir, "dance-videos"), dataDir, mediaFiles);
        // 待上传的音频/歌词/谱件临时副本：迁移后由新机继续上传，保留原幂等键。
        scanRoot(new File(dataDir, "dance-pending"), dataDir, mediaFiles);
        Map<File, String> relativePaths = new HashMap<>();
        for (File file : mediaFiles) relativePaths.put(file, relativePath(dataDir, file));
        Collections.sort(mediaFiles, Comparator.comparing(relativePaths::get));
        List<MigrationShareServer.Entry> entries = new ArrayList<>();
        long total = 0;
        String statePath = relativePath(dataDir, stateFile);
        if (!STATE_REL.equals(statePath)) throw new IOException("迁移状态路径异常");
        String stateHash = hashFile(stateFile);
        long stateSize = stateFile.length();
        entries.add(new MigrationShareServer.Entry("state", "state", STATE_REL, "application/json", stateHash,
                stateSize, stateFile.lastModified(), stateFile));
        total += stateSize;
        int scanned = 0;
        long scannedBytes = 0;
        for (File file : mediaFiles) {
            String path = relativePath(dataDir, file);
            MigrationWire.safeRelativePath(path);
            long size = file.length();
            if (size < 0 || size > MAX_FILE_BYTES) throw new IOException("文件过大：" + path);
            String sha = hashFile(file);
            String id = "f" + entries.size();
            entries.add(new MigrationShareServer.Entry(id, "media", path, MigrationWire.mimeOf(path), sha, size,
                    file.lastModified(), file));
            total += size;
            if (total > MAX_TOTAL_BYTES) throw new IOException("迁移文件总大小超过 6 GB");
            scanned++;
            scannedBytes += size;
            JSObject progress = new JSObject();
            progress.put("scannedFiles", scanned);
            progress.put("scannedBytes", scannedBytes);
            progress.put("currentPath", path);
            notifyListeners("shareProgress", progress);
        }
        return new MigrationShareServer.Manifest(createdAt, total, entries);
    }

    private void scanRoot(File root, File dataDir, List<File> out) throws IOException {
        if (!root.exists()) return;
        String dataRoot = dataDir.getCanonicalPath() + File.separator;
        ArrayList<File> stack = new ArrayList<>();
        stack.add(root);
        while (!stack.isEmpty()) {
            File directory = stack.remove(stack.size() - 1);
            File[] children = directory.listFiles();
            if (children == null) continue;
            for (File child : children) {
                String name = child.getName();
                if (name.startsWith(".")) continue;
                String canonical = child.getCanonicalPath();
                if (!canonical.startsWith(dataRoot)) throw new IOException("迁移目录越界");
                if (child.isDirectory()) {
                    stack.add(child);
                    continue;
                }
                if (!child.isFile()) continue;
                if (name.endsWith(".part") || name.endsWith(".tmp") || name.endsWith(".crdownload")) continue;
                MigrationWire.safeRelativePath(relativePath(dataDir, child));
                out.add(child);
                if (out.size() >= MAX_FILES) throw new IOException("文件数量超过上限");
            }
        }
    }

    private FileResult receiveEntry(ReceiveSession session, EntryInfo entry, File dataDir, File inbox,
                                    int index, int fileCount, long completedBytes, long totalBytes) throws Exception {
        boolean stateRole = "state".equals(entry.role);
        File target;
        String status = "received";
        if (stateRole) {
            target = new File(inbox, "state-" + System.currentTimeMillis() + "-" + randomHex(4) + ".json");
        } else {
            target = new File(dataDir, entry.path);
            String root = dataDir.getCanonicalPath() + File.separator;
            if (!target.getCanonicalPath().startsWith(root)) {
                throw new MigrationFailure("INVALID_PATH", "清单包含非法路径", false);
            }
            File parent = target.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) {
                throw new MigrationFailure("WRITE_FAILED", "无法创建目标目录", false);
            }
            if (target.exists()) {
                if (matchesEntry(target, entry)) {
                    deletePart(session, entry, target.getParentFile());
                    FileResult skipped = new FileResult(entry.path, "skipped");
                    skipped.destination = relativePath(dataDir, target);
                    skipped.uri = Uri.fromFile(target).toString();
                    skipped.sha256 = entry.sha256;
                    skipped.size = entry.size;
                    return skipped;
                }
                target = conflictTarget(inbox, entry);
                status = "conflict";
                // 隔离名由「原始路径 + 内容摘要」派生：重试时命中上次的隔离副本，不重复下载、不再堆副本。
                if (matchesEntry(target, entry)) {
                    deletePart(session, entry, target.getParentFile());
                    FileResult existing = new FileResult(entry.path, "conflict");
                    existing.destination = relativePath(dataDir, target);
                    existing.uri = Uri.fromFile(target).toString();
                    existing.sha256 = entry.sha256;
                    existing.size = entry.size;
                    existing.error = "新机已有同名文件且内容不同，旧机文件已在隔离目录中，未覆盖";
                    return existing;
                }
            }
        }
        if (target.exists() && stateRole) {
            target = new File(inbox, "state-" + System.currentTimeMillis() + "-" + randomHex(4) + ".json");
        }
        if (target.getParentFile() != null && !target.getParentFile().exists() && !target.getParentFile().mkdirs()) {
            throw new MigrationFailure("WRITE_FAILED", "无法创建迁移目录", false);
        }
        // 半包名绑定本次握手与清单内容摘要：换会话或旧机内容变化都不会误用旧断点。
        File part = new File(target.getParentFile(), MigrationWire.partName(session.handshakeId, entry.sha256, entry.path));
        sweepForeignParts(part.getParentFile(), session.handshakeId);
        downloadEntry(session, entry, part, index, fileCount, completedBytes, totalBytes);
        if (target.exists()) {
            if (matchesEntry(target, entry)) {
                part.delete();
                FileResult skipped = new FileResult(entry.path, "skipped");
                skipped.destination = relativePath(dataDir, target);
                skipped.uri = Uri.fromFile(target).toString();
                skipped.sha256 = entry.sha256;
                skipped.size = entry.size;
                return skipped;
            }
            if (!"conflict".equals(status)) {
                target = conflictTarget(inbox, entry);
                status = "conflict";
            } else {
                // 隔离名已绑定内容摘要，同名却内容不同只可能是摘要前缀碰撞，宁可失败也不覆盖。
                part.delete();
                throw new MigrationFailure("WRITE_FAILED", "隔离文件与旧机内容冲突：" + entry.path, false);
            }
        }
        if (!part.renameTo(target)) {
            throw new MigrationFailure("WRITE_FAILED", "无法保存文件：" + entry.path, true);
        }
        FileResult result = new FileResult(entry.path, status);
        result.destination = relativePath(dataDir, target);
        result.uri = Uri.fromFile(target).toString();
        result.sha256 = entry.sha256;
        result.size = entry.size;
        if ("conflict".equals(status)) result.error = "新机已有同名文件且内容不同，已保存到隔离目录，未覆盖";
        return result;
    }

    /** 删除本次握手、本次内容对应的半包；不影响其他会话或其他内容的断点。 */
    private static void deletePart(ReceiveSession session, EntryInfo entry, File directory) {
        if (directory == null) return;
        File part = new File(directory, MigrationWire.partName(session.handshakeId, entry.sha256, entry.path));
        if (part.exists()) part.delete();
    }

    /**
     * 清掉「其他握手」留下的旧 .part：它们绑定的是已失效的握手，本次会话无法复用。
     * 每个目录只扫一次；当前握手自己的半包（含稍后要继续的文件）一律不动。
     */
    private void sweepForeignParts(File directory, String handshakeId) {
        if (directory == null) return;
        String key;
        try {
            key = directory.getCanonicalPath();
        } catch (IOException error) {
            return;
        }
        if (!sweptPartDirs.add(key)) return;
        File[] children = directory.listFiles();
        if (children == null) return;
        for (File child : children) {
            if (child.isFile() && MigrationWire.isForeignPart(child.getName(), handshakeId)) child.delete();
        }
    }

    private void downloadEntry(ReceiveSession session, EntryInfo entry, File part,
                               int index, int fileCount, long completedBytes, long totalBytes) throws Exception {
        long expected = entry.size;
        long chunkSize = MigrationCrypto.FILE_CHUNK_SIZE;
        int checksumRetries = 0;
        HttpURLConnection connection = null;
        for (int attempt = 0; attempt < 4; attempt++) {
            checkCancelled();
            long offset = part.exists() ? part.length() : 0;
            long resume = MigrationWire.resumableOffset(offset, expected, chunkSize);
            if (resume != offset) {
                if (resume == 0) part.delete();
                else truncate(part, resume);
            }
            offset = resume;
            if (expected == 0) {
                if (part.exists()) part.delete();
                if (!part.createNewFile()) throw new MigrationFailure("WRITE_FAILED", "无法创建空文件", true);
                String actual = sha256(part);
                if (!MigrationWire.constantTimeEquals(actual, entry.sha256)) {
                    part.delete();
                    throw new MigrationFailure("CHECKSUM_MISMATCH", "文件校验失败：" + entry.path, true);
                }
                return;
            }
            connection = open(entry, session, offset);
            currentConnection = connection;
            int status;
            try {
                status = connection.getResponseCode();
            } catch (IOException error) {
                connection.disconnect();
                throw new MigrationFailure("NETWORK", "网络中断，已保留断点，可继续：" + entry.path, true);
            }
            if (status == 401) {
                connection.disconnect();
                receiveSession = null;
                throw new MigrationFailure("SESSION_EXPIRED", "旧手机迁移会话已过期，请重新开始分享并重新连接", false);
            }
            if (status == 404 || status == 409) {
                connection.disconnect();
                throw new MigrationFailure("MANIFEST_CHANGED", "旧手机文件清单已变化，请重新开始分享", false);
            }
            if (status == 416) {
                connection.disconnect();
                if (offset == expected && part.exists() && part.length() == expected) {
                    String actual = sha256(part);
                    if (MigrationWire.constantTimeEquals(actual, entry.sha256)) return;
                }
                part.delete();
                continue;
            }
            String chunkHeader = connection.getHeaderField("X-Migration-Chunk-Size");
            if (chunkHeader == null) {
                connection.disconnect();
                throw new MigrationFailure("PLAINTEXT_PEER",
                        "旧手机版本过旧，迁移通道没有加密，已停止接收；请把两台手机升级到同一版本", false);
            }
            String overheadHeader = connection.getHeaderField("X-Migration-Frame-Overhead");
            try {
                if (Long.parseLong(chunkHeader) != chunkSize) {
                    connection.disconnect();
                    throw new MigrationFailure("PROTOCOL_MISMATCH", "旧手机迁移分块大小不兼容，请升级后再试", false);
                }
                if (overheadHeader != null && Long.parseLong(overheadHeader) != MigrationCrypto.CHUNK_FRAME_OVERHEAD) {
                    connection.disconnect();
                    throw new MigrationFailure("PROTOCOL_MISMATCH", "旧手机迁移分帧格式不兼容，请升级后再试", false);
                }
            } catch (NumberFormatException error) {
                connection.disconnect();
                throw new MigrationFailure("PROTOCOL_MISMATCH", "旧手机迁移协议无效", false);
            }
            long aligned = MigrationCrypto.alignDown(offset);
            if (status == 206) {
                long plainStart = parseLongHeader(connection.getHeaderField("X-Migration-Plain-Start"));
                long rangeStart = contentRangeStart(connection.getHeaderField("Content-Range"));
                if (plainStart != aligned || rangeStart != aligned) {
                    connection.disconnect();
                    part.delete();
                    continue;
                }
            } else if (status == 200) {
                if (offset > 0) {
                    connection.disconnect();
                    part.delete();
                    continue;
                }
                aligned = 0;
            } else {
                String error = readError(connection);
                connection.disconnect();
                throw new MigrationFailure("HTTP_" + status, error.isEmpty() ? "旧手机返回错误" : error, status >= 500);
            }

            try {
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                boolean resumed = offset > 0;
                // 续传前缀来自本机私有目录，文件名绑定「本次握手 + 清单摘要」，但它没有逐块密文可校验，
                // 因此不当作已认证数据：整文件 SHA-256 必须与清单一致，否则删除半包重下一次（见下方分支）。
                if (resumed) feedDigest(part, digest);
                long written = offset;
                long position = aligned;
                int skip = (int) (offset - aligned);
                byte[] fileKey = MigrationCrypto.fileKey(session.keys.file, entry.id);
                long lastSpaceCheck = System.currentTimeMillis();
                try (InputStream in = connection.getInputStream();
                     FileOutputStream out = new FileOutputStream(part, resumed)) {
                    while (position < expected) {
                        checkCancelled();
                        int plainLength = (int) Math.min(chunkSize, expected - position);
                        long chunkIndex = position / chunkSize;
                        byte[] frame = new byte[plainLength + MigrationCrypto.CHUNK_FRAME_OVERHEAD];
                        readFully(in, frame);
                        byte[] nonce = new byte[MigrationCrypto.NONCE_BYTES];
                        byte[] cipher = new byte[plainLength + MigrationCrypto.TAG_BYTES];
                        System.arraycopy(frame, 0, nonce, 0, nonce.length);
                        System.arraycopy(frame, nonce.length, cipher, 0, cipher.length);
                        byte[] plain;
                        try {
                            plain = MigrationCrypto.open(fileKey, nonce,
                                    MigrationCrypto.chunkAad(session.handshakeId, entry.id, chunkIndex, expected), cipher);
                        } catch (Exception error) {
                            throw new MigrationFailure("CHECKSUM_MISMATCH",
                                    "文件解密校验失败，已删除损坏半包：" + entry.path, true);
                        }
                        int from = position == aligned ? skip : 0;
                        out.write(plain, from, plain.length - from);
                        digest.update(plain, from, plain.length - from);
                        written += plain.length - from;
                        position += plainLength;
                        if (System.currentTimeMillis() - lastSpaceCheck > 1000) {
                            lastSpaceCheck = System.currentTimeMillis();
                            if (availableBytes() < LOW_SPACE_BYTES) {
                                throw new MigrationFailure("INSUFFICIENT_SPACE", "新手机空间不足，已保留断点", true);
                            }
                        }
                        notifyProgress("download", index + 1, fileCount, entry.path, written, expected,
                                completedBytes + written, totalBytes, resumed);
                    }
                    out.getFD().sync();
                }
                if (part.length() != expected) {
                    throw new MigrationFailure("INCOMPLETE", "文件未下载完整，已保留断点：" + entry.path, true);
                }
                String actual = MigrationWire.hex(digest.digest());
                if (!MigrationWire.constantTimeEquals(actual, entry.sha256)) {
                    throw new MigrationFailure("CHECKSUM_MISMATCH", "文件校验失败，已删除损坏半包：" + entry.path, true);
                }
                return;
            } catch (MigrationFailure failure) {
                if ("CHECKSUM_MISMATCH".equals(failure.code) || "INCOMPLETE".equals(failure.code)) {
                    part.delete();
                    if (checksumRetries++ == 0) continue;
                }
                throw failure;
            } catch (IOException error) {
                throw new MigrationFailure("NETWORK", "下载中断，已保留断点，可继续：" + entry.path, true);
            } finally {
                if (connection != null) connection.disconnect();
                currentConnection = null;
            }
        }
        throw new MigrationFailure("RANGE_FAILED", "旧手机不支持断点续传，请重新开始分享", true);
    }

    private static void truncate(File file, long length) throws IOException {
        try (java.io.RandomAccessFile access = new java.io.RandomAccessFile(file, "rw")) {
            access.setLength(length);
        }
    }

    private static void readFully(InputStream in, byte[] buffer) throws IOException {
        int offset = 0;
        while (offset < buffer.length) {
            int read = in.read(buffer, offset, buffer.length - offset);
            if (read < 0) throw new IOException("连接提前结束");
            offset += read;
        }
    }

    private static long parseLongHeader(String value) {
        if (value == null) return -1;
        try {
            return Long.parseLong(value.trim());
        } catch (NumberFormatException error) {
            return -1;
        }
    }

    private HttpURLConnection open(EntryInfo entry, ReceiveSession session, long offset) throws Exception {
        URL url = new URL("http", session.host, session.port, "/api/migration/file?id=" + entry.id);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection(Proxy.NO_PROXY);
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setUseCaches(false);
        String range = offset > 0 ? "bytes=" + offset + "-" : null;
        for (Map.Entry<String, String> header : signedHeaders(session, "GET", "/api/migration/file",
                "id=" + entry.id, range).entrySet()) {
            connection.setRequestProperty(header.getKey(), header.getValue());
        }
        connection.setRequestProperty("Accept-Encoding", "identity");
        connection.setRequestProperty("Connection", "close");
        if (range != null) connection.setRequestProperty("Range", range);
        return connection;
    }

    /**
     * 握手：配对码不上网。双方用 ECDH(P-256) 共享秘密 + 配对码派生的材料经 HKDF 派生会话密钥，
     * 客户端先出示 HMAC 证明，服务端确认成功后再回出示自己的证明；两侧证明都绑定
     * handshakeId 与双方临时公钥，任何冒充者都无法只凭握手材料伪造。
     */
    private ReceiveSession pair(String host, int port, String key, String discoveryToken) throws Exception {
        // 首轮：临时 ECDH(P-256) 握手，双方公钥交换后各自算出共享秘密；
        // 旧手机在确认阶段出示 HMAC 证明，冒充者拿不到配对码/token 就无法生成同一组会话密钥。
        KeyPair pair = MigrationCrypto.newKeyPair();
        byte[] clientPub = MigrationCrypto.publicBytes(pair.getPublic());
        String handshakeId;
        byte[] serverPub;
        byte[] salt;
        boolean auto;
        JSONObject handshake = null;
        HttpURLConnection connection = null;
        try {
            URL handshakeUrl = new URL("http", host, port, "/api/migration/handshake");
            connection = (HttpURLConnection) handshakeUrl.openConnection(Proxy.NO_PROXY);
            currentConnection = connection;
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setUseCaches(false);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Connection", "close");
            JSONObject request = new JSONObject();
            request.put("schema", PROTOCOL_SCHEMA);
            request.put("clientPub", MigrationCrypto.hex(clientPub));
            if (discoveryToken != null) request.put("discoveryToken", discoveryToken);
            byte[] body = request.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(body);
            }
            int status = connection.getResponseCode();
            handshake = readJson(connection, 8192);
            if (status != 200) {
                String message = handshake == null ? "配对环境未建立" : handshake.optString("error", "配对环境未建立");
                throw new MigrationFailure("PAIR_FAILED", message, false);
            }
        } finally {
            connection.disconnect();
            currentConnection = null;
        }
        if (handshake == null || handshake.optInt("schema", -1) != PROTOCOL_SCHEMA) {
            throw new MigrationFailure("PAIR_FAILED", "旧手机迁移协议版本不兼容，请把两台手机升级到同一版本", false);
        }
        handshakeId = handshake.optString("handshakeId", "");
        try {
            serverPub = MigrationCrypto.unhex(handshake.optString("serverPub", ""));
            salt = MigrationCrypto.unhex(handshake.optString("salt", ""));
            if (!handshakeId.matches("[0-9a-f]{32}") || serverPub.length != MigrationCrypto.PUBLIC_KEY_BYTES
                    || salt.length != 16) {
                throw new IllegalArgumentException("handshake");
            }
        } catch (Exception error) {
            throw new MigrationFailure("PAIR_FAILED", "旧手机返回的加密握手数据无效", false);
        }
        auto = handshake.optBoolean("auto", false);
        PublicKey peer = MigrationCrypto.parsePublicKey(serverPub);
        byte[] shared = MigrationCrypto.sharedSecret(pair.getPrivate(), peer);
        byte[] material;
        if (auto && discoveryToken != null) {
            material = MigrationWire.discoveryTokenBytes(discoveryToken);
        } else if (key != null) {
            material = MigrationWire.pairingCodeBytes(key);
        } else {
            throw new MigrationFailure("KEY_REQUIRED", "请输入旧手机显示的 6 位数字配对码", false);
        }
        MigrationCrypto.Keys keys = MigrationCrypto.derive(material, handshakeId, salt, clientPub, serverPub, shared);
        String confirm = MigrationCrypto.clientProof(keys, handshakeId, clientPub, serverPub);

        // 自动发现路径：旧手机用户点「允许」前，服务端回 428；这里轮询等待确认。
        long deadline = System.currentTimeMillis() + 90_000L;
        long lastHintAt = 0;
        long waitMs = 400L;
        while (true) {
            connection = null;
            try {
                URL confirmUrl = new URL("http", host, port, "/api/migration/confirm");
                connection = (HttpURLConnection) confirmUrl.openConnection(Proxy.NO_PROXY);
                currentConnection = connection;
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
                connection.setReadTimeout(READ_TIMEOUT_MS);
                connection.setUseCaches(false);
                connection.setDoOutput(false);
                connection.setRequestProperty("X-Migration-Handshake", handshakeId);
                connection.setRequestProperty("X-Migration-Confirm", confirm);
                connection.setRequestProperty("Content-Length", "0");
                connection.setRequestProperty("Connection", "close");
                int status = connection.getResponseCode();
                JSONObject result = readJson(connection, 4096);
                if (status == 428) {
                    long now = System.currentTimeMillis();
                    if (now - lastHintAt > 2000) {
                        lastHintAt = now;
                        JSObject data = new JSObject();
                        data.put("stage", "waiting-approval");
                        notifyOnUiThread("pairProgress", data);
                    }
                    if (now > deadline) {
                        throw new MigrationFailure("PAIR_TIMEOUT", "旧手机一直没有确认连接，请在旧手机上点「允许」后重试", true);
                    }
                    Thread.sleep(Math.min(waitMs, 1500L));
                    waitMs = Math.min(waitMs * 2, 1500L);
                    continue;
                }
                if (status == 403) {
                    String message = result == null ? "旧手机拒绝了这次连接" : result.optString("error", "旧手机拒绝了这次连接");
                    throw new MigrationFailure("PAIR_DENIED", message, false);
                }
                if (status != 200) {
                    String message = result == null ? "配对码不正确" : result.optString("error", "配对码不正确");
                    throw new MigrationFailure("PAIR_FAILED", message, false);
                }
                String expectedServerProof = MigrationCrypto.serverProof(keys, handshakeId, clientPub, serverPub);
                String providedServerProof = result == null ? "" : result.optString("serverProof", "");
                if (!MigrationCrypto.constantTimeEqualsHex(providedServerProof, expectedServerProof)) {
                    throw new MigrationFailure("PAIR_FAILED",
                            "旧手机身份校验失败，可能有设备在冒充；请重新开始分享", false);
                }
                long expiresAt = result == null ? System.currentTimeMillis() + 60L * 60L * 1000L
                        : result.optLong("expiresAt", System.currentTimeMillis() + 60L * 60L * 1000L);
                long serverTime = result == null ? System.currentTimeMillis() : result.optLong("serverTime", System.currentTimeMillis());
                return new ReceiveSession(host, port, handshakeId, keys, expiresAt, serverTime - System.currentTimeMillis());
            } finally {
                if (connection != null) connection.disconnect();
                currentConnection = null;
            }
        }
    }

    private Map<String, String> signedHeaders(ReceiveSession session, String method, String path,
                                              String query, String range) throws Exception {
        return signedHeaders(session, method, path, query, range, MigrationCrypto.randomHex(random, 16));
    }

    private Map<String, String> signedHeaders(ReceiveSession session, String method, String path,
                                              String query, String range, String nonce) throws Exception {
        long now = System.currentTimeMillis() + session.clockOffset;
        String auth = MigrationCrypto.requestAuth(session.keys, method, path, query, range, now, nonce);
        Map<String, String> headers = new HashMap<>();
        headers.put("X-Migration-Handshake", session.handshakeId);
        headers.put("X-Migration-Time", String.valueOf(now));
        headers.put("X-Migration-Nonce", nonce);
        headers.put("X-Migration-Auth", auth);
        return headers;
    }

    private JSONObject pollManifest(ReceiveSession session) throws Exception {
        long deadline = System.currentTimeMillis() + 60_000L;
        while (System.currentTimeMillis() < deadline) {
            checkCancelled();
            HttpURLConnection connection = null;
            try {
                URL url = new URL("http", session.host, session.port, "/api/migration/manifest");
                connection = (HttpURLConnection) url.openConnection(Proxy.NO_PROXY);
                currentConnection = connection;
                connection.setRequestMethod("GET");
                connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
                connection.setReadTimeout(READ_TIMEOUT_MS);
                connection.setUseCaches(false);
                String requestNonce = MigrationCrypto.randomHex(random, 16);
                for (Map.Entry<String, String> header : signedHeaders(session, "GET", "/api/migration/manifest", "", null, requestNonce).entrySet()) {
                    connection.setRequestProperty(header.getKey(), header.getValue());
                }
                connection.setRequestProperty("Accept-Encoding", "identity");
                connection.setRequestProperty("Connection", "close");
                int status = connection.getResponseCode();
                if (status == 503) {
                    Thread.sleep(400);
                    continue;
                }
                if (status == 401) {
                    receiveSession = null;
                    throw new MigrationFailure("SESSION_EXPIRED", "旧手机迁移会话已过期，请重新开始分享并重新连接", false);
                }
                if (status != 200) {
                    String error = readError(connection);
                    throw new MigrationFailure("MANIFEST_FAILED", error.isEmpty() ? "无法读取旧手机文件清单" : error, status >= 500);
                }
                byte[] sealed = readBytes(connection, MAX_MANIFEST_BYTES);
                if (sealed == null || sealed.length <= MigrationCrypto.NONCE_BYTES) {
                    throw new MigrationFailure("MANIFEST_FAILED", "旧手机文件清单为空或未加密", false);
                }
                byte[] responseNonce = new byte[MigrationCrypto.NONCE_BYTES];
                byte[] cipher = new byte[sealed.length - MigrationCrypto.NONCE_BYTES];
                System.arraycopy(sealed, 0, responseNonce, 0, responseNonce.length);
                System.arraycopy(sealed, responseNonce.length, cipher, 0, cipher.length);
                byte[] plain;
                try {
                    plain = MigrationCrypto.open(session.keys.enc, responseNonce,
                            MigrationCrypto.manifestAad(session.handshakeId, requestNonce), cipher);
                } catch (Exception error) {
                    throw new MigrationFailure("DECRYPT_FAILED", "文件清单解密失败，可能有设备在篡改传输，请重新开始分享", false);
                }
                JSONObject object = new JSONObject(new String(plain, StandardCharsets.UTF_8));
                return object;
            } finally {
                if (connection != null) connection.disconnect();
                currentConnection = null;
            }
        }
        throw new MigrationFailure("MANIFEST_TIMEOUT", "旧手机仍在准备文件清单，请稍后重试", true);
    }

    private ManifestInfo validateManifest(JSONObject root) throws Exception {
        if (root.optInt("schema", -1) != 2) throw new MigrationFailure("SCHEMA_UNSUPPORTED", "迁移协议版本不兼容，请把两台手机升级到同一版本", false);
        if (root.optInt("chunkSize", -1) != MigrationCrypto.FILE_CHUNK_SIZE) {
            throw new MigrationFailure("SCHEMA_UNSUPPORTED", "迁移分块协议不兼容", false);
        }
        JSONArray files = root.optJSONArray("files");
        if (files == null || files.length() == 0) throw new MigrationFailure("MANIFEST_EMPTY", "旧手机没有可迁移文件", false);
        if (files.length() > MAX_FILES) throw new MigrationFailure("MANIFEST_TOO_LARGE", "文件数量超过上限", false);
        long declaredTotal = root.optLong("totalBytes", -1);
        long total = 0;
        int stateCount = 0;
        List<EntryInfo> entries = new ArrayList<>();
        Set<String> ids = new HashSet<>();
        Set<String> paths = new HashSet<>();
        for (int i = 0; i < files.length(); i++) {
            JSONObject object = files.optJSONObject(i);
            if (object == null) throw new MigrationFailure("MANIFEST_INVALID", "文件清单格式无效", false);
            String id = object.optString("id", "");
            if (!id.matches("[A-Za-z0-9_-]{1,32}") || !ids.add(id)) {
                throw new MigrationFailure("MANIFEST_INVALID", "文件清单 id 无效", false);
            }
            String role = object.optString("role", "");
            String path = MigrationWire.safeRelativePath(object.optString("path", ""));
            if (!paths.add(path)) throw new MigrationFailure("MANIFEST_INVALID", "文件清单路径重复", false);
            String sha = object.optString("sha256", "");
            if (!MigrationWire.isHexSha256(sha)) throw new MigrationFailure("MANIFEST_INVALID", "文件校验值无效", false);
            long size = object.optLong("sizeBytes", -1);
            if (size < 0 || size > MAX_FILE_BYTES) throw new MigrationFailure("MANIFEST_INVALID", "文件大小无效", false);
            String mime = object.optString("mime", MigrationWire.mimeOf(path));
            if ("state".equals(role)) {
                if (!STATE_REL.equals(path)) throw new MigrationFailure("MANIFEST_INVALID", "状态文件路径无效", false);
                stateCount++;
            } else if ("media".equals(role)) {
                if (!path.startsWith("dance-offline/") && !path.startsWith("dance-videos/")
                        && !path.startsWith("dance-pending/")) {
                    throw new MigrationFailure("MANIFEST_INVALID", "媒体文件不在允许目录", false);
                }
            } else {
                throw new MigrationFailure("MANIFEST_INVALID", "文件角色无效", false);
            }
            total += size;
            if (total > MAX_TOTAL_BYTES) throw new MigrationFailure("MANIFEST_TOO_LARGE", "迁移文件总大小超过 6 GB", false);
            entries.add(new EntryInfo(id, role, path, mime, sha, size));
        }
        if (stateCount != 1) throw new MigrationFailure("MANIFEST_INVALID", "缺少迁移状态文件", false);
        if (declaredTotal != total) throw new MigrationFailure("MANIFEST_INVALID", "文件总大小与清单不一致", false);
        return new ManifestInfo(total, entries);
    }

    private void writeAtomic(File temp, File target, byte[] bytes) throws IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) throw new IOException("无法创建目录");
        try (FileOutputStream out = new FileOutputStream(temp, false)) {
            out.write(bytes);
            out.flush();
            out.getFD().sync();
        }
        if (target.exists() && !target.delete()) throw new IOException("无法替换旧迁移状态");
        if (!temp.renameTo(target)) throw new IOException("无法保存迁移状态");
        if (!target.isFile() || target.length() != bytes.length) throw new IOException("迁移状态写入校验失败");
    }

    private String hashFile(File file) throws IOException {
        long before = file.length();
        String hash = sha256(file);
        if (file.length() != before) hash = sha256(file);
        return hash;
    }

    private String sha256(File file) throws IOException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (Exception error) {
            throw new IOException("设备不支持 SHA-256");
        }
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[128 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) digest.update(buffer, 0, read);
        }
        return MigrationWire.hex(digest.digest());
    }

    private void feedDigest(File file, MessageDigest digest) throws IOException {
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[128 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) digest.update(buffer, 0, read);
        }
    }

    private void notifyProgress(String stage, int index, int count, String path, long fileBytes, long fileTotal,
                                long transferredBytes, long totalBytes, boolean resumed) {
        long now = System.currentTimeMillis();
        boolean finished = fileTotal > 0 && fileBytes >= fileTotal;
        if (!finished && now - lastProgressAt < 200) return;
        lastProgressAt = now;
        JSObject data = new JSObject();
        data.put("stage", stage);
        data.put("fileIndex", index);
        data.put("fileCount", count);
        data.put("path", path);
        data.put("fileBytes", fileBytes);
        data.put("fileTotalBytes", fileTotal);
        data.put("transferredBytes", transferredBytes);
        data.put("totalBytes", totalBytes);
        data.put("resumed", resumed);
        notifyListeners("receiveProgress", data);
    }

    private void checkCancelled() throws MigrationFailure {
        if (receiveCancelled) throw new MigrationFailure("CANCELLED", "已停止接收，已完成文件与断点保留", false);
    }

    private void stopShareInternal() {
        shareGeneration++;
        MigrationShareServer server = shareServer;
        shareServer = null;
        if (server != null) server.stop();
        manifest = null;
        shareBuilding = false;
        shareError = null;
        codeExpiresAt = 0;
        try {
            File dataDir = getContext().getFilesDir();
            File shareDir = new File(dataDir, SHARE_DIR);
            File state = new File(shareDir, "state.json");
            File temp = new File(shareDir, "state.json.tmp");
            if (state.exists()) state.delete();
            if (temp.exists()) temp.delete();
        } catch (Exception ignored) {
            // 清理失败不影响关闭服务。
        }
        keepScreenOn(false);
    }

    private long availableBytes() {
        try {
            StatFs stat = new StatFs(getContext().getFilesDir().getAbsolutePath());
            return stat.getAvailableBytes();
        } catch (Exception error) {
            return 0;
        }
    }

    /** 已存在文件与清单一致（大小 + SHA-256）才可复用；否则必须走隔离或重新下载。 */
    private boolean matchesEntry(File file, EntryInfo entry) throws IOException {
        return file.isFile() && file.length() == entry.size
                && MigrationWire.constantTimeEquals(hashFile(file), entry.sha256);
    }

    /**
     * 冲突副本用「原始路径 + 内容摘要」派生的固定名字，重试时能找回同一份副本；
     * 不再用随机名，避免每次重试都重下并多堆一份。
     */
    private File conflictTarget(File inbox, EntryInfo entry) throws IOException {
        File dir = new File(inbox, "conflicts");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("无法创建隔离目录");
        return new File(dir, MigrationWire.conflictName(entry.sha256, entry.path));
    }

    private String randomHex(int bytes) {
        byte[] value = new byte[bytes];
        random.nextBytes(value);
        return MigrationWire.hex(value);
    }

    private String relativePath(File dataDir, File file) throws IOException {
        String root = dataDir.getCanonicalPath() + File.separator;
        String path = file.getCanonicalPath();
        if (!path.startsWith(root)) throw new IOException("路径越界");
        return path.substring(root.length()).replace(File.separatorChar, '/');
    }

    private static boolean isFatalReceive(MigrationFailure failure, EntryInfo entry) {
        if ("state".equals(entry.role)) return true;
        switch (failure.code) {
            case "CANCELLED":
            case "SESSION_EXPIRED":
            case "INSUFFICIENT_SPACE":
            case "MANIFEST_CHANGED":
            case "NETWORK":
            case "INCOMPLETE":
            case "SIZE_MISMATCH":
            case "WRITE_FAILED":
            case "RANGE_FAILED":
            case "INVALID_PATH":
            case "MANIFEST_INVALID":
            case "PAIR_FAILED":
            case "KEY_REQUIRED":
            case "PLAINTEXT_PEER":
            case "PROTOCOL_MISMATCH":
            case "DECRYPT_FAILED":
                return true;
            default:
                return false;
        }
    }

    private static long contentRangeStart(String value) {
        if (value == null || !value.startsWith("bytes ")) return -1;
        int dash = value.indexOf('-', 6);
        if (dash < 0) return -1;
        try {
            return Long.parseLong(value.substring(6, dash).trim());
        } catch (NumberFormatException error) {
            return -1;
        }
    }

    private static byte[] readBytes(HttpURLConnection connection, int maxBytes) throws IOException {
        try (InputStream stream = connection.getInputStream()) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int read;
            while ((read = stream.read(chunk)) != -1) {
                buffer.write(chunk, 0, read);
                if (buffer.size() > maxBytes) throw new IOException("响应过大");
            }
            return buffer.toByteArray();
        }
    }

    private static JSONObject readJson(HttpURLConnection connection, int maxBytes) throws IOException {
        InputStream stream = null;
        try {
            int status = connection.getResponseCode();
            stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (stream == null) return null;
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int read;
            while ((read = stream.read(chunk)) != -1) {
                buffer.write(chunk, 0, read);
                if (buffer.size() > maxBytes) throw new IOException("响应过大");
            }
            String text = new String(buffer.toByteArray(), StandardCharsets.UTF_8);
            if (text.trim().isEmpty()) return null;
            return new JSONObject(text);
        } catch (org.json.JSONException error) {
            throw new IOException("旧手机响应格式无效");
        } finally {
            if (stream != null) {
                try {
                    stream.close();
                } catch (IOException ignored) {
                    // 关闭失败不改变结果。
                }
            }
        }
    }

    private static String readError(HttpURLConnection connection) {
        try {
            InputStream stream = connection.getErrorStream();
            if (stream == null) return "";
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[1024];
            int read;
            while ((read = stream.read(chunk)) != -1 && buffer.size() < 4096) buffer.write(chunk, 0, read);
            JSONObject object = new JSONObject(new String(buffer.toByteArray(), StandardCharsets.UTF_8));
            return object.optString("error", "");
        } catch (Exception error) {
            return "";
        }
    }

    private static byte[] readAll(File file, int maxBytes) throws IOException {
        if (file.length() > maxBytes) throw new IOException("文件过大");
        try (InputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int read;
            while ((read = in.read(chunk)) != -1) {
                buffer.write(chunk, 0, read);
                if (buffer.size() > maxBytes) throw new IOException("文件过大");
            }
            return buffer.toByteArray();
        }
    }

    private void keepScreenOn(boolean on) {
        Activity activity = getActivity();
        if (activity == null) return;
        activity.runOnUiThread(() -> {
            if (on) {
                activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } else {
                activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
        });
    }

    private static String humanBytes(long bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return String.format(Locale.US, "%.1f KB", bytes / 1024.0);
        if (bytes < 1024L * 1024 * 1024) return String.format(Locale.US, "%.1f MB", bytes / 1024.0 / 1024.0);
        return String.format(Locale.US, "%.1f GB", bytes / 1024.0 / 1024.0 / 1024.0);
    }

    private static String message(Throwable error) {
        String message = error == null ? null : error.getMessage();
        return message == null || message.trim().isEmpty() ? "迁移未完成，请重试" : message;
    }
}
