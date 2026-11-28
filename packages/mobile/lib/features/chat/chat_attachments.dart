import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/theme.dart';
import '../../core/api.dart';
import '../../core/chat_media.dart';
import '../../core/format.dart';
import '../../core/http.dart' show describeError;

/// 助手正文下面的产物（原型 E12–E14）：
/// 图片出缩略图（点开灯箱），其它可读文件出 `▤` chip（点开只读文档窗，
/// `⧉` 只复制文件名）。两者都盖在当前 chat 上，不跳页。
class ChatAttachments extends StatefulWidget {
  const ChatAttachments({
    super.key,
    required this.text,
    required this.api,
    required this.sessionId,
  });

  final String text;
  final OctopusApi api;
  final String sessionId;

  @override
  State<ChatAttachments> createState() => _ChatAttachmentsState();
}

class _ChatAttachmentsState extends State<ChatAttachments> {
  final Set<String> _failed = {};

  @override
  void didUpdateWidget(covariant ChatAttachments oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.text != widget.text) _failed.clear();
  }

  Future<void> _copy(String text) async {
    await Clipboard.setData(ClipboardData(text: text));
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text('已复制 · $text')));
  }

  @override
  Widget build(BuildContext context) {
    final paths = extractChatMedia(widget.text);
    final images = paths.images.where((p) => !_failed.contains(p)).toList();
    if (images.isEmpty && paths.files.isEmpty) return const SizedBox.shrink();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (images.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final path in images)
                  _Thumb(
                    key: ValueKey(path),
                    url: widget.api.chatMediaUrl(
                      widget.sessionId,
                      route: 'image',
                      path: path,
                    ),
                    name: mediaBasename(path),
                    onTap: () => showImageLightbox(
                      context,
                      api: widget.api,
                      sessionId: widget.sessionId,
                      path: path,
                    ),
                    onFailed: () => setState(() => _failed.add(path)),
                  ),
              ],
            ),
          ),
        if (paths.files.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final path in paths.files)
                  _FileChip(
                    path: path,
                    onOpen: () => showChatDocWindow(
                      context,
                      api: widget.api,
                      sessionId: widget.sessionId,
                      path: path,
                    ),
                    onCopyName: () => _copy(mediaBasename(path)),
                  ),
              ],
            ),
          ),
      ],
    );
  }
}

class _Thumb extends StatelessWidget {
  const _Thumb({
    super.key,
    required this.url,
    required this.name,
    required this.onTap,
    required this.onFailed,
  });

