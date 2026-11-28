/// chat 里的图片 / 文件路径识别与媒体地址。
///
/// 口径与桌面 `chat-images.tsx` 一致：只认绝对路径（盘符 / 常见 POSIX 根），
/// 相对路径不猜 cwd；图片走缩略图，其余可读文件走 chip + 只读文档窗。
/// 服务端 `/api/chat-media/:sessionId/{image,doc,raw}` 按会话解析白名单。
library;

const _imgExt = r'png|jpe?g|gif|webp|avif|svg|bmp|ico';
const _docExt =
    r'md|markdown|mdx|txt|json|jsonc|yaml|yml|toml|ini|conf|csv|tsv|log|'
    r'xml|html|htm|css|scss|less|js|mjs|cjs|ts|tsx|jsx|vue|svelte|'
    r'py|go|rs|java|kt|kts|sh|bash|zsh|ps1|sql|graphql|proto|diff|patch|rst|adoc';

/// 单条消息最多出几张缩略图 / 几个文件 chip —— 防止一份报告把转录铺满。
const maxChatImages = 4;
const maxChatFiles = 6;

final _urlRe = RegExp(r'[A-Za-z][A-Za-z0-9+.-]*://\S+');

/// 服务端只放行这两类绝对路径；其余形状直接忽略，避免空图闪烁。
final _servableRe = RegExp(
  r'^(?:[A-Za-z]:[\\/]|/(?:Users|home|tmp|var|opt|mnt|media|root|Volumes)/)',
);

/// markdown 图片：`![alt](path)` / `![alt](path "title")`。
final _mdImageRe = RegExp(
  r'!\[[^\]\n]*\]\(([^)\s]+?\.(?:' + _imgExt + r'))(?:\s+"[^"]*")?\)',
  caseSensitive: false,
);

/// 反引号里的图片路径：`` `C:\…\a.png` ``。
final _codeImageRe = RegExp(
  r'`([^`\n]+?\.(?:' + _imgExt + r'))`',
  caseSensitive: false,
);

/// 正文里的裸图片路径：只认盘符 / 常见 POSIX 根。
final _bareImageRe = RegExp(
  r'((?:[A-Za-z]:[\\/]|/(?:Users|home|tmp|var|opt|mnt|media|root|Volumes)/)'
          r'[^\s`<>"\x27]+?\.(?:' +
      _imgExt +
      r'))'
          r'(?=$|[\s，。；：、)\]】"\x27`])',
  caseSensitive: false,
);

/// markdown 链接（非图片）里的文档路径。先抹掉图片语法再匹配，避免 `![]()` 混进来。
final _mdDocRe = RegExp(
  r'\[[^\]\n]*\]\(([^)\s]+?\.(?:' + _docExt + r'))(?:\s+"[^"]*")?\)',
  caseSensitive: false,
);

final _codeDocRe = RegExp(
  r'`([^`\n]+?\.(?:' + _docExt + r'))`',
  caseSensitive: false,
);

final _bareDocRe = RegExp(
  r'((?:[A-Za-z]:[\\/]|/(?:Users|home|tmp|var|opt|mnt|media|root|Volumes)/)'
          r'[^\s`<>"\x27]+?\.(?:' +
      _docExt +
      r'))'
          r'(?=$|[\s，。；：、)\]】"\x27`])',
  caseSensitive: false,
);

class ChatMediaPaths {
  const ChatMediaPaths({this.images = const [], this.files = const []});

  final List<String> images;
  final List<String> files;

  bool get isEmpty => images.isEmpty && files.isEmpty;
}

