package com.wanghoufan.dancelibrary;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * 旧手机上的迁移服务。
 *
 * <p>只监听局域网：拒绝公网来源与带 Origin 的浏览器请求；所有文件按清单 id 提供，
 * 不接受客户端传路径。配对码是 6 位数字、一次性、10 分钟有效；同 Wi-Fi 新手机可通过
 * UDP 发现（只回 TCP 端口与一次性 token，不回数字码），但确认前必须由旧手机用户点一次「允许」。
 *
 * <p>传输全程加密：先做 ECDH(P-256) 握手，用配对码（或发现 token）派生的材料 + 共享秘密经 HKDF 派生
 * 会话密钥；密钥本身不上网。确认阶段双方各自出示 HMAC 证明（绑定握手标识与双方公钥），
 * 之后清单与文件均以 AES-256-GCM 加密。每块文件使用独立随机 nonce，AAD 绑定握手、
 * 文件、块序号与大小；清单响应绑定本次请求 nonce。请求另带 HMAC 签名与时间戳/nonce。
 *
 * <p>未确认握手按 handshakeId 并存，且受 MigrationPairingGuard 的「单来源名额 + 全局名额」约束，
 * 先到先得、不做 LRU 淘汰；握手限速与确认失败退避都按来源 IP 计，确认成功只允许一次。
 * 因此任一设备无法抢占合法会话，也无法借自己的失败次数把合法用户锁死。
 */
final class MigrationShareServer {

    private static final String TAG = "MigrationShareServer";
    private static final long HANDSHAKE_TTL_MS = 2L * 60L * 1000L;
    private static final long SESSION_TTL_MS = 60L * 60L * 1000L;
    private static final long AUTH_WINDOW_MS = 5L * 60L * 1000L;
    private static final int MAX_HEADER_BYTES = 16 * 1024;
    private static final int MAX_HANDSHAKE_BODY = 4096;
    private static final int MAX_SESSION_NONCES = 65_536;
    /** 并发连接上限：同网段设备开几个静默连接不能把执行请求的线程占满、拖住正常迁移。 */
    private static final int MAX_CONNECTIONS = 8;
    /** 同一来源 IP 的并发连接上限；正常迁移是单连接顺序下载，3 已留出重试余量。 */
    private static final int MAX_CONNECTIONS_PER_IP = 3;
    /** 请求头读取超时：静默连接最多占线程 10 秒；开始传输后放宽到 30 秒。 */
    private static final int HEADER_READ_TIMEOUT_MS = 10_000;
    private static final int TRANSFER_TIMEOUT_MS = 30_000;
    private static final String PROTOCOL = "dance-migration-v3";
    static final int SCHEMA = 3;

    static final class Entry {
        final String id;
        final String role;
        final String path;
        final String mime;
        final String sha256;
        final long size;
        final long lastModified;
        final File file;

        Entry(String id, String role, String path, String mime, String sha256, long size, long lastModified, File file) {
            this.id = id;
            this.role = role;
            this.path = path;
            this.mime = mime;
            this.sha256 = sha256;
            this.size = size;
            this.lastModified = lastModified;
            this.file = file;
        }
    }

    static final class Manifest {
        final long createdAt;
        final long totalBytes;
        final List<Entry> files;
        final Map<String, Entry> byId;

        Manifest(long createdAt, long totalBytes, List<Entry> files) {
            this.createdAt = createdAt;
            this.totalBytes = totalBytes;
            this.files = files;
            this.byId = new HashMap<>();
            for (Entry entry : files) byId.put(entry.id, entry);
        }

        String toJson() throws Exception {
            JSONArray array = new JSONArray();
            for (Entry entry : files) {
                JSONObject item = new JSONObject();
                item.put("id", entry.id);
                item.put("role", entry.role);
                item.put("path", entry.path);
                item.put("mime", entry.mime);
                item.put("sha256", entry.sha256);
                item.put("sizeBytes", entry.size);
                array.put(item);
            }
            JSONObject root = new JSONObject();
            root.put("schema", 2);
            root.put("createdAt", createdAt);
            root.put("totalBytes", totalBytes);
            root.put("chunkSize", MigrationCrypto.FILE_CHUNK_SIZE);
            root.put("files", array);
            return root.toString();        }
    }

    private static final class Session {
        final String id;
        final String ip;
        final PrivateKey privateKey;
        final PublicKey peerKey;
        final byte[] salt;
        final byte[] clientPub;
        final byte[] serverPub;
        final Map<String, Long> seenNonces = new HashMap<>();
        volatile long expiresAt;
        volatile boolean confirmed;
        /** 同 Wi-Fi 自动发现建立的会话：确认前必须由旧手机用户点「允许」。 */
        volatile boolean auto;
        volatile boolean approved;
        volatile boolean denied;
        /** 自动发现会话的 HKDF 输入材料（由 token 派生）；手动配对为 null，确认时用数字码。 */
        volatile byte[] material;
        volatile MigrationCrypto.Keys keys;

