import 'dart:convert';

/// 会话（与 server services/chat.ts 的 ChatSession 对齐）。
class ChatSession {
  const ChatSession({
    required this.id,
    required this.workspaceId,
    required this.createdAt,
    required this.updatedAt,
    this.title,
    this.isActive = true,
    this.provider = 'claude',
    this.providerSessionId,
    this.messages = const [],
    this.totalMessageCount = 0,
  });

  final String id;
  final String workspaceId;
  final String? title;
  final bool isActive;
  final String provider;
  final String? providerSessionId;
  final String createdAt;
  final String updatedAt;
  final List<ChatMessage> messages;
  final int totalMessageCount;

  String get displayTitle {
    final t = title?.trim();
    if (t == null || t.isEmpty) return '新会话';
    return t;
  }

  factory ChatSession.fromJson(Map<String, dynamic> json) {
    final rawMessages = json['messages'];
    return ChatSession(
      id: json['id'] as String,
      workspaceId: (json['workspaceId'] as String?) ?? '',
      title: json['title'] as String?,
      isActive: json['isActive'] as bool? ?? true,
      provider: (json['provider'] as String?) ?? 'claude',
      providerSessionId: json['providerSessionId'] as String?,
      createdAt: (json['createdAt'] as String?) ?? '',
      updatedAt: (json['updatedAt'] as String?) ?? '',
      messages: rawMessages is List
          ? rawMessages
              .whereType<Map>()
              .map((e) => ChatMessage.fromJson(e.cast<String, dynamic>()))
              .toList(growable: false)
          : const [],
      totalMessageCount: (json['totalMessageCount'] as num?)?.toInt() ?? 0,
    );
  }
}

/// 一条会话消息。`metadata` 在 wire 上是 JSON 字符串，这里解开成 Map 方便渲染。
class ChatMessage {
  const ChatMessage({
    required this.id,
    required this.sessionId,
    required this.role,
    required this.type,
    required this.content,
    required this.createdAt,
    this.meta,
  });

  final String id;
  final String sessionId;
  final String role;
  final String type;
  final String content;
  final String createdAt;
  final Map<String, dynamic>? meta;

  String get displayType => (meta?['displayType'] as String?) ?? type;
  bool get isUser => role == 'user';

  String? get thinkingContent => meta?['thinkingContent'] as String?;
  String? get thinkingDuration => meta?['thinkingDuration'] as String?;

  String? get toolName => meta?['toolName'] as String?;
  String? get toolInputText {
    final input = meta?['toolInput'];
    if (input == null) return null;
    if (input is String) return input;
    try {
      return jsonEncode(input);
    } catch (_) {
      return input.toString();
    }
  }

  String get toolStatus => (meta?['toolStatus'] as String?) ?? 'done';
  String? get toolDuration => meta?['toolDuration'] as String?;

  Map<String, dynamic>? get usage =>
      (meta?['usage'] as Map?)?.cast<String, dynamic>();
  double? get costUsd => (meta?['costUsd'] as num?)?.toDouble();

  factory ChatMessage.fromJson(Map<String, dynamic> json) => ChatMessage(
        id: (json['id'] as String?) ?? '',
        sessionId: (json['sessionId'] as String?) ?? '',
        role: (json['role'] as String?) ?? 'assistant',
        type: (json['type'] as String?) ?? 'text',
        content: (json['content'] as String?) ?? '',
        createdAt: (json['createdAt'] as String?) ?? '',
        meta: _decodeMeta(json['metadata']),
      );

  static Map<String, dynamic>? _decodeMeta(Object? raw) {
    if (raw == null) return null;
    if (raw is Map) return raw.cast<String, dynamic>();
    if (raw is String && raw.trim().isNotEmpty && raw != 'null') {
      try {
        final decoded = jsonDecode(raw);
        if (decoded is Map) return decoded.cast<String, dynamic>();
      } catch (_) {
        // 宽容读：坏 metadata 不拖垮整条会话
      }
    }
    return null;
  }
}

/// 一段正在流式输出的回合（SSE chunk 累积出来的临时态，不落库）。
class LiveTurn {
  String text = '';
  String thinking = '';
  bool thinkingDone = false;
  String? thinkingDuration;
  final List<LiveTool> tools = [];

  int? numTurns;
  int inputTokens = 0;
  int outputTokens = 0;
  int cacheReadTokens = 0;
  int cacheCreationTokens = 0;
  double? costUsd;

  bool started = false;
  bool done = false;
  String? errorMessage;
  String? errorCode;

  bool get hasAnything =>
      started || text.isNotEmpty || thinking.isNotEmpty || tools.isNotEmpty || errorMessage != null;

  int get totalTokens => inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

  void applyUsage(Map<String, dynamic>? usage) {
    if (usage == null) return;
    int n(String camel) => (usage[camel] as num?)?.toInt() ?? 0;
    final nextIn = n('inputTokens');
    final nextOut = n('outputTokens');
    final nextRead = n('cacheReadTokens');
    final nextCreate = n('cacheCreationTokens');
    if (nextIn > inputTokens) inputTokens = nextIn;
    if (nextOut > outputTokens) outputTokens = nextOut;
    if (nextRead > cacheReadTokens) cacheReadTokens = nextRead;
    if (nextCreate > cacheCreationTokens) cacheCreationTokens = nextCreate;
  }
}

class LiveTool {
  LiveTool({
    required this.id,
    required this.name,
    this.inputText,
    this.status = 'running',
    this.duration,
  });

  final String id;
  final String name;
  String? inputText;
  String status;
  String? duration;
}
