import 'package:flutter_test/flutter_test.dart';
import 'package:octopus_mobile/core/chat_media.dart';

void main() {
  group('extractChatMedia', () {
    test('markdown / 反引号 / 裸路径都能抽出图片', () {
      const text = '''
截图在 ![总览](C:\\work\\octopus-web\\artifacts\\cabin-overview.png)，
还有 `/Users/xzf/.octopus/chat-media/s1/shot.webp`。
裸路径 /tmp/diff-stat.png 也认。
''';
      final paths = extractChatMedia(text);
      expect(paths.images, [
        r'C:\work\octopus-web\artifacts\cabin-overview.png',
        '/Users/xzf/.octopus/chat-media/s1/shot.webp',
        '/tmp/diff-stat.png',
      ]);
      expect(paths.files, isEmpty);
    });

    test('文件 chip 只收非图片的可读文件', () {
      const text = '''
验收表 `C:\\work\\octopus-web\\.scratch\\r2\\acceptance-plan-r2.json`
报告 [round-report](C:\\work\\octopus-web\\round-report-2.md)
图片 C:\\work\\octopus-web\\shot.png
''';
      final paths = extractChatMedia(text);
      expect(paths.files, hasLength(2));
      expect(
        paths.files,
        containsAll([
          r'C:\work\octopus-web\.scratch\r2\acceptance-plan-r2.json',
          r'C:\work\octopus-web\round-report-2.md',
        ]),
      );
      expect(paths.images, [r'C:\work\octopus-web\shot.png']);
    });

    test('URL 与相对路径不误判', () {
      const text =
          '看这个 https://x.example.com/a.png 和 docs/spec.md，还有 /api/x.png';
      final paths = extractChatMedia(text);
      expect(paths.isEmpty, isTrue);
    });

    test('图片最多 4 张、文件最多 6 个', () {
      final text = [
        for (var i = 0; i < 8; i++) '/tmp/shot$i.png',
        for (var i = 0; i < 8; i++) '/tmp/doc$i.md',
      ].join('\n');
      final paths = extractChatMedia(text);
      expect(paths.images, hasLength(maxChatImages));
      expect(paths.files, hasLength(maxChatFiles));
    });

    test('同一路径去重', () {
      const text = '`/tmp/a.png` 和 /tmp/a.png 是同一张';
      expect(extractChatMedia(text).images, ['/tmp/a.png']);
    });
  });

  group('媒体地址', () {
    test('image / raw / doc 共用会话白名单路由，path 走查询编码', () {
      final url = chatMediaUrlFor(
        'http://10.0.2.2:3001/',
        's 1',
        route: 'image',
        path: r'C:\work\a b.png',
      );
      expect(
        url,
        'http://10.0.2.2:3001/api/chat-media/s%201/image'
        '?path=C%3A%5Cwork%5Ca+b.png',
      );
    });

    test('文件名 / 扩展名 / 大小', () {
      expect(mediaBasename(r'C:\work\a\b.md'), 'b.md');
      expect(mediaExt('/tmp/B.JSON'), '.json');
      expect(formatBytes(900), '900B');
      expect(formatBytes(2048), '2.0KB');
      expect(formatBytes(3 * 1024 * 1024), '3.0MB');
    });

    test('文档返回解析', () {
      final doc = ChatDocResult.fromJson({
        'path': '/tmp/a.json',
        'ext': '.json',
        'size': 2048,
        'kind': 'text',
        'content': '{"a":1}',
      });
      expect(doc.isText, isTrue);
      expect(doc.kindLabel, '文本');
      expect(doc.size, 2048);
    });
  });
}