        Session(String id, String ip, PrivateKey privateKey, PublicKey peerKey,
                byte[] salt, byte[] clientPub, byte[] serverPub, long expiresAt) {
            this.id = id;
            this.ip = ip;
            this.privateKey = privateKey;
            this.peerKey = peerKey;
            this.salt = salt;
            this.clientPub = clientPub;
            this.serverPub = serverPub;
            this.expiresAt = expiresAt;
        }
    }

    private final File dataDir;
    private final File stateFile;
    private final String pairingKey;
    private final long codeExpiresAt;
    private final SecureRandom random;
    private final ExecutorService workers = Executors.newFixedThreadPool(2, runnable -> {
        Thread thread = new Thread(runnable, "migration-share-http");
        thread.setDaemon(true);
        return thread;
    });
    private final Set<Socket> clients = Collections.synchronizedSet(new HashSet<>());
    /** 未确认握手按 handshakeId 并存，后到的握手不会覆盖别人正在进行的配对。 */
    private final Map<String, Session> pendingSessions = new HashMap<>();
    /** 握手限速、未确认会话名额与失败退避都按来源 IP 计，避免他人把合法用户锁死。 */
    private final MigrationPairingGuard guard = new MigrationPairingGuard();
    /** 本次分享的自动发现令牌：只回给同网段的 UDP 探针，不回数字码。 */
    private volatile String discoveryToken;
    private volatile DatagramSocket discoverySocket;
    private volatile Thread discoveryThread;
    /** 自动发现会话需要旧手机用户确认；拿到请求后由 UI 弹「允许 / 拒绝」。 */
    private volatile PairRequestListener pairRequestListener;

    interface PairRequestListener {
        void onPairRequest(String handshakeId, String ip);

        void onPairRequestCleared(String handshakeId);
    }

    void setPairRequestListener(PairRequestListener listener) {
        this.pairRequestListener = listener;
    }

    private volatile ServerSocket serverSocket;
    private volatile Thread acceptThread;
    private volatile boolean running;
    private volatile Manifest manifest;
    private volatile Session activeSession;
    private volatile boolean codeUsed;

    MigrationShareServer(File dataDir, File stateFile, String pairingKey, long codeExpiresAt, SecureRandom random) {
        this.dataDir = dataDir;
        this.stateFile = stateFile;
        this.pairingKey = pairingKey;
        this.codeExpiresAt = codeExpiresAt;
        this.random = random;
        this.discoveryToken = MigrationCrypto.randomHex(random, 16);
    }

    int start() throws IOException {
        ServerSocket socket = new ServerSocket();
        socket.setReuseAddress(true);
        socket.bind(new InetSocketAddress(InetAddress.getByName("0.0.0.0"), 0));
        serverSocket = socket;
        running = true;
        Thread thread = new Thread(this::acceptLoop, "migration-share-accept");
        thread.setDaemon(true);
        acceptThread = thread;
        thread.start();
        startDiscovery();
        return socket.getLocalPort();
    }

    /** 起一个 UDP 应答器：同网段新手机广播探针时回 TCP 端口与一次性 token（不回数字码）。 */
    private void startDiscovery() {
        try {
            DatagramSocket udp = new DatagramSocket(null);
            udp.setReuseAddress(true);
            udp.bind(new InetSocketAddress(InetAddress.getByName("0.0.0.0"), MigrationWire.DISCOVERY_PORT));
            udp.setSoTimeout(1000);
            discoverySocket = udp;
            Thread thread = new Thread(() -> discoveryLoop(udp), "migration-share-discovery");
            thread.setDaemon(true);
            discoveryThread = thread;
            thread.start();
        } catch (Exception error) {
            // 端口被占或系统限制时只影响「自动发现」，仍可用 6 位数字配对码手动连接。
            Log.w(TAG, "auto discovery unavailable", error);
            discoverySocket = null;
        }
    }