/// 从助手正文里抽图片与文件绝对路径（去重、限量）。
ChatMediaPaths extractChatMedia(String text) {
  if (text.trim().isEmpty) return const ChatMediaPaths();
  // 先把 URL 整段抹掉：否则 `https://x/a.png` 里的 `s:/` 会被当成盘符路径。
  final body = text.replaceAll(_urlRe, ' ');
  final images = <String>[];
  final files = <String>[];

  void pushImage(String? raw) {
    final path = raw?.trim();
    if (path == null || path.isEmpty || images.contains(path)) return;
    if (!_servableRe.hasMatch(path)) return;
    if (images.length >= maxChatImages) return;
    images.add(path);
  }

  void pushFile(String? raw) {
    final path = raw?.trim();
    if (path == null || path.isEmpty || files.contains(path)) return;
    if (!_servableRe.hasMatch(path)) return;
    if (images.contains(path)) return;
    final ext = mediaExt(path);
    if (_imageExtSet.contains(ext)) return;
    if (files.length >= maxChatFiles) return;
    files.add(path);
  }

  for (final m in _mdImageRe.allMatches(body)) {
    pushImage(m.group(1));
  }
  for (final m in _codeImageRe.allMatches(body)) {
    pushImage(m.group(1));
  }
  for (final m in _bareImageRe.allMatches(body)) {
    pushImage(m.group(1));
  }

  for (final m in _mdDocRe.allMatches(body.replaceAll(_mdImageRe, ' '))) {
    pushFile(m.group(1));
  }
  for (final m in _codeDocRe.allMatches(body)) {
    pushFile(m.group(1));
  }
  for (final m in _bareDocRe.allMatches(body)) {
    pushFile(m.group(1));
  }
  return ChatMediaPaths(images: images, files: files);
}

const _imageExtSet = {
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.svg',
  '.bmp',
  '.ico',
};

String mediaBasename(String path) {
  final parts = path
      .split(RegExp(r'[\\/]'))
      .where((s) => s.isNotEmpty)
      .toList();
  return parts.isEmpty ? path : parts.last;
}

String mediaExt(String path) {
  final name = mediaBasename(path);
  final i = name.lastIndexOf('.');
  return i < 0 ? '' : name.substring(i).toLowerCase();
}

String formatBytes(int n) {
  if (n >= 1024 * 1024) return '${(n / (1024 * 1024)).toStringAsFixed(1)}MB';
  if (n >= 1024) return '${(n / 1024).toStringAsFixed(1)}KB';
  return '${n}B';
}

/// `/api/chat-media/:sessionId/{image|doc|raw}?path=…`。
/// 这三个路由挂在设备闸外（`<img>` 带不了 Authorization），白名单按会话解析。
String chatMediaUrlFor(
  String baseUrl,
  String sessionId, {
  required String route,
  required String path,
}) {
  final base = baseUrl.endsWith('/')
      ? baseUrl.substring(0, baseUrl.length - 1)
      : baseUrl;
  return '$base/api/chat-media/${Uri.encodeComponent(sessionId)}/$route'
      '?path=${Uri.encodeQueryComponent(path)}';
}

/// `GET /api/chat-media/:sessionId/doc` 的返回（与桌面 `ChatDocResult` 同形）。
class ChatDocResult {
  const ChatDocResult({
    required this.path,
    required this.ext,
    required this.size,
    required this.kind,
    this.content,
    this.mime,
  });

  final String path;
  final String ext;
  final int size;

  /// text / image / video / audio / binary
  final String kind;
  final String? content;
  final String? mime;

  bool get isText => kind == 'text';
  bool get isImage => kind == 'image';

  String get kindLabel => switch (kind) {
    'text' => '文本',
    'image' => '图片',
    'video' => '视频',
    'audio' => '音频',
    _ => '二进制',
  };

  factory ChatDocResult.fromJson(Map<String, dynamic> json) => ChatDocResult(
    path: (json['path'] as String?) ?? '',
    ext: (json['ext'] as String?) ?? '',
    size: (json['size'] as num?)?.toInt() ?? 0,
    kind: (json['kind'] as String?) ?? 'binary',
    content: json['content'] as String?,
    mime: json['mime'] as String?,
  );
}
