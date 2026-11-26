/// 一台电脑 = 一张设备卡。地址就是 Tailscale 域名（https://<机器>.<tailnet>.ts.net），
/// 走不到公网；不经过任何云端。
enum DeviceStatus {
  /// /api/actuator/health → 200
  running,

  /// /api/actuator/health → 503（服务在，但还没就绪）
  notReady,

  /// 连不上（进程没跑 / 不在同一 tailnet / 电脑睡了）
  offline,

  /// 还没探过
  unknown,
}

class Device {
  const Device({
    required this.id,
    required this.name,
    required this.baseUrl,
    this.platform,
    this.lastSeenAt,
    this.note,
  });

  final String id;
  final String name;

  /// 不带尾部斜杠的根地址，例如 `https://shufang-pc.tailxxxx.ts.net`
  final String baseUrl;

  /// `WINDOWS` / `MACOS` / `OTHER` —— 只用于展示
  final String? platform;

  /// 最后一次连上的时间（ISO 字符串）
  final String? lastSeenAt;

  final String? note;

  Device copyWith({
    String? name,
    String? baseUrl,
    String? platform,
    String? lastSeenAt,
    String? note,
  }) {
    return Device(
      id: id,
      name: name ?? this.name,
      baseUrl: baseUrl ?? this.baseUrl,
      platform: platform ?? this.platform,
      lastSeenAt: lastSeenAt ?? this.lastSeenAt,
      note: note ?? this.note,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'baseUrl': baseUrl,
        if (platform != null) 'platform': platform,
        if (lastSeenAt != null) 'lastSeenAt': lastSeenAt,
        if (note != null) 'note': note,
      };

  factory Device.fromJson(Map<String, dynamic> json) {
    final baseUrl = normalizeBaseUrl(json['baseUrl'] as String? ?? '');
    final rawName = (json['name'] as String?)?.trim() ?? '';
    return Device(
      id: json['id'] as String,
      name: rawName.isNotEmpty ? rawName : guessDeviceName(baseUrl),
      baseUrl: baseUrl,
      platform: json['platform'] as String?,
      lastSeenAt: json['lastSeenAt'] as String?,
      note: json['note'] as String?,
    );
  }
}

/// 归一化手填地址：去空白、去尾部斜杠；没写协议时按 https 补。
String normalizeBaseUrl(String raw) {
  var v = raw.trim();
  if (v.isEmpty) return v;
  while (v.endsWith('/')) {
    v = v.substring(0, v.length - 1);
  }
  if (!v.startsWith('http://') && !v.startsWith('https://')) {
    // 本机调试地址（10.0.2.2 / 192.168.x / 127.0.0.1）默认 http，其余默认 https。
    final isLoopbackOrLan = RegExp(r'^(10\.0\.2\.2|127\.0\.0\.1|localhost|192\.168\.|10\.)')
        .hasMatch(v);
    v = '${isLoopbackOrLan ? 'http' : 'https'}://$v';
  }
  return v;
}

/// 从地址里猜一个显示名：`shufang-pc.tailxxxx.ts.net:47820` → `shufang-pc`。
String guessDeviceName(String baseUrl) {
  final uri = Uri.tryParse(normalizeBaseUrl(baseUrl));
  final host = uri?.host ?? '';
  if (host.isEmpty) return '新设备';
  return host.split('.').first;
}
