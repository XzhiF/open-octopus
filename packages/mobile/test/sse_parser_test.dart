import 'package:flutter_test/flutter_test.dart';
import 'package:octopus_mobile/core/models/sse.dart';

void main() {
  group('SseParser', () {
    test('单帧解析', () {
      final parser = SseParser();
      final events = parser.add('event: text_delta\ndata: {"content":"hi"}\n\n');
      expect(events, hasLength(1));
      expect(events.single.event, 'text_delta');
      expect(events.single.json?['content'], 'hi');
    });

    test('跨 chunk 切分也能拼回整帧', () {
      final parser = SseParser();
      expect(parser.add('event: res'), isEmpty);
      expect(parser.add('ult\ndata: {"a":1}'), isEmpty);
      final events = parser.add('\n\n');
      expect(events, hasLength(1));
      expect(events.single.event, 'result');
    });

    test('多行 data 用换行连接，注释行忽略', () {
      final parser = SseParser();
      final events = parser.add(': heartbeat\nevent: note\ndata: line1\ndata: line2\n\n');
      expect(events, hasLength(1));
      expect(events.single.data, 'line1\nline2');
    });

    test('一帧里没有 data 时不产出事件', () {
      final parser = SseParser();
      expect(parser.add('event: ping\n\n'), isEmpty);
    });

    test('CRLF 帧分隔符', () {
      final parser = SseParser();
      final events = parser.add('event: heartbeat\r\ndata: {"ts":"x"}\r\n\r\n');
      expect(events, hasLength(1));
      expect(events.single.event, 'heartbeat');
    });

    test('连着多帧一次到达', () {
      final parser = SseParser();
      final events = parser.add(
        'event: a\ndata: 1\n\n'
        'event: b\ndata: 2\n\n',
      );
      expect(events.map((e) => e.event), ['a', 'b']);
      expect(events.map((e) => e.data), ['1', '2']);
    });

    test('默认 event 是 message', () {
      final parser = SseParser();
      final events = parser.add('data: plain\n\n');
      expect(events.single.event, 'message');
      expect(events.single.json, isNull);
    });
  });
}
