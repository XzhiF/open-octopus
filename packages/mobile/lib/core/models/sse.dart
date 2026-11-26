import 'dart:convert';

/// 一条 SSE 帧。服务端用 `event: <type>` + `data: <json>`。
class SseEvent {
  const SseEvent(this.event, this.data);

  final String event;
  final String data;

  Map<String, dynamic>? get json {
    final trimmed = data.trim();
    if (trimmed.isEmpty) return null;
    try {
      final decoded = jsonDecode(trimmed);
      if (decoded is Map) return decoded.cast<String, dynamic>();
    } catch (_) {
      // 非 JSON 的 data（纯文本）留给调用方按 raw 处理
    }
    return null;
  }

  @override
  String toString() => 'SseEvent($event, ${data.length}B)';
}

/// 增量 SSE 解析器：喂任意切分的字符串块，吐出完整帧。
///
/// 规则（WHATWG SSE）：帧以空行结束；`event:` / `data:` 可重复，data 多行用 `\n` 连接；
/// 以 `:` 开头的行是注释（心跳）。服务端 30s 一次 heartbeat，客户端用它判断链路活。
class SseParser {
  final StringBuffer _buffer = StringBuffer();
  String _event = 'message';
  final List<String> _data = [];

  List<SseEvent> add(String chunk) {
    _buffer.write(chunk);
    var text = _buffer.toString();
    final out = <SseEvent>[];

    while (true) {
      final match = RegExp(r'\r\n\r\n|\n\n|\r\r').firstMatch(text);
      if (match == null) break;
      final rawFrame = text.substring(0, match.start);
      text = text.substring(match.end);
      final frame = _parseFrame(rawFrame);
      if (frame != null) out.add(frame);
    }

    _buffer
      ..clear()
      ..write(text);
    return out;
  }

  SseEvent? _parseFrame(String rawFrame) {
    _event = 'message';
    _data.clear();
    for (final line in rawFrame.split(RegExp(r'\r\n|\n|\r'))) {
      if (line.isEmpty || line.startsWith(':')) continue;
      final colon = line.indexOf(':');
      final field = colon == -1 ? line : line.substring(0, colon);
      var value = colon == -1 ? '' : line.substring(colon + 1);
      if (value.startsWith(' ')) value = value.substring(1);
      if (field == 'event') {
        _event = value;
      } else if (field == 'data') {
        _data.add(value);
      }
    }
    if (_data.isEmpty) return null;
    return SseEvent(_event, _data.join('\n'));
  }
}