    private void discoveryLoop(DatagramSocket udp) {
        byte[] buffer = new byte[256];
        while (running && !udp.isClosed()) {
            try {
                DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                udp.receive(packet);
                InetAddress source = packet.getAddress();
                if (source == null || !MigrationWire.isPrivateAddress(source)) continue;
                String probe = new String(packet.getData(), packet.getOffset(), packet.getLength(),
                        StandardCharsets.US_ASCII).trim();
                if (!MigrationWire.DISCOVERY_PROBE.equals(probe)) continue;
                String token = discoveryToken;
                if (token == null || running == false) continue;
                JSONObject reply = new JSONObject();
                reply.put("schema", SCHEMA);
                reply.put("protocol", PROTOCOL);
                reply.put("tcpPort", serverSocket == null ? 0 : serverSocket.getLocalPort());
                reply.put("token", token);
                byte[] payload = reply.toString().getBytes(StandardCharsets.UTF_8);
                udp.send(new DatagramPacket(payload, payload.length, source, packet.getPort()));
            } catch (java.net.SocketTimeoutException ignored) {
                // 正常轮询超时，继续等探针。
            } catch (Exception error) {
                if (running) Log.w(TAG, "discovery loop failed", error);
            }
        }
    }

    private void stopDiscovery() {
        discoveryToken = null;
        DatagramSocket udp = discoverySocket;
        discoverySocket = null;
        if (udp != null) udp.close();
        Thread thread = discoveryThread;
        discoveryThread = null;
        if (thread != null) thread.interrupt();
    }

    boolean isDiscoveryRunning() {
        return discoverySocket != null;
    }

    /** 旧手机用户点「允许」：放行这个自动发现会话。 */
    synchronized boolean allowPair(String handshakeId) {
        Session session = handshakeId == null ? null : pendingSessions.get(handshakeId);
        if (session == null || !session.auto || session.denied) return false;
        session.approved = true;
        return true;
    }

    /** 旧手机用户点「拒绝」：清掉会话并通知新手机。 */
    synchronized boolean denyPair(String handshakeId) {
        Session session = handshakeId == null ? null : pendingSessions.get(handshakeId);
        if (session == null) return false;
        session.denied = true;
        pendingSessions.remove(handshakeId);
        guard.unregister(handshakeId);
        PairRequestListener listener = pairRequestListener;
        if (listener != null) listener.onPairRequestCleared(handshakeId);
        return true;
    }

    void setManifest(Manifest value) {
        this.manifest = value;
    }

    boolean isRunning() {
        return running;
    }

    long getCodeExpiresAt() {
        return codeExpiresAt;
    }