  final String url;
  final String name;
  final VoidCallback onTap;
  final VoidCallback onFailed;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(Octo.rS),
        onTap: onTap,
        child: Container(
          width: 138,
          height: 96,
          clipBehavior: Clip.antiAlias,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(Octo.rS),
            border: Border.all(color: Octo.teal.withValues(alpha: .3)),
            color: const Color(0xFF0B0920),
          ),
          child: Stack(
            fit: StackFit.expand,
            children: [
              Image.network(
                url,
                fit: BoxFit.cover,
                loadingBuilder: (context, child, progress) => progress == null
                    ? child
                    : const Center(
                        child: SizedBox(
                          width: 14,
                          height: 14,
                          child: CircularProgressIndicator(
                            strokeWidth: 1.5,
                            valueColor: AlwaysStoppedAnimation(Octo.teal),
                          ),
                        ),
                      ),
                errorBuilder: (context, error, stack) {
                  WidgetsBinding.instance.addPostFrameCallback((_) {
                    if (context.mounted) onFailed();
                  });
                  return const SizedBox.shrink();
                },
              ),
              Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                child: Container(
                  padding: const EdgeInsets.fromLTRB(7, 7, 7, 4),
                  decoration: const BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      colors: [Color(0x0004030A), Color(0xEB04030A)],
                    ),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontFamily: Octo.mono,
                            fontSize: 8.5,
                            fontWeight: FontWeight.w700,
                            color: Octo.metal,
                          ),
                        ),
                      ),
                      const SizedBox(width: 5),
                      const Text(
                        '放大',
                        style: TextStyle(
                          fontFamily: Octo.mono,
                          fontSize: 9,
                          color: Octo.teal,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _FileChip extends StatelessWidget {
  const _FileChip({
    required this.path,
    required this.onOpen,
    required this.onCopyName,
  });

  final String path;
  final VoidCallback onOpen;
  final VoidCallback onCopyName;

  @override
  Widget build(BuildContext context) {
    final name = mediaBasename(path);
    final ext = mediaExt(path).replaceFirst('.', '');
    return Container(
      constraints: const BoxConstraints(maxWidth: 330),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(Octo.rS),
        border: Border.all(color: Octo.hairline),
        color: const Color(0xB3100D28),
      ),
      clipBehavior: Clip.antiAlias,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Flexible(
            child: InkWell(
              onTap: onOpen,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(9, 6, 7, 6),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Text(
                      '▤',
                      style: TextStyle(fontSize: 11, color: Octo.teal),
                    ),
                    const SizedBox(width: 7),
                    Flexible(
                      child: Text(
                        name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontFamily: Octo.mono,
                          fontSize: 10,
                          fontWeight: FontWeight.w600,
                          color: Octo.ink,
                        ),
                      ),
                    ),
                    if (ext.isNotEmpty) ...[
                      const SizedBox(width: 6),
                      Text(
                        ext,
                        style: const TextStyle(
                          fontFamily: Octo.mono,
                          fontSize: 8.5,
                          letterSpacing: .4,
                          color: Octo.dim,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
          Material(
            color: Colors.transparent,
            child: InkWell(
              onTap: onCopyName,
              child: Container(
                width: 24,
                height: 26,
                alignment: Alignment.center,
                decoration: const BoxDecoration(
                  border: Border(left: BorderSide(color: Octo.hairlineSoft)),
                ),
                child: const Text(
                  '⧉',
                  style: TextStyle(
                    fontFamily: Octo.mono,
                    fontSize: 10,
                    fontWeight: FontWeight.w600,
                    color: Octo.metal,
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 图片灯箱：盖在当前 chat 上，可缩放；点空白处 / 返回键关闭。
Future<void> showImageLightbox(
  BuildContext context, {
  required OctopusApi api,
  required String sessionId,
  required String path,
}) {
  final url = api.chatMediaUrl(sessionId, route: 'image', path: path);
  return showGeneralDialog<void>(
    context: context,
    barrierDismissible: true,
    barrierLabel: '关闭',
    barrierColor: const Color(0xEB04030A),
    transitionDuration: const Duration(milliseconds: 180),
    pageBuilder: (ctx, _, __) => _ImageLightbox(
      url: url,
      path: path,
      onCopy: (text) async {
        await Clipboard.setData(ClipboardData(text: text));
        if (!ctx.mounted) return;
        ScaffoldMessenger.of(ctx)
            .showSnackBar(SnackBar(content: Text('已复制 · $text')));
      },
    ),
    transitionBuilder: (ctx, anim, _, child) =>
        FadeTransition(opacity: anim, child: child),
  );
}

class _ImageLightbox extends StatelessWidget {
  const _ImageLightbox({
    required this.url,
    required this.path,
    required this.onCopy,
  });

  final String url;
  final String path;
  final ValueChanged<String> onCopy;

  @override
  Widget build(BuildContext context) {
    final close = () => Navigator.of(context).maybePop();
    return Material(
      type: MaterialType.transparency,
      child: SafeArea(
        child: Stack(
          children: [
            // 点空白处关闭；内容区自己的手势会吃掉自己的部分。
            Positioned.fill(
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: close,
              ),
            ),
            Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(14, 8, 14, 10),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              mediaBasename(path),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.w600,
                                color: Colors.white,
                              ),
                            ),
                            const SizedBox(height: 2),
                            const Text(
                              '图片 · 双指缩放 · 点空白关闭',
                              style: TextStyle(
                                fontFamily: Octo.mono,
                                fontSize: 8.5,
                                height: 1.4,
                                color: Octo.dim,
                              ),
                            ),
                          ],
                        ),
                      ),
                      IconButton(
                        onPressed: close,
                        icon: const Icon(Icons.close, size: 18),
                        color: Octo.metal,
                        style: IconButton.styleFrom(
                          side: const BorderSide(color: Octo.hairline),
                        ),
                      ),
                    ],
                  ),
                ),
                Container(
                  padding: const EdgeInsets.fromLTRB(14, 8, 14, 8),
                  decoration: const BoxDecoration(
                    border: Border(
                      top: BorderSide(color: Color(0x14FFFFFF)),
                      bottom: BorderSide(color: Color(0x0FFFFFFF)),
                    ),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          pathTail(path),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontFamily: Octo.mono,
                            fontSize: 8.5,
                            height: 1.5,
                            color: Octo.dim,
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      InkWell(
                        borderRadius: BorderRadius.circular(999),
                        onTap: () => onCopy(path),
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 9,
                            vertical: 4,
                          ),
                          decoration: BoxDecoration(
                            borderRadius: BorderRadius.circular(999),
                            border: Border.all(
                              color: Octo.teal.withValues(alpha: .4),
                            ),
                          ),
                          child: const Text(
                            '⧉ 复制',
                            style: TextStyle(
                              fontFamily: Octo.mono,
                              fontSize: 8.5,
                              fontWeight: FontWeight.w700,
                              letterSpacing: .4,
                              color: Octo.teal,
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: InteractiveViewer(
                      maxScale: 5,
                      child: Center(
                        child: Image.network(
                          url,
                          fit: BoxFit.contain,
                          loadingBuilder: (context, child, progress) =>
                              progress == null
                              ? child
                              : const Center(
                                  child: SizedBox(
                                    width: 22,
                                    height: 22,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                      valueColor: AlwaysStoppedAnimation(
                                        Octo.teal,
                                      ),
                                    ),
                                  ),
                                ),
                          errorBuilder: (context, error, stack) => const Text(
                            '图片读不出来 —— 文件可能被删，或不在会话白名单里',
                            textAlign: TextAlign.center,
                            style: TextStyle(
                              fontFamily: Octo.mono,
                              fontSize: 10.5,
                              height: 1.6,
                              color: Octo.dim,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
                const Padding(
                  padding: EdgeInsets.fromLTRB(14, 0, 14, 12),
                  child: Text(
                    '关闭后回到原滚动位置',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontFamily: Octo.mono,
                      fontSize: 9,
                      height: 1.6,
                      color: Color(0xCC8D86B8),
                    ),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// 只读文档窗：文本 / json / md 原样看，图片换成预览；仍在当前 chat 上。
Future<void> showChatDocWindow(
  BuildContext context, {
  required OctopusApi api,
  required String sessionId,
  required String path,
}) {
  return showDialog<void>(
    context: context,
    barrierColor: const Color(0x9904030A),
    builder: (_) => _ChatDocWindow(api: api, sessionId: sessionId, path: path),
  );
}

class _ChatDocWindow extends StatefulWidget {
  const _ChatDocWindow({
    required this.api,
    required this.sessionId,
    required this.path,
  });

  final OctopusApi api;
  final String sessionId;
  final String path;

  @override
  State<_ChatDocWindow> createState() => _ChatDocWindowState();
}

class _ChatDocWindowState extends State<_ChatDocWindow> {
  ChatDocResult? _doc;
  Object? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final doc = await widget.api.chatDoc(widget.sessionId, widget.path);
      if (!mounted) return;
      setState(() {
        _doc = doc;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e;
        _loading = false;
      });
    }
  }

  Future<void> _copy(String text) async {
    await Clipboard.setData(ClipboardData(text: text));
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text('已复制 · $text')));
  }

  String get _name => mediaBasename(widget.path);
  String get _ext =>
      _doc?.ext.isNotEmpty == true ? _doc!.ext : mediaExt(widget.path);

  @override
  Widget build(BuildContext context) {
    final doc = _doc;
    final meta = [
      '文档',
      '只读',
      if (doc != null) doc.kindLabel,
      if (_ext.isNotEmpty) _ext.replaceFirst('.', ''),
      if (doc != null) formatBytes(doc.size),
    ].join(' · ');

    return Dialog(
      backgroundColor: Colors.transparent,
      insetPadding: const EdgeInsets.fromLTRB(10, 52, 10, 10),
      child: Container(
        constraints: const BoxConstraints(maxWidth: 560),
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(Octo.rXl),
          border: Border.all(color: Octo.teal.withValues(alpha: .26)),
          gradient: const LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [Color(0xFC151132), Color(0xFC0A0818)],
          ),
          boxShadow: const [
            BoxShadow(
              color: Color(0xB8000000),
              blurRadius: 60,
              offset: Offset(0, 24),
            ),
          ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 11, 12, 11),
              child: Row(
                children: [
                  Container(
                    width: 28,
                    height: 28,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(9),
                      color: Octo.teal.withValues(alpha: .08),
                      border: Border.all(
                        color: Octo.teal.withValues(alpha: .3),
                      ),
                    ),
                    child: const Text(
                      '▤',
                      style: TextStyle(fontSize: 12, color: Octo.teal),
                    ),
                  ),
                  const SizedBox(width: 9),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          _name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 12.5,
                            fontWeight: FontWeight.w600,
                            color: Colors.white,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          meta,
                          style: const TextStyle(
                            fontFamily: Octo.mono,
                            fontSize: 8.5,
                            height: 1.4,
                            color: Octo.dim,
                          ),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    onPressed: () => Navigator.of(context).maybePop(),
                    icon: const Icon(Icons.close, size: 17),
                    color: Octo.metal,
                    style: IconButton.styleFrom(
                      side: const BorderSide(color: Octo.hairline),
                    ),
                  ),
                ],
              ),
            ),
            Container(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
              decoration: const BoxDecoration(
                border: Border(
                  top: BorderSide(color: Octo.hairlineSoft),
                  bottom: BorderSide(color: Color(0x128D86B8)),
                ),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      pathTail(widget.path),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontFamily: Octo.mono,
                        fontSize: 8.5,
                        height: 1.5,
                        color: Octo.dim,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  InkWell(
                    borderRadius: BorderRadius.circular(999),
                    onTap: () => _copy(widget.path),
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 9,
                        vertical: 4,
                      ),
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(999),
                        border: Border.all(
                          color: Octo.teal.withValues(alpha: .4),
                        ),
                      ),
                      child: const Text(
                        '⧉ 复制路径',
                        style: TextStyle(
                          fontFamily: Octo.mono,
                          fontSize: 8.5,
                          fontWeight: FontWeight.w700,
                          letterSpacing: .3,
                          color: Octo.teal,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            Flexible(child: _body(doc)),
            Container(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
              child: const Row(
                children: [
                  Text(
                    '只读预览',
                    style: TextStyle(
                      fontFamily: Octo.mono,
                      fontSize: 8.5,
                      height: 1.5,
                      color: Color(0xD98D86B8),
                    ),
                  ),
                  Spacer(),
                  Text(
                    '修改请回桌面',
                    style: TextStyle(
                      fontFamily: Octo.mono,
                      fontSize: 8.5,
                      height: 1.5,
                      color: Color(0xD98D86B8),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _body(ChatDocResult? doc) {
    if (_loading) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 40),
        child: Center(
          child: SizedBox(
            width: 18,
            height: 18,
            child: CircularProgressIndicator(
              strokeWidth: 1.6,
              valueColor: AlwaysStoppedAnimation(Octo.teal),
            ),
          ),
        ),
      );
    }
    if (_error != null) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(12, 14, 12, 18),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              describeError(_error!),
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontFamily: Octo.mono,
                fontSize: 10,
                height: 1.6,
                color: Octo.red,
              ),
            ),
            const SizedBox(height: 10),
            TextButton(onPressed: _load, child: const Text('重试')),
          ],
        ),
      );
    }
    if (doc == null) return const SizedBox.shrink();

    if (doc.isImage) {
      final url = widget.api.chatMediaUrl(
        widget.sessionId,
        route: 'raw',
        path: widget.path,
      );
      return Padding(
        padding: const EdgeInsets.all(12),
        child: InteractiveViewer(
          maxScale: 4,
          child: Center(
            child: Image.network(
              url,
              fit: BoxFit.contain,
              errorBuilder: (context, error, stack) => const Text(
                '图片读不出来',
                style: TextStyle(
                  fontFamily: Octo.mono,
                  fontSize: 10,
                  color: Octo.red,
                ),
              ),
            ),
          ),
        ),
      );
    }
    if (doc.kind == 'video' || doc.kind == 'audio') {
      return Padding(
        padding: const EdgeInsets.fromLTRB(16, 24, 16, 24),
        child: Text(
          '${doc.kindLabel}暂不在手机端播放（${formatBytes(doc.size)}）\n'
          '要听 / 看请回桌面打开：${widget.path}',
          textAlign: TextAlign.center,
          style: const TextStyle(
            fontFamily: Octo.mono,
            fontSize: 10,
            height: 1.7,
            color: Octo.dim,
          ),
        ),
      );
    }
    if (doc.kind == 'binary') {
      return Padding(
        padding: const EdgeInsets.fromLTRB(16, 24, 16, 24),
        child: Text(
          '无法查阅二进制文件\n${_ext.replaceFirst('.', '')} · ${formatBytes(doc.size)}\n'
          '聊天文档窗只读文本 / 图片 / 视频 / 音频。',
          textAlign: TextAlign.center,
          style: const TextStyle(
            fontFamily: Octo.mono,
            fontSize: 10,
            height: 1.7,
            color: Octo.dim,
          ),
        ),
      );
    }

    final raw = doc.content ?? '';
    final text = _pretty(doc.ext.isNotEmpty ? doc.ext : _ext, raw);
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(Octo.rS),
          border: Border.all(color: Octo.hairlineSoft),
          color: const Color(0x990A0818),
        ),
        child: SelectableText(
          text,
          style: const TextStyle(
            fontFamily: Octo.mono,
            fontSize: 9.5,
            height: 1.75,
            color: Octo.metal,
          ),
        ),
      ),
    );
  }

  static String _pretty(String ext, String content) {
    if (ext == '.json' || ext == '.jsonc') {
      try {
        return const JsonEncoder.withIndent('  ').convert(jsonDecode(content));
      } catch (_) {
        return content;
      }
    }
    return content;
  }
}