    void stop() {
        running = false;
        stopDiscovery();
        ServerSocket socket = serverSocket;
        serverSocket = null;
        if (socket != null) {
            try {
                socket.close();
            } catch (IOException ignored) {
                // 关闭失败不影响退出。
            }
        }
        synchronized (clients) {
            for (Socket client : new ArrayList<>(clients)) {
                try {
                    client.close();
                } catch (IOException ignored) {
                    // 已断开的客户端无需处理。
                }
            }
            clients.clear();
        }
        Thread thread = acceptThread;
        acceptThread = null;
        if (thread != null) thread.interrupt();
        workers.shutdownNow();
        try {
            workers.awaitTermination(1, TimeUnit.SECONDS);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
        synchronized (this) {
            PairRequestListener listener = pairRequestListener;
            if (listener != null) {
                for (String id : new ArrayList<>(pendingSessions.keySet())) listener.onPairRequestCleared(id);
            }
            pendingSessions.clear();
            guard.clear();
        }
        activeSession = null;
    }

    /** 接收连接前的准入判断：总量与单 IP 并发都设上限，防止同网段静默连接占满工作线程。 */
    private boolean admit(Socket socket) {
        String ip = socket.getInetAddress() == null ? "" : socket.getInetAddress().getHostAddress();
        synchronized (clients) {
            if (clients.size() >= MAX_CONNECTIONS) return false;
            int sameIp = 0;
            for (Socket client : clients) {
                InetAddress address = client.getInetAddress();
                if (address != null && ip.equals(address.getHostAddress())) sameIp++;
            }
            if (sameIp >= MAX_CONNECTIONS_PER_IP) return false;
            clients.add(socket);
            return true;
        }
    }

    private void acceptLoop() {
        while (running) {
            ServerSocket current = serverSocket;
            if (current == null) break;
            try {
                Socket socket = current.accept();
                if (!admit(socket)) {
                    try {
                        socket.close();
                    } catch (IOException ignored) {
                        // 超限连接直接丢弃。
                    }
                    continue;
                }
                workers.execute(() -> {
                    try {
                        handle(socket);
                    } finally {
                        clients.remove(socket);
                    }
                });
            } catch (IOException error) {
                if (running) Log.w(TAG, "accept failed", error);
            }
        }
    }

    private void handle(Socket socket) {
        try (Socket ignored = socket) {
            // 未发请求头的静默连接只占 10 秒；读完头部再放宽，避免影响大文件慢速传输。
            socket.setSoTimeout(HEADER_READ_TIMEOUT_MS);
            InputStream in = socket.getInputStream();
            OutputStream out = socket.getOutputStream();
            String requestLine = readLine(in);
            if (requestLine == null || requestLine.isEmpty()) return;
            String[] parts = requestLine.split(" ");
            if (parts.length != 3) {
                sendJson(out, 400, "Bad Request", error("请求格式无效"));
                return;
            }
            String method = parts[0];
            String target = parts[1];
            Map<String, String> headers = readHeaders(in);
            if (headers == null) {
                sendJson(out, 431, "Request Header Fields Too Large", error("请求头过大"));
                return;
            }
            socket.setSoTimeout(TRANSFER_TIMEOUT_MS);
            // 浏览器页面会带 Origin；迁移客户端是原生 HttpURLConnection，不应带。
            if (headers.containsKey("origin")) {
                sendJson(out, 403, "Forbidden", error("不接受浏览器来源"));
                return;
            }
            InetAddress remote = socket.getInetAddress();
            if (!MigrationWire.isPrivateAddress(remote)) {
                sendJson(out, 403, "Forbidden", error("只允许局域网设备"));
                return;
            }
            String remoteIp = MigrationWire.normalizeIp(remote.getHostAddress());
            int queryAt = target.indexOf('?');
            String path = queryAt >= 0 ? target.substring(0, queryAt) : target;
            String rawQuery = queryAt >= 0 ? target.substring(queryAt + 1) : "";
            Map<String, String> query = queryAt >= 0 ? parseQuery(rawQuery) : new HashMap<>();

            if ("/api/migration/handshake".equals(path)) {
                handleHandshake(method, headers, in, out, remoteIp);
                return;
            }
            if ("/api/migration/confirm".equals(path)) {
                handleConfirm(method, headers, out, remoteIp);
                return;
            }
            Session active = authenticate(headers, remoteIp, method, path, rawQuery, headers.get("range"));
            if (active == null) {
                sendJson(out, 401, "Unauthorized", error("迁移会话无效或已过期"));
                return;
            }
            if ("/api/migration/manifest".equals(path)) {
                Manifest current = manifest;
                if (current == null) {
                    sendJson(out, 503, "Service Unavailable", error("正在准备文件清单"));
                    return;
                }
                if (!"GET".equals(method) && !"HEAD".equals(method)) {
                    sendJson(out, 405, "Method Not Allowed", error("只支持 GET"));
                    return;
                }
                byte[] aad = MigrationCrypto.manifestAad(active.id, headers.get("x-migration-nonce"));
                sendEncryptedJson(out, active.keys.enc, aad, current.toJson(), "HEAD".equals(method));
                return;
            }
            if ("/api/migration/file".equals(path)) {
                if (!"GET".equals(method) && !"HEAD".equals(method)) {
                    sendJson(out, 405, "Method Not Allowed", error("只支持 GET"));
                    return;
                }
                Manifest current = manifest;
                if (current == null) {
                    sendJson(out, 503, "Service Unavailable", error("正在准备文件清单"));
                    return;
                }
                Entry entry = current.byId.get(query.get("id"));
                if (entry == null) {
                    sendJson(out, 404, "Not Found", error("文件不存在"));
                    return;
                }
                sendFile(out, entry, headers.get("range"), "HEAD".equals(method), active);
                return;
            }
            sendJson(out, 404, "Not Found", error("接口不存在"));
        } catch (Exception error) {
            Log.w(TAG, "request failed", error);
        }
    }

    private synchronized void handleHandshake(String method, Map<String, String> headers, InputStream in,
                                              OutputStream out, String remoteIp) throws Exception {
        if (!"POST".equals(method)) {
            sendJson(out, 405, "Method Not Allowed", error("只支持 POST"));
            return;
        }
        long now = System.currentTimeMillis();
        if (codeUsed || activeSession != null || guard.isConfirmed()) {
            sendJson(out, 410, "Gone", error("配对码已被使用，请在旧手机重新开始分享"));
            return;
        }
        if (now > codeExpiresAt) {
            sendJson(out, 410, "Gone", error("配对码已过期，请在旧手机重新开始分享"));
            return;
        }
        long wait = guard.beginHandshake(remoteIp, now);
        if (wait > 0) {
            sendJson(out, 429, "Too Many Requests", error("握手过于频繁，请稍后重试"));
            return;
        }
        pruneExpiredSessions(now);
        if (!guard.canRegister(remoteIp, now)) {
            sendJson(out, 429, "Too Many Requests", error("未完成的配对过多，请稍后重试"));
            return;
        }
        byte[] body = readBody(in, headers, MAX_HANDSHAKE_BODY);
        JSONObject request;
        try {
            request = body == null || body.length == 0 ? null : new JSONObject(new String(body, StandardCharsets.UTF_8));
        } catch (Exception error) {
            sendJson(out, 400, "Bad Request", error("握手请求格式无效"));
            return;
        }
        if (request == null || request.optInt("schema", -1) != SCHEMA) {
            sendJson(out, 400, "Bad Request", error("迁移协议版本不兼容，请把两台手机升级到同一版本"));
            return;
        }
        String providedToken = request.optString("discoveryToken", "");
        String currentToken = discoveryToken;
        boolean auto = currentToken != null && !providedToken.isEmpty()
                && MigrationWire.constantTimeEquals(providedToken, currentToken);
        byte[] clientPub;
        PublicKey peerKey;
        try {
            clientPub = MigrationCrypto.unhex(request.optString("clientPub", ""));
            if (clientPub.length != MigrationCrypto.PUBLIC_KEY_BYTES) throw new IllegalArgumentException("长度无效");
            peerKey = MigrationCrypto.parsePublicKey(clientPub);
        } catch (Exception error) {
            sendJson(out, 400, "Bad Request", error("握手公钥无效"));
            return;
        }
        KeyPair pair = MigrationCrypto.newKeyPair();
        byte[] serverPub = MigrationCrypto.publicBytes(pair.getPublic());
        byte[] salt = MigrationCrypto.randomBytes(random, 16);
        String handshakeId = MigrationCrypto.randomHex(random, 16);
        Session next = new Session(handshakeId, remoteIp, pair.getPrivate(), peerKey, salt, clientPub, serverPub,
                now + HANDSHAKE_TTL_MS);
        next.auto = auto;
        if (auto) {
            next.material = MigrationWire.discoveryTokenBytes(providedToken);
            PairRequestListener listener = pairRequestListener;
            if (listener != null) listener.onPairRequest(handshakeId, remoteIp);
        }
        // 只新增自己的 handshakeId，不覆盖其他设备正在确认的会话；名额由 guard 按来源与总量控制。
        pendingSessions.put(handshakeId, next);
        guard.register(handshakeId, remoteIp, next.expiresAt, now);

        JSONObject result = new JSONObject();
        result.put("ok", true);
        result.put("schema", SCHEMA);
        result.put("protocol", PROTOCOL);
        result.put("handshakeId", handshakeId);
        result.put("serverPub", MigrationCrypto.hex(serverPub));
        result.put("salt", MigrationCrypto.hex(salt));
        result.put("chunkSize", MigrationCrypto.FILE_CHUNK_SIZE);
        result.put("expiresAt", next.expiresAt);
        result.put("serverTime", now);
        result.put("auto", auto);
        sendJson(out, 200, "OK", result.toString());
    }

    /** 清掉过期未确认握手，释放名额；已确认会话不受影响。 */
    private void pruneExpiredSessions(long now) {
        Iterator<Map.Entry<String, Session>> iterator = pendingSessions.entrySet().iterator();
        while (iterator.hasNext()) {
            Map.Entry<String, Session> entry = iterator.next();
            if (now > entry.getValue().expiresAt) {
                Session expired = entry.getValue();
                iterator.remove();
                guard.unregister(entry.getKey());
                PairRequestListener listener = pairRequestListener;
                if (listener != null && expired.auto) listener.onPairRequestCleared(entry.getKey());
            }
        }
    }

    private synchronized void handleConfirm(String method, Map<String, String> headers, OutputStream out,
                                            String remoteIp) throws Exception {
        if (!"POST".equals(method)) {
            sendJson(out, 405, "Method Not Allowed", error("只支持 POST"));
            return;
        }
        long now = System.currentTimeMillis();
        if (codeUsed || activeSession != null || guard.isConfirmed()) {
            sendJson(out, 410, "Gone", error("配对码已被使用，请在旧手机重新开始分享"));
            return;
        }
        long wait = guard.confirmWait(remoteIp, now);
        if (wait > 0) {
            sendJson(out, 429, "Too Many Requests", error("配对尝试过多，请稍后再试"));
            return;
        }
        if (now > codeExpiresAt) {
            sendJson(out, 410, "Gone", error("配对码已过期，请在旧手机重新开始分享"));
            return;
        }
        String handshakeId = headers.get("x-migration-handshake");
        Session current = handshakeId == null ? null : pendingSessions.get(handshakeId);
        if (current == null || current.confirmed || now > current.expiresAt
                || !MigrationWire.constantTimeEquals(current.id, handshakeId)
                || !MigrationWire.constantTimeEquals(current.ip, remoteIp)) {
            sendJson(out, 401, "Unauthorized", error("握手已失效，请在旧手机重新开始分享"));
            return;
        }
        if (current.denied) {
            pendingSessions.remove(current.id);
            guard.unregister(current.id);
            sendJson(out, 403, "Forbidden", error("旧手机拒绝了这次连接"));
            return;
        }
        if (current.auto && !current.approved) {
            // 新手机拿到 428 后会继续轮询；旧手机用户点「允许」后才真正确认。
            sendJson(out, 428, "Precondition Required", error("等待旧手机确认连接"));
            return;
        }
        MigrationCrypto.Keys keys;
        try {
            byte[] material = current.material;
            if (material == null) material = MigrationWire.pairingCodeBytes(pairingKey);
            byte[] shared = MigrationCrypto.sharedSecret(current.privateKey, current.peerKey);
            keys = MigrationCrypto.derive(material, current.id, current.salt,
                    current.clientPub, current.serverPub, shared);
        } catch (Exception error) {
            sendJson(out, 400, "Bad Request", error("无法建立加密会话"));
            return;
        }
        String expected = MigrationCrypto.clientProof(keys, current.id, current.clientPub, current.serverPub);
        String provided = headers.get("x-migration-confirm");
        if (!MigrationCrypto.constantTimeEqualsHex(provided, expected)) {
            pendingSessions.remove(current.id);
            guard.unregister(current.id);
            PairRequestListener failedListener = pairRequestListener;
            if (failedListener != null) failedListener.onPairRequestCleared(current.id);
            guard.recordFailure(remoteIp, now);
            sendJson(out, 401, "Unauthorized", error("配对码不正确"));
            return;
        }
        // 一次性密钥：确认成功只允许一次，第二个握手不能抢走已确认的会话。
        if (!guard.claimConfirmed()) {
            pendingSessions.remove(current.id);
            guard.unregister(current.id);
            sendJson(out, 409, "Conflict", error("会话已被其他设备确认，请在旧手机重新开始分享"));
            return;
        }
        pendingSessions.remove(current.id);
        guard.unregister(current.id);
        PairRequestListener listener = pairRequestListener;
        if (listener != null) listener.onPairRequestCleared(current.id);
        current.keys = keys;
        current.confirmed = true;
        current.expiresAt = now + SESSION_TTL_MS;
        activeSession = current;
        codeUsed = true;
        JSONObject result = new JSONObject();
        result.put("ok", true);
        result.put("schema", SCHEMA);
        result.put("expiresAt", current.expiresAt);
        result.put("chunkSize", MigrationCrypto.FILE_CHUNK_SIZE);
        result.put("serverTime", now);
        result.put("serverProof", MigrationCrypto.serverProof(keys, current.id, current.clientPub, current.serverPub));
        sendJson(out, 200, "OK", result.toString());
    }

    private Session authenticate(Map<String, String> headers, String remoteIp, String method,
                                 String path, String query, String range) {
        Session current = activeSession;
        long now = System.currentTimeMillis();
        if (current == null || !current.confirmed || current.keys == null) return null;
        if (now > current.expiresAt) return null;
        if (!MigrationWire.constantTimeEquals(current.ip, remoteIp)) return null;
        if (!MigrationWire.constantTimeEquals(current.id, headers.get("x-migration-handshake"))) return null;
        String timeText = headers.get("x-migration-time");
        String nonce = headers.get("x-migration-nonce");
        String provided = headers.get("x-migration-auth");
        if (timeText == null || nonce == null || provided == null) return null;
        long time;
        try {
            time = Long.parseLong(timeText);
        } catch (NumberFormatException error) {
            return null;
        }
        if (time < now - AUTH_WINDOW_MS || time > now + AUTH_WINDOW_MS) return null;
        if (nonce.length() < 16 || nonce.length() > 64 || !isHex(nonce)) return null;
        String expected;
        try {
            expected = MigrationCrypto.requestAuth(current.keys, method, path, query, range, time, nonce);
        } catch (Exception error) {
            return null;
        }
        if (!MigrationCrypto.constantTimeEqualsHex(provided, expected)) return null;
        synchronized (current.seenNonces) {
            pruneNonces(current, now);
            if (current.seenNonces.containsKey(nonce)) return null;
            if (current.seenNonces.size() >= MAX_SESSION_NONCES) return null;
            current.seenNonces.put(nonce, now);
        }
        return current;
    }

    private static void pruneNonces(Session session, long now) {
        long cutoff = now - AUTH_WINDOW_MS;
        session.seenNonces.entrySet().removeIf(entry -> entry.getValue() < cutoff);
    }

    private void sendEncryptedJson(OutputStream out, byte[] key, byte[] aad, String json, boolean headOnly) throws Exception {
        byte[] nonce = MigrationCrypto.randomBytes(random, MigrationCrypto.NONCE_BYTES);
        byte[] cipherText = MigrationCrypto.seal(key, nonce, aad, json.getBytes(StandardCharsets.UTF_8));
        int length = nonce.length + cipherText.length;
        String head = "HTTP/1.1 200 OK\r\n"
                + "Content-Type: application/octet-stream\r\n"
                + "Content-Length: " + length + "\r\n"
                + "X-Migration-Encrypted: aes-256-gcm\r\n"
                + "Cache-Control: no-store\r\n"
                + "X-Content-Type-Options: nosniff\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
        if (!headOnly) {
            out.write(nonce);
            out.write(cipherText);
        }
        out.flush();
    }

    private void sendFile(OutputStream out, Entry entry, String rangeHeader, boolean headOnly,
                          Session session) throws Exception {
        // 分享期间文件被改写/替换时，清单里的 size/sha256 已失效；拒绝继续发送，要求客户端重取清单。
        if (!entry.file.isFile() || entry.file.length() != entry.size
                || entry.file.lastModified() != entry.lastModified) {
            sendJson(out, 409, "Conflict", error("旧手机文件已变化，请重新开始分享"));
            return;
        }
        long size = entry.size;
        MigrationWire.ByteRange range;
        try {
            range = MigrationWire.parseRange(rangeHeader, size);
        } catch (IllegalArgumentException error) {
            sendRangeError(out, size);
            return;
        }
        long start = range == null ? 0 : range.start;
        if (size == 0 && range != null) {
            sendRangeError(out, size);
            return;
        }
        if (start >= size && size > 0) {
            sendRangeError(out, size);
            return;
        }
        long aligned = MigrationCrypto.alignDown(start);
        long end = range == null ? size - 1 : range.end;
        long firstChunk = MigrationCrypto.chunkIndex(aligned);
        long lastChunk = end < 0 ? -1 : MigrationCrypto.chunkIndex(end);
        long cipherLength = 0;
        for (long chunk = firstChunk; chunk <= lastChunk; chunk++) {
            long plainStart = chunk * MigrationCrypto.FILE_CHUNK_SIZE;
            long plainLength = Math.min(MigrationCrypto.FILE_CHUNK_SIZE, size - plainStart);
            cipherLength += plainLength + MigrationCrypto.CHUNK_FRAME_OVERHEAD;
        }
        int status = range == null ? 200 : 206;
        String reason = range == null ? "OK" : "Partial Content";
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(status).append(' ').append(reason).append("\r\n")
                .append("Content-Type: application/octet-stream\r\n")
                .append("Content-Length: ").append(cipherLength).append("\r\n")
                .append("Accept-Ranges: bytes\r\n")
                .append("Cache-Control: no-store\r\n")
                .append("X-Content-Type-Options: nosniff\r\n")
                .append("X-Migration-Encrypted: aes-256-gcm\r\n")
                .append("X-Migration-Chunk-Size: ").append(MigrationCrypto.FILE_CHUNK_SIZE).append("\r\n")
                .append("X-Migration-Frame-Overhead: ").append(MigrationCrypto.CHUNK_FRAME_OVERHEAD).append("\r\n")
                .append("X-Migration-Plain-Start: ").append(aligned).append("\r\n")
                .append("X-Migration-Plain-End: ").append(Math.max(end, 0)).append("\r\n")
                .append("X-Migration-Plain-Total: ").append(size).append("\r\n")
                .append("Connection: close\r\n");
        if (range != null) {
            head.append("Content-Range: bytes ").append(aligned).append('-').append(Math.max(end, 0))
                    .append('/').append(size).append("\r\n");
        }
        head.append("\r\n");
        out.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
        out.flush();
        if (headOnly || size == 0) return;

        byte[] fileKey = MigrationCrypto.fileKey(session.keys.file, entry.id);
        try (RandomAccessFile file = new RandomAccessFile(entry.file, "r")) {
            long position = aligned;
            while (position < size) {
                if (position > end) break;
                long chunkIndex = position / MigrationCrypto.FILE_CHUNK_SIZE;
                int plainLength = (int) Math.min(MigrationCrypto.FILE_CHUNK_SIZE, size - position);
                byte[] plain = new byte[plainLength];
                file.seek(position);
                file.readFully(plain);
                // 每块、每次请求都用新的随机 nonce；即使同一块被重复请求，也不会 (key, nonce) 复用。
                byte[] nonce = MigrationCrypto.randomBytes(random, MigrationCrypto.NONCE_BYTES);
                byte[] aad = MigrationCrypto.chunkAad(session.id, entry.id, chunkIndex, size);
                byte[] cipher = MigrationCrypto.seal(fileKey, nonce, aad, plain);
                out.write(nonce);
                out.write(cipher);
                position += plainLength;
            }
            out.flush();
        }
    }

    private static void sendRangeError(OutputStream out, long size) throws IOException {
        String head = "HTTP/1.1 416 Range Not Satisfiable\r\n"
                + "Content-Range: bytes */" + size + "\r\n"
                + "Content-Length: 0\r\n"
                + "X-Migration-Plain-Total: " + size + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
        out.flush();
    }

    private static byte[] readBody(InputStream in, Map<String, String> headers, int maxBytes) throws IOException {
        String lengthText = headers.get("content-length");
        long length;
        try {
            length = lengthText == null ? 0 : Long.parseLong(lengthText);
        } catch (NumberFormatException error) {
            return null;
        }
        if (length < 0 || length > maxBytes) return null;
        byte[] body = new byte[(int) length];
        int offset = 0;
        while (offset < length) {
            int read = in.read(body, offset, (int) length - offset);
            if (read < 0) break;
            offset += read;
        }
        return offset == length ? body : null;
    }

    private static boolean isHex(String value) {
        if (value == null || value.isEmpty()) return false;
        for (int i = 0; i < value.length(); i++) {
            if (Character.digit(value.charAt(i), 16) < 0) return false;
        }
        return true;
    }

    private static Map<String, String> parseQuery(String value) {
        Map<String, String> map = new HashMap<>();
        if (value == null || value.isEmpty()) return map;
        for (String pair : value.split("&")) {
            if (pair.isEmpty()) continue;
            int equals = pair.indexOf('=');
            String key = equals >= 0 ? pair.substring(0, equals) : pair;
            String rawValue = equals >= 0 ? pair.substring(equals + 1) : "";
            try {
                map.put(URLDecoder.decode(key, "UTF-8"), URLDecoder.decode(rawValue, "UTF-8"));
            } catch (Exception ignored) {
                // 非法参数直接忽略，后续按缺少参数处理。
            }
        }
        return map;
    }

    private static Map<String, String> readHeaders(InputStream in) throws IOException {
        Map<String, String> headers = new HashMap<>();
        int total = 0;
        while (true) {
            String line = readLine(in);
            if (line == null) return headers;
            if (line.isEmpty()) return headers;
            total += line.length();
            if (total > MAX_HEADER_BYTES) return null;
            int colon = line.indexOf(':');
            if (colon <= 0) continue;
            String name = line.substring(0, colon).trim().toLowerCase(Locale.US);
            String value = line.substring(colon + 1).trim();
            headers.put(name, value);
        }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        int value;
        while ((value = in.read()) != -1) {
            if (value == '\n') break;
            if (value != '\r') buffer.write(value);
            if (buffer.size() > MAX_HEADER_BYTES) return null;
        }
        if (value == -1 && buffer.size() == 0) return null;
        return new String(buffer.toByteArray(), StandardCharsets.ISO_8859_1);
    }

    private static void sendJson(OutputStream out, int status, String reason, String json) throws IOException {
        byte[] body = json.getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 " + status + " " + reason + "\r\n"
                + "Content-Type: application/json; charset=utf-8\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "X-Content-Type-Options: nosniff\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
        out.write(body);
        out.flush();
    }

    private static String error(String message) {
        try {
            JSONObject object = new JSONObject();
            object.put("ok", false);
            object.put("error", message);
            return object.toString();
        } catch (Exception ignored) {
            return "{\"ok\":false}";
        }
    }

    static List<String> localAddresses() {
        List<String> result = new ArrayList<>();
        try {
            for (java.net.NetworkInterface network : java.util.Collections.list(java.net.NetworkInterface.getNetworkInterfaces())) {
                if (!network.isUp() || network.isLoopback()) continue;
                for (java.net.InterfaceAddress address : network.getInterfaceAddresses()) {
                    InetAddress ip = address.getAddress();
                    if (ip instanceof java.net.Inet4Address && MigrationWire.isPrivateAddress(ip)) {
                        String host = ip.getHostAddress();
                        if (!result.contains(host)) result.add(host);
                    }
                }
            }
        } catch (Exception ignored) {
            // 枚举失败时由 UI 提示用户手动查看 Wi-Fi 地址。
        }
        return result;
    }
}
